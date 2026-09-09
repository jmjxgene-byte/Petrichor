import { describe, expect, it } from "vitest"
import { assertRuntimeApproval, runtimePreflight } from "../../../scripts/canary-runtime-entry"
import { canonicalCanaryRequests, frozenEmbeddingRequests } from "../../../scripts/canary-provider-adapter"

const owner = "00000000-0000-4000-8000-000000000001", codeSha = "a".repeat(64)
function approval() {
    const p = runtimePreflight()
    return { version: 1, executionId: owner, codeSha, planHash: p.planHash, requestSetHash: p.requestSetHash,
        providerProfileHash: "b".repeat(64), userId: 1, phase: "embed", maxCalls: 22, expiresAt: "2030-01-01T00:00:00.000Z" }
}
describe("runtime单项入口离线契约", () => {
    it("预检只构造固定合成请求", () => {
        expect(runtimePreflight()).toMatchObject({ modelCalls: 0, databaseCalls: 0, calls: 22, needsNewApproval: true })
        const requests = frozenEmbeddingRequests().requests
        expect(canonicalCanaryRequests(requests)).toEqual(canonicalCanaryRequests(canonicalCanaryRequests(requests)))
    })
    it("新执行需要精确授权，过期仅允许恢复", () => {
        const a = approval()
        expect(assertRuntimeApproval(a, owner, codeSha, 0)).toEqual(a)
        expect(() => assertRuntimeApproval(a, owner, codeSha, Date.parse(a.expiresAt))).toThrow("expired")
        expect(assertRuntimeApproval(a, owner, codeSha, Date.parse(a.expiresAt), false)).toEqual(a)
    })
    it.each(["executionId", "codeSha", "planHash", "requestSetHash", "maxCalls", "phase"])("拒绝漂移字段%s", field => {
        expect(() => assertRuntimeApproval({ ...approval(), [field]: "invalid" }, owner, codeSha, 0)).toThrow()
    })
})
