import * as React from "react"
import { useAuiState, useThreadRuntime } from "@assistant-ui/react"
import { Button } from "@/components/ui/button"
import { assistantApi, deepResearchApi, type DeepResearchJobResponse } from "@/lib/api"
import { useCurrentAgentRun } from "./agent-run-ui"
import { extractPersistedMessageMetadata, readPersistedAgentRunId, toInitialMessages } from "./assistant-message-utils"

const active = (job: DeepResearchJobResponse) => ["queued", "running", "retry_wait", "cancel_requested"].includes(job.status)
const labels: Record<DeepResearchJobResponse["status"], string> = { queued: "排队中", running: "检索中", retry_wait: "等待恢复",
  cancel_requested: "正在取消", cancelled: "已取消", succeeded: "已完成", failed: "执行失败" }
type Controls = { jobs: DeepResearchJobResponse[]; enabled: boolean | null; busy: boolean; error: string | null; scopeLabel: string;
  start: (questionId: string, runKey: string) => Promise<void>; cancel: (runKey: string) => Promise<void>; refresh: () => Promise<void> }
const Context = React.createContext<Controls | null>(null)

/** 只跟踪当前会话；未知写入结果不自动重发，刷新从服务器恢复。 */
export function useThreadDeepResearch(threadId: string | null): Controls {
  const [jobs, setJobs] = React.useState<DeepResearchJobResponse[]>([])
  const [enabled, setEnabled] = React.useState<boolean | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [scopeHash, setScopeHash] = React.useState<string | null>(null)
  const [scopeLabel, setScopeLabel] = React.useState("")
  const current = React.useRef(threadId)
  current.current = threadId
  const mutation = React.useRef<{ threadId: string; version: number } | null>(null)
  const reading = React.useRef<{ threadId: string } | null>(null)
  const revision = React.useRef(0)
  const refresh = React.useCallback(async () => {
    if (!threadId || reading.current?.threadId === threadId) return
    const version = revision.current
    const ticket = { threadId }
    reading.current = ticket
    try {
      const response = await deepResearchApi.list(threadId)
      if (current.current !== threadId || revision.current !== version) return
      const hash = typeof response.data.sourceScopeHash === "string" && /^[a-f0-9]{64}$/.test(response.data.sourceScopeHash) ? response.data.sourceScopeHash : null
      const scope = response.data.sourceScope
      setScopeHash(hash)
      setScopeLabel(scope?.mode === "all" ? "全部资料" : scope?.mode === "local" ? "仅本地资料" : scope?.mode === "selected" ? `${scope.refs.length} 个指定资料源` : "")
      setJobs(response.data.jobs); setEnabled(response.data.enabled && hash !== null); setError(hash ? null : "资料范围信息缺失，请刷新状态。")
    } catch {
      if (current.current === threadId && revision.current === version) setError("无法读取深度任务状态，请刷新状态后再操作。")
    } finally { if (reading.current === ticket) reading.current = null }
  }, [threadId])
  React.useEffect(() => {
    current.current = threadId; reading.current = null
    revision.current++; setJobs([]); setEnabled(null); setError(null); setScopeHash(null); setScopeLabel(""); setBusy(mutation.current?.threadId === threadId)
    void refresh()
    return () => { revision.current++; if (current.current === threadId) current.current = null }
  }, [refresh, threadId])
  React.useEffect(() => {
    if (error || !jobs.some(active)) return
    const timer = setInterval(() => { void refresh() }, 3000)
    return () => clearInterval(timer)
  }, [jobs, error, refresh])
  const mutate = React.useCallback(async (run: () => Promise<{ data: DeepResearchJobResponse }>) => {
    if (!threadId || mutation.current?.threadId === threadId) return
    const operation = { threadId, version: ++revision.current }
    mutation.current = operation; setBusy(true); setError(null)
    try {
      const response = await run()
      if (current.current !== threadId || revision.current !== operation.version) return
      setJobs((previous) => [response.data, ...previous.filter((job) => job.runKey !== response.data.runKey)])
    } catch {
      if (current.current === threadId && revision.current === operation.version) setError("操作结果未确认；请先刷新状态，不会自动重新发起任务。")
    } finally {
      const ownsOperation = mutation.current === operation
      if (ownsOperation) mutation.current = null
      if (current.current === threadId && ownsOperation) { revision.current++; setBusy(false) }
    }
  }, [threadId])
  return { jobs, enabled, busy, error, refresh, scopeLabel,
    start: async (questionMessageId, fastRunKey) => { if (threadId && enabled && !error && scopeHash) await mutate(() => deepResearchApi.start({ threadId, questionMessageId, fastRunKey, expectedSourceScopeHash: scopeHash })) },
    cancel: async (runKey) => { await mutate(() => deepResearchApi.cancel(runKey)) },
  }
}

export function DeepResearchProvider({ threadId, children, disabled = false }: { threadId: string | null; children: React.ReactNode; disabled?: boolean }) {
  const controls = useThreadDeepResearch(threadId)
  const runtime = useThreadRuntime()
  const running = useAuiState((state) => state.thread.isRunning)
  const appended = React.useRef(new Set<string>())
  const currentThread = React.useRef(threadId)
  currentThread.current = threadId
  const [resultError, setResultError] = React.useState(false)
  const [resultAttempt, setResultAttempt] = React.useState(0)
  const completedJson = JSON.stringify(controls.jobs.filter((job) => job.status === "succeeded")
    .map((job) => ({ runKey: job.runKey, resultMessageId: job.resultMessageId })))
  React.useEffect(() => { appended.current.clear(); setResultError(false) }, [threadId])
  React.useEffect(() => {
    if (!threadId || running) return
    const completed: Array<{ runKey: string; resultMessageId: string | null }> = JSON.parse(completedJson)
    if (completed.some((job) => !job.resultMessageId)) setResultError(true)
    const missing = completed.filter((job) => job.resultMessageId && !appended.current.has(job.runKey)
      && !runtime.getState().messages.some((message) => readPersistedAgentRunId(message.metadata) === job.runKey))
    if (!missing.length) return
    let disposed = false
    void assistantApi.threadDetail(threadId).then((response) => {
      if (disposed || currentThread.current !== threadId || runtime.getState().isRunning) return
      let missingResult = false
      for (const job of [...missing].reverse()) {
        if (appended.current.has(job.runKey) || runtime.getState().messages.some((message) => readPersistedAgentRunId(message.metadata) === job.runKey)) continue
        const row = response.data.messages.find((message) => message.id === job.resultMessageId && message.role === "assistant")
        const message = row ? toInitialMessages([row])[0] : null
        if (!message || readPersistedAgentRunId(message.metadata) !== job.runKey) { missingResult = true; continue }
        runtime.append({ role: "assistant", startRun: false,
          content: message.parts.flatMap((part) => part.type === "text" ? [{ type: "text" as const, text: part.text }] : []),
          metadata: extractPersistedMessageMetadata(row!.content) ?? { custom: {} } })
        appended.current.add(job.runKey)
      }
      setResultError(missingResult)
    }).catch(() => { if (!disposed) setResultError(true) })
    return () => { disposed = true }
  }, [completedJson, threadId, running, runtime, resultAttempt])
  return <Context.Provider value={disabled ? null : controls}>
    {children}
    {resultError ? <div role="status" className="text-xs text-muted-foreground">深度任务已完成，结果加载失败。<Button variant="ghost" size="sm" onClick={() => { void controls.refresh(); setResultAttempt((value) => value + 1) }}>刷新结果</Button></div> : null}
  </Context.Provider>
}

export function DeepResearchMessageControl() {
  const controls = React.useContext(Context)
  const run = useCurrentAgentRun()
  const running = useAuiState((state) => state.thread.isRunning)
  if (!controls || !run || run.id.startsWith("deep_") || !run.questionMessageId || !["completed", "stopped"].includes(run.status)) return null
  const job = controls.jobs.find((item) => item.fastRunKey === run.id)
  return <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
    {job ? <span>深度检索 · {labels[job.status]}{job.errorCode ? `（${job.errorCode}）` : ""}</span>
      : <Button variant="ghost" size="sm" disabled={!controls.enabled || controls.busy || running || !!controls.error}
          title="对这条问题按会话已保存的资料范围检索；结果追加，原回答保留。"
          onClick={() => { void controls.start(run.questionMessageId!, run.id) }}>深入检索</Button>}
    {!job && controls.enabled === false ? <span>Worker 尚未启用</span> : null}
    {!job && controls.enabled === null && !controls.error ? <span>正在读取任务状态</span> : null}
    {!job && controls.scopeLabel ? <span>保存范围：{controls.scopeLabel}</span> : null}
    {job && active(job) && job.status !== "cancel_requested" ? <Button variant="ghost" size="sm" disabled={controls.busy} onClick={() => { void controls.cancel(job.runKey) }}>取消</Button> : null}
    {controls.error ? <><span>{controls.error}</span><Button variant="ghost" size="sm" disabled={controls.busy} onClick={() => { void controls.refresh() }}>刷新状态</Button></> : null}
  </div>
}
