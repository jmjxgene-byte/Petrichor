import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
    returning: vi.fn(), conflict: vi.fn(), limit: vi.fn(), where: vi.fn(),
}))
vi.mock("@/server/db/client", () => ({
    getDb: () => ({
        insert: () => ({ values: () => ({ onConflictDoNothing: mocks.conflict }) }),
        select: () => ({ from: () => ({ where: mocks.where }) }),
    }),
    getSqlClient: vi.fn(), isSqliteDatabase: () => false,
}))
import { createDeepResearchJob, type CreateDeepResearchJobInput } from "./deep-research-job-store"

const input: CreateDeepResearchJobInput = {
    runKey: "synthetic-run", idempotencyKey: "synthetic-key", userId: 1,
    threadId: 2, questionMessageId: 3, sourceScopeHash: "synthetic-scope",
    capabilitySnapshot: { contractVersion: 2, sourceCutoffs: {}, allowedModes: ["exact"],
        wikiReady: false, graphReady: false, qualityStale: false, capturedAt: "2026-09-08T00:00:00.000Z" },
}
beforeEach(() => {
    vi.resetAllMocks()
    mocks.conflict.mockReturnValue({ returning: mocks.returning })
    mocks.where.mockReturnValue({ limit: mocks.limit })
})
describe("Deep创建唯一索引竞争", () => {
    it("不限定冲突索引，新建成功无需读取旧任务", async () => {
        const row = { id: 4 }
        mocks.returning.mockResolvedValue([row])
        expect(await createDeepResearchJob(input)).toBe(row)
        expect(mocks.conflict).toHaveBeenCalledWith()
        expect(mocks.where).not.toHaveBeenCalled()
    })
    it("冲突后只返回通过归属过滤的原任务", async () => {
        const row = { id: 5 }
        mocks.returning.mockResolvedValue([])
        mocks.limit.mockResolvedValue([row])
        expect(await createDeepResearchJob(input)).toBe(row)
        expect(mocks.limit).toHaveBeenCalledWith(1)
    })
    it("真正的run key碰撞或归属不匹配仍报错", async () => {
        mocks.returning.mockResolvedValue([])
        mocks.limit.mockResolvedValue([])
        await expect(createDeepResearchJob(input)).rejects.toThrow("深度检索幂等键冲突")
    })
    it("数据库其他错误不吞掉且不自动重试", async () => {
        mocks.returning.mockRejectedValue(new Error("synthetic-connection-failure"))
        await expect(createDeepResearchJob(input)).rejects.toThrow("synthetic-connection-failure")
        expect(mocks.returning).toHaveBeenCalledTimes(1)
        expect(mocks.where).not.toHaveBeenCalled()
    })
})
