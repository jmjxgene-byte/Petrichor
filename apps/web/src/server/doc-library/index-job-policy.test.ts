import { describe, expect, it } from "vitest"
import { checkIndexReservation, expiredIndexJobState, hasLiveIndexLease } from "./index-job-policy"
const base = { status: "running", attemptCount: 1, consumedInputTokens: 0, consumedCostMicrousd: 0 }
describe("索引租约与保守预算", () => {
    it("调用前租约过期可重新排队，占用后结果未知必须失败", () => {
        expect(expiredIndexJobState(base).status).toBe("queued")
        expect(expiredIndexJobState({ ...base, consumedInputTokens: 10 })).toEqual({ status: "failed", errorCode: "model_outcome_unknown" })
        expect(expiredIndexJobState({ ...base, attemptCount: 3 }).status).toBe("failed")
        expect(expiredIndexJobState({ ...base, status: "cancel_requested" }).status).toBe("cancelled")
    })
    it("旧worker、过期lease、取消任务不可继续写入", () => {
        const lease = { status: "running", leaseOwner: "worker", leaseExpiresAt: new Date(100) }
        expect(hasLiveIndexLease(lease, "worker", new Date(99))).toBe(true)
        expect(hasLiveIndexLease(lease, "other", new Date(99))).toBe(false)
        expect(hasLiveIndexLease(lease, "worker", new Date(100))).toBe(false)
        expect(hasLiveIndexLease({ ...lease, status: "cancel_requested" }, "worker", new Date(99))).toBe(false)
    })
    it("使用generation累计值而非每job重新授额", () => {
        const approval = { approvalId: "fixture", manifestHash: "a".repeat(64), maxInputTokens: 100, maxCostMicrousd: 100, expiresAt: "2099-01-01T00:00:00.000Z" }
        const spent = { inputTokens: 80, costMicrousd: 70 }
        expect(checkIndexReservation(approval, spent, { inputTokens: 20, costMicrousd: 30 })).toEqual({ inputTokens: 20, costMicrousd: 30 })
        expect(() => checkIndexReservation(approval, spent, { inputTokens: 21, costMicrousd: 30 })).toThrow("预算不足")
        expect(() => checkIndexReservation(approval, spent, { inputTokens: 20, costMicrousd: 31 })).toThrow("预算不足")
        expect(() => checkIndexReservation(approval, { ...spent, inputTokens: Infinity }, { inputTokens: 1, costMicrousd: 0 })).toThrow("无效")
    })
})
