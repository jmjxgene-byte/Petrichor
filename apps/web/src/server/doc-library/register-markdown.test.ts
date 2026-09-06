import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ getDb: vi.fn(), readUploadedMarkdown: vi.fn() }))
vi.mock("@/server/db/client", () => ({ getDb: mocks.getDb, isSqliteDatabase: () => false }))
vi.mock("./markdown-source", () => ({ readUploadedMarkdown: mocks.readUploadedMarkdown }))
vi.mock("@/server/cache", () => ({
    CACHE_TTL_SECONDS: {}, cacheDropByPrefix: vi.fn(), cacheReadThrough: vi.fn(),
    cacheKey: (...parts: unknown[]) => parts.join(":"),
}))
import { registerDocument } from "./library-logic"

const input = { userId: 1, libraryId: 10, folderId: null, fileName: "test.md", title: null,
    fileType: "markdown" as const, contentType: "text/markdown", objectKey: "uploads/1/test.md",
    sizeBytes: 999, pageCount: null, parseFromSource: true }
function database(libraryExists = true, folderExists = true) {
    let selects = 0
    const inserted: unknown[] = []
    const insert = vi.fn(() => ({ values: (value: unknown) => {
        inserted.push(value)
        return { returning: async () => [{ id: 42 }] }
    } }))
    const tx = { insert, update: () => ({ set: () => ({ where: async () => undefined }) }) }
    const db = {
        select: () => ({ from: () => ({ where: () => ({ limit: async () => {
            selects++
            return (selects === 1 ? libraryExists : folderExists) ? [{ id: 10 }] : []
        } }) }) }),
        transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
    }
    mocks.getDb.mockReturnValue(db)
    return { db, inserted }
}
describe("Markdown 登记权限和事务", () => {
    beforeEach(() => vi.clearAllMocks())
    it("先校验文档库归属，禁止未授权来源读取", async () => {
        const { db } = database(false)
        await expect(registerDocument(input)).rejects.toThrow("文档库不存在")
        expect(mocks.readUploadedMarkdown).not.toHaveBeenCalled()
        expect(db.transaction).not.toHaveBeenCalled()
    })
    it("文件夹不属于目标库时不读取对象", async () => {
        database(true, false)
        await expect(registerDocument({ ...input, folderId: 99 })).rejects.toThrow("文件夹不存在")
        expect(mocks.readUploadedMarkdown).not.toHaveBeenCalled()
    })
    it("解析失败不写 ready 文档或增加计数", async () => {
        const { db } = database()
        mocks.readUploadedMarkdown.mockRejectedValueOnce(new Error("解析失败"))
        await expect(registerDocument(input)).rejects.toThrow("解析失败")
        expect(db.transaction).not.toHaveBeenCalled()
    })
    it("原文件解析结果用于原有原子登记事务", async () => {
        const { inserted } = database()
        mocks.readUploadedMarkdown.mockResolvedValueOnce({ title: "原文标题", sizeBytes: 40,
            pageCount: null, blocks: [], chunks: [{ text: "正文结尾", page: null, locator: "标题" }] })
        expect(await registerDocument(input)).toEqual({ id: "42" })
        expect(inserted[0]).toMatchObject({ title: "原文标题", sizeBytes: 40, status: "ready" })
        expect(inserted[1]).toEqual([expect.objectContaining({ text: "正文结尾", documentId: 42 })])
    })
    it("不能给非 Markdown 或自带 chunks 的请求启用原文解析", async () => {
        database()
        await expect(registerDocument({ ...input, fileType: "pdf" })).rejects.toThrow("仅支持")
        await expect(registerDocument({ ...input, chunks: [{ text: "伪造" }] })).rejects.toThrow("仅支持")
        expect(mocks.readUploadedMarkdown).not.toHaveBeenCalled()
    })
})
