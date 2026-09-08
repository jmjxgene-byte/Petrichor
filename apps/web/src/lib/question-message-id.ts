export function questionMessageIdFromMetadata(value: string | null): string | null {
    if (!value) return null
    try {
        const parsed: unknown = JSON.parse(value)
        if (!parsed || typeof parsed !== "object") return null
        const id = (parsed as Record<string, unknown>).questionMessageId
        return typeof id === "string" && /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) ? id : null
    } catch { return null }
}
