import { and, asc, eq } from "drizzle-orm"
import { docDocuments, docChunks } from "@/server/db/schema"
import { withReadBudget } from "@/server/db/read-budget"
import { fetchS3ObjectBytes } from "@/server/upload/s3-fetch"

/** Markdown offset指向原UTF-8文本；其他格式指向带原locator的版本化提取文本，不冒充PDF字节位置。 */
export async function loadDocumentIndexSource(userId: number, libraryId: number, documentId: number, abortSignal?: AbortSignal) {
    const loaded = await withReadBudget(async (reader, checkpoint) => {
        const [document] = await reader.select().from(docDocuments).where(and(eq(docDocuments.id, documentId),
            eq(docDocuments.userId, userId), eq(docDocuments.libraryId, libraryId), eq(docDocuments.status, "ready"))).limit(1)
        if (!document) throw new Error("索引源文档不可访问")
        if (document.fileType === "markdown") return { document, extracted: null }
        if (!["pdf", "docx", "csv"].includes(document.fileType)) throw new Error("不支持该格式增强索引")
        await checkpoint()
        const chunks = await reader.select({ text: docChunks.text, locator: docChunks.locator, page: docChunks.page }).from(docChunks)
            .where(and(eq(docChunks.documentId, documentId), eq(docChunks.userId, userId), eq(docChunks.libraryId, libraryId)))
            .orderBy(asc(docChunks.chunkIndex)).limit(4_001)
        if (!chunks.length || chunks.length > 4_000) throw new Error("原始提取片段为空或超过上限")
        const extracted = chunks.map((chunk) => `## ${chunk.locator ?? (chunk.page == null ? "正文" : `第${chunk.page}页`)}\n\n${chunk.text}`).join("\n\n")
        return { document, extracted }
    }, { abortSignal })
    let source: string
    const sourceFormat = loaded.extracted == null ? "raw_markdown" as const : "extracted_text_v1" as const
    if (loaded.extracted != null) source = loaded.extracted
    else {
        if (!new RegExp(`^uploads/${userId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(md|markdown)$`, "i").test(loaded.document.objectKey)) throw new Error("索引对象键无效")
        const { data } = await fetchS3ObjectBytes(loaded.document.objectKey, { maxBytes: 8 * 1024 * 1024, timeoutMs: 30_000, abortSignal })
        source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data)
    }
    if (!source.trim() || Buffer.byteLength(source, "utf8") > 8 * 1024 * 1024) throw new Error("索引文本为空或超过8MiB")
    return { source, sourceFormat, title: loaded.document.title, updatedAt: loaded.document.updatedAt.toISOString() }
}
