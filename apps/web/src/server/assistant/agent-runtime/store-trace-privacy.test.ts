import { describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ values: vi.fn(() => ({ onConflictDoNothing: async () => {} })) }))
vi.mock("@/server/db/client", () => ({ getDb: () => ({ insert: () => ({ values: mocks.values }) }) }))
import { persistTrace, persistSubtasks } from "./store"
import { TraceCollector } from "./trace"

describe("Trace与子任务落库边界", () => {
    it("混合工具、委派和自由事件只写脱敏载荷，不修改内存运行数据", async () => {
        mocks.values.mockClear()
        const trace = new TraceCollector("fixture", "1", "1", "synthetic", 0)
        trace.event("observation", { summary: "private_observation", alias: { raw: "private_nested" }, count: 2 })
        for (const toolId of ["source.search", "agent.delegate"]) {
            trace.recordToolCall({ id: toolId, toolId, toolName: toolId, namespace: "source", input: { query: "private_query" },
                rawOutput: { body: "private_body" }, summary: "private_summary", ok: true, durationMs: 1, retries: 0,
                evidenceIds: [], permissionDecision: "allowed", startedAt: 0 })
        }
        trace.recordDelegation({ taskId: "task", objective: "private_objective", status: "completed", depth: 1,
            durationMs: 1, evidenceCount: 0, traceId: "child" })
        const snapshot = trace.build()
        await persistTrace(snapshot)
        await persistSubtasks("fixture", snapshot)
        expect(mocks.values).toHaveBeenCalledTimes(3)
        const written = JSON.stringify(mocks.values.mock.calls)
        expect(written).not.toContain("private_")
        expect(written).toContain("source.search")
        expect(written).toContain("agent.delegate")
        expect(written).toContain("durationMs")
        expect(snapshot.delegations[0].objective).toBe("private_objective")
    })
})
