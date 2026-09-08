import { describe, expect, it } from "vitest"
import { validateGroundedCitations, isGroundingSourceEvidence } from "./grounded-citations"
describe("本轮已读引用门", () => {
    it("只有资料源正文能通过类型门，辅助总结和外部网页不替代选定资料", () => {
        for (const source of ["knowledge", "document", "wiki", "geneops"] as const) {
            expect(isGroundingSourceEvidence({ source, content: "合成原文" })).toBe(true)
            expect(isGroundingSourceEvidence({ source, content: " \n" })).toBe(false)
        }
        for (const source of ["subagent", "memory", "tool", "graph", "web"] as const) {
            expect(isGroundingSourceEvidence({ source, content: "有内容不代表资料原文" })).toBe(false)
        }
    })
    it("仅允许本轮已读编号，多处同源引用允许", () => {
        expect(validateGroundedCitations("合成结论[1]。另一处[1]", new Set([1])).valid).toBe(true)
        expect(validateGroundedCitations("合成[1]和伪造[9]", new Set([1])).reason).toBe("unread_citation")
        expect(validateGroundedCitations("合成[0]", new Set([0])).valid).toBe(false)
    })
    it("空引用、代码和链接不能充当引用依据", () => {
        for (const answer of ["无引用结论", "`[1]`", "``示例 [1]``", "```js\n[1]\n```", "```js\n[1]", "[1](https://example.invalid)", "\\[1]", "[1]: https://example.invalid"]) {
            expect(validateGroundedCitations(answer, new Set([1])).reason).toBe("missing_citation")
        }
        expect(validateGroundedCitations("结论[1]", new Set()).valid).toBe(false)
    })
})
