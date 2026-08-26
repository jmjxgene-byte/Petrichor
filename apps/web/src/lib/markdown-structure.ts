const DEFAULT_CHUNK_MAX_CHARS = 3_200
const DEFAULT_CHUNK_TARGET_CHARS = 1_200
const DEFAULT_CHUNK_MIN_TAIL_CHARS = 400
const DEFAULT_SHORT_HEADING_CHARS = 120
const HEADING_DOMINANCE_RATIO = 0.6
const DEFAULT_CHUNK_OVERLAP_CHARS = 320

export const DEFAULT_MARKDOWN_CHUNK_LIMIT = 120

const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const FENCE_PATTERN = /^\s*(```|~~~)/
const SENTENCE_END_PATTERN = /[。！？；!?;]/g

export type MarkdownSection = {
    headingPath: string[]
    heading: string
    text: string
}

export type MarkdownChunk = {
    chunkKey: string
    position: number
    heading: string
    headingPath: string[]
    contentMd: string
}

export type MarkdownDocumentSource = {
    markdown: string
    frontmatterTitle: string | null
}

type FenceSpan = { start: number; end: number }

export function extractMarkdownDocumentSource(source: string): MarkdownDocumentSource {
    const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
    if (!normalized.startsWith("---\n")) {
        return { markdown: normalized, frontmatterTitle: null }
    }

    const closingIndex = normalized.indexOf("\n---\n", 4)
    if (closingIndex < 0) {
        return { markdown: normalized, frontmatterTitle: null }
    }

    const frontmatter = normalized.slice(4, closingIndex)
    const titleLine = frontmatter.split("\n").find((line) => /^title\s*:/i.test(line))
    const rawTitle = titleLine?.replace(/^title\s*:\s*/i, "").trim() ?? ""
    const frontmatterTitle = rawTitle
        .replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, doubleQuoted, singleQuoted) =>
            String(doubleQuoted ?? singleQuoted ?? "").trim())
        .trim() || null

    return {
        markdown: normalized.slice(closingIndex + "\n---\n".length),
        frontmatterTitle,
    }
}

export function parseMarkdownSections(markdown: string, articleTitle: string): MarkdownSection[] {
    const normalized = markdown.replace(/\r\n?/g, "\n").trim()
    if (!normalized) return []

    const sections: MarkdownSection[] = []
    const stack: Array<{ level: number; title: string }> = []
    let buffer: string[] = []
    let inFence = false

    const flush = () => {
        const text = buffer.join("\n").trim()
        buffer = []
        if (!text) return
        sections.push({
            headingPath: stack.map((item) => item.title),
            heading: stack.at(-1)?.title ?? (articleTitle.trim() || "文档正文"),
            text,
        })
    }

    for (const line of normalized.split("\n")) {
        if (FENCE_PATTERN.test(line)) {
            inFence = !inFence
            buffer.push(line)
            continue
        }
        const match = inFence ? null : line.match(HEADING_PATTERN)
        if (match) {
            flush()
            const level = match[1].length
            while (stack.length > 0 && stack.at(-1)!.level >= level) stack.pop()
            stack.push({ level, title: match[2].trim() || articleTitle })
        }
        buffer.push(line)
    }
    flush()
    return sections
}

export function splitMarkdownForKnowledgeBuild(
    markdown: string,
    articleTitle: string,
    maxChars = DEFAULT_CHUNK_MAX_CHARS,
    chunkLimit = DEFAULT_MARKDOWN_CHUNK_LIMIT,
): { chunks: MarkdownChunk[]; truncated: boolean } {
    const sections = parseMarkdownSections(markdown, articleTitle)
    if (sections.length === 0) return { chunks: [], truncated: false }

    const chunks: MarkdownChunk[] = []
    for (const merged of mergeSections(sections, articleTitle, maxChars)) {
        for (const piece of splitLongSection(merged.text, maxChars, DEFAULT_CHUNK_OVERLAP_CHARS)) {
            if (chunks.length >= chunkLimit) return { chunks, truncated: true }
            const position = chunks.length
            chunks.push({
                chunkKey: `chunk-${String(position + 1).padStart(3, "0")}`,
                position,
                heading: merged.heading,
                headingPath: merged.headingPath,
                contentMd: piece,
            })
        }
    }
    return { chunks, truncated: false }
}

function mergeSections(sections: MarkdownSection[], articleTitle: string, maxChars: number) {
    const groups: MarkdownSection[][] = []
    let current: MarkdownSection[] = []
    let currentLength = 0

    for (const section of sections) {
        if (current.length === 0) {
            current = [section]
            currentLength = section.text.length
            continue
        }
        const sameTop = topLevelOf(section) === topLevelOf(current[0])
        const onlyShortHeading = current.every(isShortHeadingOnly)
        const projected = currentLength + section.text.length + 1
        const mayOverflow = currentLength < DEFAULT_CHUNK_MIN_TAIL_CHARS && projected <= maxChars
        if (!sameTop || (!onlyShortHeading && !mayOverflow && projected > DEFAULT_CHUNK_TARGET_CHARS)) {
            groups.push(current)
            current = [section]
            currentLength = section.text.length
            continue
        }
        current.push(section)
        currentLength = projected
    }
    if (current.length > 0) groups.push(current)

    for (let index = groups.length - 1; index >= 0; index -= 1) {
        const group = groups[index]
        if (groupLength(group) >= DEFAULT_CHUNK_MIN_TAIL_CHARS) continue
        const next = groups[index + 1]
        const prev = groups[index - 1]
        const length = groupLength(group)
        if (next && topLevelOf(next[0]) === topLevelOf(group[0]) && length + groupLength(next) <= maxChars) {
            groups.splice(index, 2, [...group, ...next])
        } else if (prev && topLevelOf(prev[0]) === topLevelOf(group[0]) && length + groupLength(prev) <= maxChars) {
            groups.splice(index - 1, 2, [...prev, ...group])
        }
    }

    return groups.map((group) => ({
        ...resolveMergedHeading(group, articleTitle),
        text: group.map((section) => section.text).join("\n\n"),
    }))
}

function isShortHeadingOnly(section: MarkdownSection) {
    return section.text.length <= DEFAULT_SHORT_HEADING_CHARS
}

function resolveMergedHeading(group: MarkdownSection[], articleTitle: string) {
    if (group.length === 1) return { heading: group[0].heading, headingPath: group[0].headingPath }
    const total = group.reduce((sum, section) => sum + section.text.length, 0)
    const dominant = group.find((section) => section.text.length >= total * HEADING_DOMINANCE_RATIO)
    const anchor = dominant ?? group.find((section) => !isShortHeadingOnly(section)) ?? group[0]
    return {
        heading: anchor.headingPath.at(-1) ?? (articleTitle.trim() || "文档正文"),
        headingPath: anchor.headingPath,
    }
}

function topLevelOf(section: MarkdownSection) {
    return section.headingPath[0] ?? "\u0000导语"
}

function groupLength(group: MarkdownSection[]) {
    return group.reduce((sum, section) => sum + section.text.length, 0)
}

function collectFenceSpans(text: string): FenceSpan[] {
    const spans: FenceSpan[] = []
    let offset = 0
    let openAt: number | null = null
    for (const line of text.split("\n")) {
        if (FENCE_PATTERN.test(line)) {
            if (openAt == null) openAt = offset
            else {
                spans.push({ start: openAt, end: offset + line.length })
                openAt = null
            }
        }
        offset += line.length + 1
    }
    if (openAt != null) spans.push({ start: openAt, end: text.length })
    return spans
}

function fenceSpanAt(spans: FenceSpan[], index: number): FenceSpan | null {
    return spans.find((span) => index > span.start && index < span.end) ?? null
}

function findBreakPoint(text: string, from: number, to: number, spans: FenceSpan[]): number | null {
    const candidates: number[] = []
    const paragraph = text.lastIndexOf("\n\n", to)
    if (paragraph > from) candidates.push(paragraph)
    const line = text.lastIndexOf("\n", to)
    if (line > from) candidates.push(line)
    SENTENCE_END_PATTERN.lastIndex = 0
    let sentence = -1
    for (const match of text.slice(from, to).matchAll(SENTENCE_END_PATTERN)) {
        sentence = from + match.index + match[0].length
    }
    if (sentence > from) candidates.push(sentence)
    for (const candidate of candidates) {
        if (!fenceSpanAt(spans, candidate)) return candidate
    }
    return null
}

function splitLongSection(text: string, maxChars: number, overlapChars: number): string[] {
    if (text.length <= maxChars) return [text]
    const spans = collectFenceSpans(text)
    const chunks: string[] = []
    let cursor = 0
    while (cursor < text.length) {
        const hardEnd = Math.min(text.length, cursor + maxChars)
        let end = hardEnd
        if (hardEnd < text.length) {
            const floor = cursor + Math.floor(maxChars * 0.55)
            const candidate = findBreakPoint(text, floor, hardEnd, spans)
            if (candidate != null) end = candidate
            else {
                const span = fenceSpanAt(spans, hardEnd)
                end = span ? span.end : hardEnd
            }
        }
        const value = text.slice(cursor, end).trim()
        if (value) chunks.push(value)
        if (end >= text.length) break
        let next = Math.max(end - overlapChars, cursor + 1)
        const overlapSpan = fenceSpanAt(spans, next)
        if (overlapSpan) next = Math.max(overlapSpan.end, cursor + 1)
        const aligned = text.indexOf("\n", next)
        cursor = aligned > next && aligned < end ? aligned + 1 : next
    }
    return chunks
}
