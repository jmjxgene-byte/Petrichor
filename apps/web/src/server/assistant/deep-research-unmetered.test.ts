import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn(), resolve: vi.fn(), call: vi.fn(), pricing: vi.fn(),
    reserve: vi.fn(), complete: vi.fn(), fail: vi.fn(), getJob: vi.fn(), search: vi.fn() }))
vi.mock("@/server/db/client", () => ({ getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: mocks.select }) }) }),
    update: () => ({ set: () => ({ where: mocks.update }) }),
}) }))
vi.mock("@/server/ai/generation", () => ({ resolveChatModel: mocks.resolve, callChatCompletion: mocks.call }))
vi.mock("./deep-research-pricing", () => ({ fetchDeepResearchPricingSnapshot: mocks.pricing }))
vi.mock("./agent-runtime/store", () => ({ persistEvidence: vi.fn(async () => {}) }))
vi.mock("./agent-runtime/tools/sources", () => ({ sourceTools: [
    { id: "source.search", execute: mocks.search }, { id: "source.read", execute: vi.fn() },
] }))
vi.mock("./deep-research-job-store", async (original) => ({
    ...await original<typeof import("./deep-research-job-store")>(),
    reserveDeepResearchExecution: mocks.reserve, completeDeepResearchJob: mocks.complete,
    failDeepResearchJob: mocks.fail, getDeepResearchJob: mocks.getJob,
    heartbeatDeepResearchJob: vi.fn(async () => true),
}))
import { executeDeepResearchJob } from "./deep-research-executor"
import { buildDeepResearchSourceScopeHash } from "./deep-research-contract"

beforeEach(() => {
    vi.clearAllMocks()
    const job = { id: 1, runKey: "fixture", threadId: 2, questionMessageId: 3, userId: 4, fastRunKey: null,
        status: "running", sourceScopeHash: buildDeepResearchSourceScopeHash(null),
        capabilitySnapshotJson: JSON.stringify({ contractVersion: null, allowedModes: ["exact"], sourceCutoffs: {},
            wikiReady: false, graphReady: false, qualityStale: false, capturedAt: "2026-09-08T00:00:00Z" }) }
    mocks.select.mockResolvedValueOnce([job]).mockResolvedValueOnce([{ focusJson: null }])
        .mockResolvedValueOnce([{ contentJson: JSON.stringify({ parts: [{ type: "text", text: "合成问题" }] }) }])
        .mockResolvedValueOnce([{ systemRole: "user" }])
    mocks.resolve.mockResolvedValue({ model: { id: 8, modelId: "fixture", updatedAt: 1 },
        provider: { id: 9, providerKey: "openai-compatible", baseUrl: "https://example.invalid/v1", updatedAt: 1 },
        credential: { id: 10, updatedAt: 1 }, options: {} })
    mocks.reserve.mockResolvedValue(true)
    mocks.call.mockResolvedValue({ answer: "[]", modelName: "fixture", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, totalsKnown: true } })
    mocks.search.mockResolvedValue({ candidates: [] })
    mocks.complete.mockResolvedValue({ job: { status: "succeeded" } })
    mocks.getJob.mockResolvedValue(job)
    mocks.fail.mockResolvedValue({ status: "failed" })
    mocks.pricing.mockRejectedValue(new Error("不应访问计费接口"))
})
describe("用户取消Deep金额限制", () => {
    it("执行器不访问价格接口，仍预留执行身份、固定模型并记录token", async () => {
        expect(await executeDeepResearchJob(1, "worker")).toMatchObject({ status: "succeeded" })
        expect(mocks.pricing).not.toHaveBeenCalled()
        expect(mocks.reserve).toHaveBeenCalledOnce()
        expect(mocks.call).toHaveBeenCalledOnce()
        expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ modelRefId: 8, maxRetries: 0, maxOutputTokens: 384 }))
        const completion = mocks.complete.mock.calls[0][0].runCompletion
        expect(completion.totalTokens).toBe(12)
        expect(JSON.parse(completion.metricsJson)).toMatchObject({ monetaryBudgetMode: "not_enforced_by_user_request", pricingSnapshot: null, costEstimate: null })
    })
    it("取消费用门不绕过唯一执行预留", async () => {
        mocks.reserve.mockResolvedValue(false)
        await executeDeepResearchJob(1, "worker")
        expect(mocks.call).not.toHaveBeenCalled()
        expect(mocks.resolve).not.toHaveBeenCalled()
    })
    it("上游失败不直接归因额度耗尽，也不重试已开始的调用", async () => {
        mocks.call.mockRejectedValue(new Error("upstream unavailable"))
        await executeDeepResearchJob(1, "worker")
        expect(mocks.fail).toHaveBeenCalledWith({ jobId: 1, workerId: "worker", errorCode: "model_failed", retryable: false })
        expect(mocks.call).toHaveBeenCalledOnce()
    })
})
