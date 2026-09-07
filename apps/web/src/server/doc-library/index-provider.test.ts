import { describe, expect, it, vi } from "vitest"
import { MockEmbeddingModelV3 } from "ai/test"
import { APICallError } from "ai"
const mocks = vi.hoisted(() => ({ resolveEmbeddingModel: vi.fn() }))
vi.mock("@/server/ai/resolution", () => mocks)
import { quoteIndexInputs, resolveDocumentIndexProvider, parseIndexProviderPolicies, type IndexProviderPolicy } from "./index-provider"
import { hashDocumentText } from "./passage-builder"
const date = new Date(0)
const profileKey = hashDocumentText(JSON.stringify({ modelRefId: 1, model: "synthetic", dimensions: 2, providerId: 1,
    baseUrl: "https://example.invalid", providerRevision: date.toISOString(), modelRevision: date.toISOString() }))
const policy: IndexProviderPolicy = { profileKey, maxInputTokens: 1000, tokenOverheadPerInput: 2,
    credentialFingerprint: hashDocumentText(JSON.stringify({ id: 1, updatedAt: date.toISOString() })),
    priceMicrousdPerMillionTokens: 1_000_000, maxRequestFeeMicrousd: 10, pricingEvidence: "fixture-only", expiresAt: "2099-01-01T00:00:00Z", batchSize: 2 }
function resolveWith(model: MockEmbeddingModelV3) {
    mocks.resolveEmbeddingModel.mockResolvedValue({ model, resolved: {
        model: { id: 1, modelId: "synthetic", dimensions: 2, updatedAt: date }, provider: { id: 1, updatedAt: date }, credential: { id: 1, updatedAt: date }, runtime: { baseUrl: "https://example.invalid" },
    } })
}
describe("provider预算与SDK边界", () => {
    it("凭证轮换后不能沿用旧价格核验", async () => {
        resolveWith(new MockEmbeddingModelV3())
        await expect(resolveDocumentIndexProvider(1, { ...policy, credentialFingerprint: "f".repeat(64) })).rejects.toThrow("凭证")
    })
    it("多模型policy不得有相同档案的歧义价格", () => {
        expect(parseIndexProviderPolicies(policy)).toEqual([policy])
        expect(() => parseIndexProviderPolicies([policy, policy])).toThrow("重复")
    })
    it("保守覆盖逐输入请求费用与特殊token，不接受过期/超限", () => {
        expect(quoteIndexInputs(["x", "yy"], policy)).toEqual({ inputTokens: 7, costMicrousd: 27 })
        expect(() => quoteIndexInputs(["中文"], { ...policy, maxInputTokens: 4 })).toThrow("上界")
        expect(() => quoteIndexInputs(["x"], { ...policy, expiresAt: date.toISOString() })).toThrow("过期")
    })
    it("使用实际SDK与假模型返回向量，不执行真实网络调用", async () => {
        const model = new MockEmbeddingModelV3({ maxEmbeddingsPerCall: 2, doEmbed: async ({ values }) => ({ embeddings: values.map(() => [1, 0]), usage: { tokens: values.length }, warnings: [] }) })
        resolveWith(model)
        const provider = await resolveDocumentIndexProvider(1, policy)
        expect(await provider.embed(["a", "b", "c"], new AbortController().signal)).toHaveLength(3)
        expect(model.doEmbedCalls).toHaveLength(2)
    })
    it("503也不自动重试", async () => {
        const model = new MockEmbeddingModelV3({ doEmbed: async () => { throw new APICallError({ message: "synthetic", url: "https://example.invalid", requestBodyValues: {}, statusCode: 503, isRetryable: true }) } })
        resolveWith(model)
        const provider = await resolveDocumentIndexProvider(1, policy)
        await expect(provider.embed(["a"], new AbortController().signal)).rejects.toThrow()
        expect(model.doEmbedCalls).toHaveLength(1)
    })
    it("用量缺失不把向量返回当成功验收", async () => {
        const model = new MockEmbeddingModelV3({ doEmbed: async () => ({ embeddings: [[1, 0]], warnings: [] }) })
        resolveWith(model)
        const provider = await resolveDocumentIndexProvider(1, policy)
        await expect(provider.embed(["a"], new AbortController().signal)).rejects.toThrow("用量无法核验")
    })
})
