import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), generate: vi.fn() }))
vi.mock("ai", () => ({ generateText: mocks.generate }))
vi.mock("@/server/ai/resolution", () => ({ resolveLanguageModel: mocks.resolve, resolveModelForPurpose: vi.fn() }))
vi.mock("@/lib/logger", () => ({ createLogger: () => ({ info: vi.fn(), error: vi.fn() }), toLogError: () => ({}) }))
import { chatModelFingerprint } from "./model-identity"
import { callChatCompletion } from "./generation"
const identity = {
    model: { id: 1, modelId: "synthetic-model", updatedAt: new Date(0) },
    provider: { id: 2, providerKey: "openai-compatible", baseUrl: "https://example.invalid/v1", updatedAt: new Date(0) },
    credential: { id: 3, updatedAt: new Date(0) },
    options: { maxTokens: null, temperature: null, thinking: null, disableThinkingForTools: true },
}
beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolve.mockResolvedValue({ resolved: identity, model: {} })
    mocks.generate.mockResolvedValue({ text: "合成回答", reasoning: [], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, inputTokenDetails: {}, outputTokenDetails: {} } })
})
describe("受控模型身份", () => {
    it("只取元数据，不读取运行时凭据；配置和凭证版本变化使指纹变化", () => {
        const fingerprint = chatModelFingerprint({ ...identity, get runtime() { throw new Error("不应读取密钥") } } as typeof identity)
        expect(fingerprint).toHaveLength(64)
        expect(chatModelFingerprint({ ...identity, credential: { ...identity.credential, updatedAt: new Date(1) } })).not.toBe(fingerprint)
        expect(chatModelFingerprint({ ...identity, provider: { ...identity.provider, baseUrl: "https://other.invalid/v1" } })).not.toBe(fingerprint)
    })
    it("解析器回落到其他模型时在生成之前拒绝", async () => {
        mocks.resolve.mockResolvedValue({ resolved: { ...identity, model: { ...identity.model, id: 99 } }, model: {} })
        await expect(callChatCompletion({ userId: 1, modelRefId: 1, expectedModelFingerprint: chatModelFingerprint(identity), message: "合成" })).rejects.toThrow("模型配置已变化")
        expect(mocks.generate).not.toHaveBeenCalled()
    })
    it("身份匹配可调用，未指定指纹的旧路径仍可调用", async () => {
        await callChatCompletion({ userId: 1, modelRefId: 1, expectedModelFingerprint: chatModelFingerprint(identity), maxOutputTokens: 384, maxRetries: 0, message: "合成" })
        expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 384, maxRetries: 0 }))
        await callChatCompletion({ userId: 1, message: "普通路径" })
        expect(mocks.generate).toHaveBeenCalledTimes(2)
    })
})
