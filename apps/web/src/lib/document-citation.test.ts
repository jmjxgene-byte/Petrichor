import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { verifyDocumentSourceAnchor } from "./document-citation"
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
describe("原文引用版本校验", () => {
    it("保留BOM、CRLF、emoji偏移，验证第二处重复文本", async () => {
        const text = "\uFEFF# 标题\r\n\r\n相同😀\r\n\r\n相同😀"
        const startOffset = text.lastIndexOf("相同"), endOffset = text.length
        const anchor = { sourceHash: hash(text), contentHash: hash("相同😀"), startOffset, endOffset, sourceFormat: "raw_markdown" as const }
        expect(await verifyDocumentSourceAnchor(text, anchor)).toBe(true)
        expect(await verifyDocumentSourceAnchor(text.slice(1), anchor)).toBe(false)
        expect(await verifyDocumentSourceAnchor(text, { ...anchor, endOffset: endOffset + 1 })).toBe(false)
        expect(await verifyDocumentSourceAnchor(text, { ...anchor, contentHash: "0".repeat(64) })).toBe(false)
        expect(await verifyDocumentSourceAnchor(text, { ...anchor, sourceFormat: "extracted_text_v1" })).toBe(false)
    })
})
