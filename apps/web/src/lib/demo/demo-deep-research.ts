import type { DeepResearchJobResponse } from "@/lib/api"
import { demoStore } from "./demo-store"

const threadId = "700900"
const fastRunKey = "run-demo-deep-ui"
let job: DeepResearchJobResponse | null = null
let started = 0

export function seedDemoDeepThread() {
  if (demoStore.threads.some((thread) => thread.summary.id === threadId)) return
  const date = new Date().toISOString()
  const event = (sequence: number, type: string, payload: Record<string, unknown>) => ({ type: "data-agent-event", data: { runId: fastRunKey, sequence, timestamp: Date.now(), type, payload } })
  demoStore.threads.unshift({ summary: { id: threadId, title: "深度检索交互演示（虚构）", focus: null, createdAt: date, updatedAt: date }, plans: [], messages: [
    { id: "700901", role: "user", createdAt: date, content: { parts: [{ type: "text", text: "比较两份演练资料的适用条件。" }] } },
    { id: "700902", role: "assistant", createdAt: date, content: { parts: [
      { type: "text", text: "这是虚构的快速回答。点击下方“深入检索”可演示任务状态和追加结果，不调用任何模型。" },
      event(1, "agent_started", { goal: "虚构演示", model: "synthetic", conversationId: threadId, questionMessageId: "700901" }),
      event(2, "agent_completed", { status: "completed", metrics: { durationMs: 1, toolCalls: 0, evidenceCount: 0, subAgentCount: 0, iterations: 1 } }),
    ] } },
  ] })
}

export function demoDeepList(id: string) {
  if (job?.status === "running" && Date.now() - started >= 4000) {
    const date = new Date().toISOString()
    job = { ...job, status: "succeeded", resultMessageId: "700903", completedAt: date, updatedAt: date }
    const thread = demoStore.threads.find((item) => item.summary.id === threadId)
    if (thread && !thread.messages.some((message) => message.id === "700903")) thread.messages.push({ id: "700903", role: "assistant", createdAt: date,
      content: { parts: [{ type: "text", text: "## 深度检索补充\n\n这是**虚构演示结果**：两份资料适用条件不同，应分别核对。原快速回答保留；本次未调用模型。" }],
        agentRunId: "deep_demo_ui", deepResearch: { runKey: "deep_demo_ui", fastRunKey, references: [] } } })
  }
  return { enabled: id === threadId, sourceScope: { mode: "local" }, sourceScopeHash: "0".repeat(64), jobs: id === threadId && job ? [job] : [] }
}

export function demoDeepStart(id: string) {
  if (id !== threadId) throw new Error("只支持虚构演示会话")
  if (!job) {
    const date = new Date().toISOString(); started = Date.now()
    job = { runKey: "deep_demo_ui", fastRunKey, status: "running", attemptCount: 1, maxAttempts: 3, errorCode: null, resultMessageId: null,
      capabilitySnapshot: { contractVersion: null, sourceCutoffs: {}, allowedModes: ["exact"], wikiReady: false, graphReady: false, qualityStale: false, capturedAt: date },
      createdAt: date, updatedAt: date, startedAt: date, completedAt: null, cancelledAt: null }
  }
  return job
}
export function demoDeepCancel() {
  if (!job) throw new Error("演示任务不存在")
  if (job.status === "running") job = { ...job, status: "cancelled", cancelledAt: new Date().toISOString() }
  return job
}
