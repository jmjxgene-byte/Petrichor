import type { DocDocumentDetail, DocLibrary } from "@/lib/api"
import type { DocumentIndexStatus, DocumentIndexQuote } from "@/lib/document-index-types"

/** 纯浏览器内存演示；无数据库、模型或实际费用。 */
const date = "2026-09-08T00:00:00Z"
const source = "# 演示文档\n\n这是用于界面验证的合成文本，不是真实知识。\n"
export const demoIndexLibrary: DocLibrary = { id: "700001", name: "示例资料库（演示）", description: "合成示例，不连接真实数据", color: null, icon: null, documentCount: 1, createdAt: date, updatedAt: date }
export const demoIndexDocument: DocDocumentDetail = { id: "700101", libraryId: "700001", folderId: null, fileName: "synthetic.md", title: "演示文档",
    fileType: "markdown", contentType: "text/markdown", objectKey: "demo/document-index.md", sizeBytes: new TextEncoder().encode(source).length,
    pageCount: null, status: "ready", createdAt: date, updatedAt: date, charCount: source.length,
    blocks: [], chunks: [{ chunkIndex: 0, page: null, locator: "演示文档", text: source }], summary: null }
let phase: "not_built" | "ready_to_activate" | "ready" | "cancelled" = "not_built"
export function demoDocumentIndexStatus(): DocumentIndexStatus {
    const generation = phase === "not_built" ? null : { id: "700201", status: phase === "cancelled" ? "cancelled" : "ready", expectedDocuments: 1, completedDocuments: 1, passageCount: 1,
        manifestHash: "0".repeat(64), errorCode: null, updatedAt: date }
    return { libraryId: "700001", enabled: true, workerConfigured: false, hybridConfigured: false, keywordDocuments: 1,
        phase, currentReady: phase === "ready", current: phase === "ready" ? generation : null, latest: generation }
}
export function demoDocumentIndexQuote(): DocumentIndexQuote {
    return { token: "demo-only-not-a-real-signature", libraryId: "700001", documentCount: 1, passageCount: 1,
        maxInputTokens: 100, maxCostMicrousd: 100, quoteExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        executionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), model: "演示模型（不调用）", manifestHash: "0".repeat(64) }
}
export function demoCompleteIndex() { phase = "ready_to_activate"; return { generationId: "700201", status: "ready" } }
export function demoActivateIndex() { phase = "ready"; return { generationId: 700201, manifestHash: "0".repeat(64) } }
export function demoCancelIndex() { phase = "cancelled"; return { generationId: "700201", status: "cancelled" } }
export function demoIndexSourceUrl() { return `data:text/markdown;charset=utf-8,${encodeURIComponent(source)}` }
