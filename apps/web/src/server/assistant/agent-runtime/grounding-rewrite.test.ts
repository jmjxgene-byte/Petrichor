import { beforeEach, describe, expect, it, vi } from "vitest"
const stream = vi.hoisted(() => vi.fn())
vi.mock("ai", () => ({ streamText: stream }))
import { rewriteGroundingQuery } from "./grounding-rewrite"
beforeEach(() => vi.clearAllMocks())
describe("有限补检改写", () => {
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
