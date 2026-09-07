import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), isSqliteDatabase: vi.fn() }))
vi.mock("./client", () => mocks)
import { withReadBudget } from "./read-budget"

beforeEach(() => { vi.clearAllMocks(); mocks.isSqliteDatabase.mockReturnValue(false) })
afterEach(() => vi.restoreAllMocks())

describe("事务本地只读查询预算", () => {
    it("多条读取语句的checkpoint不断收窄剩余服务端预算", async () => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(1_000)
        const execute = vi.fn(async (_statement: SQL) => [])
        mocks.getDb.mockReturnValue({ transaction: async (callback: (tx: object) => unknown) => callback({ execute }) })
        await withReadBudget(async (_reader, checkpoint) => {
            clock.mockReturnValue(1_250)
            await checkpoint()
            return []
        }, { queryDeadlineAt: 1_500 })
        const dialect = new PgDialect()
        expect(execute.mock.calls.map(([statement]) => dialect.sqlToQuery(statement).params)).toEqual([["500"], ["250"]])
    })
    it("继承剩余deadline，以只读事务设置本地超时后查询", async () => {
        vi.spyOn(Date, "now").mockReturnValue(1_000)
        const execute = vi.fn(async (_statement: SQL) => [])
        const tx = { execute }
        const transaction = vi.fn(async (run) => run(tx))
        mocks.getDb.mockReturnValue({ transaction })
        const run = vi.fn(async () => ["safe"])
        expect(await withReadBudget(run, { queryDeadlineAt: 1_500 })).toEqual(["safe"])
        expect(transaction).toHaveBeenCalledWith(expect.any(Function), { accessMode: "read only" })
        const compiled = new PgDialect().sqlToQuery(execute.mock.calls[0][0])
        expect(compiled.sql).toContain("set_config('statement_timeout'")
        expect(compiled.sql).toContain("true")
        expect(compiled.params).toEqual(["500"])
        expect(execute.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0])
    })
    it("预先取消时不获取连接", async () => {
        const controller = new AbortController(); controller.abort()
        await expect(withReadBudget(async () => [], { abortSignal: controller.signal })).rejects.toThrow()
        expect(mocks.getDb).not.toHaveBeenCalled()
    })
    it("连接排队期间超时后不执行查询", async () => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(1_000)
        mocks.getDb.mockReturnValue({ transaction: async (callback: (tx: object) => unknown) => {
            clock.mockReturnValue(2_000)
            return callback({})
        } })
        const run = vi.fn(async () => [])
        await expect(withReadBudget(run, { queryDeadlineAt: 1_500 })).rejects.toThrow("超时")
        expect(run).not.toHaveBeenCalled()
    })
    it("取消后不交付查询返回内容，错误由事务回滚", async () => {
        const controller = new AbortController()
        mocks.getDb.mockReturnValue({ transaction: async (callback: (tx: object) => unknown) => callback({ execute: async () => [] }) })
        await expect(withReadBudget(async () => { controller.abort(); return ["discard"] }, { abortSignal: controller.signal })).rejects.toThrow()
    })
})
