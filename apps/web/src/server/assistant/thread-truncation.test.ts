import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ read: vi.fn(), lock: vi.fn(), remove: vi.fn(), cancel: vi.fn(), commit: vi.fn(), transaction: vi.fn() }))
vi.mock("@/server/db/client", () => ({ getDb: () => ({ transaction: mocks.transaction }), isSqliteDatabase: () => false }))
vi.mock("./deep-research-thread-cancellation", () => ({ cancelDeepResearchForScope: mocks.cancel }))
import { truncateAssistantThreadMessages } from "./thread-logic"
class ReadChain {
    from() { return this }
    where() { return this }
    limit() { return this }
    orderBy() { return this }
    for() { mocks.lock(); return this }
    then(resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown) { return mocks.read().then(resolve, reject) }
}
beforeEach(() => {
    vi.resetAllMocks()
    mocks.read.mockResolvedValueOnce([{ id: 11 }]).mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }])
    mocks.cancel.mockResolvedValue(undefined); mocks.remove.mockResolvedValue(undefined)
    mocks.transaction.mockImplementation(async (run: (tx: unknown) => unknown) => {
        const result = await run({ select: () => new ReadChain(), delete: () => ({ where: mocks.remove }) })
        mocks.commit(); return result
    })
})
describe("编辑历史与Deep取消的事务边界", () => {
    it("锁定会话后，仅取消被移除消息对应任务，再删除消息", async () => {
        expect(await truncateAssistantThreadMessages({ userId: 7, threadId: 11, keepCount: 1 })).toEqual({ deleted: 2 })
        expect(mocks.lock).toHaveBeenCalledOnce()
        expect(mocks.cancel).toHaveBeenCalledWith(expect.anything(), 7, [11], [2, 3])
        expect(mocks.remove).toHaveBeenCalledOnce()
        expect(mocks.cancel.mock.invocationCallOrder[0]).toBeLessThan(mocks.remove.mock.invocationCallOrder[0])
        expect(mocks.commit).toHaveBeenCalledOnce()
    })
    it("取消更新失败时不继续删除或提交", async () => {
        mocks.cancel.mockRejectedValueOnce(new Error("synthetic_failure"))
        await expect(truncateAssistantThreadMessages({ userId: 7, threadId: 11, keepCount: 1 })).rejects.toThrow("synthetic_failure")
        expect(mocks.remove).not.toHaveBeenCalled()
        expect(mocks.commit).not.toHaveBeenCalled()
    })
    it("会话不可访问时不取消任务或删除消息", async () => {
        mocks.read.mockReset().mockResolvedValueOnce([])
        await expect(truncateAssistantThreadMessages({ userId: 7, threadId: 11, keepCount: 1 })).rejects.toThrow("会话不存在")
        expect(mocks.cancel).not.toHaveBeenCalled()
        expect(mocks.remove).not.toHaveBeenCalled()
    })
})
