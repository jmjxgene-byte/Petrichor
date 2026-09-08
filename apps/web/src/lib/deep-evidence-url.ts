/** Deep只持久化安全链接与位置，不携带citeSnippet/hlText等正文参数。 */
export function normalizeDeepEvidenceUrl(raw: unknown, source?: string): string | null {
    if (typeof raw !== "string" || raw.length > 2_000 || /[\u0000-\u001f\\]/.test(raw)) return null
    if (raw.startsWith("/")) {
        if (!["document", "knowledge", "wiki"].includes(source ?? "") || raw.startsWith("//")) return null
        const url = new URL(raw, "https://petrichor.invalid")
        if (!/^\/dashboard\/doc-library\/[1-9]\d*$/.test(url.pathname) && !/^\/dashboard\/knowledge\/[1-9]\d*\/articles\/[1-9]\d*$/.test(url.pathname)) return null
        const params = new URLSearchParams()
        for (const key of ["documentId", "generationId", "passageId", "citeIndex", "hlPage"]) {
            const value = url.searchParams.get(key)
            if (value != null) {
                if (url.searchParams.getAll(key).length !== 1 || !/^[1-9]\d*$/.test(value)) return null
                params.set(key, value)
            }
        }
        const hash = url.searchParams.get("contentHash")
        if (hash != null) {
            if (url.searchParams.getAll("contentHash").length !== 1 || !/^[a-f0-9]{64}$/.test(hash)) return null
            params.set("contentHash", hash)
        }
        for (const key of ["citeSourceId", "citeChunkId"]) {
            const value = url.searchParams.get(key)
            if (value && /^[a-zA-Z0-9:_-]{1,200}$/.test(value)) params.set(key, value)
        }
        if (url.pathname.startsWith("/dashboard/doc-library/") && !params.has("documentId")) return null
        return `${url.pathname}${params.size ? `?${params}` : ""}`
    }
    try {
        const url = new URL(raw)
        for (const key of ["citeSnippet", "citeTerms", "hlText"]) url.searchParams.delete(key)
        return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.toString() : null
    } catch { return null }
}
