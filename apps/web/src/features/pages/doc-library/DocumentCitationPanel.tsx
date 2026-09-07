import { useEffect, useState } from "react"
import { docLibraryApi } from "@/lib/api"
import { parseDocumentCitation, type DocumentCitationWindow } from "@/lib/document-citation"

export function DocumentCitationPanel({ libraryId, documentId, search }: { libraryId: string; documentId: string; search: string }) {
    const key = `${libraryId}:${documentId}:${search}`
    const [result, setResult] = useState<{ key: string; data: DocumentCitationWindow | null } | null>(null)
    const citation = parseDocumentCitation(search)
    useEffect(() => {
        const target = parseDocumentCitation(search)
        if (!target || target === "invalid") return
        const controller = new AbortController()
        docLibraryApi.readCitation(libraryId, documentId, target, controller.signal).then(({ data }) => {
            if (controller.signal.aborted) return
            if (typeof data.content !== "string" || data.content.length > 4_000 || !Number.isInteger(data.anchorStart) || !Number.isInteger(data.anchorEnd)
                || data.anchorStart < 0 || data.anchorEnd <= data.anchorStart || data.anchorEnd > data.content.length) throw new Error("invalid_window")
            setResult({ key, data })
        }).catch(() => { if (!controller.signal.aborted) setResult({ key, data: null }) })
        return () => controller.abort()
    }, [libraryId, documentId, search, key])
    if (!citation) return null
    if (citation === "invalid") return <p role="status" className="border-b p-3 text-sm text-muted-foreground">引用缺少有效定位信息，仅可查看原文。</p>
    const data = result?.key === key ? result.data : undefined
    return <section aria-label="引用定位" className="max-h-[35vh] shrink-0 overflow-auto border-b p-3 text-sm">
        {data === undefined ? <p role="status">正在核验引用位置…</p> : data === null
            ? <p role="alert">无法核验此引用，可能已失效或暂不可用。下方原文不代表已定位命中。</p>
            : <>
                <p className="mb-2 text-xs text-muted-foreground">命中片段及邻近上下文 · 索引版本 #{citation.generationId} · 时间未知</p>
                <p className="whitespace-pre-wrap break-words">{data.content.slice(0, data.anchorStart)}<mark className="rounded bg-yellow-100 text-neutral-900">{data.content.slice(data.anchorStart, data.anchorEnd)}</mark>{data.content.slice(data.anchorEnd)}</p>
            </>}
    </section>
}
