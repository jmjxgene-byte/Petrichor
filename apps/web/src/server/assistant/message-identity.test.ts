import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ values: vi.fn(), returning: vi.fn(), update: vi.fn(), set: vi.fn(), where: vi.fn() }))
vi.mock("@/server/db/client", () => ({ getDb: () => ({ insert: () => ({ values: mocks.values }), update: mocks.update }), isSqliteDatabase: () => false }))
import { persistAssistantMessage } from "./thread-logic"
beforeEach(() => {
    vi.clearAllMocks()
    mocks.values.mockReturnValue({ returning: mocks.returning })
    mocks.returning.mockResolvedValue([{ id: 79 }])
    mocks.update.mockReturnValue({ set: mocks.set }); mocks.set.mockReturnValue({ where: mocks.where }); mocks.where.mockResolvedValue(undefined)
})
describe("服务器消息身份", () => {
    it("返回数据库分配的ID，不采用客户端字段", async () => {
        expect(await persistAssistantMessage({ userId: 7, threadId: 11, role: "user", content: { id: "client-id", questionMessageId: "123", text: "合成" } })).toBe(79)
        expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({ threadId: 11, role: "user" }))
        expect(mocks.returning).toHaveBeenCalledOnce()
    })
    it("无数据库ID时明确失败，不继续伪装保存成功", async () => {
        mocks.returning.mockResolvedValueOnce([])
        await expect(persistAssistantMessage({ userId: 7, threadId: 11, role: "user", content: "合成" })).rejects.toThrow("消息保存未返回ID")
        expect(mocks.update).not.toHaveBeenCalled()
    })
})
