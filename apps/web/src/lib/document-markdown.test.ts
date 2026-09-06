import { describe, expect, it } from "vitest"
import { DOC_LIBRARY_MAX_MARKDOWN_BYTES, parseDocumentMarkdown } from "./document-markdown"

describe("Markdown 原文件解析", () => {
    it("超过旧 2 MiB 的文档保留末尾正文", () => {
        const text = "# 群聊\n\n" + "消息正文与时间。\n".repeat(110_000) + "\n最后一条唯一消息-END"
        expect(new TextEncoder().encode(text).length).toBeGreaterThan(2 * 1024 * 1024)
        const result = parseDocumentMarkdown(text, "群聊.md")
        expect(result.chunks.at(-1)?.text).toContain("最后一条唯一消息-END")
        expect(result.chunks.length).toBeLessThan(4000)
        expect(result.chunks.every((chunk) => chunk.text.length <= 4000)).toBe(true)
    })
    it("拒绝超限和无正文输入", () => {
        expect(() => parseDocumentMarkdown("a".repeat(DOC_LIBRARY_MAX_MARKDOWN_BYTES + 1), "x.md")).toThrow("8 MiB")
        expect(() => parseDocumentMarkdown("  \n", "x.md")).toThrow("正文")
    })
    it("保留 frontmatter 标题但不索引元数据", () => {
        const result = parseDocumentMarkdown("---\ntitle: 测试\nsecret: excluded\n---\n# 内容\n正文", "x.md")
        expect(result.title).toBe("测试")
        expect(result.chunks.map((c) => c.text).join("")).not.toContain("excluded")
    })
})
