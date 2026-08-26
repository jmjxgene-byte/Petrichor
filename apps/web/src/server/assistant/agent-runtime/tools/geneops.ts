import { z } from "zod"
import { executeGeneOpsRpc } from "@/server/external-source/logic"
import { defineTool } from "./adapter"
import type { AgentToolDefinition, ToolExecutionContext, ToolNormalizerResult } from "../types"

const searchSchema = z.object({
    query: z.string().trim().min(1).max(500),
    source: z.enum(["wearesellers", "wechat_mp"]).optional(),
    mode: z.enum(["exact", "fuzzy"]).default("exact"),
    limit: z.number().int().min(1).max(20).default(10),
})

const readSchema = z.object({
    documentId: z.string().trim().min(1).max(200),
    afterPosition: z.number().int().min(-1).default(-1),
    limit: z.number().int().min(1).max(12).default(8),
})

const graphSearchSchema = z.object({
    query: z.string().trim().min(1).max(300),
    nodeTypes: z.array(z.enum(["topic", "entity", "category", "tag"])).max(4).optional(),
    limit: z.number().int().min(1).max(20).default(10),
})

const graphExpandSchema = z.object({
    nodeId: z.string().trim().min(1).max(200),
    maxNodes: z.number().int().min(1).max(40).default(30),
    maxEdges: z.number().int().min(1).max(80).default(60),
})

const backlinksSchema = z.object({
    pageId: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(20).default(10),
})

type SearchRow = {
    result_key: string
    document_id: string
    reply_id: string | null
    chunk_kind: string
    title: string
    snippet: string
    author: string | null
    source_url: string
    match_type: string
}

type ReadRow = {
    document_id: string
    chunk_position: number
    chunk_kind: string
    title: string
    content: string
    author: string | null
    source_url: string
}

function auditContext(ctx: ToolExecutionContext, toolName: string, queryType: string, parameters: unknown) {
    return {
        userId: ctx.userId,
        threadId: ctx.threadId,
        runId: ctx.dbRunId,
        toolName,
        queryType,
        parameters,
    }
}

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
        inputSchema: searchSchema,
        execute: async (ctx, raw) => {
            const input = searchSchema.parse(raw)
            return await executeGeneOpsRpc(
                auditContext(ctx, "geneops.search", "search", input),
                async (client) => await client<SearchRow[]>`
                    select * from knowledge_vault.search_v1(
                        ${input.query}, ${input.source ?? null}, ${input.mode}, ${input.limit}
                    )
                `,
            )
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
        inputSchema: readSchema,
        execute: async (ctx, raw) => {
            const input = readSchema.parse(raw)
            return await executeGeneOpsRpc(
                auditContext(ctx, "geneops.read_chunks", "read", input),
                async (client) => await client<ReadRow[]>`
                    select * from knowledge_vault.read_chunks_v1(
                        ${input.documentId}, ${input.afterPosition}, ${input.limit}
                    )
                `,
            )
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
        inputSchema: graphSearchSchema,
        execute: async (ctx, raw) => {
            const input = graphSearchSchema.parse(raw)
            return await executeGeneOpsRpc(
                auditContext(ctx, "geneops.graph_search", "graph_search", input),
                async (client) => await client<Record<string, unknown>[]>`
                    select * from knowledge_vault.graph_search_v1(
                        ${input.query}, ${input.nodeTypes ?? null}, ${input.limit}
                    )
                `,
            )
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
        inputSchema: graphExpandSchema,
        execute: async (ctx, raw) => {
            const input = graphExpandSchema.parse(raw)
            return await executeGeneOpsRpc(
                auditContext(ctx, "geneops.graph_expand", "graph_expand", input),
                async (client) => {
                    const [row] = await client<Array<{ result: unknown }>>`
                        select knowledge_vault.graph_neighborhood_v1(
                            ${input.nodeId}, ${input.maxNodes}, ${input.maxEdges}
                        ) as result
                    `
                    return row?.result ?? null
                },
            )
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
        inputSchema: backlinksSchema,
        execute: async (ctx, raw) => {
            const input = backlinksSchema.parse(raw)
            return await executeGeneOpsRpc(
                auditContext(ctx, "geneops.backlinks", "backlinks", input),
                async (client) => await client<Record<string, unknown>[]>`
                    select * from knowledge_vault.backlinks_v1(${input.pageId}, ${input.limit})
                `,
            )
        },
        normalize: (output): ToolNormalizerResult => {
            const rows = Array.isArray(output) ? output : []
            return { progress: rows.length > 0, summary: `GeneOps 找到 ${rows.length} 条反向关联`, data: { backlinks: rows } }
        },
    }),
]
