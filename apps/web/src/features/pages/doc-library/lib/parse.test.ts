import { describe, expect, it } from "vitest"
import {
    detectFileType,
    DOC_LIBRARY_MAX_REGISTER_PAYLOAD_BYTES,
    jsonPayloadByteLength,
    parseDelimitedRows,
    parseDocument,
} from "./parse"

describe("文档库文件类型", () => {
    it("允许 PDF、DOCX、Markdown、CSV，并拒绝 Excel", () => {
        expect(detectFileType(new File([], "report.pdf"))).toBe("pdf")
        expect(detectFileType(new File([], "report.docx"))).toBe("docx")
        expect(detectFileType(new File([], "README.md"))).toBe("markdown")
        expect(detectFileType(new File([], "guide.markdown"))).toBe("markdown")
        expect(detectFileType(new File([], "report.csv"))).toBe("csv")
        expect(detectFileType(new File([], "report.tsv"))).toBe("csv")
        expect(detectFileType(new File([], "report.xlsx"))).toBeNull()
        expect(detectFileType(new File([], "report.xls"))).toBeNull()
    })
})

describe("Markdown 结构解析", () => {
    it("读取 frontmatter 标题但不把 frontmatter 放入检索分片", async () => {
        const file = new File([
            "---\ntitle: 部署手册\ntags: [ops]\n---\n# 安装\n\n正文\n\n## 配置\n\n更多内容",
        ], "README.md", { type: "text/markdown" })

        const parsed = await parseDocument(file, "markdown")

        expect(parsed.title).toBe("部署手册")
        expect(parsed.chunks.map((chunk) => chunk.text).join("\n")).not.toContain("tags:")
        expect(parsed.chunks.some((chunk) => chunk.locator?.includes("安装"))).toBe(true)
        expect(parsed.chunks.map((chunk) => chunk.text).join("\n")).toContain("## 配置")
    })

    it("代码围栏里的井号不会被误判为标题或切断", async () => {
        const file = new File([
            "# 示例\n\n```bash\n# 这是注释\necho ok\n```\n\n后续说明",
        ], "code.md")

        const parsed = await parseDocument(file, "markdown")
        const text = parsed.chunks.map((chunk) => chunk.text).join("\n")

        expect(text).toContain("# 这是注释")
        expect(text).toContain("```bash")
        expect(text).toContain("```")
    })
})

describe("文档注册载荷", () => {
    it("按 UTF-8 字节数计算，并为 Vercel 限制保留余量", () => {
        expect(jsonPayloadByteLength({ text: "中文" })).toBeGreaterThan(JSON.stringify({ text: "中文" }).length)
        expect(DOC_LIBRARY_MAX_REGISTER_PAYLOAD_BYTES).toBeLessThan(4.5 * 1024 * 1024)
    })
})

describe("CSV 安全解析", () => {
    it("处理引号、逗号和换行", () => {
        expect(parseDelimitedRows('name,note\r\nAlice,"hello, world"\r\nBob,"line 1\nline 2"', ","))
            .toEqual([
                ["name", "note"],
                ["Alice", "hello, world"],
                ["Bob", "line 1\nline 2"],
            ])
    })

    it("拒绝未闭合引号", () => {
        expect(() => parseDelimitedRows('name,"broken', ",")).toThrow("未闭合")
    })

    it("生成带表头语义的检索分片", async () => {
        const file = new File(["name,role\nAlice,Admin\nBob,Member"], "members.csv", {
            type: "text/csv",
        })
        const parsed = await parseDocument(file, "csv")

        expect(parsed.chunks).toHaveLength(1)
        expect(parsed.chunks[0]?.text).toContain("name: Alice")
        expect(parsed.chunks[0]?.text).toContain("role: Member")
    })
})
