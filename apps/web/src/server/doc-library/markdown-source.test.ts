import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ fetchS3ObjectBytes: vi.fn() }))
vi.mock("@/server/upload/s3-fetch", () => mocks)
import { readUploadedMarkdown } from "./markdown-source"

const key = "uploads/1/11111111-1111-4111-8111-111111111111.md"
describe("读取当前用户的 Markdown", () => {
    beforeEach(() => vi.clearAllMocks())
    it.each([
        key.replace("uploads/1/", "uploads/2/"), "https://example.com/a.md",
        "uploads/1/../2/a.md", key.replace(".md", ".pdf"),
    ])("非法或越权键不触发下载：%s", async (objectKey) => {
        await expect(readUploadedMarkdown(1, objectKey, "a.md")).rejects.toThrow("当前用户")
        expect(mocks.fetchS3ObjectBytes).not.toHaveBeenCalled()
    })
    it("按实际内容登记，不依赖客户端声明的大小", async () => {
        const data = Buffer.from("# 标题\n\n测试正文")
        mocks.fetchS3ObjectBytes.mockResolvedValue({ data, mime: "text/markdown" })
        const result = await readUploadedMarkdown(1, key, "a.md")
        expect(result.sizeBytes).toBe(data.length)
        expect(result.title).toBe("标题")
        expect(mocks.fetchS3ObjectBytes).toHaveBeenCalledWith(key, { maxBytes: 8 * 1024 * 1024, timeoutMs: 30_000 })
    })
    it("拒绝非法 UTF-8，下载错误不泄漏签名地址", async () => {
        mocks.fetchS3ObjectBytes.mockResolvedValueOnce({ data: Buffer.from([0xff]), mime: "text/plain" })
        await expect(readUploadedMarkdown(1, key, "a.md")).rejects.toThrow("UTF-8")
        mocks.fetchS3ObjectBytes.mockRejectedValueOnce(new Error("https://private.invalid/?signature=private"))
        await expect(readUploadedMarkdown(1, key, "a.md")).rejects.toThrow("读取上传文件失败")
    })
})
