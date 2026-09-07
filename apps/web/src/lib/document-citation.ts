export type DocumentCitation = { generationId: string; passageId: string; contentHash: string }
export type DocumentCitationWindow = { title: string; content: string; anchorStart: number; anchorEnd: number }

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
