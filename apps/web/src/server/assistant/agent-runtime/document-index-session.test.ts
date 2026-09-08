import { describe, expect, it } from "vitest"
import { getDocumentIndexSession } from "./document-index-session"
import { AgentStateStore } from "./state"
import type { ToolExecutionContext } from "./types"

function context(): ToolExecutionContext {
    const state = new AgentStateStore({ conversationId: "fixture", userId: "1", goal: "合成" }).current
    return { runId: state.runId, conversationId: "fixture", userId: 1, state, delegationDepth: 0 }
}

describe("同次回答的文档索引会话", () => {
    it("先委派再搜索仍与父回答共享版本和队列，独立state不合并", () => {
        const parent = context()
        const child = { ...context(), documentIndexReadSession: getDocumentIndexSession(parent) }
        const nested = { ...context(), documentIndexReadSession: getDocumentIndexSession(child) }
        getDocumentIndexSession(child).pins.set(3, 5)
        expect(getDocumentIndexSession(parent).pins.get(3)).toBe(5)
        expect(getDocumentIndexSession(nested)).toBe(getDocumentIndexSession(parent))
        expect(getDocumentIndexSession(child).queue).toBe(getDocumentIndexSession(parent).queue)
        expect(child.state).not.toBe(parent.state)
        expect(JSON.stringify(parent.state)).not.toContain("pins")
    })
    it("同一用户同一对话的新Run不继承上一回答的pin", () => {
        const first = context()
        getDocumentIndexSession(first).pins.set(3, 5)
        const next = context()
        expect(getDocumentIndexSession(next).pins.size).toBe(0)
        expect(getDocumentIndexSession(next)).not.toBe(getDocumentIndexSession(first))
    })
})
