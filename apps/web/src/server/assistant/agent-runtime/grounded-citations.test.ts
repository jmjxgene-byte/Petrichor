import { describe, expect, it } from "vitest"
import { validateGroundedCitations } from "./grounded-citations"
describe("本轮已读引用门", () => {
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
