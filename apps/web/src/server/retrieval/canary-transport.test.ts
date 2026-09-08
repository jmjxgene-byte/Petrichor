import { describe, expect, it } from "vitest"
import { decodeCanaryFrame, encodeCanaryFrame } from "../../../scripts/canary-transport"

describe("canary完整性帧", () => {
    it("按UTF8字节校验中文和大报文", () => {
        const value = JSON.stringify({ data: "中文😀".repeat(100000) })
        expect(decodeCanaryFrame(encodeCanaryFrame(value))).toBe(value)
    })
    it("缺失头尾、截断和多余输出均拒绝", () => {
        const frame = encodeCanaryFrame('{"x":1}')
        for (const raw of ["", frame.slice(1), frame.slice(0, -1), frame + "log", frame.slice(0, 100)]) expect(() => decodeCanaryFrame(raw)).toThrow()
    })
    it("同长度损坏仍被SHA检测", () => {
        expect(() => decodeCanaryFrame(encodeCanaryFrame('{"x":1}').replace('{"x":1}', '{"x":2}'))).toThrow("frame_hash_mismatch")
    })
    it("正文变长被长度检测", () => {
        expect(() => decodeCanaryFrame(encodeCanaryFrame("abc").replace("\nabc\n", "\nabcd\n"))).toThrow("frame_length_mismatch")
    })
    it("超过4MiB拒绝", () => {
        expect(() => encodeCanaryFrame("x".repeat(4 * 1024 * 1024 + 1))).toThrow("frame_oversize")
    })
    it("帧完整并不等于业务JSON或canary通过", () => {
        const raw = decodeCanaryFrame(encodeCanaryFrame("not json"))
        expect(() => JSON.parse(raw)).toThrow()
    })
})
