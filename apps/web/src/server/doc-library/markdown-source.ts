import { DOC_LIBRARY_MAX_MARKDOWN_BYTES, parseDocumentMarkdown } from "@/lib/document-markdown"
import { HttpError } from "@/server/http/response"
import { fetchS3ObjectBytes } from "@/server/upload/s3-fetch"

export async function readUploadedMarkdown(userId: number, objectKey: string, fileName: string) {
    const keyPattern = new RegExp(`^uploads/${userId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(md|markdown)$`, "i")
    if (!keyPattern.test(objectKey)) throw new HttpError(400, "仅允许读取当前用户上传的 Markdown 文件")
    let data: Buffer
    try {
        ({ data } = await fetchS3ObjectBytes(objectKey, { maxBytes: DOC_LIBRARY_MAX_MARKDOWN_BYTES, timeoutMs: 30_000 }))
    } catch (error) {
        if (error instanceof HttpError) throw error
        throw new HttpError(502, "读取上传文件失败，请稍后重试")
    }
    if (data.length === 0 || data.length > DOC_LIBRARY_MAX_MARKDOWN_BYTES) throw new HttpError(413, "Markdown 文件大小必须在 1 B 到 8 MiB 之间")
    let text: string
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(data) }
    catch { throw new HttpError(400, "Markdown 文件必须使用 UTF-8 编码") }
    try { return { ...parseDocumentMarkdown(text, fileName), sizeBytes: data.length } }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "Markdown 解析失败") }
}
