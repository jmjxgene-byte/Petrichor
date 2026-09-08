import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ values: vi.fn(), set: vi.fn(), where: vi.fn() }))
vi.mock("@/server/db/client", () => ({ getDb: () => ({ insert: () => ({ values: mocks.values }), update: () => ({ set: mocks.set }) }) }))
import { createAgentRunRecord, finishAgentRunRecord } from "./store"
import { AgentStateStore } from "./state"
import { TraceCollector } from "./trace"
import { questionMessageIdFromMetadata } from "@/lib/question-message-id"
beforeEach(() => { vi.clearAllMocks(); mocks.values.mockResolvedValue(undefined); mocks.set.mockReturnValue({ where: mocks.where }); mocks.where.mockResolvedValue(undefined) })
describe("Run问题关联元数据", () => {
    it("创建与收尾均保留同一服务器问题ID，不由latency覆盖", async () => {
        await createAgentRunRecord({ runKey: "fixture", conversationId: "11", threadId: 11, userId: 7, model: "fixture", goal: "合成", complexity: "simple", questionMessageId: 79 })
        expect(questionMessageIdFromMetadata(mocks.values.mock.calls[0][0].metricsJson)).toBe("79")
        const state = new AgentStateStore({ runId: "fixture", conversationId: "11", userId: "7", goal: "合成" })
        const trace = new TraceCollector("fixture", "11", "7", "fixture")
        await finishAgentRunRecord({ runKey: "fixture", questionMessageId: 79, state: state.snapshot(), trace: trace.build(), answer: "合成" })
        const metrics = mocks.set.mock.calls[0][0].metricsJson
        expect(questionMessageIdFromMetadata(metrics)).toBe("79")
        expect(JSON.parse(metrics).latency).toBeDefined()
    })
    it("旧、损坏或临时ID元数据不产生可用关联", () => {
        for (const value of [null, "{broken", "{}", '{"questionMessageId":"client-id"}', '{"questionMessageId":"0"}']) expect(questionMessageIdFromMetadata(value)).toBeNull()
    })
})
