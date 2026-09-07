/** extracted_text_v1的固定序列化：调用方按chunkIndex排序；不得trim或美化，否则旧hash/偏移失效。 */
export function serializeDocumentExtractedSource(chunks: ReadonlyArray<{ text: string; locator?: string | null; page?: number | null }>): string {
    return chunks.map((chunk) => `## ${chunk.locator ?? (chunk.page == null ? "正文" : `第${chunk.page}页`)}\n\n${chunk.text}`).join("\n\n")
}
