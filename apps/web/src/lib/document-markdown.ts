import { extractMarkdownDocumentSource, parseMarkdownSections, splitMarkdownForKnowledgeBuild } from "./markdown-structure"

export const DOC_LIBRARY_MAX_MARKDOWN_BYTES = 8 * 1024 * 1024

/** 浏览器与服务端共享结构解析；超出索引能力时明确拒绝，不静默丢弃尾部。 */
export function parseDocumentMarkdown(text: string, fileName: string) {
    if (new TextEncoder().encode(text).byteLength > DOC_LIBRARY_MAX_MARKDOWN_BYTES) {
        throw new Error("Markdown 文件不能超过 8 MiB")
    }
    const source = extractMarkdownDocumentSource(text)
    const fallback = fileName.replace(/\.(?:md|markdown)$/i, "") || fileName
    const title = source.frontmatterTitle
        ?? parseMarkdownSections(source.markdown, fallback).find((section) => section.headingPath.length > 0)?.headingPath[0]
        ?? fallback
    const result = splitMarkdownForKnowledgeBuild(source.markdown, title, 3_200, 4_000)
    if (result.truncated) throw new Error("Markdown 分片超过 4000 条，请按章节拆分后上传")
    if (result.chunks.length === 0) throw new Error("Markdown 文档没有可索引的正文")
    if (result.chunks.some((chunk) => chunk.contentMd.length > 4_000)) {
        throw new Error("Markdown 含过长且不可拆分的代码块，请拆分该代码块后上传")
    }
    return {
        title: title.slice(0, 255), pageCount: null, blocks: [],
        chunks: result.chunks.map((chunk) => ({
            text: chunk.contentMd, page: null,
            locator: (chunk.headingPath.join(" > ") || chunk.heading).slice(0, 80),
        })),
    }
}
