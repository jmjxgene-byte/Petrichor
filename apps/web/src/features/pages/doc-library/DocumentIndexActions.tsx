import { useEffect, useId, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { docLibraryApi } from "@/lib/api"
import type { DocumentIndexQuote, DocumentIndexStatus } from "@/lib/document-index-types"

export function DocumentIndexActions({ libraryId, libraryName, status, onChanged }: {
  libraryId: string; libraryName: string; status: DocumentIndexStatus; onChanged: () => void
}) {
  const [mode, setMode] = useState<"build" | "activate" | null>(null)
  const [quote, setQuote] = useState<DocumentIndexQuote | null>(null)
  const [target, setTarget] = useState<{ id: string; manifestHash: string } | null>(null)
  const [phase, setPhase] = useState<"idle" | "quoting" | "submitting">("idle")
  const [confirmed, setConfirmed] = useState(false)
  const [expired, setExpired] = useState(false)
  const [error, setError] = useState(false)
  const request = useRef<AbortController | null>(null)
  const submitting = useRef(false)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const checkboxId = useId()
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    if (!quote) return
    const timer = setTimeout(() => setExpired(true), Math.max(0, Math.min(900_000, Date.parse(quote.quoteExpiresAt) - Date.now())))
    return () => clearTimeout(timer)
  }, [quote])
  const open = (kind: "build" | "activate", button: HTMLButtonElement) => {
    trigger.current = button; setQuote(null); setConfirmed(false); setExpired(false); setError(false)
    setTarget(kind === "activate" && status.latest ? { id: status.latest.id, manifestHash: status.latest.manifestHash } : null)
    setMode(kind)
  }
  const close = () => {
    if (submitting.current) return
    request.current?.abort(); setMode(null); setQuote(null); setConfirmed(false); setPhase("idle")
  }
  const estimate = async () => {
    request.current?.abort()
    const controller = new AbortController(); request.current = controller
    setPhase("quoting"); setError(false); setQuote(null); setConfirmed(false); setExpired(false)
    try {
      const result = await docLibraryApi.quoteIndex(libraryId, controller.signal)
      if (controller.signal.aborted) return
      if (result.data.libraryId !== libraryId) throw new Error("quote_scope_mismatch")
      if (!Number.isFinite(Date.parse(result.data.quoteExpiresAt)) || !Number.isFinite(Date.parse(result.data.executionExpiresAt))) throw new Error("quote_expiry_invalid")
      setQuote(result.data)
    } catch { if (!controller.signal.aborted) setError(true) }
    finally { if (!controller.signal.aborted) setPhase("idle") }
  }
  const submit = async () => {
    if (!confirmed || submitting.current || (mode === "build" && (!quote || expired || Date.parse(quote.quoteExpiresAt) <= Date.now()))) return
    submitting.current = true; setPhase("submitting"); setError(false)
    try {
      if (mode === "build" && quote) await docLibraryApi.buildIndex(libraryId, quote.token)
      else if (mode === "activate" && target) await docLibraryApi.activateIndex(target.id, target.manifestHash)
      else throw new Error("missing_target")
      setMode(null); setQuote(null); setConfirmed(false); onChanged()
    } catch { setError(true); setConfirmed(false) }
    finally { submitting.current = false; setPhase("idle") }
  }
  return <>
    {status.enabled && status.keywordDocuments > 0 && status.latest?.status !== "building" ? <Button variant="ghost" size="sm" className="h-6 px-1 text-xs" onClick={(event) => open("build", event.currentTarget)}>预估构建</Button> : null}
    {status.enabled && status.phase === "ready_to_activate" ? <Button variant="ghost" size="sm" className="h-6 px-1 text-xs" onClick={(event) => open("activate", event.currentTarget)}>核验并启用</Button> : null}
    <Dialog open={mode !== null} onOpenChange={(value) => { if (!value) close() }}>
      <DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus() }}>
        <DialogHeader>
          <DialogTitle>{mode === "activate" ? "启用增强索引" : "预估增强索引"}</DialogTitle>
          <DialogDescription>{libraryName} · {mode === "activate" ? "只切换已完成的索引，不重新向量化。服务端复核失败将保留旧索引。" : "预估会读取本库可索引资料，但不调用模型；确认后才向已配置的向量服务发送片段。"}</DialogDescription>
        </DialogHeader>
        {mode === "build" && quote ? <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt>资料范围</dt><dd>{quote.documentCount} 篇文档 · {quote.passageCount} 个片段</dd>
          <dt>模型</dt><dd className="break-all">{quote.model}</dd>
          <dt>输入上界</dt><dd>{quote.maxInputTokens.toLocaleString()} tokens</dd>
          <dt>费用上界</dt><dd>US$ {(quote.maxCostMicrousd / 1_000_000).toFixed(6)}（非实际账单）</dd>
          <dt>确认截止</dt><dd>{new Date(quote.quoteExpiresAt).toLocaleString()}</dd>
          <dt>执行授权截止</dt><dd>{new Date(quote.executionExpiresAt).toLocaleString()}</dd>
        </dl> : null}
        {mode === "activate" && target ? <p className="text-sm">目标版本 #{target.id} · 快照 {target.manifestHash.slice(0, 12)}…</p> : null}
        {mode === "build" ? <p className="text-xs text-muted-foreground">已有同范围任务将复用，不重复创建或重置原审批。取消不能撤回已经发生的模型调用。</p> : null}
        {expired ? <p role="alert" className="text-sm">报价已过期，请重新预估。</p> : null}
        {error ? <p role="alert" className="text-sm">操作未确认成功。请先刷新索引状态核对，再检查核验策略或资料版本；不会自动重试创建。</p> : null}
        {(mode === "activate" || quote) ? <div className="flex items-start gap-2">
          <Checkbox id={checkboxId} checked={confirmed} disabled={phase !== "idle" || expired} onCheckedChange={(value) => setConfirmed(value === true)} />
          <Label htmlFor={checkboxId} className="text-sm leading-5">{mode === "activate" ? "我确认核验并切换到以上索引版本" : "我确认以上资料范围、模型和费用上界"}</Label>
        </div> : null}
        <DialogFooter>
          <Button variant="outline" disabled={phase === "submitting"} onClick={close}>取消</Button>
          {mode === "build" && (!quote || expired) ? <Button disabled={phase !== "idle"} onClick={() => void estimate()}>{phase === "quoting" ? "正在预估…" : "生成预估"}</Button>
            : <Button disabled={!confirmed || phase !== "idle" || expired} onClick={() => void submit()}>{phase === "submitting" ? "正在提交…" : mode === "activate" ? "确认启用" : "确认创建任务"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
