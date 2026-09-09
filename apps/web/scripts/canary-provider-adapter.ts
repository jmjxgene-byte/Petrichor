import { createHash } from "node:crypto"
import fs from "node:fs"
import { z } from "zod"
import { inspectCanaryCall, runDurableCanaryBatch } from "./canary-call-journal"
import { planGroundedCanary } from "../src/server/retrieval/grounded-canary-plan"
import { syntheticQaDataset } from "../src/server/retrieval/fixtures/grounded-qa-v1"
import { buildDocumentPassages } from "../src/server/doc-library/passage-builder"

const embedding = z.object({ model: z.literal("BAAI/bge-m3"), input: z.array(z.string().min(1).max(10000)).min(1).max(4), encoding_format: z.literal("float") }).strict()
const rerank = z.object({ model: z.literal("BAAI/bge-reranker-v2-m3"), query: z.string().min(1).max(2000), documents: z.array(z.string().min(1).max(4000)).min(1).max(20), top_n: z.number().int().positive(), return_documents: z.literal(false) }).strict()
export type CanaryRequest = { kind: "document_embedding" | "query_embedding" | "rerank"; body: unknown }
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

export function frozenEmbeddingRequests() {
    const plan = planGroundedCanary()
    if (plan.planHash !== "61faa403c88032f3633e7b9a354101e8bdfe85a312c04dc8bca6d2f1a3f1f89d") throw new Error("canary_plan_changed")
    const requests: CanaryRequest[] = []
    for (const item of plan.documents) {
        const doc = syntheticQaDataset.documents.find(d => d.id === item.id)!
        const passages = buildDocumentPassages(doc.text, doc.title)
        for (let offset = 0; offset < passages.length; offset += 4) requests.push({ kind: "document_embedding", body: {
            model: "BAAI/bge-m3", encoding_format: "float", input: passages.slice(offset, offset + 4).map(p => `${doc.title}\n${p.locator}\n${p.text}`),
        } })
    }
    if (requests.length !== 14) throw new Error("document_request_count")
    const queries: CanaryRequest[] = plan.caseIds.map(id => {
        const c = syntheticQaDataset.cases.find(c => c.id === id)!
        return { kind: "query_embedding", body: { model: "BAAI/bge-m3", encoding_format: "float", input: [[...c.history.map(h => h.content), c.question].join("\n")] } }
    })
    if (queries.length !== 8) throw new Error("query_request_count")
    return { planHash: plan.planHash, requests: [...requests, ...queries] }
}

const vectorRow = z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number().finite()).length(1024) })
const rankRow = z.object({ index: z.number().int().nonnegative(), relevance_score: z.number().finite() })
const usage = z.object({ total_tokens: z.number().int().nonnegative().optional() }).optional()
function normalizeResponse(raw: unknown, request: ReturnType<typeof embedding.parse> | ReturnType<typeof rerank.parse>) {
    if ("input" in request) {
        const parsed = z.object({ model: z.literal("BAAI/bge-m3").optional(), data: z.array(vectorRow), usage }).parse(raw)
        const rows = parsed.data.map(r => ({ index: r.index, embedding: r.embedding.map(Math.fround) }))
        if (rows.length !== request.input.length || new Set(rows.map(r => r.index)).size !== rows.length || rows.some(r => r.index >= rows.length || !r.embedding.some(n => n !== 0) || r.embedding.some(n => !Number.isFinite(Math.fround(n))))) throw new Error("embedding_contract")
        return { data: rows.sort((a, b) => a.index - b.index).map(r => ({ index: r.index, embedding: r.embedding.map(Math.fround) })), usage: { total_tokens: parsed.usage?.total_tokens ?? null } }
    }
    const parsed = z.object({ model: z.literal("BAAI/bge-reranker-v2-m3").optional(), results: z.array(rankRow), usage }).parse(raw)
    const rows = parsed.results
    if (rows.length !== request.documents.length || new Set(rows.map(r => r.index)).size !== rows.length || rows.some((r, i) => r.index >= rows.length || (i > 0 && rows[i - 1].relevance_score < r.relevance_score))) throw new Error("rerank_contract")
    return { results: rows.map(r => ({ index: r.index, relevance_score: r.relevance_score })), usage: { total_tokens: parsed.usage?.total_tokens ?? null } }
}

/** transport必须由调用方明确注入，测试不隐式使用全局fetch；此模块不解析/导出凭证。 */
export async function runPersistedProviderBatch(input: {
    directory: string; executionId: string; planHash: string; providerProfileHash: string; apiKey?: string
    requests: CanaryRequest[]; transport: (url: string, init: RequestInit) => Promise<Response>; signal?: AbortSignal
    afterPersist?: (receipt: { ordinal: number; reused: boolean; bytes: number; sha256: string }) => Promise<void>
}) {
    input.signal?.throwIfAborted()
    const parsed = input.requests.map(request => {
        const body = request.kind === "rerank" ? rerank.parse(request.body) : embedding.parse(request.body)
        if (request.kind === "query_embedding" && "input" in body && body.input.length !== 1) throw new Error("query_batch_size")
        if ("documents" in body && body.top_n !== body.documents.length) throw new Error("rerank_count")
        const texts = "input" in body ? body.input : [body.query, ...body.documents]
        if (texts.some(text => Buffer.byteLength(text) > 4096)) throw new Error("canary_input_limit")
        return { kind: request.kind, body }
    })
    const bodies = parsed.map(r => JSON.stringify(r.body))
    const contract = { version: 1, executionId: input.executionId, planHash: input.planHash, providerProfileHash: input.providerProfileHash,
        calls: parsed.map((r, i) => ({ kind: r.kind, requestHash: sha(bodies[i]) })),
    }
    if (!input.apiKey?.trim() && (!fs.existsSync(input.directory) || bodies.some((_, ordinal) => inspectCanaryCall(input.directory, contract, ordinal) !== "persisted"))) throw new Error("credential_missing")
    return runDurableCanaryBatch({ directory: input.directory, contract, requests: bodies, afterPersist: input.afterPersist, invoke: async (body, ordinal) => {
        input.signal?.throwIfAborted()
        if (!input.apiKey?.trim()) throw new Error("credential_missing")
        const signal = AbortSignal.any([AbortSignal.timeout(20000), ...(input.signal ? [input.signal] : [])])
        const route = parsed[ordinal].kind === "rerank" ? "rerank" : "embeddings"
        const response = await input.transport(`https://api.siliconflow.cn/v1/${route}`, { method: "POST", redirect: "error", signal,
            headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` }, body })
        if (!response.ok) { await response.body?.cancel(); throw new Error("provider_http_failed") }
        const reader = response.body?.getReader()
        if (!reader) throw new Error("provider_empty_body")
        const parts: Uint8Array[] = []; let bytes = 0
        try {
            for (;;) {
                signal.throwIfAborted()
                const next = await reader.read(); if (next.done) break
                bytes += next.value.byteLength
                if (bytes > 262144) throw new Error("provider_response_limit")
                parts.push(next.value)
            }
        } finally { await reader.cancel(); reader.releaseLock() }
        signal.throwIfAborted()
        return Buffer.from(JSON.stringify(normalizeResponse(JSON.parse(Buffer.concat(parts).toString("utf8")), parsed[ordinal].body)))
    } })
}
