import { describe, expect, it, vi } from "vitest"
import type postgres from "postgres"
import { withCanaryCredential } from "../../../scripts/canary-credential-bridge"
function fixture(overrides: Record<string, unknown> = {}, gate = { role: "petrichor_runtime", ro: "on" }) {
    const events: string[] = []
    const tx = vi.fn(async (parts: TemplateStringsArray, ...params: unknown[]) => {
        const sql = parts.join("?")
        if (sql.includes("set_config")) return []
        if (sql.includes("current_user")) return [gate]
        expect(params).toEqual([1])
        return [{ binding_user: "1", model_user: "1", provider_user: "1", credential_user: "1", model_ref: 9,
            model_id: "BAAI/bge-m3", dimensions: 1024, model_enabled: true, provider_enabled: true,
            provider_id: 1, provider_key: "siliconflow", base_url: null, headers_json: "{}", credential_id: 2,
            api_key_enc: "synthetic-cipher", model_revision: "v1", provider_revision: "v1", credential_revision: "v1", ...overrides }]
    })
    const begin = vi.fn(async (options: string, run: (tx: unknown) => Promise<unknown>) => {
        expect(options).toBe("read only isolation level repeatable read")
        const value = await run(tx); events.push("transaction-ended"); return value
    })
    const decrypt = vi.fn(() => { events.push("decrypt"); return "synthetic-secret" })
    const use = vi.fn(async (value: { apiKey: string; providerProfileHash: string }) => {
        events.push("use"); expect(value.apiKey).toBe("synthetic-secret"); return { hash: value.providerProfileHash }
    })
    return { client: { begin } as unknown as postgres.Sql, userId: 1, decrypt, use, events }
}
describe("canary只读凭证桥接", () => {
    it("结束只读事务后才解密使用，返回结果不包含凭证", async () => {
        const f = fixture(), result = await withCanaryCredential(f)
        expect(f.events).toEqual(["transaction-ended", "decrypt", "use"])
        expect(result.hash).toMatch(/^[a-f0-9]{64}$/)
        expect(JSON.stringify(result)).not.toContain("synthetic-secret")
    })
    it.each([{ provider_user: "2" }, { dimensions: 512 }, { model_enabled: false }, { base_url: "https://other.invalid" }, { headers_json: '{"Authorization":"extra"}' }])("档案失配在解密前拒绝", async override => {
        const f = fixture(override)
        await expect(withCanaryCredential(f)).rejects.toThrow("credential_bridge_failed")
        expect(f.decrypt).not.toHaveBeenCalled(); expect(f.use).not.toHaveBeenCalled()
    })
    it("非runtime或非只读角色不读取凭证", async () => {
        const f = fixture({}, { role: "postgres", ro: "off" })
        await expect(withCanaryCredential(f)).rejects.toThrow("credential_bridge_failed")
        expect(f.decrypt).not.toHaveBeenCalled()
    })
    it("调用方错误不暴露凭证", async () => {
        const f = fixture(); f.use.mockRejectedValue(new Error("synthetic-secret"))
        await expect(withCanaryCredential(f)).rejects.toThrow("canary_execution_failed")
    })
    it("冻结档案发生变化时在解密前拒绝", async () => {
        const original = await withCanaryCredential(fixture())
        const f = fixture({ provider_revision: "v2" })
        await expect(withCanaryCredential({ ...f, expectedProviderProfileHash: original.hash })).rejects.toThrow("credential_bridge_failed")
        expect(f.decrypt).not.toHaveBeenCalled(); expect(f.use).not.toHaveBeenCalled()
    })
})
