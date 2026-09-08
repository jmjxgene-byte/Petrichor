/** 只验证引用身份，不将格式合法当成语义支持或答案正确。 */
export function validateGroundedCitations(answer: string, readableIndices: ReadonlySet<number>) {
    // 代码示例、Markdown链接不构成资料引用。
    let fence: { character: string; length: number } | null = null
    const prose = answer.split("\n").filter((line) => {
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
        if (fence) {
            if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = null
            return false
        }
        if (marker) { fence = { character: marker[1][0], length: marker[1].length }; return false }
        return true
    }).join("\n").replace(/(`+)[\s\S]*?\1/g, "")
    const indices = [...prose.matchAll(/(?<!\\)\[(\d+)\](?!\s*[(:])/g)].map((match) => Number(match[1]))
    if (!indices.length) return { valid: false, reason: "missing_citation" as const, count: 0 }
    if (indices.some((index) => !Number.isSafeInteger(index) || index < 1 || !readableIndices.has(index))) return { valid: false, reason: "unread_citation" as const, count: indices.length }
    return { valid: true, reason: "valid_references" as const, count: indices.length }
}

export const UNVERIFIED_CITATION_ANSWER = "本次回答未通过资料引用核验，我暂不提供未经核验的结论。请补充具体对象或问题，我会重新检索当前选定的资料。"
