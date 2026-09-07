export type EvidenceChunk = { chunkIndex: number; text: string }

/** 核心命中先占预算，前后文只用剩余额度，不能把尾部命中裁掉。 */
export function buildEvidenceWindow(chunks: EvidenceChunk[], anchorIndex: number, maxChars = 4_000) {
    const anchor = chunks.find((chunk) => chunk.chunkIndex === anchorIndex)
    if (!anchor || !anchor.text.trim()) throw new Error("命中片段已失效")
    if (anchor.text.length > maxChars) throw new Error("命中片段超出证据窗口预算")
    const separator = "\n\n"
    const neighbors = chunks.filter((chunk) => chunk.chunkIndex !== anchorIndex)
        .sort((a, b) => Math.abs(a.chunkIndex - anchorIndex) - Math.abs(b.chunkIndex - anchorIndex)
            || a.chunkIndex - b.chunkIndex)
    let remaining = maxChars - anchor.text.length
    const selected = [{ ...anchor }]
    for (const chunk of neighbors) {
        const take = Math.min(chunk.text.length, remaining - separator.length)
        if (take <= 0) break
        selected.push({ ...chunk, text: chunk.chunkIndex < anchorIndex ? chunk.text.slice(-take) : chunk.text.slice(0, take) })
        remaining -= take + separator.length
    }
    selected.sort((a, b) => a.chunkIndex - b.chunkIndex)
    const preceding = selected.filter((chunk) => chunk.chunkIndex < anchorIndex)
    const anchorStart = preceding.reduce((sum, chunk) => sum + chunk.text.length + separator.length, 0)
    return { content: selected.map((chunk) => chunk.text).join(separator), indices: selected.map((chunk) => chunk.chunkIndex), anchorStart, anchorEnd: anchorStart + anchor.text.length }
}
