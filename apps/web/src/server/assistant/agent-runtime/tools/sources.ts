import { z } from "zod"

import { assistantSourceRefSchema, type AssistantSourceCatalogItem } from "@/lib/assistant-source-contract"
import type { AssistantFocus } from "@/server/assistant/domain-types"
import { searchDocuments, readDocument } from "@/server/assistant/tools/doc-library"
import { resolveAssistantSources } from "@/server/assistant/source-catalog"
import { readSourceStatistics } from "@/server/assistant/source-statistics"
import { buildEvidenceWindow } from "@/server/doc-library/evidence-window"
import { searchDocumentIndex, readDocumentIndexPassage } from "@/server/doc-library/index-retrieval"
import { badRequest } from "@/server/http/response"
import { defineTool, toAssistantContext } from "./adapter"
import { geneOpsTools } from "./geneops"
import { knowledgeTools } from "./knowledge"
import type {
    AgentToolDefinition,
    ToolExecutionContext,
    ToolNormalizerResult,
} from "../types"

const sourceSearchSchema = z.object({
    query: z.string().trim().min(1).max(400),
    limit: z.number().int().min(1).max(20).default(12),
    geneOpsSource: z.enum(["wearesellers", "wechat_mp"]).optional(),
    geneOpsMode: z.enum(["exact", "fuzzy"]).default("exact"),
})

const positiveIdSchema = z.coerce.number().int().positive()

const knowledgeReadSchema = z.object({
    kind: z.literal("knowledge"),
    sourceRef: assistantSourceRefSchema,
    knowledgeBaseId: positiveIdSchema,
    nodeKey: z.string().optional(),
    chunkId: z.union([z.string(), z.number()]).optional(),
    pageKey: z.string().optional(),
    articleId: z.union([z.string(), z.number()]).optional(),
}).superRefine((value, ctx) => {
    const count = [value.nodeKey, value.chunkId, value.pageKey, value.articleId]
        .filter((item) => item != null).length
    if (count !== 1) ctx.addIssue({ code: "custom", message: "知识候选定位字段必须且只能提供一个" })
})

const documentReadSchema = z.object({
    kind: z.literal("document"),
    sourceRef: assistantSourceRefSchema,
    documentId: positiveIdSchema,
    anchorChunkId: positiveIdSchema.optional(),
    passageId: positiveIdSchema.optional(),
    generationId: positiveIdSchema.optional(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).superRefine((value, ctx) => {
    const modern = [value.passageId, value.generationId, value.contentHash].some((item) => item != null)
    if (modern && (value.passageId == null || value.generationId == null || value.contentHash == null || value.anchorChunkId != null)) {
        ctx.addIssue({ code: "custom", message: "代际锚点必须完整，且不能与旧chunk锚点混用" })
    }
})

const geneOpsReadSchema = z.object({
    kind: z.literal("geneops"),
    sourceRef: assistantSourceRefSchema,
    documentId: z.string().trim().min(1).max(200),
})

const sourceReadSchema = z.union([knowledgeReadSchema, documentReadSchema, geneOpsReadSchema])

type SourceReadInput = z.infer<typeof sourceReadSchema>

type SourceCandidate = {
    candidateKey: string
    sourceRef: string
    sourceKind: "knowledge-base" | "doc-library" | "external-source"
    sourceName: string
    title: string
    snippet: string
    url: string | null
    score: number
    retrievalMode?: string
    read: SourceReadInput
}

type SourceSearchOutput = {
    candidates: SourceCandidate[]
    degradedSources: Array<{ sourceRef: string; sourceName: string; message: string }>
}

type SourceReadOutput = {
    normalized: ToolNormalizerResult
}

const RRF_K = 60

function requireTool(tools: AgentToolDefinition[], id: string) {
    const found = tools.find((item) => item.id === id)
    if (!found) throw new Error(`统一资料源依赖工具未注册：${id}`)
    return found
}

function focusForSource(ctx: ToolExecutionContext, source: AssistantSourceCatalogItem): ToolExecutionContext {
    const base = (ctx.focus ?? {}) as AssistantFocus
    if (source.kind === "knowledge-base") {
        return { ...ctx, focus: { ...base, knowledgeBaseId: source.id } }
    }
    if (source.kind === "doc-library") {
        return { ...ctx, focus: { ...base, libraryId: source.id } }
    }
    return {
        ...ctx,
        focus: { ...base, sourceScope: { mode: "selected", refs: [source.ref] } },
    }
}

function rankFeed(
    rows: Omit<SourceCandidate, "score">[],
    quality: number,
): SourceCandidate[] {
    return rows.map((row, index) => ({
        ...row,
        score: Number((quality / (RRF_K + index + 1)).toFixed(8)),
    }))
}

async function searchKnowledge(
    ctx: ToolExecutionContext,
    source: AssistantSourceCatalogItem,
    query: string,
): Promise<SourceCandidate[]> {
    const tool = requireTool(knowledgeTools, "knowledge.search")
    const output = await tool.execute(focusForSource(ctx, source), {
        query,
        knowledgeBaseId: source.id,
        limit: 8,
    }) as { hits?: Array<Record<string, unknown>> }
    const rows = (output.hits ?? []).map((hit): Omit<SourceCandidate, "score"> | null => {
        const title = typeof hit.title === "string" ? hit.title : "未命名知识"
        const articleId = stringValue(hit.articleId)
        const chunkId = stringValue(hit.chunkId)
        const pageKey = stringValue(hit.pageKey)
        const nodeKey = stringValue(hit.nodeKey)
        const locatorCount = [chunkId, pageKey, nodeKey, articleId].filter(Boolean).length
        if (locatorCount === 0) return null
        const read: SourceReadInput = {
            kind: "knowledge",
            sourceRef: source.ref,
            knowledgeBaseId: Number(source.id),
            ...(chunkId ? { chunkId } : pageKey ? { pageKey } : nodeKey ? { nodeKey } : { articleId: articleId! }),
        }
        return {
            candidateKey: `knowledge:${source.id}:${chunkId ?? pageKey ?? nodeKey ?? articleId}`,
            sourceRef: source.ref,
            sourceKind: source.kind,
            sourceName: source.name,
            title,
            snippet: clip(stringValue(hit.summary) ?? stringValue(hit.reason) ?? "", 600),
            url: stringValue(hit.href),
            read,
        }
    }).filter((item): item is Omit<SourceCandidate, "score"> => item != null)
    return rankFeed(rows, 0.85)
}

async function searchKnowledgeAcross(
    ctx: ToolExecutionContext,
    sources: AssistantSourceCatalogItem[],
    query: string,
): Promise<SourceCandidate[]> {
    const tool = requireTool(knowledgeTools, "knowledge.search")
    const output = await tool.execute({ ...ctx, focus: {} }, { query, limit: 12 }) as {
        hits?: Array<Record<string, unknown>>
    }
    const byId = new Map(sources.map((source) => [source.id, source]))
    const rows = (output.hits ?? []).map((hit): Omit<SourceCandidate, "score"> | null => {
        const kbId = stringValue(hit.knowledgeBaseId)
        const source = kbId ? byId.get(kbId) : null
        if (!source) return null
        const articleId = stringValue(hit.articleId)
        const chunkId = stringValue(hit.chunkId)
        const pageKey = stringValue(hit.pageKey)
        const nodeKey = stringValue(hit.nodeKey)
        if (![chunkId, pageKey, nodeKey, articleId].some(Boolean)) return null
        return {
            candidateKey: `knowledge:${source.id}:${chunkId ?? pageKey ?? nodeKey ?? articleId}`,
            sourceRef: source.ref,
            sourceKind: source.kind,
            sourceName: source.name,
            title: stringValue(hit.title) ?? "未命名知识",
            snippet: clip(stringValue(hit.summary) ?? stringValue(hit.reason) ?? "", 600),
            url: stringValue(hit.href),
            read: {
                kind: "knowledge",
                sourceRef: source.ref,
                knowledgeBaseId: Number(source.id),
                ...(chunkId ? { chunkId } : pageKey ? { pageKey } : nodeKey ? { nodeKey } : { articleId: articleId! }),
            },
        }
    }).filter((item): item is Omit<SourceCandidate, "score"> => item != null)
    return rankFeed(rows, 0.85)
}

async function searchDocumentLibrary(
    ctx: ToolExecutionContext, source: AssistantSourceCatalogItem, query: string,
    degraded?: (source: AssistantSourceCatalogItem, message: string) => void,
): Promise<SourceCandidate[]> {
    return searchDocumentsAcross(ctx, [source], query, degraded)
}

async function searchDocumentsAcross(
    ctx: ToolExecutionContext, sources: AssistantSourceCatalogItem[], query: string,
    degraded?: (source: AssistantSourceCatalogItem, message: string) => void,
): Promise<SourceCandidate[]> {
    let indexed: Awaited<ReturnType<typeof searchDocumentIndex>> = { hits: [], indexedLibraryIds: [], degraded: [] }
    try {
        indexed = await searchDocumentIndex({ userId: ctx.userId, libraryIds: sources.map((source) => Number(source.id)),
            query, limit: 12, abortSignal: ctx.abortSignal, queryDeadlineAt: ctx.queryDeadlineAt })
        if (indexed.degraded.length) for (const source of sources) degraded?.(source, "增强检索部分不可用，已使用可用词法结果")
    } catch {
        if (ctx.abortSignal?.aborted) throw new Error("文档检索已取消")
        for (const source of sources) degraded?.(source, "增强索引不可用，回退关键词检索")
    }
    const fallback = sources.filter((source) => !indexed.indexedLibraryIds.includes(Number(source.id)))
    let legacy: Array<Record<string, unknown>> = []
    if (fallback.length) {
        try {
            legacy = await searchDocuments(toAssistantContext({ ...ctx, focus: {} }), {
                query, libraryId: null, libraryIds: fallback.map((source) => Number(source.id)), limit: 12,
            }) as Array<Record<string, unknown>>
        } catch {
            if (!indexed.hits.length) throw new Error("文档检索未能完成")
            for (const source of fallback) degraded?.(source, "部分文档关键词检索未能完成")
        }
    }
    const byId = new Map(sources.map((source) => [source.id, source]))
    const rows: Array<Record<string, unknown>> = [...indexed.hits, ...legacy]
    return rankFeed(rows.flatMap((row): Array<Omit<SourceCandidate, "score">> => {
        const source = byId.get(String(row.libraryId))
        if (!source) return []
        const documentId = Number(row.documentId)
        const read: SourceReadInput = row.passageId != null
            ? { kind: "document", sourceRef: source.ref, documentId, passageId: Number(row.passageId),
                generationId: Number(row.generationId), contentHash: String(row.contentHash) }
            : { kind: "document", sourceRef: source.ref, documentId, anchorChunkId: positiveIdSchema.parse(row.chunkId) }
        return [{
            candidateKey: row.passageId != null ? `document:${documentId}:generation:${row.generationId}:passage:${row.passageId}` : `document:${documentId}:chunk:${row.chunkId}`,
            sourceRef: source.ref, sourceKind: source.kind, sourceName: source.name,
            title: stringValue(row.title) ?? stringValue(row.fileName) ?? "未命名文档",
            snippet: clip(stringValue(row.snippet) ?? "", 600), url: stringValue(row.href), read,
            retrievalMode: stringValue(row.mode) ?? "keyword",
        }]
    }), 0.8)
}

async function searchGeneOps(
    ctx: ToolExecutionContext,
    source: AssistantSourceCatalogItem,
    input: z.infer<typeof sourceSearchSchema>,
): Promise<SourceCandidate[]> {
    const tool = requireTool(geneOpsTools, "geneops.search")
    const rows = await tool.execute(focusForSource(ctx, source), {
        query: input.query,
        ...(input.geneOpsSource ? { source: input.geneOpsSource } : {}),
        mode: input.geneOpsMode,
        limit: 8,
    }) as Array<Record<string, unknown>>
    return rankFeed(rows.map((row) => {
        const documentId = String(row.document_id)
        const resultKey = stringValue(row.result_key) ?? documentId
        return {
            candidateKey: `geneops:${resultKey}`,
            sourceRef: source.ref,
            sourceKind: source.kind,
            sourceName: source.name,
            title: stringValue(row.title) ?? "GeneOps 实时内容",
            snippet: clip(stringValue(row.snippet) ?? "", 600),
            url: stringValue(row.source_url),
            read: { kind: "geneops", sourceRef: source.ref, documentId },
        }
    }), 0.9)
}

async function executeSourceSearch(
    ctx: ToolExecutionContext,
    raw: unknown,
): Promise<SourceSearchOutput> {
    const input = sourceSearchSchema.parse(raw)
    const resolved = await resolveAssistantSources(ctx.userId, (ctx.focus ?? null) as AssistantFocus | null)
    const sources = resolved.selected
    const indexDegradations: SourceSearchOutput["degradedSources"] = []
    const reportDegraded = (source: AssistantSourceCatalogItem, message: string) => indexDegradations.push({ sourceRef: source.ref, sourceName: source.name, message })
    if (sources.length === 0) {
        throw badRequest(resolved.unavailable[0]?.unavailableReason ?? "当前范围没有可用资料源")
    }

    const tasks: Array<{
        source: AssistantSourceCatalogItem
        run: () => Promise<SourceCandidate[]>
    }> = []
    const knowledgeSources = sources.filter((source) => source.kind === "knowledge-base")
    const documentSources = sources.filter((source) => source.kind === "doc-library")
    const externalSources = sources.filter((source) => source.kind === "external-source")
    if (resolved.scope.mode === "selected") {
        for (const source of knowledgeSources) {
            tasks.push({ source, run: async () => await searchKnowledge(ctx, source, input.query) })
        }
        if (documentSources[0]) tasks.push({ source: documentSources[0], run: async () => documentSources.length === 1
            ? searchDocumentLibrary(ctx, documentSources[0], input.query, reportDegraded)
            : searchDocumentsAcross(ctx, documentSources, input.query, reportDegraded) })
    } else {
        if (knowledgeSources[0]) {
            tasks.push({
                source: { ...knowledgeSources[0], name: "全部知识库" },
                run: async () => await searchKnowledgeAcross(ctx, knowledgeSources, input.query),
            })
        }
        if (documentSources[0]) {
            tasks.push({
                source: { ...documentSources[0], name: "全部文档库" },
                run: async () => await searchDocumentsAcross(ctx, documentSources, input.query, reportDegraded),
            })
        }
    }
    for (const source of externalSources) {
        tasks.push({ source, run: async () => await searchGeneOps(ctx, source, input) })
    }

    const settled = await Promise.allSettled(tasks.map((task) => task.run()))

    const candidates: SourceCandidate[] = []
    const degradedSources = resolved.unavailable.map((source) => ({
        sourceRef: source.ref,
        sourceName: source.name,
        message: source.unavailableReason ?? "资料源不可用",
    }))
    degradedSources.push(...indexDegradations)
    settled.forEach((result, index) => {
        const source = tasks[index]!.source
        if (result.status === "fulfilled") {
            candidates.push(...result.value)
        } else {
            degradedSources.push({
                sourceRef: source.ref,
                sourceName: source.name,
                message: result.reason instanceof Error ? result.reason.message : "查询失败",
            })
        }
    })

    const externalOnly = sources.every((source) => source.kind === "external-source")
    if (externalOnly && degradedSources.length > 0 && candidates.length === 0) {
        throw new Error(degradedSources[0]?.message ?? "GeneOps 数据源不可用")
    }
    const deduped = new Map<string, SourceCandidate>()
    for (const candidate of [...candidates].sort((a, b) => b.score - a.score)) {
        if (!deduped.has(candidate.candidateKey)) deduped.set(candidate.candidateKey, candidate)
    }
    return {
        candidates: [...deduped.values()].slice(0, input.limit),
        degradedSources,
    }
}

function normalizeSourceSearch(output: unknown): ToolNormalizerResult {
    const value = output as SourceSearchOutput
    const degraded = value.degradedSources.length > 0
        ? `；${value.degradedSources.length} 个来源降级`
        : ""
    return {
        progress: value.candidates.length > 0,
        summary: value.candidates.length > 0
            ? `统一资料源找到 ${value.candidates.length} 个候选${degraded}`
            : `统一资料源没有命中${degraded}`,
        data: value,
        suggestedActions: value.candidates.length > 0 ? ["source.read"] : ["rewrite_query"],
    }
}

async function executeSourceRead(ctx: ToolExecutionContext, raw: unknown): Promise<SourceReadOutput> {
    const input = sourceReadSchema.parse(raw)
    const resolved = await resolveAssistantSources(ctx.userId, (ctx.focus ?? null) as AssistantFocus | null)
    const source = resolved.selected.find((item) => item.ref === input.sourceRef)
    if (!source) throw badRequest("读取目标不在当前资料源范围内，或来源当前不可用")
    const expectedKind = input.kind === "knowledge"
        ? "knowledge-base"
        : input.kind === "document" ? "doc-library" : "external-source"
    if (source.kind !== expectedKind) throw badRequest("候选类型与资料源不匹配")

    if (input.kind === "knowledge") {
        if (String(input.knowledgeBaseId) !== source.id) {
            throw badRequest("知识候选不属于当前选定的知识库")
        }
        const tool = requireTool(knowledgeTools, "knowledge.read")
        const output = await tool.execute(focusForSource(ctx, source), input)
        return { normalized: annotateEvidence(tool.normalize?.(output, input), source) }
    }
    if (input.kind === "geneops") {
        const tool = requireTool(geneOpsTools, "geneops.read_chunks")
        const output = await tool.execute(
            focusForSource(ctx, source),
            { documentId: input.documentId, afterPosition: -1, limit: 8 },
        )
        return { normalized: annotateEvidence(tool.normalize?.(output, input), source) }
    }

    const documentId = Number(input.documentId)
    if (input.passageId != null && input.generationId != null && input.contentHash != null) {
        const output = await readDocumentIndexPassage({ userId: ctx.userId, libraryId: Number(source.id), documentId,
            passageId: input.passageId, generationId: input.generationId, contentHash: input.contentHash,
            abortSignal: ctx.abortSignal, queryDeadlineAt: ctx.queryDeadlineAt })
        return { normalized: {
            progress: true, summary: `已按命中位置读取「${output.title}」`, evidence: [{
                source: "document", title: output.title, content: output.content,
                sourceId: `${documentId}:generation:${input.generationId}:passage:${input.passageId}`, url: output.href,
                metadata: { sourceRef: source.ref, sourceName: source.name, documentId: String(documentId),
                    generationId: String(input.generationId), passageId: String(input.passageId), contentHash: input.contentHash,
                    sourceHash: output.anchor.sourceHash, startOffset: output.anchor.startOffset, endOffset: output.anchor.endOffset },
            }],
        } }
    }
    // reader在同一受限事务中核验focus.libraryId、用户和锚点后才读取正文。
    const output = await readDocument(toAssistantContext(focusForSource(ctx, source)), {
        documentId,
        fromIndex: 0,
        limit: input.anchorChunkId == null ? 12 : 3,
        anchorChunkId: input.anchorChunkId,
    }) as {
        documentId: string
        href: string
        title: string
        fileName: string
        anchorIndex: number | null
        chunks: Array<{ chunkIndex: number; locator: string | null; text: string }>
    }
    if (input.anchorChunkId != null && output.anchorIndex == null) throw badRequest("命中片段已失效")
    const content = output.anchorIndex != null
        ? buildEvidenceWindow(output.chunks, output.anchorIndex).content
        : output.chunks.map((chunk) => `${chunk.locator ? `[${chunk.locator}]\n` : ""}${chunk.text}`).join("\n\n")
    return {
        normalized: {
            progress: content.length > 0,
            summary: content.length > 0 ? `已读取文档「${output.title}」` : "文档没有可读内容",
            evidence: content.length > 0 ? [{
                source: "document",
                title: output.title || output.fileName,
                content: clip(content, 8_000),
                sourceId: input.anchorChunkId == null ? output.documentId : `${output.documentId}:chunk:${input.anchorChunkId}`,
                url: output.href,
                confidence: 0.8,
                metadata: {
                    sourceRef: source.ref, sourceName: source.name, documentId: output.documentId,
                    ...(input.anchorChunkId == null ? {} : { anchorChunkId: String(input.anchorChunkId), anchorIndex: output.anchorIndex }),
                },
            }] : [],
        },
    }
}

function annotateEvidence(
    normalized: ToolNormalizerResult | undefined,
    source: AssistantSourceCatalogItem,
): ToolNormalizerResult {
    const value = normalized ?? { summary: "资料源没有返回可读内容" }
    return {
        ...value,
        evidence: value.evidence?.map((item) => ({
            ...item,
            metadata: {
                ...item.metadata,
                sourceRef: source.ref,
                sourceName: source.name,
            },
        })),
    }
}

async function executeSourceLookup(ctx: ToolExecutionContext, raw: unknown) {
    const search = await executeSourceSearch(ctx, raw)
    // 每轮最多3个窗口；两轮合计不超过快速检索的6窗口上限。
    // 只在最靠前的6个候选内做文档去重优先，不能为了凑来源去深读长尾。
    const pool = search.candidates.slice(0, 6)
    const selected: SourceCandidate[] = []
    const seen = new Set<string>()
    for (const candidate of pool) {
        const read = candidate.read
        const documentKey = read.kind === "document" || read.kind === "geneops"
            ? `${candidate.sourceRef}:${read.documentId}`
            : `${candidate.sourceRef}:${read.articleId ?? read.pageKey ?? candidate.url?.split(/[?#]/)[0] ?? candidate.candidateKey}`
        if (seen.has(documentKey)) continue
        seen.add(documentKey); selected.push(candidate)
        if (selected.length === 3) break
    }
    for (const candidate of pool) {
        if (selected.length === 3) break
        if (!selected.some((item) => item.candidateKey === candidate.candidateKey)) selected.push(candidate)
    }
    const reads = await Promise.allSettled(
        selected.map((candidate) => executeSourceRead(ctx, candidate.read)),
    )
    return { search, reads }
}

function normalizeSourceLookup(output: unknown): ToolNormalizerResult {
    const value = output as {
        search: SourceSearchOutput
        reads: PromiseSettledResult<SourceReadOutput>[]
    }
    const evidence: NonNullable<ToolNormalizerResult["evidence"]> = []
    let readCount = 0
    const failedReadCount = value.reads.filter((read) => read.status === "rejected").length
    for (const read of value.reads) {
        if (read.status !== "fulfilled") continue
        readCount += 1
        evidence.push(...(read.value.normalized.evidence ?? []))
    }
    const degraded = value.search.degradedSources.length > 0
        ? value.search.degradedSources.map((item) => `${item.sourceName}：${item.message}`)
        : []
    return {
        progress: evidence.length > 0,
        summary: evidence.length > 0
            ? `跨资料源找到 ${value.search.candidates.length} 个候选并深读 ${readCount} 个${failedReadCount ? `；${failedReadCount} 个候选读取失败` : ""}${degraded.length ? `；${degraded.length} 个来源降级` : ""}`
            : `跨资料源没有读到可引用正文${degraded.length ? `；${degraded.length} 个来源降级` : ""}`,
        data: {
            candidateCount: value.search.candidates.length,
            readCount,
            failedReadCount,
            retrievalModes: [...new Set(value.search.candidates.map((candidate) => candidate.retrievalMode).filter(Boolean))],
            degradedSources: degraded,
        },
        evidence,
        suggestedActions: evidence.length > 0 ? [] : ["source.search", "rewrite_query"],
    }
}

function stringValue(value: unknown): string | null {
    if (value == null) return null
    const text = String(value).trim()
    return text || null
}

function clip(value: string, max: number) {
    return value.length > max ? `${value.slice(0, max)}…` : value
}

export const sourceTools: AgentToolDefinition[] = [
    defineTool({
        id: "source.overview", name: "source_overview", namespace: "source", riskLevel: "low", sideEffect: false, maxRetries: 0, timeoutMs: 8_000,
        description: "何时用：读取当前选定范围内的资料数量元数据。何时不用：需要正文内容或业务数量时。外部源无总量接口时返回未知，不将命中数当全库总数。",
        inputSchema: z.object({}).strict(),
        execute: (ctx) => readSourceStatistics(ctx.userId, ctx.focus as AssistantFocus | undefined, ctx.abortSignal),
        normalize: (output) => ({ summary: "已读取所选范围资料统计", data: output, evidence: [] }),
    }),
    defineTool({
        id: "source.lookup",
        name: "lookup_sources",
        namespace: "source",
        core: true,
        riskLevel: "low",
        sideEffect: false,
        maxRetries: 0,
        timeoutMs: 8_000,
        description: "在当前选择的知识库、文档库与实时外部资料源中并行检索并深读最相关内容。何时用：普通资料问答优先使用。何时不用：复杂比较需要自行选择多个候选时改用 source.search 与 source.read。",
        inputSchema: sourceSearchSchema,
        execute: executeSourceLookup,
        normalize: normalizeSourceLookup,
    }),
    defineTool({
        id: "source.search",
        name: "search_sources",
        namespace: "source",
        riskLevel: "low",
        sideEffect: false,
        description: "跨当前选定资料源搜索候选；复杂比较先搜索，再用 read_source 深读真正相关的候选。",
        inputSchema: sourceSearchSchema,
        execute: executeSourceSearch,
        normalize: normalizeSourceSearch,
    }),
    defineTool({
        id: "source.read",
        name: "read_source",
        namespace: "source",
        riskLevel: "low",
        sideEffect: false,
        description: "读取 search_sources 返回的候选；参数必须原样使用候选里的 read 对象。",
        inputSchema: sourceReadSchema,
        execute: executeSourceRead,
        normalize: (output) => (output as SourceReadOutput).normalized,
    }),
]
