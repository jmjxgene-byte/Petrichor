import { afterEach, describe, expect, it, vi } from "vitest"
import { OpenAiCompatibleReranker } from "./reranker"
const model = new OpenAiCompatibleReranker({ enabled: true, provider: "openai-compatible", model: "synthetic", baseUrl: "https://example.invalid/v1", topN: 2, timeoutMs: 1000 })
const candidates = [{ nodeKey: "a" }, { nodeKey: "b" }]
afterEach(() => vi.unstubAllGlobals())
describe("重排HTTP契约", () => {
    it.each([
        { results: [] }, { results: [{ index: 0, score: 1 }] },
        { results: [{ index: 0, score: 1 }, { index: 0, score: 0 }] },
        { results: [{ index: 0.5, score: 1 }, { index: 1, score: 0 }] },
        { results: [{ index: 2, score: 1 }, { index: 1, score: 0 }] },
        { results: [{ index: 0, score: "1" }, { index: 1, score: 0 }] },
        { results: [{ index: 0 }, { index: 1, score: 0 }] },
    ])("拒绝不完整、重复或无效结果", async (response) => {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json(response)))
        await expect(model.rerank("q", candidates)).rejects.toThrow("rerank_invalid_results")
    })
    it("拒绝过大响应", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(128 * 1024 + 1))))
        await expect(model.rerank("q", candidates)).rejects.toThrow("rerank_response_too_large")
    })
    it("调用前取消不发送请求", async () => {
        vi.stubGlobal("fetch", vi.fn())
        const c = new AbortController(); c.abort(new Error("cancelled"))
        await expect(model.rerank("q", candidates, { signal: c.signal })).rejects.toThrow("cancelled")
        expect(fetch).not.toHaveBeenCalled()
    })
})
