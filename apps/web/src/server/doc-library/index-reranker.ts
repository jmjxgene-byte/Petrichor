import { and, eq } from "drizzle-orm"
import { withReadBudget, type ReadBudget } from "@/server/db/read-budget"
import { aiBindings, aiCredentials, aiModels, aiProviders } from "@/server/db/schema"
import { LocalLexicalReranker, OpenAiCompatibleReranker, type RerankCandidate } from "@/server/retrieval/reranker"

/** 仅已核验的硅基流动路径；复用当前用户凭证，不复制到env或浏览器。 */
export async function rerankIndexedCandidates<T extends RerankCandidate>(input: ReadBudget & { userId: number; query: string; candidates: T[] }) {
    const local = () => new LocalLexicalReranker().rerank(input.query, input.candidates)
    input.abortSignal?.throwIfAborted()
    if (process.env.PETRICHOR_DOC_RERANK_ENABLED !== "true" || input.candidates.length < 2) return { items: await local(), degraded: [] as string[] }
    const deadline = Math.min(input.queryDeadlineAt ?? Infinity, Date.now() + 1500)
    if (deadline - Date.now() < 250) return { items: await local(), degraded: ["rerank_budget_exhausted"] }
    const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, deadline - Date.now())), ...(input.abortSignal ? [input.abortSignal] : [])])
    try {
        if (input.candidates.length > 20 || input.query.length > 2000 || process.env.PETRICHOR_DOC_RERANK_MODEL !== "BAAI/bge-reranker-v2-m3") throw new Error("rerank_config_invalid")
        const [row] = await withReadBudget((reader) => reader.select({
            baseUrl: aiProviders.baseUrl, headers: aiProviders.headersJson, encryptedKey: aiCredentials.apiKeyEnc,
        }).from(aiBindings)
            .innerJoin(aiModels, eq(aiModels.id, aiBindings.modelRefId))
            .innerJoin(aiProviders, eq(aiProviders.id, aiModels.providerId))
            .innerJoin(aiCredentials, eq(aiCredentials.id, aiProviders.credentialId))
            .where(and(eq(aiBindings.userId, input.userId), eq(aiBindings.purpose, "EMBEDDING"),
                eq(aiModels.userId, input.userId), eq(aiModels.enabled, true), eq(aiModels.kind, "EMBEDDING"),
                eq(aiProviders.userId, input.userId), eq(aiProviders.enabled, true), eq(aiProviders.providerKey, "siliconflow"),
                eq(aiCredentials.userId, input.userId))).limit(1), { abortSignal: signal, queryDeadlineAt: deadline })
        if (!row || (row.baseUrl && row.baseUrl.replace(/\/$/, "") !== "https://api.siliconflow.cn/v1")
            || Object.keys(JSON.parse(row.headers || "{}")).length) throw new Error("rerank_provider_invalid")
        const { decodeApiKey } = await import("@/server/ai/config-logic")
        const apiKey = decodeApiKey(row.encryptedKey)
        if (!apiKey) throw new Error("rerank_credential_missing")
        signal.throwIfAborted()
        const reranker = new OpenAiCompatibleReranker({ enabled: true, provider: "openai-compatible",
            model: "BAAI/bge-reranker-v2-m3", baseUrl: "https://api.siliconflow.cn/v1", apiKey,
            topN: input.candidates.length, timeoutMs: Math.max(1, deadline - Date.now()) })
        const items = await reranker.rerank(input.query, input.candidates, { signal })
        input.abortSignal?.throwIfAborted()
        return { items, degraded: [] as string[] }
    } catch {
        // 只记录固定降级码；不持久化查询、正文、provider响应或包含Key的异常。
        input.abortSignal?.throwIfAborted()
        return { items: await local(), degraded: ["rerank_unavailable"] }
    }
}
