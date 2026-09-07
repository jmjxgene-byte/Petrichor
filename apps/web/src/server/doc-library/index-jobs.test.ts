import { beforeEach, describe, expect, it, vi } from "vitest"
import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
const mocks = vi.hoisted(() => ({ getDb: vi.fn(), isSqliteDatabase: vi.fn() }))
vi.mock("@/server/db/client", () => mocks)
import { claimDocumentIndexJob, heartbeatDocumentIndexJob, reserveDocumentIndexBudget, cancelDocumentIndexGeneration, failDocumentIndexJob, acknowledgeIndexCancellation } from "./index-jobs"

const now = new Date("2026-09-08T00:00:00Z")
const approval = { approvalId: "fixture", manifestHash: "a".repeat(64), maxInputTokens: 100, maxCostMicrousd: 100, expiresAt: "2099-01-01T00:00:00Z" }
const job = { id: 7, generationId: 3, userId: 1, status: "running", leaseOwner: "worker", leaseExpiresAt: new Date(now.getTime() + 1000),
    consumedInputTokens: 0, consumedCostMicrousd: 0, approvedBudgetJson: JSON.stringify(approval), attemptCount: 0 }

function fixture(results: unknown[][], returns: unknown[][] = []) {
    let index = 0, updateIndex = 0
    const settings: unknown[] = [], predicates: SQL[] = []
    const locking = vi.fn((_strength: string, _options?: unknown) => {})
    const tx = {
        execute: vi.fn(async (_statement: SQL) => []),
        select: () => {
            const rows = results[index++] ?? []
            const chain = { from: () => chain, where: (p: SQL) => { predicates.push(p); return chain },
                limit: () => chain, orderBy: () => chain, for: (strength: string, options?: unknown) => { locking(strength, options); return chain },
                then: <T>(resolve: (rows: unknown[]) => T) => Promise.resolve(rows).then(resolve) }
            return chain
        },
        update: vi.fn(() => ({ set: (value: unknown) => {
            settings.push(value)
            const result = returns[updateIndex++] ?? []
            return { where: (p: SQL) => { predicates.push(p); return { returning: async () => result } } }
        } })),
    }
    mocks.getDb.mockReturnValue({ ...tx, transaction: async (run: (tx: object) => unknown) => run(tx) })
    return { tx, settings, predicates, locking }
}
beforeEach(() => { vi.clearAllMocks(); mocks.isSqliteDatabase.mockReturnValue(false) })

describe("索引任务状态机存储契约", () => {
    it("重复取消返回已取消代际，不再次操作其job", async () => {
        const f = fixture([[{ id: 3, status: "cancelled" }]], [[]])
        expect(await cancelDocumentIndexGeneration(1, 3, now)).toEqual({ id: 3, status: "cancelled" })
        expect(f.settings).toHaveLength(1)
    })
    it("失败终态保留已占用预算并阻止代际继续处理", async () => {
        const f = fixture([], [[job], []])
        await failDocumentIndexJob({ userId: 1, jobId: 7, workerId: "worker", errorCode: "model_outcome_unknown" }, now)
        expect(f.settings[0]).toMatchObject({ status: "failed", leaseOwner: null, errorCode: "model_outcome_unknown" })
        expect(f.settings[0]).not.toHaveProperty("consumedInputTokens")
        expect(f.settings[1]).toMatchObject({ status: "failed" })
    })
    it("取消确认只允许原owner确认cancel_requested，不退还预算", async () => {
        const f = fixture([], [[job]])
        await acknowledgeIndexCancellation(7, "worker", now)
        const query = new PgDialect().sqlToQuery(f.predicates[0])
        expect(query.params).toContain("worker")
        expect(query.params).toContain("cancel_requested")
        expect(f.settings[0]).not.toHaveProperty("consumedCostMicrousd")
    })
    it("已有活跃任务时不认领新任务", async () => {
        const f = fixture([[], [{ id: 1 }]])
        expect(await claimDocumentIndexJob("worker", now)).toBeNull()
        expect(f.tx.update).not.toHaveBeenCalled()
    })
    it("候选通过SKIP LOCKED认领，保留单任务租约", async () => {
        const f = fixture([[], [], [job]], [[job]])
        expect(await claimDocumentIndexJob("worker", now)).toEqual(job)
        expect(f.locking).toHaveBeenCalledWith("update", { skipLocked: true })
        expect(f.settings[0]).toMatchObject({ status: "running", attemptCount: 1, leaseOwner: "worker", leaseExpiresAt: new Date(now.getTime()+60000) })
    })
    it("heartbeat必须匹配owner、running和未过期条件", async () => {
        const f = fixture([], [[job]])
        await heartbeatDocumentIndexJob(7, "worker", now)
        const query = new PgDialect().sqlToQuery(f.predicates[0])
        expect(query.sql).toContain('"lease_expires_at" >')
        expect(query.params).toContain("running")
        expect(query.params).toContain("worker")
    })
    it("按跨job消耗拒绝超额预占，不执行update", async () => {
        const f = fixture([[job], [{ id: 3, manifestHash: approval.manifestHash }], [{ inputTokens: "90", costMicrousd: "90" }]])
        await expect(reserveDocumentIndexBudget({ userId: 1, jobId: 7, workerId: "worker", reservation: { inputTokens: 11, costMicrousd: 0 } }, now)).rejects.toThrow("预算不足")
        expect(f.tx.update).not.toHaveBeenCalled()
    })
    it("预算已预占的任务不重复发放", async () => {
        const f = fixture([[{ ...job, consumedInputTokens: 20 }]])
        await expect(reserveDocumentIndexBudget({ userId: 1, jobId: 7, workerId: "worker", reservation: { inputTokens: 11, costMicrousd: 0 } }, now)).rejects.toThrow("禁止重复调用")
        expect(f.tx.update).not.toHaveBeenCalled()
    })
    it("取消building generation后分别取消queued与请求停止running", async () => {
        const f = fixture([], [[{ id: 3 }], [], []])
        expect(await cancelDocumentIndexGeneration(1, 3, now)).toEqual({ id: 3 })
        expect(f.settings).toEqual([
            { status: "cancelled", updatedAt: now }, { status: "cancelled", updatedAt: now }, { status: "cancel_requested", updatedAt: now },
        ])
        expect(new PgDialect().sqlToQuery(f.predicates[0]).params).toContain(1)
    })
})
