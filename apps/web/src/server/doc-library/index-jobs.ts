import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm"
import { z } from "zod"
import { getDb, isSqliteDatabase } from "@/server/db/client"
import { docIndexGenerations, docIndexJobs } from "@/server/db/schema"
import { requireIndexApproval } from "./index-contract"
import { checkIndexReservation, expiredIndexJobState, hasLiveIndexLease, INDEX_LEASE_MS, INDEX_MAX_PRECALL_ATTEMPTS } from "./index-job-policy"

function pgDb() {
    if (isSqliteDatabase()) throw new Error("索引任务状态机要求PostgreSQL")
    return getDb()
}
const workerSchema = z.string().trim().min(1).max(200)

/** 全局短事务锁保证首期只有一个活跃索引任务；不在锁内调用模型或S3。 */
export async function claimDocumentIndexJob(workerId: string, clock?: Date) {
    workerId = workerSchema.parse(workerId)
    return await pgDb().transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('petrichor-doc-index-slot'))`)
        const now = clock ?? new Date()
        const expired = await tx.select().from(docIndexJobs).where(and(
            inArray(docIndexJobs.status, ["running", "cancel_requested"]), lte(docIndexJobs.leaseExpiresAt, now),
        )).for("update")
        for (const job of expired) {
            const next = expiredIndexJobState(job)
            await tx.update(docIndexJobs).set({ ...next, leaseOwner: null, leaseExpiresAt: null, updatedAt: now }).where(eq(docIndexJobs.id, job.id))
            if (next.status === "failed") await tx.update(docIndexGenerations).set({ status: "failed", errorCode: next.errorCode, updatedAt: now })
                .where(and(eq(docIndexGenerations.id, job.generationId), eq(docIndexGenerations.status, "building")))
        }
        const [active] = await tx.select({ id: docIndexJobs.id }).from(docIndexJobs).where(and(
            inArray(docIndexJobs.status, ["running", "cancel_requested"]), gt(docIndexJobs.leaseExpiresAt, now),
        )).limit(1)
        if (active) return null
        const [job] = await tx.select().from(docIndexJobs).where(and(
            eq(docIndexJobs.status, "queued"), lte(docIndexJobs.availableAt, now),
            sql`${docIndexJobs.attemptCount} < ${INDEX_MAX_PRECALL_ATTEMPTS}`,
            sql`exists (select 1 from petrichor_doc_index_generation g where g.id = ${docIndexJobs.generationId} and g.status = 'building')`,
        )).orderBy(asc(docIndexJobs.availableAt), asc(docIndexJobs.id)).limit(1).for("update", { skipLocked: true })
        if (!job) return null
        const claimedAt = clock ?? new Date()
        const [claimed] = await tx.update(docIndexJobs).set({
            status: "running", leaseOwner: workerId, leaseExpiresAt: new Date(claimedAt.getTime() + INDEX_LEASE_MS),
            heartbeatAt: claimedAt, attemptCount: job.attemptCount + 1, errorCode: null, updatedAt: claimedAt,
        }).where(eq(docIndexJobs.id, job.id)).returning()
        return claimed ?? null
    })
}

export async function heartbeatDocumentIndexJob(jobId: number, workerId: string, clock?: Date) {
    const now = clock ?? new Date()
    const [job] = await pgDb().update(docIndexJobs).set({ heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + INDEX_LEASE_MS), updatedAt: now,
    }).where(and(eq(docIndexJobs.id, jobId), eq(docIndexJobs.status, "running"),
        eq(docIndexJobs.leaseOwner, workerId), gt(docIndexJobs.leaseExpiresAt, now))).returning()
    return job ?? null
}

/** 整任务调用前预占上界；已占用则拒绝再次执行。失败/崩溃不自动退回额度。 */
export async function reserveDocumentIndexBudget(input: { userId: number; jobId: number; workerId: string; reservation: unknown }, clock?: Date) {
    return await pgDb().transaction(async (tx) => {
        // 与claim统一先slot再job，避免过期恢复与预算锁反向等待。
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('petrichor-doc-index-slot'))`)
        const now = clock ?? new Date()
        const [job] = await tx.select().from(docIndexJobs).where(and(eq(docIndexJobs.id, input.jobId), eq(docIndexJobs.userId, input.userId))).for("update")
        if (!job || !hasLiveIndexLease(job, input.workerId, clock ?? new Date())) throw new Error("索引任务租约已失效")
        if (job.consumedInputTokens || job.consumedCostMicrousd) throw new Error("任务已预占模型预算，禁止重复调用")
        const [generation] = await tx.select().from(docIndexGenerations).where(and(
            eq(docIndexGenerations.id, job.generationId), eq(docIndexGenerations.status, "building"),
        )).for("update")
        if (!generation) throw new Error("索引generation不可执行")
        const approval = requireIndexApproval(JSON.parse(job.approvedBudgetJson), generation.manifestHash, now.getTime())
        const [used] = await tx.select({
            inputTokens: sql<string>`coalesce(sum(${docIndexJobs.consumedInputTokens}),0)::text`,
            costMicrousd: sql<string>`coalesce(sum(${docIndexJobs.consumedCostMicrousd}),0)::text`,
        }).from(docIndexJobs).where(eq(docIndexJobs.generationId, job.generationId))
        const reservation = checkIndexReservation(approval, {
            inputTokens: Number(used?.inputTokens ?? 0), costMicrousd: Number(used?.costMicrousd ?? 0),
        }, input.reservation)
        const reservedAt = clock ?? new Date()
        if (!hasLiveIndexLease(job, input.workerId, reservedAt)) throw new Error("索引任务租约已失效")
        requireIndexApproval(approval, generation.manifestHash, reservedAt.getTime())
        await tx.update(docIndexJobs).set({ consumedInputTokens: reservation.inputTokens,
            consumedCostMicrousd: reservation.costMicrousd, updatedAt: reservedAt,
        }).where(eq(docIndexJobs.id, job.id))
        return reservation
    })
}

export async function cancelDocumentIndexGeneration(userId: number, generationId: number, clock?: Date) {
    return await pgDb().transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('petrichor-doc-index-slot'))`)
        const now = clock ?? new Date()
        const [generation] = await tx.update(docIndexGenerations).set({ status: "cancelled", updatedAt: now })
            .where(and(eq(docIndexGenerations.id, generationId), eq(docIndexGenerations.userId, userId), eq(docIndexGenerations.status, "building"))).returning()
        if (!generation) return null
        await tx.update(docIndexJobs).set({ status: "cancelled", updatedAt: now }).where(and(eq(docIndexJobs.generationId, generationId), eq(docIndexJobs.status, "queued")))
        await tx.update(docIndexJobs).set({ status: "cancel_requested", updatedAt: now }).where(and(eq(docIndexJobs.generationId, generationId), eq(docIndexJobs.status, "running")))
        return generation
    })
}

const failureCodeSchema = z.enum(["source_changed", "model_failed", "validation_failed", "budget_exceeded", "model_outcome_unknown"])

export async function acknowledgeIndexCancellation(jobId: number, workerId: string, now = new Date()) {
    const [job] = await pgDb().update(docIndexJobs).set({ status: "cancelled", leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
        .where(and(eq(docIndexJobs.id, jobId), eq(docIndexJobs.leaseOwner, workerId), eq(docIndexJobs.status, "cancel_requested"))).returning()
    return job ?? null
}

export async function failDocumentIndexJob(input: { userId: number; jobId: number; workerId: string; errorCode: z.infer<typeof failureCodeSchema> }, clock?: Date) {
    const errorCode = failureCodeSchema.parse(input.errorCode)
    return await pgDb().transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('petrichor-doc-index-slot'))`)
        const now = clock ?? new Date()
        const [job] = await tx.update(docIndexJobs).set({ status: "failed", errorCode, leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
            .where(and(eq(docIndexJobs.id, input.jobId), eq(docIndexJobs.userId, input.userId), eq(docIndexJobs.leaseOwner, input.workerId),
                eq(docIndexJobs.status, "running"), gt(docIndexJobs.leaseExpiresAt, now))).returning()
        if (!job) return null
        await tx.update(docIndexGenerations).set({ status: "failed", errorCode, updatedAt: now })
            .where(and(eq(docIndexGenerations.id, job.generationId), eq(docIndexGenerations.status, "building")))
        return job
    })
}
