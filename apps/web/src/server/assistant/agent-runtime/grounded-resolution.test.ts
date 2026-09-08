import { describe, expect, it } from "vitest"
import { parseGroundedResolution } from "./grounded-resolution"

describe("资料弃答输出契约", () => {
    it.each(["insufficient", "clarification", "time_unknown", "conflict"])("仅选择安全状态，不透传模型结论：%s", (status) => {
        const result = parseGroundedResolution(JSON.stringify({ groundingStatus: status }))!
        expect(result.status).toBe(status)
        expect(result.answer.length).toBeGreaterThan(20)
        expect(result.answer).not.toContain("[1]")
    })
    it.each([
        '{"groundingStatus":"answer"}', '{"groundingStatus":"insufficient","answer":"夹带结论"}',
        '```json\n{"groundingStatus":"insufficient"}\n```',
        '结论[1]\n{"groundingStatus":"insufficient"}',
        '[{"groundingStatus":"insufficient"}]', 'null', '{}', " ".repeat(161),
    ])("未知或混合载荷不绕过引用门：%s", (value) => {
        expect(parseGroundedResolution(value)).toBeNull()
    })
})
