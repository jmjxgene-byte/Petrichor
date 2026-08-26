import {
    expandGeneOpsGraph,
    geneOpsBacklinksSchema,
    geneOpsGraphExpandSchema,
    geneOpsGraphSearchSchema,
    geneOpsReadSchema,
    geneOpsSearchSchema,
    getGeneOpsBacklinks,
    readGeneOpsChunks,
    searchGeneOps,
    searchGeneOpsGraph,
    type GeneOpsReadRow as ReadRow,
    type GeneOpsSearchRow as SearchRow,
} from "@/server/external-source/geneops-query"
import { resolveAssistantSources } from "@/server/assistant/source-catalog"
import type { AssistantFocus } from "@/server/assistant/domain-types"
import { badRequest } from "@/server/http/response"
import { defineTool } from "./adapter"
import type { AgentToolDefinition, ToolExecutionContext, ToolNormalizerResult } from "../types"

export const geneOpsTools: AgentToolDefinition[] = [
    defineTool({
        id: "geneops.search",
        name: "geneops_search",
        namespace: "geneops",
        riskLevel: "medium",
        sideEffect: false,
        allowedInSubAgent: true,
        timeoutMs: 12_000,
        maxRetries: 0,
        description: "实时搜索 GeneOps 已授权的 WeAreSellers / 微信公众号知识内容，返回候选，不访问受限内容。",
        inputSchema: geneOpsSearchSchema,
        execute: async (ctx, raw) => {
            const source = await requireGeneOpsInScope(ctx)
            return await searchGeneOps(actorContext(ctx, source.id), raw)
        },
        normalize: (output): ToolNormalizerResult => {
            const rows = Array.isArray(output) ? output as SearchRow[] : []
            return {
                progress: rows.length > 0,
                summary: rows.length > 0 ? `GeneOps 实时检索找到 ${rows.length} 个候选` : "GeneOps 实时检索没有命中",
                data: {
                    results: rows.map((row) => ({
                        resultKey: row.result_key,
                        documentId: row.document_id,
                        replyId: row.reply_id,
                        kind: row.chunk_kind,
                        title: row.title,
                        snippet: row.snippet,
                        author: row.author,
                        url: row.source_url,
                        matchType: row.match_type,
                    })),
                },
                suggestedActions: rows.length > 0 ? ["geneops.read_chunks"] : ["rewrite_query"],
            }
        },
    }),
    defineTool({
        id: "geneops.read_chunks",
        name: "geneops_read_chunks",
        namespace: "geneops",
        riskLevel: "medium",
        sideEffect: false,
        allowedInSubAgent: true,
        timeoutMs: 12_000,
        maxRetries: 0,
        description: "按游标深读一个 GeneOps 文档的安全检索分片，返回正文证据。",
        inputSchema: geneOpsReadSchema,
        execute: async (ctx, raw) => {
            const source = await requireGeneOpsInScope(ctx)
            return await readGeneOpsChunks(actorContext(ctx, source.id), raw)
        },
        normalize: (output): ToolNormalizerResult => {
            const rows = Array.isArray(output) ? output as ReadRow[] : []
            return {
                progress: rows.length > 0,
                summary: rows.length > 0 ? `已深读 GeneOps 文档的 ${rows.length} 个分片` : "该 GeneOps 文档没有可读取分片",
                evidence: rows.map((row) => ({
                    source: "geneops",
                    title: row.title,
                    content: row.content,
                    sourceId: `${row.document_id}:${row.chunk_position}`,
                    url: row.source_url,
                    confidence: 0.9,
                    metadata: {
                        ephemeral: true,
                        documentId: row.document_id,
                        chunkPosition: row.chunk_position,
                        chunkKind: row.chunk_kind,
                        author: row.author,
                        queriedAt: new Date().toISOString(),
                    },
                })),
                suggestedActions: rows.length > 0 ? ["answer_with_evidence"] : ["geneops.search"],
            }
        },
    }),
    defineTool({
        id: "geneops.graph_search",
        name: "geneops_graph_search",
        namespace: "geneops",
        riskLevel: "medium",
        sideEffect: false,
        allowedInSubAgent: true,
        timeoutMs: 10_000,
        maxRetries: 0,
        description: "实时搜索 GeneOps 知识图谱节点。",
        inputSchema: geneOpsGraphSearchSchema,
        execute: async (ctx, raw) => {
            const source = await requireGeneOpsInScope(ctx)
            return await searchGeneOpsGraph(actorContext(ctx, source.id), raw)
        },
        normalize: (output): ToolNormalizerResult => {
            const rows = Array.isArray(output) ? output : []
            return { progress: rows.length > 0, summary: `GeneOps 图谱找到 ${rows.length} 个节点`, data: { nodes: rows } }
        },
    }),
    defineTool({
        id: "geneops.graph_expand",
        name: "geneops_graph_expand",
        namespace: "geneops",
        riskLevel: "medium",
        sideEffect: false,
        allowedInSubAgent: true,
        timeoutMs: 10_000,
        maxRetries: 0,
        description: "展开 GeneOps 图谱节点的安全邻域。",
        inputSchema: geneOpsGraphExpandSchema,
        execute: async (ctx, raw) => {
            const source = await requireGeneOpsInScope(ctx)
            return await expandGeneOpsGraph(actorContext(ctx, source.id), raw)
        },
        normalize: (output): ToolNormalizerResult => ({
            progress: output != null,
            summary: output == null ? "GeneOps 图谱没有返回邻域" : "已读取 GeneOps 图谱邻域",
            data: output,
        }),
    }),
    defineTool({
        id: "geneops.backlinks",
        name: "geneops_backlinks",
        namespace: "geneops",
        riskLevel: "medium",
        sideEffect: false,
        allowedInSubAgent: true,
        timeoutMs: 10_000,
        maxRetries: 0,
        description: "读取 GeneOps Wiki 页面反向关联。",
        inputSchema: geneOpsBacklinksSchema,
        execute: async (ctx, raw) => {
            const source = await requireGeneOpsInScope(ctx)
            return await getGeneOpsBacklinks(actorContext(ctx, source.id), raw)
        },
        normalize: (output): ToolNormalizerResult => {
            const rows = Array.isArray(output) ? output : []
            return { progress: rows.length > 0, summary: `GeneOps 找到 ${rows.length} 条反向关联`, data: { backlinks: rows } }
        },
    }),
]

async function requireGeneOpsInScope(ctx: ToolExecutionContext) {
    const resolved = await resolveAssistantSources(
        ctx.userId,
        (ctx.focus ?? null) as AssistantFocus | null,
    )
    const source = resolved.selected.find((item) => item.kind === "external-source")
    if (!source) {
        throw badRequest("当前提问范围不包含 GeneOps 实时资料源")
    }
    return source
}

function actorContext(ctx: ToolExecutionContext, sourceId: string) {
    return {
        userId: ctx.userId,
        sourceId: Number(sourceId),
        ...(ctx.threadId != null ? { threadId: ctx.threadId } : {}),
        ...(ctx.dbRunId != null ? { runId: ctx.dbRunId } : {}),
    }
}
