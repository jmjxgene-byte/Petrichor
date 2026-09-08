// @vitest-environment jsdom
import * as React from "react"
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ list: vi.fn(), start: vi.fn(), cancel: vi.fn(), detail: vi.fn(), append: vi.fn(), messages: [] as Array<{ metadata?: unknown }>, running: false }))
vi.mock("@/lib/api", () => ({ deepResearchApi: mocks, assistantApi: { threadDetail: mocks.detail } }))
vi.mock("./agent-run-ui", () => ({ useCurrentAgentRun: () => ({ id: "fast-1", questionMessageId: "22", status: "completed" }) }))
vi.mock("@assistant-ui/react", () => ({ useAuiState: (selector: (state: { thread: { isRunning: boolean } }) => unknown) => selector({ thread: { isRunning: mocks.running } }),
  useThreadRuntime: () => runtime }))
const runtime = { getState: () => ({ messages: mocks.messages, isRunning: mocks.running }), append: mocks.append }
import { DeepResearchMessageControl, DeepResearchProvider, useThreadDeepResearch } from "./deep-research-controls"
const job = { runKey: "deep_1", fastRunKey: "fast-1", status: "running", resultMessageId: null, errorCode: null }
beforeEach(() => {
  vi.resetAllMocks(); mocks.messages = []; mocks.running = false
  mocks.list.mockResolvedValue({ data: { sourceScopeHash: "0".repeat(64), sourceScope: { mode: "local" }, enabled: true, jobs: [] } })
  mocks.start.mockResolvedValue({ data: job })
  mocks.cancel.mockResolvedValue({ data: { ...job, status: "cancel_requested" } })
})
afterEach(() => cleanup())
describe("手动Deep入口", () => {
  it("不自动启动，点击后显示状态并可取消", async () => {
    render(<DeepResearchProvider threadId="11"><DeepResearchMessageControl /></DeepResearchProvider>)
    const start = await screen.findByRole("button", { name: "深入检索" })
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false))
    expect(mocks.start).not.toHaveBeenCalled()
    fireEvent.click(start)
    expect(await screen.findByText("深度检索 · 检索中")).toBeTruthy()
    expect(mocks.start).toHaveBeenCalledWith({ threadId: "11", questionMessageId: "22", fastRunKey: "fast-1", expectedSourceScopeHash: "0".repeat(64) })
    fireEvent.click(screen.getByRole("button", { name: "取消" }))
    expect(await screen.findByText("深度检索 · 正在取消")).toBeTruthy()
    expect(mocks.cancel).toHaveBeenCalledWith("deep_1")
  })
  it("Worker关闭时禁用启动，不发起请求", async () => {
    mocks.list.mockResolvedValue({ data: { sourceScopeHash: "0".repeat(64), sourceScope: { mode: "local" }, enabled: false, jobs: [] } })
    render(<DeepResearchProvider threadId="11"><DeepResearchMessageControl /></DeepResearchProvider>)
    await screen.findByText("Worker 尚未启用")
    expect((screen.getByRole("button", { name: "深入检索" }) as HTMLButtonElement).disabled).toBe(true)
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it("未知写入结果不自动重发，刷新恢复已有任务", async () => {
    mocks.start.mockRejectedValue(new Error("timeout"))
    const { result } = renderHook(() => useThreadDeepResearch("11"))
    await waitFor(() => expect(result.current.enabled).toBe(true))
    await act(() => result.current.start("22", "fast-1"))
    expect(result.current.error).toContain("操作结果未确认")
    await act(() => result.current.start("22", "fast-1"))
    expect(mocks.start).toHaveBeenCalledOnce()
    mocks.list.mockResolvedValue({ data: { sourceScopeHash: "0".repeat(64), sourceScope: { mode: "local" }, enabled: true, jobs: [job] } })
    await act(() => result.current.refresh())
    expect(result.current.jobs[0].runKey).toBe("deep_1")
  })
  it("切换会话后忽略旧查询，StrictMode仍能读取新状态", async () => {
    let finish!: (value: unknown) => void
    mocks.list.mockImplementation((id: string) => id === "11" ? new Promise((resolve) => { finish = resolve }) : Promise.resolve({ data: { sourceScopeHash: "0".repeat(64), sourceScope: { mode: "local" }, enabled: true, jobs: [] } }))
    const { result, rerender } = renderHook(({ id }) => useThreadDeepResearch(id), { initialProps: { id: "11" }, wrapper: React.StrictMode })
    rerender({ id: "12" })
    await waitFor(() => expect(result.current.enabled).toBe(true))
    await act(async () => finish({ data: { sourceScopeHash: "0".repeat(64), sourceScope: { mode: "local" }, enabled: false, jobs: [job] } }))
    expect(result.current.enabled).toBe(true)
    expect(result.current.jobs).toEqual([])
  })
  it("已完成结果追加一次并明确不触发模型，原消息不覆盖", async () => {
    mocks.list.mockResolvedValue({ data: { sourceScopeHash: "0".repeat(64), sourceScope: { mode: "local" }, enabled: true, jobs: [{ ...job, status: "succeeded", resultMessageId: "33" }] } })
    mocks.detail.mockResolvedValue({ data: { messages: [{ id: "33", role: "assistant", content: { parts: [{ type: "text", text: "合成补充" }], agentRunId: "deep_1", deepResearch: { runKey: "deep_1", fastRunKey: "fast-1", references: [] } } }] } })
    render(<DeepResearchProvider threadId="11"><DeepResearchMessageControl /></DeepResearchProvider>)
    await waitFor(() => expect(mocks.append).toHaveBeenCalledOnce())
    expect(mocks.append).toHaveBeenCalledWith(expect.objectContaining({ role: "assistant", startRun: false, content: [{ type: "text", text: "## 深度检索补充\n\n合成补充" }] }))
    expect(mocks.start).not.toHaveBeenCalled()
  })
})
