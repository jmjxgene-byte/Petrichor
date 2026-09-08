import { describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ values: vi.fn(async (_row: { inputJson: string; outputJson: string }) => {}) }))
vi.mock("@/server/db/client", () => ({ getDb: () => ({ insert: () => ({ values: mocks.values }) }), isSqliteDatabase: () => false }))
import { recordAssistantStep } from "./thread-logic"

describe("当前Agent旧步骤表metadata-only写入", () => {
    it.each(["search_knowledge", "delegate_task", "source.lookup"])("%s不因工具别名保留请求或响应正文", async (toolName) => {
        mocks.values.mockClear()
        await recordAssistantStep({ metadataOnly: true, runId: 1, stepIndex: 2, toolName,
            input: { query: "private question" }, output: { summary: "private answer", nested: { text: "private evidence" } },
            status: "COMPLETED", durationMs: 3 })
        expect(mocks.values).toHaveBeenCalledOnce()
        const row = mocks.values.mock.calls[0][0]
        expect(JSON.stringify(row)).not.toContain("private")
        expect(row).toMatchObject({ runId: 1, stepIndex: 2, toolName, status: "COMPLETED", durationMs: 3 })
        expect(JSON.parse(row.inputJson)).toEqual({ redacted: true, reason: "agent-run-metadata-only" })
        expect(JSON.parse(row.outputJson)).toEqual({ redacted: true, reason: "agent-run-metadata-only" })
    })
})
