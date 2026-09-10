import { describe, expect, it } from "vitest"
import { assertRerankRuntimeApproval, rerankRuntimePreflight } from "../../../scripts/canary-rerank-runtime-entry"
const owner = "00000000-0000-4000-8000-000000000002", codeSha = "a".repeat(64), requestSetHash = "b".repeat(64)
const approval = () => ({ version: 1, executionId: owner, planHash: "61faa403c88032f3633e7b9a354101e8bdfe85a312c04dc8bca6d2f1a3f1f89d", codeSha,
    providerProfileHash: "c".repeat(64), requestSetHash, userId: "Gene" as const, phase: "rerank" as const, maxCalls: 8 as const, expiresAt: "2030-01-01T00:00:00.000Z" })
describe("重排运行时入口", () => {
    it("预检无模型/数据库调用并固定8项", () => expect(rerankRuntimePreflight()).toMatchObject({ phase: "rerank", calls: 8, modelCalls: 0, databaseCalls: 0, needsNewApproval: true }))
    it("精确绑定计划、代码、请求集和具名用户，过期仅可恢复", () => {
        expect(assertRerankRuntimeApproval(approval(), owner, codeSha, requestSetHash, 0).userId).toBe("Gene")
        expect(() => assertRerankRuntimeApproval(approval(), owner, codeSha, requestSetHash, Date.parse("2030-01-01T00:00:00.000Z"))).toThrow("expired")
        expect(assertRerankRuntimeApproval(approval(), owner, codeSha, requestSetHash, Date.parse("2030-01-01T00:00:00.000Z"), false).phase).toBe("rerank")
        for (const [field, value] of [["codeSha", "d".repeat(64)], ["requestSetHash", "e".repeat(64)], ["phase", "embed"]] as const) {
            expect(() => assertRerankRuntimeApproval({ ...approval(), [field]: value }, owner, codeSha, requestSetHash, 0)).toThrow()
        }
    })
})
