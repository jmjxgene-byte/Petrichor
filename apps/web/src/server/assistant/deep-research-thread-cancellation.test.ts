import { describe, expect, it, vi } from "vitest"
import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import { cancelDeepResearchForScope } from "./deep-research-thread-cancellation"
describe("会话变更取消范围", () => {
    it("仅针对所属用户、目标会话和被移除问题，区分排队与运行态", async () => {
        const where = vi.fn(async (_condition: SQL) => undefined), set = vi.fn((_value: { status: string }) => ({ where }))
        const tx = { update: vi.fn(() => ({ set })) } as unknown as Parameters<typeof cancelDeepResearchForScope>[0]
        await cancelDeepResearchForScope(tx, 7, [11], [79])
        expect(set.mock.calls.map((call) => call[0].status)).toEqual(["cancelled", "cancel_requested", "cancelled"])
        const dialect = new PgDialect()
        expect(dialect.sqlToQuery(where.mock.calls[0][0]).params).toEqual([7, 11, 79, "queued", "retry_wait"])
        expect(dialect.sqlToQuery(where.mock.calls[1][0]).params).toEqual([7, 11, 79, "running"])
        expect(dialect.sqlToQuery(where.mock.calls[2][0]).params).toEqual([7, "running", 7, 11, 79, "cancel_requested", "cancelled"])
    })
    it("空目标不会退化成取消全部任务", async () => {
        const update = vi.fn()
        const tx = { update } as unknown as Parameters<typeof cancelDeepResearchForScope>[0]
        await cancelDeepResearchForScope(tx, 7, [], undefined)
        await cancelDeepResearchForScope(tx, 7, [11], [])
        expect(update).not.toHaveBeenCalled()
    })
})
