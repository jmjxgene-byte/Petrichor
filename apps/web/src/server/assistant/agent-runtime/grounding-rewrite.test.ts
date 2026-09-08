import { beforeEach, describe, expect, it, vi } from "vitest"
const stream = vi.hoisted(() => vi.fn())
vi.mock("ai", () => ({ streamText: stream }))
import { rewriteGroundingQuery, groundingRewriteHistory } from "./grounding-rewrite"
beforeEach(() => vi.clearAllMocks())
describe("有限补检改写", () => {
    it("历史仅取用户/助手文本，不传系统、工具、图片或任意对象", () => {
        expect(groundingRewriteHistory([
            { role: "system", content: "system_secret" }, { role: "tool", content: "tool_secret" },
            { role: "user", content: [{ type: "image", image: "private_image" }, { type: "text", text: "讨论Listing" }] },
            { role: "assistant", content: "a".repeat(1000) },
        ])).toEqual([{ role: "user", text: "讨论Listing" }, { role: "assistant", text: "a".repeat(500) }])
    })
    it("含义未确定时返回澄清而非虚构查询", async () => {
        stream.mockReturnValue({ text: Promise.resolve('{"needsClarification":true}'), usage: Promise.resolve({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }) })
        expect((await rewriteGroundingQuery({ model: {}, goal: "翻新怎么翻？", deadline: Date.now() + 8_000, messages: [{ role: "user", content: "前文" }] })).status).toBe("clarification")
        expect(JSON.parse(stream.mock.calls[0][0].prompt).history).toEqual([{ role: "user", text: "前文" }])
    })
    it("一次调用、硬输出上限、零重试，只返回查询和用量", async () => {
        stream.mockReturnValue({ text: Promise.resolve('{"query":"Listing 翻新"}'), usage: Promise.resolve({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }) })
        const result = await rewriteGroundingQuery({ model: {}, goal: "翻新怎么翻？", deadline: Date.now() + 8_000 })
        expect(result).toEqual({ status: "rewritten", query: "Listing 翻新", usage: { input: 10, output: 5, total: 15 } })
        expect(stream).toHaveBeenCalledOnce()
        expect(stream).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 256, maxRetries: 0 }))
    })
    it("时限不足或取消不调用模型", async () => {
        expect((await rewriteGroundingQuery({ model: {}, goal: "合成", deadline: Date.now() + 2_000 })).status).toBe("skipped")
        expect((await rewriteGroundingQuery({ model: {}, goal: "合成", deadline: Date.now() + 8_000, signal: AbortSignal.abort() })).status).toBe("skipped")
        expect(stream).not.toHaveBeenCalled()
    })
    it("非JSON回答、越界字段不进入补检，但保留实际用量", async () => {
        stream.mockReturnValue({ text: Promise.resolve('{"query":"合成","answer":"未经检索的答案"}'), usage: Promise.resolve({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }) })
        expect(await rewriteGroundingQuery({ model: {}, goal: "合成", deadline: Date.now() + 8_000 })).toMatchObject({ status: "invalid", query: null, usage: { total: 15 } })
    })
})
