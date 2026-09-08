import { createHash } from "node:crypto"
import { buildIndexTokenText } from "@/server/retrieval/tokenize"

export const DOCUMENT_PREPROCESSING_VERSION = 2
export type DocumentPreprocessingVersion = 1 | 2
const CHILD_TARGET = 768
const OVERLAP = 80
const PARENT_MAX = 4_000
type Unit = { start: number; end: number; locator: string; atomic: boolean; section: number; message: boolean }
export type BuiltPassage = {
    passageIndex: number; sourceHash: string; contentHash: string
    startOffset: number; endOffset: number; parentStartOffset: number; parentEndOffset: number
    locator: string; text: string; searchTokens: string; publishedAt: null
}
export function hashDocumentText(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex")
}

/** 位置是未归一化原字符串的UTF-16 offset；CRLF/BOM保持原样，回读必须核验sourceHash。 */
export function buildDocumentPassages(source: string, title: string, version: DocumentPreprocessingVersion = DOCUMENT_PREPROCESSING_VERSION): BuiltPassage[] {
    if (version !== 1 && version !== 2) throw new Error("不支持的文档预处理版本")
    if (Buffer.byteLength(source, "utf8") > 8 * 1024 * 1024) throw new Error("文档超过8MiB")
    const sourceHash = hashDocumentText(source)
    const messageHeading = /^##\s+\d{4}\\?-\d{2}\\?-\d{2}\s+\d{2}:\d{2}(?::\d{2})?(?:\s|$)/
    const h2 = [...source.matchAll(/^## [^\r\n]*/gm)]
    const messageHeadings = h2.filter((h) => messageHeading.test(h[0])).length
    const chatMode = messageHeadings >= 10 && messageHeadings / h2.length >= 0.9
    const units: Unit[] = []
    const heading: Array<{ level: number; title: string }> = []
    const frontmatter = source.match(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0].length ?? 0
    let start = frontmatter
    let end = start
    let fence: { char: string; length: number } | null = null
    let atomic = false
    let section = 0
    let message = false
    const locator = () => (heading.map((h) => h.title).join(" > ") || title).slice(0, 255)
    const flush = () => {
        if (units.length >= 40_000) throw new Error("文档结构单元超过安全上限")
        if (end > start && source.slice(start, end).trim()) {
            const previous = units.at(-1)
            const canPack = previous && ((message && previous.message) || (version === 2 && !message && !previous.message))
            if (canPack && !atomic && !previous.atomic && previous.section === section && end - previous.start <= CHILD_TARGET) {
                previous.end = end
            } else units.push({ start, end, locator: locator(), atomic, section, message })
        }
        start = end
        atomic = false
    }
    for (const match of source.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
        if (!match[0] || match.index < frontmatter) continue
        const line = match[0].replace(/[\r\n]+$/, "")
        const lineEnd = match.index + match[0].length
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
        if (fence) {
            end = lineEnd
            if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) {
                fence = null
                flush()
            }
            continue
        }
        if (marker) {
            flush(); start = match.index; end = lineEnd; atomic = true
            fence = { char: marker[1][0], length: marker[1].length }
            continue
        }
        const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
        if (chatMode && messageHeading.test(line)) {
            flush(); message = true; start = match.index; end = lineEnd
            continue
        }
        if (/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) atomic = true
        if (h) {
            flush()
            message = false
            section++
            while (heading.length && heading.at(-1)!.level >= h[1].length) heading.pop()
            heading.push({ level: h[1].length, title: h[2] })
            start = match.index
        }
        end = lineEnd
        if (!line.trim() && !message) flush()
    }
    flush()
    const children: Unit[] = []
    const pushChild = (unit: Unit) => {
        if (children.length >= 40_000) throw new Error("文档分片超过安全上限")
        children.push(unit)
    }
    for (const unit of units) {
        if (unit.atomic || (unit.message && unit.end - unit.start <= PARENT_MAX)) {
            if (unit.end - unit.start > PARENT_MAX) throw new Error("不可拆分代码块或表格超过上下文预算")
            pushChild(unit)
            continue
        }
        let cursor = unit.start
        while (cursor < unit.end) {
            let stop = Math.min(cursor + CHILD_TARGET, unit.end)
            if (stop < unit.end) {
                const prefix = source.slice(cursor, stop)
                const boundaries = [...prefix.matchAll(/[\n。！？；!?;]/g)]
                const boundary = boundaries.at(-1)?.index
                if (boundary != null && boundary > CHILD_TARGET / 2) stop = cursor + boundary + 1
                if (/^[\uDC00-\uDFFF]$/.test(source[stop] ?? "")) stop--
                if (source[stop - 1] === "\r" && source[stop] === "\n") stop--
            }
            pushChild({ ...unit, start: cursor, end: stop })
            if (stop >= unit.end) break
            cursor = Math.max(cursor + 1, stop - OVERLAP)
            if (/^[\uDC00-\uDFFF]$/.test(source[cursor] ?? "")) cursor--
        }
    }
    const nonempty = children.filter((unit) => source.slice(unit.start, unit.end).trim())
    return nonempty.map((unit, passageIndex) => {
        const text = source.slice(unit.start, unit.end)
        // 使用同标题范围内的完整相邻单元扩展，不截断代码块、不推断回复关系。
        let parentStart = unit.start, parentEnd = unit.end
        for (let distance = 1; distance <= 8; distance++) for (const direction of [-1, 1]) {
            const other = nonempty[passageIndex + direction * distance]
            if (!other || other.section !== unit.section) continue
            const nextStart = Math.min(parentStart, other.start), nextEnd = Math.max(parentEnd, other.end)
            if (nextEnd - nextStart <= PARENT_MAX) { parentStart = nextStart; parentEnd = nextEnd }
        }
        return {
            passageIndex, sourceHash, contentHash: hashDocumentText(text),
            startOffset: unit.start, endOffset: unit.end, parentStartOffset: parentStart, parentEndOffset: parentEnd,
            locator: unit.locator, text, searchTokens: buildIndexTokenText(`${title}\n${unit.locator}\n${text}`), publishedAt: null,
        }
    })
}
