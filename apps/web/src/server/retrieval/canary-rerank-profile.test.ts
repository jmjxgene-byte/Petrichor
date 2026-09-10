import { describe, expect, it } from "vitest"
import { assertCanaryRerankProfile, snapshotRerankProfile } from "../../../scripts/canary-rerank-profile"
const config = { enabled: true, provider: "openai-compatible" as const, model: "BAAI/bge-reranker-v2-m3", topN: 20, baseUrl: "https://api.example.test/v1/", apiKey: "super-secret", timeoutMs: 8000 }
describe("重排配置安全快照", () => {
    it("规范化HTTPS地址并只输出Key存在性", () => {
        const result = snapshotRerankProfile(config)
        expect(result.snapshot).toMatchObject({ enabled: true, model: "BAAI/bge-reranker-v2-m3", baseUrl: "https://api.example.test/v1", endpointProtocol: "https", endpointHost: "api.example.test", apiKeyPresent: true })
        expect(JSON.stringify(result)).not.toContain("super-secret")
        expect(result.profileHash).toMatch(/^[a-f0-9]{64}$/)
    })
    it.each([
        { baseUrl: "http://api.example.test/v1" }, { baseUrl: "https://user:pass@api.example.test/v1" },
        { baseUrl: "https://api.example.test/v1?key=secret" }, { baseUrl: "javascript:alert(1)" }, { timeoutMs: 999 }, { topN: 21 },
    ])("拒绝不安全的profile字段", override => expect(() => snapshotRerankProfile({ ...config, ...override })).toThrow("rerank_profile"))
    it("未启用、模型或Key缺失时不能通过canary门", () => {
        const snapshot = snapshotRerankProfile(config).snapshot
        expect(assertCanaryRerankProfile(snapshot).snapshot.model).toBe(config.model)
        for (const patch of [{ enabled: false }, { model: "other" }, { apiKeyPresent: false }, { endpointProtocol: "none", baseUrl: null }]) {
            expect(() => assertCanaryRerankProfile({ ...snapshot, ...patch })).toThrow("rerank_profile_not_ready")
        }
    })
    it("快照只含允许的元数据键", () => {
        const { snapshot } = snapshotRerankProfile(config)
        expect(Object.keys(snapshot).sort()).toEqual(["apiKeyPresent", "baseUrl", "enabled", "endpointHost", "endpointProtocol", "model", "provider", "timeoutMs", "topN"])
    })
})
