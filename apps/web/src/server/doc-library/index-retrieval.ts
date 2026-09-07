import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { isSqliteDatabase } from "@/server/db/client"
import { withReadBudget, type ReadBudget } from "@/server/db/read-budget"
import { docDocuments, docIndexGenerations, docPassages } from "@/server/db/schema"
import { buildQueryTokens, buildTsQuery } from "@/server/retrieval/tokenize"
import { reciprocalRankFusion, toRecallHits } from "@/server/retrieval/fusion"
import { LocalLexicalReranker } from "@/server/retrieval/reranker"
import { docLibraryDocumentPath } from "@/lib/dashboard-routes"
import { parseStoredIndexManifest, serializeIndexVectors } from "./index-contract"
import { resolveDocumentIndexProvider } from "./index-provider"
import { documentHitSnippet, documentSearchTerms } from "./search-query"
import { buildEvidenceWindow } from "./evidence-window"
import { hashDocumentText } from "./passage-builder"

type IndexInput = ReadBudget & { userId: number; libraryIds: number[]; query: string; limit?: number }
export type IndexedDocumentHit = {
    passageId: number; generationId: number; documentId: number; libraryId: number; title: string; text: string
    contentHash: string; sourceHash: string; locator: string | null; passageIndex: number
}

export async function searchDocumentIndex(input: IndexInput) {
    const degraded: string[] = []
    const empty = { hits: [] as Array<IndexedDocumentHit & { snippet: string; href: string; mode: string }>, indexedLibraryIds: [] as number[], degraded }
    if (process.env.PETRICHOR_DOC_INDEX_ENABLED !== "true" || isSqliteDatabase() || !input.libraryIds.length) return empty
    const deadline = Math.min(input.queryDeadlineAt ?? Infinity, Date.now() + 8_000)
    const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, deadline - Date.now())), ...(input.abortSignal ? [input.abortSignal] : [])])
    const budget = { abortSignal: signal, queryDeadlineAt: deadline }
    const generations = await withReadBudget((reader) => reader.select().from(docIndexGenerations).where(and(
        eq(docIndexGenerations.userId, input.userId), inArray(docIndexGenerations.libraryId, input.libraryIds),
        eq(docIndexGenerations.isCurrent, true), eq(docIndexGenerations.status, "ready"),
    )), budget)
    if (!generations.length) return empty
    const documents = await withReadBudget((reader) => reader.select({ id: docDocuments.id, libraryId: docDocuments.libraryId, updatedAt: docDocuments.updatedAt }).from(docDocuments)
        .where(and(eq(docDocuments.userId, input.userId), inArray(docDocuments.libraryId, input.libraryIds), eq(docDocuments.status, "ready"))).limit(10_001), budget)
    if (documents.length > 10_000) throw new Error("索引范围超过检索上限")
    const eligible = generations.filter((generation) => {
        const manifest = parseStoredIndexManifest(generation.manifestJson, generation.manifestHash)
        const current = documents.filter((doc) => doc.libraryId === generation.libraryId)
        const versions = new Map(current.map((doc) => [doc.id, doc.updatedAt.toISOString()]))
        const valid = current.length === manifest.documents.length && manifest.documents.every((doc) => versions.get(doc.documentId) === doc.updatedAt)
        if (!valid) degraded.push("index_snapshot_stale")
        return valid
    })
    if (!eligible.length) return empty
    const filters = [eq(docPassages.userId, input.userId), eq(docDocuments.userId, input.userId), eq(docDocuments.status, "ready"),
        inArray(docPassages.generationId, eligible.map((g) => g.id)), inArray(docPassages.libraryId, input.libraryIds)]
    const fields = { passageId: docPassages.id, generationId: docPassages.generationId, documentId: docPassages.documentId,
        libraryId: docPassages.libraryId, title: docDocuments.title, text: docPassages.text, contentHash: docPassages.contentHash,
        sourceHash: docPassages.sourceHash, locator: docPassages.locator, passageIndex: docPassages.passageIndex }
    const terms = documentSearchTerms(input.query)
    const tsquery = buildTsQuery(buildQueryTokens(terms.join(" ")))
    const lexical: IndexedDocumentHit[] = !tsquery ? [] : await withReadBudget((reader) => reader.select(fields).from(docPassages)
        .innerJoin(docDocuments, eq(docDocuments.id, docPassages.documentId))
        .where(and(...filters, sql`search_vector @@ to_tsquery('simple', ${tsquery})`))
        .orderBy(desc(sql`ts_rank_cd(search_vector, to_tsquery('simple', ${tsquery}))`), asc(docPassages.id)).limit(30), budget)
    const semantic: IndexedDocumentHit[] = []
    const semanticFeeds: IndexedDocumentHit[][] = []
    if (process.env.PETRICHOR_DOC_HYBRID_ENABLED === "true") {
        const groups = new Map<string, typeof eligible>()
        for (const generation of eligible) {
            const key = generation.embeddingProfileJson
            groups.set(key, [...(groups.get(key) ?? []), generation])
        }
        for (const group of groups.values()) {
            try {
                signal.throwIfAborted()
                if (deadline - Date.now() <= 2_000) { degraded.push("semantic_budget_exhausted"); break }
                const semanticDeadline = Math.min(deadline - 2_000, Date.now() + 2_500)
                const semanticSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, semanticDeadline - Date.now()))])
                const profile = parseStoredIndexManifest(group[0].manifestJson, group[0].manifestHash).profile
                const provider = await resolveDocumentIndexProvider(input.userId, JSON.parse(process.env.PETRICHOR_DOC_INDEX_PROVIDER_POLICY ?? "null"), profile)
                const vectors = await provider.embed([input.query], semanticSignal)
                const [vector] = serializeIndexVectors(vectors, 1, profile.dimensions)
                const distance = sql<number>`embedding <=> ${vector}::vector`
                const feed = await withReadBudget((reader) => reader.select(fields).from(docPassages)
                    .innerJoin(docDocuments, eq(docDocuments.id, docPassages.documentId))
                    .where(and(...filters, inArray(docPassages.generationId, group.map((g) => g.id)),
                        eq(docPassages.embeddingStatus, "ready"), eq(docPassages.embeddingDimensions, profile.dimensions),
                        sql`embedding is not null and vector_dims(embedding) = ${profile.dimensions}`))
                    .orderBy(asc(distance), asc(docPassages.id)).limit(Math.max(1, Math.floor(30 / groups.size))), { abortSignal: semanticSignal, queryDeadlineAt: semanticDeadline })
                semantic.push(...feed)
                semanticFeeds.push(feed)
            } catch { degraded.push("semantic_unavailable") }
        }
    }
    const key = (hit: IndexedDocumentHit) => `${hit.generationId}:${hit.passageId}`
    const byKey = new Map([...lexical, ...semantic].map((hit) => [key(hit), hit]))
    const ranked = reciprocalRankFusion([
        toRecallHits("chunk_bm25", lexical.map((hit) => ({ nodeKey: key(hit) }))),
        ...semanticFeeds.map((feed) => toRecallHits("chunk_vector", feed.map((hit) => ({ nodeKey: key(hit) })))),
    ], { topK: Math.min(input.limit ?? 20, 20) })
    const reranked = await new LocalLexicalReranker().rerank(input.query, ranked.map((rank) => ({ ...rank,
        title: byKey.get(rank.nodeKey)?.title, content: byKey.get(rank.nodeKey)?.text })))
    return { hits: reranked.map((rank) => {
        const hit = byKey.get(rank.nodeKey)!
        return { ...hit, snippet: documentHitSnippet(hit.text, terms), href: docLibraryDocumentPath(String(hit.libraryId), String(hit.documentId)),
            mode: rank.recallSources.includes("chunk_vector") ? "hybrid" : "lexical" }
    }), indexedLibraryIds: eligible.map((g) => g.libraryId), degraded: [...new Set(degraded)] }
}

export async function readDocumentIndexPassage(input: ReadBudget & { userId: number; libraryId: number; documentId: number; generationId: number; passageId: number; contentHash: string }) {
    if (process.env.PETRICHOR_DOC_INDEX_ENABLED !== "true" || isSqliteDatabase()) throw new Error("增强索引当前不可用")
    return await withReadBudget(async (reader, checkpoint) => {
        const [generation] = await reader.select().from(docIndexGenerations).where(and(eq(docIndexGenerations.id, input.generationId),
            eq(docIndexGenerations.userId, input.userId), eq(docIndexGenerations.libraryId, input.libraryId), inArray(docIndexGenerations.status, ["ready", "retired"]))).limit(1)
        if (!generation) throw new Error("引用索引版本已失效")
        const snapshot = parseStoredIndexManifest(generation.manifestJson, generation.manifestHash).documents.find((doc) => doc.documentId === input.documentId)
        await checkpoint()
        const [document] = await reader.select().from(docDocuments).where(and(eq(docDocuments.id, input.documentId), eq(docDocuments.userId, input.userId),
            eq(docDocuments.libraryId, input.libraryId), eq(docDocuments.status, "ready"))).limit(1)
        if (!document || document.updatedAt.toISOString() !== snapshot?.updatedAt) throw new Error("引用原文版本已变化")
        const filters = [eq(docPassages.generationId, input.generationId), eq(docPassages.userId, input.userId), eq(docPassages.libraryId, input.libraryId), eq(docPassages.documentId, input.documentId)]
        await checkpoint()
        const [anchor] = await reader.select().from(docPassages).where(and(...filters, eq(docPassages.id, input.passageId))).limit(1)
        if (!anchor || anchor.sourceHash !== snapshot.sourceHash || anchor.contentHash !== input.contentHash || hashDocumentText(anchor.text) !== anchor.contentHash) throw new Error("引用片段hash不匹配")
        await checkpoint()
        const neighbors = await reader.select().from(docPassages).where(and(...filters,
            sql`${docPassages.passageIndex} between ${Math.max(0, anchor.passageIndex - 1)} and ${anchor.passageIndex + 1}`)).orderBy(asc(docPassages.passageIndex))
        const chunks = neighbors.map((item) => {
            if (item.sourceHash !== snapshot.sourceHash || hashDocumentText(item.text) !== item.contentHash) throw new Error("引用上下文hash不匹配")
            if (item.id === anchor.id) return { chunkIndex: item.passageIndex, text: anchor.text }
            const start = Math.max(item.startOffset, anchor.parentStartOffset, item.startOffset > anchor.startOffset ? anchor.endOffset : 0)
            const end = Math.min(item.endOffset, anchor.parentEndOffset, item.startOffset < anchor.startOffset ? anchor.startOffset : Infinity)
            return { chunkIndex: item.passageIndex, text: end > start ? item.text.slice(start - item.startOffset, end - item.startOffset) : "" }
        })
        const window = buildEvidenceWindow(chunks, anchor.passageIndex)
        return { title: document.title, content: window.content, anchorStart: window.anchorStart, anchorEnd: window.anchorEnd, anchor,
            href: `${docLibraryDocumentPath(String(input.libraryId), String(input.documentId))}&generationId=${input.generationId}&passageId=${input.passageId}&contentHash=${input.contentHash}` }
    }, input)
}
