import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { docLibraryApi } from "@/lib/api"
import type { DocumentIndexStatus, DocumentIndexPhase } from "@/lib/document-index-types"

const LABELS: Record<DocumentIndexPhase, string> = {
  disabled: "增强索引未启用", not_built: "尚未构建增强索引", building: "增强索引构建中",
  ready: "增强索引就绪", stale: "增强索引需更新", failed: "最近构建失败", cancelled: "已请求取消构建", unavailable: "索引状态暂不可用",
  ready_to_activate: "索引已构建，待核验启用",
}

export function DocumentIndexStatusLine({ libraryId, revision }: { libraryId: string; revision: string }) {
  const [refresh, setRefresh] = useState(0)
  const key = `${libraryId}:${revision}:${refresh}`
  const [loaded, setLoaded] = useState<{ key: string; data: DocumentIndexStatus | null } | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [actionError, setActionError] = useState(false)
  const data = loaded?.key === key ? loaded.data : undefined
  useEffect(() => {
    const controller = new AbortController()
    docLibraryApi.indexStatus(libraryId, controller.signal).then((response) => {
      if (!controller.signal.aborted) setLoaded({ key, data: response.data })
    }).catch(() => {
      if (!controller.signal.aborted) setLoaded({ key, data: null })
    })
    return () => controller.abort()
  }, [libraryId, key])

  const cancel = async () => {
    if (!data?.latest || cancelling) return
    setCancelling(true); setActionError(false)
    try {
      await docLibraryApi.cancelIndex(data.latest.id)
      setRefresh((value) => value + 1)
    } catch { setActionError(true) }
    finally { setCancelling(false) }
  }
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span role="status" aria-live="polite">
        {data === undefined ? "正在读取检索状态…" : data === null ? "检索状态暂不可用" : <>
          关键词可用：{data.keywordDocuments} 篇 · {data.phase === "building" && !data.workerConfigured ? "等待索引处理（Worker 未启用）" : LABELS[data.phase]}
          {data.currentReady && data.phase !== "ready" ? " · 旧索引仍可用" : null}
          {data.phase === "building" && data.latest ? `（${data.latest.completedDocuments}/${data.latest.expectedDocuments}）` : null}
        </>}
      </span>
      <Button variant="ghost" size="sm" className="h-6 px-1 text-xs" disabled={data === undefined} onClick={() => setRefresh((value) => value + 1)}>刷新状态</Button>
      {data?.latest?.status === "building" ? <Button variant="ghost" size="sm" className="h-6 px-1 text-xs" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "正在请求取消…" : "停止构建"}</Button> : null}
      {actionError ? <span role="alert">取消请求未能完成，请刷新核对。</span> : null}
    </div>
  )
}
