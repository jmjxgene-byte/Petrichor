import { buildQueryTokens } from "@/server/retrieval/tokenize"
import { toKeywordQuery } from "@/server/retrieval/query-rewrite"

const NOISE = new Set(["怎么", "如何", "怎样", "什么", "请问", "这个", "那个", "一下"])

export function documentSearchTerms(query: string): string[] {
    const keyword = toKeywordQuery(query.slice(0, 400)).toLowerCase()
        .replace(/(?:怎么|怎样)(?:操作|处理|做|翻|弄)?[？?。！!\s]*$/, "").trim()
    const phrases = keyword.split(/[\s\p{P}\p{S}]+/u).filter(Boolean)
    return [...new Set([...phrases, ...buildQueryTokens(keyword)])]
        .filter((term) => !NOISE.has(term)).slice(0, 24)
}

/** LIKE 模式与绑定的 ESCAPE 字符配套，%/_ 不是用户通配符。 */
export function literalLikePattern(term: string): string {
    return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

/** 摘要围绕真实词项命中；不再盲取分片前600字符。 */
export function documentHitSnippet(text: string, terms: string[], maxChars = 600): string {
    const lower = text.toLowerCase()
    const positions = terms.map((term) => ({ term, at: lower.indexOf(term) }))
        .filter((hit) => hit.at >= 0)
        .sort((a, b) => b.term.length - a.term.length || a.at - b.at)
    const start = Math.max(0, (positions[0]?.at ?? 0) - 120)
    return text.slice(start, start + maxChars)
}
