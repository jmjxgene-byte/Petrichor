import { describe, expect, it } from "vitest"
import { buildDocumentPassages, hashDocumentText } from "./passage-builder"

describe("确定性文档passage", () => {
    it("时间戳消息标题打包完整短消息，避免逐标题碎片化，不猜时间区", () => {
        const messages = Array.from({ length: 20 }, (_, i) => `## 2026\\-09\\-08 12:00:00 示例${i}\n\n合成消息${i}\n\n`)
        const source = "# 群聊\n\n" + messages.join("")
        const rows = buildDocumentPassages(source, "群聊")
        expect(rows.length).toBeLessThan(10)
        for (const message of messages) expect(rows.some((row) => row.text.includes(message))).toBe(true)
        expect(rows.every((row) => row.publishedAt === null)).toBe(true)
        for (const row of rows) expect(source.slice(row.startOffset, row.endOffset)).toBe(row.text)
    })
    it("原始CRLF/BOM位置可回读，frontmatter不入索引", () => {
        const source = '\uFEFF---\r\ntitle: Private metadata\r\n---\r\n# 一级\r\n正文\r\n\r\n## 二级\r\n尾部';
        const rows = buildDocumentPassages(source, "标题")
        expect(rows.length).toBeGreaterThan(0)
        for (const row of rows) {
            expect(source.slice(row.startOffset, row.endOffset)).toBe(row.text)
            expect(row.sourceHash).toBe(hashDocumentText(source))
            expect(row.text).not.toContain("Private metadata")
            expect(row.publishedAt).toBeNull()
        }
        expect(rows.at(-1)?.locator).toBe("一级 > 二级")
        expect(buildDocumentPassages(source, "标题")).toEqual(rows)
    })
    it("不同长度和类型围栏内的标题不成为章节，不切断代码", () => {
        const code = "````md\n# 不是真标题\n```\n~~~\n" + "代码".repeat(700) + "\n````\n"
        const rows = buildDocumentPassages("# 章节\n\n" + code + "\n尾部", "文档")
        expect(rows.find((row) => row.text === code)?.locator).toBe("章节")
        expect(rows.some((row) => row.locator.includes("不是真标题"))).toBe(false)
    })
    it("长段落全部覆盖且保留尾部，不切断emoji代理对", () => {
        const source = "😀内容".repeat(2_000) + "末尾证据"
        const rows = buildDocumentPassages(source, "文档")
        expect(rows.at(-1)?.text).toContain("末尾证据")
        let covered = 0
        for (const row of rows) {
            expect(row.startOffset).toBeLessThanOrEqual(covered)
            covered = Math.max(covered, row.endOffset)
            expect(row.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
            expect(row.parentEndOffset - row.parentStartOffset).toBeLessThanOrEqual(4_000)
            expect(row.contentHash).toBe(hashDocumentText(row.text))
        }
        expect(covered).toBe(source.length)
    })
    it("超大原子代码块拒绝增强索引而非截掉正文", () => {
        expect(() => buildDocumentPassages("```\n" + "x".repeat(4_001) + "\n```", "文档")).toThrow("代码块")
    })
    it("空文档不伪造片段", () => expect(buildDocumentPassages(" \n", "文档")).toEqual([]))
    it("GFM表格保留完整表头，不按768字符切断", () => {
        const table = "| 名称 | 内容 |\n| --- | --- |\n" + "| 示例 | 合成内容 |\n".repeat(90)
        expect(buildDocumentPassages(table, "文档").map((row) => row.text)).toEqual([table])
    })
    it("相同标题的不同章节不会被当作同一上下文", () => {
        const source = "# 相同\n第一处\n\n# 相同\n第二处"
        const rows = buildDocumentPassages(source, "文档")
        expect(rows).toHaveLength(2)
        expect(source.slice(rows[0].parentStartOffset, rows[0].parentEndOffset)).not.toContain("第二处")
    })
})
