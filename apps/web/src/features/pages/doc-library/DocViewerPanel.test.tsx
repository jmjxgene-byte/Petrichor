// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("@/components/theme-provider", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }))
vi.mock("@/components/extend/ui/pdf-viewer", () => ({ PDFViewer: () => null }))
vi.mock("@/components/extend/ui/docx-viewer", () => ({ DocxViewerPreview: () => null }))
vi.mock("@/lib/api", () => ({ uploadApi: { presignGet: async () => ({ data: { url: "https://example.invalid/synthetic" } }) } }))
import { DocViewerPanel } from "./DocViewerPanel"
import { demoIndexDocument } from "@/lib/demo/demo-document-index"
import { serializeDocumentExtractedSource } from "@/lib/document-extracted-source"
beforeEach(() => vi.stubGlobal("crypto", webcrypto))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe("提取文本引用查看器", () => {
    it.each(["pdf", "docx", "csv"] as const)("%s切到核验后的文本，不声称页面坐标定位", async (fileType) => {
        const chunks = [{ chunkIndex: 2, text: "命中重复", page: 3, locator: null }, { chunkIndex: 0, text: "命中重复", page: 1, locator: null }]
        const text = serializeDocumentExtractedSource(chunks.slice().sort((a, b) => a.chunkIndex - b.chunkIndex))
        const hash = (value: string) => createHash("sha256").update(value).digest("hex")
        const anchor = { sourceFormat: "extracted_text_v1" as const, sourceHash: hash(text), contentHash: hash("命中重复"), startOffset: text.lastIndexOf("命中重复"), endOffset: text.length }
        const { container, rerender } = render(<DocViewerPanel document={{ ...demoIndexDocument, fileType, chunks }} sourceAnchor={anchor} />)
        await screen.findByText("文本版本与引用位置已核验")
        expect(screen.getByRole("tab", { name: "文本" }).getAttribute("aria-selected")).toBe("true")
        expect(screen.getByText(/不是原文件页面坐标/)).toBeTruthy()
        expect(container.querySelectorAll("[data-citation-hit]")).toHaveLength(1)
        rerender(<DocViewerPanel document={{ ...demoIndexDocument, fileType, chunks: [...chunks, { chunkIndex: 3, text: "已变更", page: null, locator: null }] }} sourceAnchor={anchor} />)
        await screen.findByText("文本版本或位置不匹配，未在文本中定位。")
        expect(container.querySelector("[data-citation-hit]")).toBeNull()
    })
})
