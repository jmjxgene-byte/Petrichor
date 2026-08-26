import { describe, expect, it } from "vitest"
import { detectFileType, parseDelimitedRows, parseDocument } from "./parse"

describe("文档库文件类型", () => {
    it("允许 PDF、DOCX、CSV，并拒绝 Excel", () => {
        expect(detectFileType(new File([], "report.pdf"))).toBe("pdf")
        expect(detectFileType(new File([], "report.docx"))).toBe("docx")
        expect(detectFileType(new File([], "report.csv"))).toBe("csv")
        expect(detectFileType(new File([], "report.tsv"))).toBe("csv")
        expect(detectFileType(new File([], "report.xlsx"))).toBeNull()
        expect(detectFileType(new File([], "report.xls"))).toBeNull()
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
