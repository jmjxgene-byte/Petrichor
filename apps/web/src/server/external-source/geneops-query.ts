import { z } from "zod"

import { executeGeneOpsRpc, geneOpsRetrievalV2Ready } from "./logic"

export const geneOpsSearchSchema = z.object({
    query: z.string().trim().min(1).max(500),
    source: z.enum(["wearesellers", "wechat_mp"]).optional(),
    mode: z.enum(["exact", "fuzzy"]).default("exact"),
    limit: z.number().int().min(1).max(20).default(10),
})

export const geneOpsReadSchema = z.object({
    documentId: z.string().trim().min(1).max(200),
    anchorReplyId: z.string().trim().min(1).max(200).optional(),
    anchorPosition: z.number().int().min(0).optional(),
    beforeCount: z.number().int().min(0).max(6).default(2),
    afterCount: z.number().int().min(0).max(12).default(5),
    afterPosition: z.number().int().min(-1).default(-1),
    limit: z.number().int().min(1).max(12).default(8),
})

export const geneOpsGraphSearchSchema = z.object({
    query: z.string().trim().min(1).max(300),
    nodeTypes: z.array(z.enum(["topic", "entity", "category", "tag"])).max(4).optional(),
    limit: z.number().int().min(1).max(20).default(10),
})

export const geneOpsGraphExpandSchema = z.object({
    nodeId: z.string().trim().min(1).max(200),
    maxNodes: z.number().int().min(1).max(40).default(30),
    maxEdges: z.number().int().min(1).max(80).default(60),
})

export const geneOpsBacklinksSchema = z.object({
    pageId: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(20).default(10),
})

export type GeneOpsSearchRow = {
    result_key: string
    document_id: string
    reply_id: string | null
    chunk_kind: string
    title: string
    snippet: string
    author: string | null
    source_url: string
    match_type: string
    exact_rank?: number | null
    semantic_rank?: number | null
    lexical_score?: number | null
    semantic_similarity?: number | null
    combined_score?: number | null
    generation_id?: string | null
    source_cutoff_at?: string | null
    snapshot_id?: string | null
    parent_reply_id?: string | null
    anchor_position?: number | null
    published_at?: string | null
    publication_status?: string | null
    source_position?: number | null
    source_position_status?: string | null
    timeline_confidence?: number | null
}

export type GeneOpsReadRow = {
    document_id: string
    chunk_position: number
    chunk_kind: string
    title: string
    content: string
    author: string | null
    source_url: string
    generation_id?: string | null
    snapshot_id?: string | null
    anchor_reply_id?: string | null
    anchor_position?: number | null
    published_at?: string | null
    publication_status?: string | null
    source_position_status?: string | null
    timeline_confidence?: number | null
}

export type GeneOpsAuditActor = {
    userId: number
    sourceId?: number
    threadId?: number
    runId?: number
}

export async function searchGeneOps(actor: GeneOpsAuditActor, raw: unknown) {
    const input = geneOpsSearchSchema.parse(raw)
    return await executeGeneOpsRpc(
        audit(actor, "geneops.search", "search", input),
        async (client, source) => geneOpsRetrievalV2Ready(source)
            ? await client<GeneOpsSearchRow[]>`
                select * from knowledge_vault.search_v2(
                    ${input.query}, ${input.source ?? null}, ${input.mode}, ${input.limit},
                    null::extensions.vector, null::text
                )
            `
            : await client<GeneOpsSearchRow[]>`
                select * from knowledge_vault.search_v1(
                    ${input.query}, ${input.source ?? null}, ${input.mode}, ${input.limit}
                )
            `,
    )
}

export async function readGeneOpsChunks(actor: GeneOpsAuditActor, raw: unknown) {
    const input = geneOpsReadSchema.parse(raw)
    return await executeGeneOpsRpc(
        audit(actor, "geneops.read_chunks", "read", input),
        async (client, source) => geneOpsRetrievalV2Ready(source)
            ? await client<GeneOpsReadRow[]>`
                select * from knowledge_vault.read_chunks_v2(
                    ${input.documentId},
                    ${input.anchorReplyId ?? null},
                    ${input.anchorPosition ?? null},
                    ${input.beforeCount},
                    ${input.afterCount}
                )
            `
            : await client<GeneOpsReadRow[]>`
                select * from knowledge_vault.read_chunks_v1(
                    ${input.documentId}, ${input.afterPosition}, ${input.limit}
                )
            `,
    )
}

export async function searchGeneOpsGraph(actor: GeneOpsAuditActor, raw: unknown) {
    const input = geneOpsGraphSearchSchema.parse(raw)
    return await executeGeneOpsRpc(
        audit(actor, "geneops.graph_search", "graph_search", input, "graph"),
        async (client) => await client<Record<string, unknown>[]>`
            select * from knowledge_vault.graph_search_v1(
                ${input.query}, ${input.nodeTypes ?? null}, ${input.limit}
            )
        `,
    )
}

export async function expandGeneOpsGraph(actor: GeneOpsAuditActor, raw: unknown) {
    const input = geneOpsGraphExpandSchema.parse(raw)
    return await executeGeneOpsRpc(
        audit(actor, "geneops.graph_expand", "graph_expand", input, "graph"),
        async (client) => {
            const [row] = await client<Array<{ result: unknown }>>`
                select knowledge_vault.graph_neighborhood_v1(
                    ${input.nodeId}, ${input.maxNodes}, ${input.maxEdges}
                ) as result
            `
            return row?.result ?? null
        },
    )
}

export async function getGeneOpsBacklinks(actor: GeneOpsAuditActor, raw: unknown) {
    const input = geneOpsBacklinksSchema.parse(raw)
    return await executeGeneOpsRpc(
        audit(actor, "geneops.backlinks", "backlinks", input, "wiki"),
        async (client) => await client<Record<string, unknown>[]>`
            select * from knowledge_vault.backlinks_v1(${input.pageId}, ${input.limit})
        `,
    )
}

function audit(
    actor: GeneOpsAuditActor,
    toolName: string,
    queryType: string,
    parameters: unknown,
    requiredCapability?: "wiki" | "graph",
) {
    return {
        userId: actor.userId,
        ...(actor.sourceId != null ? { sourceId: actor.sourceId } : {}),
        ...(actor.threadId != null ? { threadId: actor.threadId } : {}),
        ...(actor.runId != null ? { runId: actor.runId } : {}),
        toolName,
        queryType,
        parameters,
        ...(requiredCapability ? { requiredCapability } : {}),
    }
}
