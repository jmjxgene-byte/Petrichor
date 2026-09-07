import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { serializeDocumentExtractedSource } from "./document-extracted-source"
import { verifyDocumentSourceAnchor } from "./document-citation"
describe("提取文本v1位置契约", () => {
    it("保留每个locator、重复标题、空白和换行，不改动既有序列化", async () => {
        const chunks = [{ text: " 前文\r\n", page: 3, locator: null }, { text: "重复", page: null, locator: "表[1]" }, { text: "重复", page: null, locator: "表[1]" }]
        const source = serializeDocumentExtractedSource(chunks)
        expect(source).toBe("## 第3页\n\n 前文\r\n\n\n## 表[1]\n\n重复\n\n## 表[1]\n\n重复")
        const hash = (value: string) => createHash("sha256").update(value).digest("hex")
        const anchor = { sourceFormat: "extracted_text_v1" as const, startOffset: source.lastIndexOf("重复"), endOffset: source.length, sourceHash: hash(source), contentHash: hash("重复") }
        expect(await verifyDocumentSourceAnchor(source, anchor, "extracted_text_v1")).toBe(true)
        expect(await verifyDocumentSourceAnchor(source, anchor)).toBe(false)
        expect(await verifyDocumentSourceAnchor(source.trimStart(), anchor, "extracted_text_v1")).toBe(true)
        expect(await verifyDocumentSourceAnchor(source.replace(" 前文", "前文"), anchor, "extracted_text_v1")).toBe(false)
    })
})
