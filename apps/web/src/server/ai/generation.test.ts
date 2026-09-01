import { describe, expect, it } from "vitest"

import { resolveMaxOutputTokens } from "./generation"

describe("resolveMaxOutputTokens", () => {
    it("用途绑定未配置上限时采用本次调用上限", () => {
        expect(resolveMaxOutputTokens(null, 384)).toBe(384)
    })

    it("用途绑定上限更小时不得被本次调用放大", () => {
        expect(resolveMaxOutputTokens(256, 384)).toBe(256)
    })

    it("未传本次上限时保持现有用途绑定行为", () => {
        expect(resolveMaxOutputTokens(2_000, undefined)).toBe(2_000)
        expect(resolveMaxOutputTokens(null, undefined)).toBeUndefined()
    })

    it("拒绝无效的本次调用上限", () => {
        expect(() => resolveMaxOutputTokens(null, 0)).toThrow("正整数")
        expect(() => resolveMaxOutputTokens(null, 1.5)).toThrow("正整数")
    })
})
