import { describe, expect, it } from "vitest"

import {
    DeepResearchExecutionError,
    runDeepResearchPipeline,
    type DeepResearchCandidate,
} from "./deep-research-pipeline"
import { DEEP_RESEARCH_MODEL_OUTPUT_LIMITS } from "./deep-research-limits"

const signal = new AbortController().signal

describe("deep research pipeline", () => {
    it("为两次模型调用设置固定输出上限", () => {
        expect(DEEP_RESEARCH_MODEL_OUTPUT_LIMITS).toEqual({
            planner: 384,
            synthesis: 1_200,
            maxRetriesPerCall: 0,
        })
        expect(DEEP_RESEARCH_MODEL_OUTPUT_LIMITS.planner + DEEP_RESEARCH_MODEL_OUTPUT_LIMITS.synthesis)
            .toBe(1_584)
        expect(DEEP_RESEARCH_MODEL_OUTPUT_LIMITS.maxRetriesPerCall).toBe(0)
    })

    it("多 query/mode 候选去重后深读并综合", async () => {
        const searches: string[] = []
        const candidate = (key: string, score: number): DeepResearchCandidate => ({
            candidateKey: key,
            title: key,
            sourceName: "GeneOps",
            url: `https://example.com/${key}`,
            score,
            read: { key },
        })
        const result = await runDeepResearchPipeline({
            question: "Amazon 退货怎么处理？",
            modes: ["exact", "fuzzy"],
            signal,
        }, {
            planQueries: async () => ["Amazon 退货", "买家退款"],
            search: async (query, mode) => {
                searches.push(`${query}:${mode}`)
                return [candidate("same", mode === "fuzzy" ? 0.8 : 0.9), candidate(`${query}-${mode}`, 0.5)]
            },
            read: async (item) => [{
                title: item.title,
                content: `证据:${item.candidateKey}`,
                source: "geneops",
                url: item.url,
                queriedAt: "2026-09-01T00:00:00.000Z",
            }],
            synthesize: async (_question, evidence) => `共${evidence.length}条证据`,
        })

        expect(searches).toHaveLength(6)
        expect(result.candidates.filter((item) => item.candidateKey === "same")).toHaveLength(1)
        expect(result.answer).toBe(`共${result.evidence.length}条证据`)
    })

    it("部分来源失败时继续，全部无候选时 fail-closed", async () => {
        const candidate: DeepResearchCandidate = {
            candidateKey: "ok",
            title: "ok",
            sourceName: "local",
            url: null,
            score: 1,
            read: {},
        }
        const result = await runDeepResearchPipeline({ question: "问题", modes: ["exact"], signal }, {
            planQueries: async () => ["备用"],
            search: async (query) => query === "问题" ? [candidate] : Promise.reject(new Error("down")),
            read: async () => [{
                title: "ok",
                content: "正文",
                source: "knowledge",
                url: null,
                queriedAt: "2026-09-01T00:00:00.000Z",
            }],
            synthesize: async () => "回答",
        })
        expect(result.answer).toBe("回答")

        await expect(runDeepResearchPipeline({ question: "问题", modes: ["exact"], signal }, {
            planQueries: async () => [],
            search: async () => [],
            read: async () => [],
            synthesize: async () => "不会执行",
        })).rejects.toEqual(expect.objectContaining<Partial<DeepResearchExecutionError>>({
            code: "validation_failed",
        }))
    })
})
