import { embedMany } from "ai"
import { z } from "zod"
import { resolveEmbeddingModel } from "@/server/ai/resolution"
import { indexEmbeddingProfileSchema } from "./index-contract"
import { hashDocumentText } from "./passage-builder"

/** 由运营核验后配置，不从浏览器请求直接信任价格或provider能力。 */
export const indexProviderPolicySchema = z.object({
    profileKey: z.string().min(1).max(500),
    maxInputTokens: z.number().int().min(1).max(100_000),
    tokenOverheadPerInput: z.number().int().min(0).max(1000),
    priceMicrousdPerMillionTokens: z.number().int().nonnegative(),
    maxRequestFeeMicrousd: z.number().int().nonnegative(),
    pricingEvidence: z.string().min(1).max(1000), expiresAt: z.string().datetime(),
    batchSize: z.number().int().min(1).max(32),
}).strict()
export type IndexProviderPolicy = z.infer<typeof indexProviderPolicySchema>

export function quoteIndexInputs(values: string[], policy: IndexProviderPolicy, now = Date.now()) {
    policy = indexProviderPolicySchema.parse(policy)
    if (Date.parse(policy.expiresAt) <= now) throw new Error("provider价格/能力核验已过期")
    if (!values.length || values.length > 40_000) throw new Error("embedding输入数量无效")
    // 仅用于已核验的byte-token上界，包含provider特殊token余量，不能冒充精确token计数。
    const bounds = values.map((value) => Buffer.byteLength(value, "utf8") + policy.tokenOverheadPerInput)
    if (bounds.some((value) => value > policy.maxInputTokens)) throw new Error("分片超过provider输入上界")
    const inputTokens = bounds.reduce((sum, value) => sum + value, 0)
    // 按每输入可能单独成为一次请求保守计费，覆盖SDK内部进一步拆批和逐请求向上取整。
    const cost = bounds.reduce((sum, value) => sum + (BigInt(value) * BigInt(policy.priceMicrousdPerMillionTokens) + 999_999n) / 1_000_000n + BigInt(policy.maxRequestFeeMicrousd), 0n)
    const costMicrousd = Number(cost)
    if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(costMicrousd)) throw new Error("预算上界溢出")
    return { inputTokens, costMicrousd }
}

export async function resolveDocumentIndexProvider(userId: number, rawPolicy: unknown) {
    const policy = indexProviderPolicySchema.parse(rawPolicy)
    const { model, resolved } = await resolveEmbeddingModel(userId)
    const profile = indexEmbeddingProfileSchema.parse({
        modelRefId: resolved.model.id, model: resolved.model.modelId, dimensions: resolved.model.dimensions, version: 1,
        key: hashDocumentText(JSON.stringify({ modelRefId: resolved.model.id, model: resolved.model.modelId,
            dimensions: resolved.model.dimensions, providerId: resolved.provider.id, baseUrl: resolved.runtime.baseUrl,
            providerRevision: resolved.provider.updatedAt.toISOString(), modelRevision: resolved.model.updatedAt.toISOString(),
        })),
    })
    if (policy.profileKey !== profile.key) throw new Error("provider核验档案不匹配")
    return {
        profile,
        quote: (values: string[]) => quoteIndexInputs(values, policy),
        embed: async (values: string[], signal: AbortSignal) => {
            const embeddings: number[][] = []
            for (let offset = 0; offset < values.length; offset += policy.batchSize) {
                signal.throwIfAborted()
                const batch = values.slice(offset, offset + policy.batchSize)
                const bound = quoteIndexInputs(batch, policy)
                const result = await embedMany({ model, values: batch, abortSignal: signal, maxRetries: 0, maxParallelCalls: 1 })
                if (!Number.isSafeInteger(result.usage.tokens) || result.usage.tokens < 0 || result.usage.tokens > bound.inputTokens) throw new Error("provider用量无法核验")
                if (result.embeddings.length !== batch.length) throw new Error("provider向量数量不匹配")
                embeddings.push(...result.embeddings)
            }
            return embeddings
        },
    }
}
