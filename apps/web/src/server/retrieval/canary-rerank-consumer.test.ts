import { describe, expect, it } from "vitest"
import { buildSafeRerankReport, consumeRerankResult, parseRerankResponse } from "../../../scripts/canary-rerank-consumer"
const response = (scores = [0.9, 0.5, 0.1]) => ({ results: scores.map((relevance_score, index) => ({ index, relevance_score })), usage: { total_tokens: 12 } })
describe("重排结果消费契约", () => {
    it("按候选索引映射安全ID，不保存正文", () => {
        const result = consumeRerankResult({ caseId: "terms-1", candidateIds: ["passage-a", "passage-b", "passage-c"], goldIds: ["passage-b"], raw: response([0.9, 0.5, 0.1]) })
        expect(result.rankedIds).toEqual(["passage-a", "passage-b", "passage-c"])
        expect(result.recallAt20).toBe(1); expect(result.usageTokens).toBe(12)
        expect(JSON.stringify(result)).not.toContain("text")
    })
    it("允许按分数排序的非连续候选索引", () => {
        const result = consumeRerankResult({ caseId: "ranked", candidateIds: ["a", "b", "c"], raw: { results: [
            { index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.4 }, { index: 1, relevance_score: 0.1 },
        ], usage: { total_tokens: null } } })
        expect(result.rankedIds).toEqual(["c", "a", "b"])
    })
    it.each([
        { results: [{ index: 0, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }, { index: 2, relevance_score: 0 }] },
        { results: [{ index: 0, relevance_score: 0.9 }, { index: 3, relevance_score: 0.1 }, { index: 1, relevance_score: 0 }] },
        { results: [{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.9 }, { index: 2, relevance_score: 0 }] },
        { results: [{ index: 0, relevance_score: 0.9, document: { text: "secret" } }, { index: 1, relevance_score: 0.1 }, { index: 2, relevance_score: 0 }] },
    ])("拒绝重复、越界/缺索引、分数乱序和正文回显", raw => {
        expect(() => parseRerankResponse({ ...raw, usage: { total_tokens: null } }, 3)).toThrow()
    })
    it("拒绝重复候选和gold越权", () => {
        expect(() => consumeRerankResult({ caseId: "x", candidateIds: ["a", "a"], raw: response([0.9, 0.1]) })).toThrow("candidate_ids")
        expect(() => consumeRerankResult({ caseId: "x", candidateIds: ["a", "b", "c"], goldIds: ["outside"], raw: response() })).toThrow("gold_outside")
    })
    it("报告只保留排序元数据并生成稳定hash", () => {
        const cases = [{ caseId: "one", candidateIds: ["a", "b", "c"], goldIds: ["b"], raw: response() }]
        const one = buildSafeRerankReport({ executionId: "00000000-0000-4000-8000-000000000001", planHash: "a".repeat(64), requestSetHash: "b".repeat(64), cases })
        const two = buildSafeRerankReport({ executionId: one.executionId, planHash: one.planHash, requestSetHash: one.requestSetHash, cases })
        expect(one.resultHash).toBe(two.resultHash); expect(one.rawTextPersisted).toBe(false); expect(one.modelCalls).toBe(0)
        expect(JSON.stringify(one)).not.toContain("secret"); expect(JSON.stringify(one)).not.toContain("query")
    })
})
