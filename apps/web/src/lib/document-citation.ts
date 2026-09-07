export type DocumentCitation = { generationId: string; passageId: string; contentHash: string }
export type DocumentSourceAnchor = { sourceHash: string; contentHash: string; startOffset: number; endOffset: number; sourceFormat: "raw_markdown" | "extracted_text_v1" }
export type DocumentCitationWindow = { title: string; content: string; anchorStart: number; anchorEnd: number; sourceAnchor?: DocumentSourceAnchor }

/** 偏移是原文本UTF-16下标；只有整文与片段SHA都匹配才允许原文高亮。 */
export async function verifyDocumentSourceAnchor(text: string, anchor: DocumentSourceAnchor): Promise<boolean> {
    if (anchor.sourceFormat !== "raw_markdown" || !Number.isSafeInteger(anchor.startOffset) || !Number.isSafeInteger(anchor.endOffset)
        || anchor.startOffset < 0 || anchor.endOffset <= anchor.startOffset || anchor.endOffset > text.length
        || !/^[a-f0-9]{64}$/.test(anchor.sourceHash) || !/^[a-f0-9]{64}$/.test(anchor.contentHash)) return false
    const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("")
    return await digest(text) === anchor.sourceHash && await digest(text.slice(anchor.startOffset, anchor.endOffset)) === anchor.contentHash
}

/** null是普通打开；invalid是引用不完整，不能伪装成成功定位。 */
export function parseDocumentCitation(search: string): DocumentCitation | "invalid" | null {
    const params = new URLSearchParams(search)
    const keys = ["generationId", "passageId", "contentHash"]
    if (!keys.some((key) => params.has(key))) return null
    if (keys.some((key) => params.getAll(key).length !== 1)) return "invalid"
    const generationId = params.get("generationId")!, passageId = params.get("passageId")!, contentHash = params.get("contentHash")!
    if (![generationId, passageId].every((id) => /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))) || !/^[a-f0-9]{64}$/.test(contentHash)) return "invalid"
    return { generationId, passageId, contentHash }
}
