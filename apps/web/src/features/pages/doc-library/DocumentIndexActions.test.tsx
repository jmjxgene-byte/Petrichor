// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ quoteIndex: vi.fn(), buildIndex: vi.fn(), activateIndex: vi.fn() }))
vi.mock("@/lib/api", () => ({ docLibraryApi: mocks }))
import { DocumentIndexActions } from "./DocumentIndexActions"
import type { DocumentIndexStatus } from "@/lib/document-index-types"
const status: DocumentIndexStatus = { libraryId: "2", enabled: true, workerConfigured: false, hybridConfigured: false,
  keywordDocuments: 1, phase: "not_built", currentReady: false, current: null, latest: null }
const quote = { libraryId: "2", token: "synthetic", documentCount: 1, passageCount: 2, model: "synthetic", maxInputTokens: 100,
  maxCostMicrousd: 100, quoteExpiresAt: "2099-01-01T00:00:00Z", executionExpiresAt: "2099-01-02T00:00:00Z" }
beforeEach(() => { vi.clearAllMocks(); mocks.quoteIndex.mockResolvedValue({ data: quote }); mocks.buildIndex.mockResolvedValue({ data: { generationId: "3" } }) })
afterEach(async () => {
  cleanup()
  // Radix FocusScope在卸载后用0ms任务恢复焦点；须在jsdom销毁前完成。
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
})
describe("索引确认UI", () => {
  it("打开不自动报价，未勾选不得创建任务", async () => {
    const changed = vi.fn()
    render(<DocumentIndexActions libraryId="2" libraryName="合成库" status={status} onChanged={changed} />)
    fireEvent.click(screen.getByRole("button", { name: "预估构建" }))
    expect(mocks.quoteIndex).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "生成预估" }))
    const confirm = await screen.findByRole("button", { name: "确认创建任务" })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(confirm); expect(mocks.buildIndex).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(confirm)
    await waitFor(() => expect(mocks.buildIndex).toHaveBeenCalledWith("2", "synthetic"))
    expect(changed).toHaveBeenCalledOnce()
  })
  it("报价过期不允许确认", async () => {
    mocks.quoteIndex.mockResolvedValueOnce({ data: { ...quote, quoteExpiresAt: "2000-01-01T00:00:00Z" } })
    render(<DocumentIndexActions libraryId="2" libraryName="合成库" status={status} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "预估构建" }))
    fireEvent.click(screen.getByRole("button", { name: "生成预估" }))
    await screen.findByText("报价已过期，请重新预估。")
    expect(mocks.buildIndex).not.toHaveBeenCalled()
  })
  it("无效截止时间不能成为可确认报价", async () => {
    mocks.quoteIndex.mockResolvedValueOnce({ data: { ...quote, quoteExpiresAt: "invalid" } })
    render(<DocumentIndexActions libraryId="2" libraryName="合成库" status={status} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "预估构建" }))
    fireEvent.click(screen.getByRole("button", { name: "生成预估" }))
    await screen.findByRole("alert")
    expect(screen.queryByRole("button", { name: "确认创建任务" })).toBeNull()
    expect(mocks.buildIndex).not.toHaveBeenCalled()
  })
  it("关闭弹窗中止报价，迟到结果不恢复确认按钮", async () => {
    let resolve!: (value: { data: typeof quote }) => void
    mocks.quoteIndex.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    render(<DocumentIndexActions libraryId="2" libraryName="合成库" status={status} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "预估构建" }))
    fireEvent.click(screen.getByRole("button", { name: "生成预估" }))
    const signal = mocks.quoteIndex.mock.calls[0][1] as AbortSignal
    fireEvent.click(screen.getByRole("button", { name: /^取消$/ }))
    expect(signal.aborted).toBe(true)
    resolve({ data: quote })
    fireEvent.click(screen.getByRole("button", { name: "预估构建" }))
    await waitFor(() => expect(screen.queryByRole("button", { name: "确认创建任务" })).toBeNull())
    expect(mocks.buildIndex).not.toHaveBeenCalled()
  })
  it("提交失败清除确认，不自动重试", async () => {
    mocks.buildIndex.mockRejectedValueOnce(new Error("unknown_outcome"))
    const changed = vi.fn()
    render(<DocumentIndexActions libraryId="2" libraryName="合成库" status={status} onChanged={changed} />)
    fireEvent.click(screen.getByRole("button", { name: "预估构建" }))
    fireEvent.click(screen.getByRole("button", { name: "生成预估" }))
    const confirm = await screen.findByRole("button", { name: "确认创建任务" })
    fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(confirm)
    await screen.findByRole("alert")
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    expect(mocks.buildIndex).toHaveBeenCalledOnce()
    expect(changed).not.toHaveBeenCalled()
  })
  it("启用也要独立确认，使用打开对话框时的目标", async () => {
    mocks.activateIndex.mockResolvedValueOnce({ data: {} })
    render(<DocumentIndexActions libraryId="2" libraryName="合成库" status={{ ...status, phase: "ready_to_activate", latest: {
      id: "3", manifestHash: "a".repeat(64), status: "ready", expectedDocuments: 1, completedDocuments: 1, passageCount: 2, errorCode: null, updatedAt: quote.quoteExpiresAt,
    } }} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "核验并启用" }))
    const confirm = screen.getByRole("button", { name: "确认启用" })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(confirm)
    await waitFor(() => expect(mocks.activateIndex).toHaveBeenCalledWith("3", "a".repeat(64)))
  })
})
