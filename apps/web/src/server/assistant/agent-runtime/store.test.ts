import { describe, expect, it, vi } from "vitest"

const getDb = vi.fn()
const logMocks = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock("@/server/db/client", () => ({ getDb: () => getDb() }))
vi.mock("@/lib/logger", () => ({
    createLogger: () => logMocks,
    toLogError: (error: unknown) => error instanceof Error ? error : new Error(String(error)),
}))

import { __testing, listAgentRunsForConversation, loadAgentRunTrace, loadAgentRunView } from "./store"

/**
 * 持久化层的错误日志必须能定位问题：
 * drizzle真正错误码在cause上；message/detail/stack可能含参数，禁止直接打印。
 */
describe("logStoreError", () => {
    function capture(error: unknown): Record<string, unknown> {
        logMocks.error.mockClear()
        __testing.logStoreError("createRun", error, { runKey: "run_x" })
        return logMocks.error.mock.calls[0][0] as Record<string, unknown>
    }

    it("仅带出cause上的SQLSTATE，不打印SQL与详情", () => {
        const error = new Error("Failed query: insert into ...")
        error.cause = { code: "42P01", message: 'relation "petrichor_agent_run" does not exist' }
        const payload = capture(error)

        expect(payload.code).toBe("42P01")
        expect(payload.errorKind).toBe("database_error")
        expect(payload).not.toHaveProperty("cause")
        expect(payload).not.toHaveProperty("err")
        expect(JSON.stringify(payload)).not.toContain("insert into")
        expect(JSON.stringify(payload)).not.toContain("does not exist")
    })

    it("表不存在时给出可执行的迁移提示", () => {
        const error = new Error("Failed query")
        error.cause = { code: "42P01", message: "relation does not exist" }
        expect(String(capture(error).hint)).toContain("2026-08-18-agent-runtime-v2.sql")
    })

    it("其它错误码不会误报迁移提示", () => {
        const error = new Error("Failed query")
        error.cause = { code: "23505", message: "duplicate key" }
        const payload = capture(error)
        expect(payload.hint).toBeUndefined()
        expect(payload.code).toBe("23505")
    })

    it("没有 cause 时不崩，仍保留上下文", () => {
        const payload = capture(new Error("boom"))
        expect(payload.errorKind).toBe("error")
        expect(JSON.stringify(payload)).not.toContain("boom")
        expect(payload.runKey).toBe("run_x")
    })

    it("非 Error 值也能记录", () => {
        const payload = capture("private non-error payload")
        expect(payload.errorKind).toBe("unknown_error")
        expect(JSON.stringify(payload)).not.toContain("private")
    })
    it("恶意错误名、详情和扩展上下文字段均不泄漏", () => {
        logMocks.error.mockClear()
        const error = new Error("private query")
        error.name = "private body"
        error.stack = "private stack"
        error.cause = { code: "private_code", message: "private detail", detail: "private parameters" }
        __testing.logStoreError("persistEvidence", error, { runKey: "run_x", conversationId: "2", rawInput: "private context" })
        const payload = logMocks.error.mock.calls[0][0]
        expect(JSON.stringify(payload)).not.toContain("private")
        expect(payload).toMatchObject({ scope: "persistEvidence", runKey: "run_x", conversationId: "2", errorKind: "error" })
        expect(payload).not.toHaveProperty("code")
    })
    it("原始Postgres错误对象也只保留合法SQLSTATE", () => {
        expect(capture({ code: "23505", detail: "private duplicate value" })).toMatchObject({ code: "23505", errorKind: "database_error" })
    })
})

/**
 * 读路径必须 fail-open：迁移未执行时接口不能 500，
 * 否则聊天页恢复执行面板时会整页报错。
 */
describe("读路径容错", () => {
    function throwUndefinedTable() {
        getDb.mockImplementation(() => {
            const error = new Error("Failed query: select ...")
            error.cause = { code: "42P01", message: 'relation "petrichor_agent_run" does not exist' }
            throw error
        })
    }

    it("表不存在时 loadAgentRunView 返回 null 而不是抛错", async () => {
        throwUndefinedTable()
        logMocks.error.mockClear()
        await expect(loadAgentRunView("run_x", 1)).resolves.toBeNull()
        expect(String(logMocks.error.mock.calls[0][0].hint)).toContain("2026-08-18-agent-runtime-v2.sql")
    })

    it("表不存在时 loadAgentRunTrace 返回 null", async () => {
        throwUndefinedTable()
        await expect(loadAgentRunTrace("run_x", 1)).resolves.toBeNull()
    })

    it("表不存在时 listAgentRunsForConversation 返回空数组", async () => {
        throwUndefinedTable()
        await expect(listAgentRunsForConversation("1", 1)).resolves.toEqual([])
    })
})
