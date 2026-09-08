import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn(), update: vi.fn(), committed: vi.fn(), transaction: vi.fn() }))
vi.mock("@/server/db/client", () => ({ getDb: () => ({ transaction: mocks.transaction }), getSqlClient: vi.fn() }))
import { completeDeepResearchJob } from "./deep-research-job-store"
const job = { id: 1, userId: 7, threadId: 11, runKey: "deep-fixture", status: "running", leaseOwner: "worker", leaseExpiresAt: new Date(1000), resultMessageId: null }
const message = { parts: [{ type: "text" as const, text: "合成" }], agentRunId: "deep-fixture", deepResearch: { runKey: "deep-fixture", fastRunKey: null, references: [] } }
const runCompletion = { answer: "合成", metricsJson: '{"safeCount":1}', inputTokens: 10, outputTokens: 5, totalTokens: 15, durationMs: 20 }
beforeEach(() => {
    vi.resetAllMocks()
    mocks.select.mockResolvedValue([job]); mocks.insert.mockResolvedValue([{ id: 44 }])
    mocks.update.mockResolvedValueOnce([{ ...job, status: "succeeded", resultMessageId: 44 }]).mockResolvedValue([{ id: 9 }])
    mocks.transaction.mockImplementation(async (run: (tx: unknown) => unknown) => {
        const tx = { select: () => ({ from: () => ({ where: () => ({ limit: mocks.select }) }) }),
            insert: () => ({ values: () => ({ returning: mocks.insert }) }),
            update: () => ({ set: () => ({ where: () => ({ returning: mocks.update }) }) }),
        }
        const result = await run(tx)
        mocks.committed()
        return result
    })
})
describe("Deep完成事务契约（非真实PG并发测试）", () => {
    it("消息、Job和Run更新都完成后才提交", async () => {
        const result = await completeDeepResearchJob({ jobId: 1, workerId: "worker", now: new Date(0), message, runCompletion })
        expect(result?.job.status).toBe("succeeded")
        expect(mocks.insert).toHaveBeenCalledOnce()
        expect(mocks.update).toHaveBeenCalledTimes(2)
        expect(mocks.transaction).toHaveBeenCalledOnce()
        expect(mocks.committed).toHaveBeenCalledOnce()
    })
    it("Run更新未命中时事务回调失败，不提交前面的消息和Job", async () => {
        mocks.update.mockReset().mockResolvedValueOnce([{ ...job, status: "succeeded" }]).mockResolvedValueOnce([])
        await expect(completeDeepResearchJob({ jobId: 1, workerId: "worker", now: new Date(0), message, runCompletion })).rejects.toThrow("Run完成状态竞争")
        expect(mocks.committed).not.toHaveBeenCalled()
    })
    it("过期租约不写入，重复成功只返回已有消息", async () => {
        expect(await completeDeepResearchJob({ jobId: 1, workerId: "worker", now: new Date(1000), message, runCompletion })).toBeNull()
        expect(mocks.insert).not.toHaveBeenCalled()
        mocks.select.mockResolvedValueOnce([{ ...job, status: "succeeded", resultMessageId: 44 }]).mockResolvedValueOnce([{ id: 44 }])
        expect((await completeDeepResearchJob({ jobId: 1, workerId: "worker", now: new Date(1000), message, runCompletion }))?.message.id).toBe(44)
        expect(mocks.insert).not.toHaveBeenCalled()
        expect(mocks.update).not.toHaveBeenCalled()
    })
})
