import { describe, expect, it, vi } from "vitest"

import {
    DeepResearchExecutionError,
    runDeepResearchPipeline,
    type DeepResearchCandidate,
} from "./deep-research-pipeline"
import { DEEP_RESEARCH_MODEL_OUTPUT_LIMITS } from "./deep-research-limits"

const signal = new AbortController().signal

describe("deep research pipeline", () => {
    it.each(["insufficient", "clarification", "time_unknown", "conflict"])("Deep安全弃答%s保持一次综合及降级提示", async (status) => {
        const synthesize = vi.fn(async () => JSON.stringify({ groundingStatus: status }))
        const result = await runDeepResearchPipeline({ question: "合成", modes: ["exact"], signal }, {
            planQueries: async () => [],
            search: async () => ({ candidates: [{ candidateKey: "fixture", title: "合成", sourceName: "本地", url: null, score: 1, read: {} }], degradedSourceChecks: 1 }),
            read: async () => [{ referenceKey: "fixture", title: "合成", content: "已读但不足以结论的正文", source: "document", url: null, queriedAt: "2026-09-08T00:00:00Z" }],
            synthesize,
        })
        expect(result.resolution).toBe(status)
        expect(result.answer).not.toContain("groundingStatus")
        expect(result.answer).not.toContain("已读但不足以结论的正文")
        expect(result.answer).toContain("1 次来源检查降级")
        expect(result.evidence).toHaveLength(1)
        expect(synthesize).toHaveBeenCalledOnce()
    })
    it("夹带正文的弃答JSON不能获得跳过引用门的状态", async () => {
        const result = await runDeepResearchPipeline({ question: "合成", modes: ["exact"], signal }, {
            planQueries: async () => [],
            search: async () => [{ candidateKey: "fixture", title: "合成", sourceName: "本地", url: null, score: 1, read: {} }],
            read: async () => [{ referenceKey: "fixture", title: "合成", content: "合成", source: "document", url: null, queriedAt: "2026-09-08T00:00:00Z" }],
            synthesize: async () => '{"groundingStatus":"insufficient","answer":"私自结论"}',
        })
        expect(result.resolution).toBeNull()
    })
    it("不同文档库各自的generation不互相冲突", async () => {
        const result = await runDeepResearchPipeline({ question: "合成", modes: ["exact"], signal }, {
            planQueries: async () => ["另一个問法"],
            search: async (query) => [{ candidateKey: query, title: "合成", sourceName: "本地", url: null, score: 1,
                read: { kind: "document", sourceRef: query === "合成" ? "doc-library:3" : "doc-library:4", generationId: query === "合成" ? 1 : 2 } }],
            read: async (item) => [{ referenceKey: item.candidateKey, title: "合成", content: "已读正文", source: "document", url: null, queriedAt: "2026-09-08T00:00:00Z" }],
            synthesize: async () => "合成回答",
        })
        expect(result.candidates).toHaveLength(2)
        expect(result.evidence).toHaveLength(2)
    })
    it("跨查询使用排名融合，原始巨大分数和单列表重复不能刷高排名", async () => {
        const candidate = (key: string, score: number): DeepResearchCandidate => ({ candidateKey: key, title: key, sourceName: "合成", url: null, score, read: {} })
        const result = await runDeepResearchPipeline({ question: "合成", modes: ["exact"], signal }, {
            planQueries: async () => ["另一个问法"],
            search: async (query) => query === "合成" ? [candidate("a", 1e12), candidate("a", 1e12), candidate("b", 1)] : [candidate("b", 0.001)],
            read: async (item) => [{ referenceKey: item.candidateKey, title: item.title, content: "合成正文", source: "document", url: null, queriedAt: "2026-09-08T00:00:00Z" }],
            synthesize: async () => "合成回答",
        })
        expect(result.candidates.map((item) => item.candidateKey)).toEqual(["b", "a"])
        expect(result.candidates[1].score).toBeCloseTo(1 / 61, 5)
    })
    it.each([2, undefined])("同库跨查询混入其他generation或legacy时不深读/综合：%s", async (second) => {
        const read = vi.fn(async () => [])
        const synthesize = vi.fn(async () => "不应调用")
        await expect(runDeepResearchPipeline({ question: "合成", modes: ["exact"], signal }, {
            planQueries: async () => ["另一个问法"],
            search: async (query) => [{ candidateKey: query, title: "合成", sourceName: "本地", url: null, score: 1,
                read: { kind: "document", sourceRef: "doc-library:3", generationId: query === "合成" ? 1 : second } }],
            read, synthesize,
        })).rejects.toMatchObject({ code: "validation_failed" })
        expect(read).not.toHaveBeenCalled()
        expect(synthesize).not.toHaveBeenCalled()
    })
    it("搜索成功中的来源降级与部分深读失败都对用户可见", async () => {
        const candidate = (key: string): DeepResearchCandidate => ({ candidateKey: key, title: "合成", sourceName: "合成", url: null, score: 1, read: {} })
        const result = await runDeepResearchPipeline({ question: "合成", modes: ["exact"], signal }, {
            planQueries: async () => [],
            search: async () => ({ candidates: [candidate("ok"), candidate("fail")], degradedSourceChecks: 1 }),
            read: async (item) => {
                if (item.candidateKey === "fail") throw new Error("private_failure_payload")
                return [{ referenceKey: "ok", title: "合成", content: "合成证据", source: "document", url: null, queriedAt: "2026-09-08T00:00:00Z" }]
            },
            synthesize: async () => "合成结论",
        })
        expect(result).toMatchObject({ failedSearchCount: 0, failedReadCount: 1, degradedSourceChecks: 1 })
        expect(result.answer).toContain("1 次来源检查降级")
        expect(result.answer).toContain("1 次深读失败")
        expect(result.answer).not.toContain("private_failure_payload")
    })
    it.each(["plan", "search", "read", "synthesize"])("%s阶段取消后不进入后续步骤或返回答案", async (stage) => {
        const controller = new AbortController()
        const cancel = (current: string) => { if (current === stage) controller.abort() }
        const candidate: DeepResearchCandidate = { candidateKey: "fixture", title: "合成", sourceName: "合成", url: null, score: 1, read: {} }
        const deps = {
            planQueries: vi.fn(async () => { cancel("plan"); return [] }),
            search: vi.fn(async () => { cancel("search"); return [candidate] }),
            read: vi.fn(async () => { cancel("read"); return [{ referenceKey: "fixture", title: "合成", content: "合成正文", source: "document", url: null, queriedAt: "2026-09-08T00:00:00Z" }] }),
            synthesize: vi.fn(async () => { cancel("synthesize"); return "不应发布的草稿" }),
        }
        await expect(runDeepResearchPipeline({ question: "合成", modes: ["exact"], signal: controller.signal }, deps)).rejects.toMatchObject({ name: "AbortError" })
        if (stage === "plan") expect(deps.search).not.toHaveBeenCalled()
        if (stage === "plan" || stage === "search") expect(deps.read).not.toHaveBeenCalled()
        if (stage !== "synthesize") expect(deps.synthesize).not.toHaveBeenCalled()
    })
    it("开始前已取消或没有模式时不消耗规划调用", async () => {
        const deps = { planQueries: vi.fn(async () => []), search: vi.fn(async () => []), read: vi.fn(async () => []), synthesize: vi.fn(async () => "") }
        await expect(runDeepResearchPipeline({ question: "合成", modes: ["exact"], signal: AbortSignal.abort() }, deps)).rejects.toMatchObject({ name: "AbortError" })
        await expect(runDeepResearchPipeline({ question: "合成", modes: [], signal }, deps)).rejects.toMatchObject({ code: "validation_failed" })
        expect(deps.planQueries).not.toHaveBeenCalled()
    })
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
                referenceKey: `ref:${item.candidateKey}`,
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
                referenceKey: "ref:ok",
                title: "ok",
                content: "正文",
                source: "knowledge",
                url: null,
                queriedAt: "2026-09-01T00:00:00.000Z",
            }],
            synthesize: async () => "回答",
        })
        expect(result.answer).toContain("1 次搜索、0 次深读失败")
        expect(result.answer.endsWith("回答")).toBe(true)
        expect(result.failedSearchCount).toBe(1)

        await expect(runDeepResearchPipeline({ question: "问题", modes: ["exact"], signal }, {
            planQueries: async () => [],
            search: async () => [],
            read: async () => [],
            synthesize: async () => "不会执行",
        })).rejects.toEqual(expect.objectContaining<Partial<DeepResearchExecutionError>>({
            code: "validation_failed",
        }))
    })

    it("综合前按稳定来源归并，模型证据与最终 references 使用同一顺序", async () => {
        const candidates: DeepResearchCandidate[] = [
            { candidateKey: "a", title: "A", sourceName: "GeneOps", url: "https://example.com/a", score: 1, read: {} },
            { candidateKey: "a-duplicate", title: "A2", sourceName: "GeneOps", url: "https://example.com/a", score: 0.9, read: {} },
            { candidateKey: "b", title: "B", sourceName: "GeneOps", url: "https://example.com/b", score: 0.8, read: {} },
        ]
        let synthesized: string[] = []
        const result = await runDeepResearchPipeline({ question: "ODR", modes: ["exact"], signal }, {
            planQueries: async () => [],
            search: async () => candidates,
            read: async (candidate) => [{
                referenceKey: candidate.url!,
                title: candidate.title,
                content: `正文:${candidate.candidateKey}`,
                source: "geneops",
                sourceName: "GeneOps",
                url: candidate.url,
                queriedAt: "2026-09-01T00:00:00.000Z",
            }],
            synthesize: async (_question, evidence) => {
                synthesized = evidence.map((item) => item.referenceKey)
                return "结论 [1] [2]"
            },
        })

        expect(result.rawEvidenceCount).toBe(3)
        expect(synthesized).toEqual(["https://example.com/a", "https://example.com/b"])
        expect(result.evidence.map((item) => item.referenceKey)).toEqual(synthesized)
        expect(result.evidence[0]?.content).toContain("正文:a-duplicate")
    })

    it("综合与持久化引用源统一限制为40条", async () => {
        const candidates = Array.from({ length: 45 }, (_, index): DeepResearchCandidate => ({
            candidateKey: `candidate-${index}`,
            title: `来源${index}`,
            sourceName: "GeneOps",
            url: `https://example.com/${index}`,
            score: 100 - index,
            read: {},
        }))
        let synthesisCount = 0
        const result = await runDeepResearchPipeline({ question: "ODR", modes: ["exact"], signal }, {
            planQueries: async () => [],
            search: async () => candidates,
            read: async (candidate) => Array.from({ length: 4 }, (_, chunk) => ({
                referenceKey: `${candidate.url}-${chunk}`,
                title: `${candidate.title}-${chunk}`,
                content: `正文${chunk}`,
                source: "geneops",
                url: `${candidate.url}/${chunk}`,
                queriedAt: "2026-09-01T00:00:00.000Z",
            })),
            synthesize: async (_question, evidence) => {
                synthesisCount = evidence.length
                return "结论 [1]"
            },
        })
        expect(result.rawEvidenceCount).toBe(48)
        expect(synthesisCount).toBe(40)
        expect(result.evidence).toHaveLength(40)
    })
})
