import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
const mocks = vi.hoisted(() => ({ budget: vi.fn(), decode: vi.fn(), predicate: null as SQL | null }))
vi.mock("@/server/db/read-budget", () => ({ withReadBudget: mocks.budget }))
vi.mock("@/server/ai/config-logic", () => ({ decodeApiKey: mocks.decode }))
import { rerankIndexedCandidates } from "./index-reranker"
const input = { userId: 7, query: "退货", candidates: [{ nodeKey: "a", content: "无关资料" }, { nodeKey: "b", content: "退货资料" }] }
function rows(value: unknown[]) {
    mocks.budget.mockImplementation(async (run) => {
        const chain = { from: () => chain, innerJoin: () => chain, where: (predicate: SQL) => { mocks.predicate = predicate; return chain }, limit: async () => value }
        return run({ select: () => chain })
    })
}
beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv("PETRICHOR_DOC_RERANK_ENABLED", "true")
    vi.stubEnv("PETRICHOR_DOC_RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
    rows([{ baseUrl: null, headers: "{}", encryptedKey: "synthetic-cipher" }])
    mocks.decode.mockReturnValue("synthetic-key")
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] })))
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
describe("文档重排凭证与降级边界", () => {
    it("关闭时不读取配置或调用服务", async () => {
        vi.stubEnv("PETRICHOR_DOC_RERANK_ENABLED", "false")
        const result = await rerankIndexedCandidates(input)
        expect(result.items[0].nodeKey).toBe("b")
        expect(mocks.budget).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
    })
    it("真实查询约束四层归属，固定目标，只向provider使用凭证", async () => {
        const result = await rerankIndexedCandidates(input)
        expect(result.degraded).toEqual([]); expect(result.items.map(x => x.nodeKey)).toEqual(["b", "a"])
        const sql = new PgDialect().sqlToQuery(mocks.predicate!)
        expect(sql.params.filter(x => x === 7)).toHaveLength(4)
        expect(fetch).toHaveBeenCalledTimes(1)
        expect(fetch).toHaveBeenCalledWith("https://api.siliconflow.cn/v1/rerank", expect.objectContaining({ redirect: "error", headers: expect.objectContaining({ authorization: "Bearer synthetic-key" }) }))
        expect(JSON.stringify(result)).not.toContain("synthetic-key")
    })
    it.each([[], [{ baseUrl: "https://untrusted.invalid/v1", headers: null }], [{ baseUrl: null, headers: '{"Authorization":"other"}' }]])("配置缺失/目标或headers不符不外发", async (...value) => {
        rows(value)
        expect((await rerankIndexedCandidates(input)).degraded).toEqual(["rerank_unavailable"])
        expect(fetch).not.toHaveBeenCalled(); expect(mocks.decode).not.toHaveBeenCalled()
    })
    it("预算不足不读取凭证", async () => {
        expect((await rerankIndexedCandidates({ ...input, queryDeadlineAt: Date.now() })).degraded).toEqual(["rerank_budget_exhausted"])
        expect(mocks.budget).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
    })
    it("模型不符拒绝外部调用", async () => {
        vi.stubEnv("PETRICHOR_DOC_RERANK_MODEL", "other")
        expect((await rerankIndexedCandidates(input)).degraded).toEqual(["rerank_unavailable"])
        expect(fetch).not.toHaveBeenCalled()
    })
    it("超过20候选不读取凭证或调用模型", async () => {
        expect((await rerankIndexedCandidates({ ...input, candidates: Array.from({ length: 21 }, (_, i) => ({ nodeKey: String(i) })) })).degraded).toEqual(["rerank_unavailable"])
        expect(mocks.budget).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
    })
    it("内部重排时限触发后降级，原请求未取消", async () => {
        vi.mocked(fetch).mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
            init!.signal!.addEventListener("abort", () => reject(new Error("timed_out")), { once: true })
        }))
        const result = await rerankIndexedCandidates({ ...input, queryDeadlineAt: Date.now() + 300 })
        expect(result.degraded).toEqual(["rerank_unavailable"])
        expect(result.items[0].nodeKey).toBe("b")
        expect(fetch).toHaveBeenCalledTimes(1)
    })
    it("服务错误只返回固定降级码且不重试", async () => {
        vi.mocked(fetch).mockRejectedValue(new Error("synthetic-key response-body"))
        const result = await rerankIndexedCandidates(input)
        expect(result.items[0].nodeKey).toBe("b"); expect(result.degraded).toEqual(["rerank_unavailable"])
        expect(JSON.stringify(result)).not.toContain("synthetic-key")
        expect(fetch).toHaveBeenCalledTimes(1)
    })
    it("已取消不会外发或降级伪装成功", async () => {
        const controller = new AbortController(); controller.abort(new Error("cancelled"))
        await expect(rerankIndexedCandidates({ ...input, abortSignal: controller.signal })).rejects.toThrow("cancelled")
        expect(fetch).not.toHaveBeenCalled()
    })
})
