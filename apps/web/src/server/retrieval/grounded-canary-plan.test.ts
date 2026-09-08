import { describe, expect, it, vi } from "vitest"
import { createGroundedReviewTemplate, DEFAULT_CANARY_DOCUMENTS, planGroundedCanary } from "./grounded-canary-plan"
import { evaluateGroundedQa } from "./grounded-evaluation"

describe("合成canary审批规划", () => {
    it("固定输入确定性、保留完整文档且绝不授权执行", () => {
        const plan = planGroundedCanary()
        expect(plan).toEqual(planGroundedCanary([...DEFAULT_CANARY_DOCUMENTS].reverse()))
        expect(plan.authorizedToExecute).toBe(false)
        expect(plan.totals.documents).toBe(3)
        expect(plan.totals.passages).toBeGreaterThan(20)
        expect(plan.totals.embeddingRequestsAtBatch4).toBe(plan.documents.reduce((n, d) => n + Math.ceil(d.passageCount / 4), 0))
        expect(plan.pricing.exactTokens).toBeNull(); expect(plan.pricing.cost).toBeNull()
        expect(plan.totals.cases).toBeLessThan(60)
    })
    it.each([[], ["timeline-old", "timeline-old"], ["/etc/passwd"], ["timeline-old", "timeline-new", "timeline-undated", "timeline-conflict"]])("拒绝空、重复、任意路径或超限选择", (...ids) => {
        expect(() => planGroundedCanary(ids)).toThrow()
    })
    it("报告不包含原文或问题，规划阶段不联网", () => {
        const fetch = vi.spyOn(globalThis, "fetch")
        try {
            const json = JSON.stringify(planGroundedCanary())
            expect(json).not.toContain("第1项是演练")
            expect(json).not.toContain("question")
            expect(fetch).not.toHaveBeenCalled()
        } finally { fetch.mockRestore() }
    })
    it("60题人工模板不伪造实际运行、命中和评审状态", () => {
        const template = createGroundedReviewTemplate()
        expect(template.cases).toHaveLength(60)
        for (const row of template.cases) {
            expect(row.humanGoldStatus).toBe("pending")
            expect(row.actualRetrievedIds).toBeNull(); expect(row.actualReadIds).toBeNull()
            expect(row.actualAnswer).toBeNull(); expect(row.reviewer).toBeNull()
            expect(row.supportedClaims).toBeNull()
        }
        expect(() => evaluateGroundedQa(template)).toThrow()
    })
})
