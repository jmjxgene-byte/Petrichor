import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ reader: null as unknown, fetch: vi.fn() }))
vi.mock("@/server/db/read-budget", () => ({ withReadBudget: async (run: (reader: unknown, checkpoint: () => Promise<void>) => Promise<unknown>) => run(mocks.reader, async () => {}) }))
vi.mock("@/server/upload/s3-fetch", () => ({ fetchS3ObjectBytes: mocks.fetch }))
import { loadDocumentIndexSource } from "./index-source"
const document = { id: 1, userId: 7, libraryId: 3, title: "合成标题", fileType: "markdown", updatedAt: new Date(0), objectKey: "uploads/7/00000000-0000-4000-8000-000000000000.md" }
function fixture(results: unknown[][]) {
    let cursor = 0
    mocks.reader = { select: () => {
        const rows = results[cursor++] ?? []
        const chain = { from: () => chain, where: () => chain, orderBy: () => chain, limit: () => chain,
            then: <T>(resolve: (rows: unknown[]) => T) => Promise.resolve(rows).then(resolve) }
        return chain
    } }
}
beforeEach(() => vi.clearAllMocks())
describe("索引输入来源适配", () => {
    it("Markdown保留BOM与换行并传递取消信号", async () => {
        fixture([[document]])
        const source = "\uFEFF# 合成\r\n原文"
        mocks.fetch.mockResolvedValue({ data: Buffer.from(source) })
        const controller = new AbortController()
        expect(await loadDocumentIndexSource(7, 3, 1, controller.signal)).toMatchObject({ source, sourceFormat: "raw_markdown" })
        expect(mocks.fetch).toHaveBeenCalledWith(document.objectKey, expect.objectContaining({ abortSignal: controller.signal, maxBytes: 8*1024*1024 }))
    })
    it("无归属文档及跨用户对象键均不读取S3", async () => {
        fixture([[]])
        await expect(loadDocumentIndexSource(7, 3, 1)).rejects.toThrow("不可访问")
        fixture([[{ ...document, objectKey: document.objectKey.replace("/7/", "/8/") }]])
        await expect(loadDocumentIndexSource(7, 3, 1)).rejects.toThrow("对象键")
        expect(mocks.fetch).not.toHaveBeenCalled()
    })
    it.each(["pdf", "docx", "csv"])("%s复用已有提取内容，声明非原始字节定位", async (fileType) => {
        fixture([[{ ...document, fileType }], [{ locator: null, page: 3, text: "合成提取内容" }]])
        expect(await loadDocumentIndexSource(7, 3, 1)).toMatchObject({ source: "## 第3页\n\n合成提取内容", sourceFormat: "extracted_text_v1" })
        expect(mocks.fetch).not.toHaveBeenCalled()
    })
    it("Excel仍不进入增强索引", async () => {
        fixture([[{ ...document, fileType: "xlsx" }]])
        await expect(loadDocumentIndexSource(7, 3, 1)).rejects.toThrow("不支持")
    })
})
