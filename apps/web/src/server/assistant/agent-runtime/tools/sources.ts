import { z } from "zod"
import { and, eq } from "drizzle-orm"

import { assistantSourceRefSchema, type AssistantSourceCatalogItem } from "@/lib/assistant-source-contract"
import type { AssistantFocus } from "@/server/assistant/domain-types"
import { searchDocuments, readDocument } from "@/server/assistant/tools/doc-library"
import { resolveAssistantSources } from "@/server/assistant/source-catalog"
import { getDb } from "@/server/db/client"
import { docDocuments } from "@/server/db/schema"
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
    ctx: ToolExecutionContext,
    source: AssistantSourceCatalogItem,
    query: string,
): Promise<SourceCandidate[]> {
    const rows = await searchDocuments(toAssistantContext(focusForSource(ctx, source)), {
        query,
        libraryId: Number(source.id),
        limit: 8,
    }) as Array<Record<string, unknown>>
    return rankFeed(rows.map((row) => {
        const documentId = String(row.documentId)
        return {
            candidateKey: `document:${documentId}`,
            sourceRef: source.ref,
            sourceKind: source.kind,
            sourceName: source.name,
            title: stringValue(row.title) ?? stringValue(row.fileName) ?? "未命名文档",
            snippet: clip(stringValue(row.snippet) ?? "", 600),
            url: stringValue(row.href),
            read: { kind: "document", sourceRef: source.ref, documentId: Number(documentId) },
        }
    }), 0.8)
}

async function searchDocumentsAcross(
    ctx: ToolExecutionContext,
    sources: AssistantSourceCatalogItem[],
    query: string,
): Promise<SourceCandidate[]> {
    const rows = await searchDocuments(toAssistantContext({ ...ctx, focus: {} }), {
        query,
        libraryId: null,
        limit: 12,
    }) as Array<Record<string, unknown>>
    const byId = new Map(sources.map((source) => [source.id, source]))
    return rankFeed(rows.flatMap((row): Array<Omit<SourceCandidate, "score">> => {
        const source = byId.get(String(row.libraryId))
        if (!source) return []
        const documentId = String(row.documentId)
        return [{
            candidateKey: `document:${documentId}`,
            sourceRef: source.ref,
            sourceKind: source.kind,
            sourceName: source.name,
            title: stringValue(row.title) ?? stringValue(row.fileName) ?? "未命名文档",
            snippet: clip(stringValue(row.snippet) ?? "", 600),
            url: stringValue(row.href),
            read: { kind: "document", sourceRef: source.ref, documentId: Number(documentId) },
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
        for (const source of documentSources) {
            tasks.push({ source, run: async () => await searchDocumentLibrary(ctx, source, input.query) })
        }
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
                run: async () => await searchDocumentsAcross(ctx, documentSources, input.query),
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
    const [ownedDocument] = await getDb().select({ id: docDocuments.id })
        .from(docDocuments)
        .where(and(
            eq(docDocuments.id, documentId),
            eq(docDocuments.userId, ctx.userId),
            eq(docDocuments.libraryId, Number(source.id)),
        ))
        .limit(1)
    if (!ownedDocument) throw badRequest("文档候选不属于当前选定的文档库")

    const output = await readDocument(toAssistantContext(focusForSource(ctx, source)), {
        documentId,
        fromIndex: 0,
        limit: 12,
    }) as {
        documentId: string
        href: string
        title: string
        fileName: string
        chunks: Array<{ locator: string | null; text: string }>
    }
    const content = output.chunks.map((chunk) =>
        `${chunk.locator ? `[${chunk.locator}]\n` : ""}${chunk.text}`).join("\n\n")
    return {
        normalized: {
            progress: content.length > 0,
            summary: content.length > 0 ? `已读取文档「${output.title}」` : "文档没有可读内容",
            evidence: content.length > 0 ? [{
                source: "document",
                title: output.title || output.fileName,
                content: clip(content, 8_000),
                sourceId: output.documentId,
                url: output.href,
                confidence: 0.8,
                metadata: { sourceRef: source.ref, sourceName: source.name },
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
    const readLimit = ctx.state.complexity === "simple" ? 2 : 3
    const reads = await Promise.allSettled(
        search.candidates.slice(0, readLimit).map((candidate) => executeSourceRead(ctx, candidate.read)),
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
            ? `跨资料源找到 ${value.search.candidates.length} 个候选并深读 ${readCount} 个${degraded.length ? `；${degraded.length} 个来源降级` : ""}`
            : `跨资料源没有读到可引用正文${degraded.length ? `；${degraded.length} 个来源降级` : ""}`,
        data: {
            candidateCount: value.search.candidates.length,
            readCount,
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
        id: "source.lookup",
        name: "lookup_sources",
        namespace: "source",
        core: true,
        riskLevel: "low",
        sideEffect: false,
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
