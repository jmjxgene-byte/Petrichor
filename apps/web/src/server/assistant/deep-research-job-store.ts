import { and, eq, inArray } from "drizzle-orm"
import { z } from "zod"

import { getDb, getSqlClient } from "@/server/db/client"
import { assistantMessages, deepResearchJobs, type DeepResearchJobRecord } from "@/server/db/schema"

export const DEEP_RESEARCH_JOB_STATUSES = [
    "queued",
    "running",
    "retry_wait",
    "cancel_requested",
    "cancelled",
    "succeeded",
    "failed",
] as const

export type DeepResearchJobStatus = typeof DEEP_RESEARCH_JOB_STATUSES[number]

export const DEEP_RESEARCH_LEASE_SECONDS = 60
export const DEEP_RESEARCH_HEARTBEAT_SECONDS = 20
export const DEEP_RESEARCH_RETRY_BACKOFF_SECONDS = [10, 30, 90] as const

export const deepResearchErrorCodeSchema = z.enum([
    "timeout",
    "connection_failed",
    "model_failed",
    "validation_failed",
    "cancelled",
    "internal_error",
    "lease_expired",
])

export type DeepResearchErrorCode = z.infer<typeof deepResearchErrorCodeSchema>

export const deepResearchCapabilitySnapshotSchema = z.object({
    contractVersion: z.number().int().nonnegative().nullable(),
    sourceCutoffs: z.record(z.string(), z.string().nullable()).default({}),
    allowedModes: z.array(z.enum(["exact", "fuzzy", "hybrid"])).max(3),
    wikiReady: z.boolean(),
    graphReady: z.boolean(),
    qualityStale: z.boolean(),
    capturedAt: z.string().datetime(),
}).strict()

export type DeepResearchCapabilitySnapshot = z.infer<typeof deepResearchCapabilitySnapshotSchema>

export const deepResearchFinalMessageSchema = z.object({
    parts: z.array(z.object({
        type: z.literal("text"),
        text: z.string().min(1).max(100_000),
    }).strict()).min(1).max(4),
    agentRunId: z.string().trim().min(1).max(64),
    deepResearch: z.object({
        runKey: z.string().trim().min(1).max(64),
        fastRunKey: z.string().trim().min(1).max(64).nullable(),
        references: z.array(z.object({
            title: z.string().trim().min(1).max(500),
            url: z.string().url().max(2_000),
            source: z.string().trim().min(1).max(100),
            queriedAt: z.string().datetime(),
        }).strict()).max(40),
    }).strict(),
}).strict()

export type DeepResearchFinalMessage = z.infer<typeof deepResearchFinalMessageSchema>

export type CreateDeepResearchJobInput = {
    runKey: string
    idempotencyKey: string
    threadId: number
    userId: number
    questionMessageId: number
    fastRunKey?: string | null
    sourceScopeHash: string
    capabilitySnapshot: DeepResearchCapabilitySnapshot
}

const cancellableStatuses: DeepResearchJobStatus[] = ["queued", "retry_wait"]

export async function createDeepResearchJob(input: CreateDeepResearchJobInput) {
    const capabilitySnapshot = deepResearchCapabilitySnapshotSchema.parse(input.capabilitySnapshot)
    const db = getDb()
    const [created] = await db
        .insert(deepResearchJobs)
        .values({
            runKey: input.runKey,
            idempotencyKey: input.idempotencyKey,
            threadId: input.threadId,
            userId: input.userId,
            questionMessageId: input.questionMessageId,
            fastRunKey: input.fastRunKey ?? null,
            sourceScopeHash: input.sourceScopeHash,
            capabilitySnapshotJson: JSON.stringify(capabilitySnapshot),
        })
        .onConflictDoNothing({ target: deepResearchJobs.idempotencyKey })
        .returning()
    if (created) return created

    const [existing] = await db
        .select()
        .from(deepResearchJobs)
        .where(and(
            eq(deepResearchJobs.idempotencyKey, input.idempotencyKey),
            eq(deepResearchJobs.userId, input.userId),
        ))
        .limit(1)
    if (!existing) throw new Error("深度检索幂等键冲突")
    return existing
}

export async function getDeepResearchJob(runKey: string, userId: number) {
    const [job] = await getDb()
        .select()
        .from(deepResearchJobs)
        .where(and(eq(deepResearchJobs.runKey, runKey), eq(deepResearchJobs.userId, userId)))
        .limit(1)
    return job ?? null
}

export async function claimDeepResearchJob(input: {
    workerId: string
    now?: Date
    leaseSeconds?: number
}) {
    const workerId = z.string().trim().min(1).max(200).parse(input.workerId)
    const now = input.now ?? new Date()
    const leaseSeconds = z.number().int().min(10).max(300).parse(
        input.leaseSeconds ?? DEEP_RESEARCH_LEASE_SECONDS,
    )
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1_000)
    const client = getSqlClient()
    try {
        const claimedId = await client.begin(async (sql) => {
            const [claimed] = await sql<Array<{ id: number }>>`
                with candidate as (
                    select id
                    from petrichor_deep_research_job
                    where status in ('queued', 'retry_wait')
                      and available_at <= ${now}
                      and attempt_count < max_attempts
                    order by available_at, id
                    for update skip locked
                    limit 1
                )
                update petrichor_deep_research_job as job
                set status = 'running',
                    attempt_count = job.attempt_count + 1,
                    lease_owner = ${workerId},
                    lease_expires_at = ${leaseExpiresAt},
                    heartbeat_at = ${now},
                    started_at = coalesce(job.started_at, ${now}),
                    updated_at = ${now}
                where job.id = (select id from candidate)
                returning job.id
            `
            return claimed?.id ?? null
        })
        if (claimedId == null) return null
        const [job] = await getDb().select().from(deepResearchJobs)
            .where(eq(deepResearchJobs.id, claimedId)).limit(1)
        return job ?? null
    } finally {
        await client.end({ timeout: 5 })
    }
}

export async function heartbeatDeepResearchJob(input: {
    jobId: number
    workerId: string
    now?: Date
    leaseSeconds?: number
}) {
    const now = input.now ?? new Date()
    const leaseSeconds = input.leaseSeconds ?? DEEP_RESEARCH_LEASE_SECONDS
    const [job] = await getDb().update(deepResearchJobs).set({
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1_000),
        updatedAt: now,
    }).where(and(
        eq(deepResearchJobs.id, input.jobId),
        eq(deepResearchJobs.status, "running"),
        eq(deepResearchJobs.leaseOwner, input.workerId),
    )).returning()
    return job ?? null
}

export function deepResearchRetryPlan(attemptCount: number, maxAttempts: number) {
    if (attemptCount >= maxAttempts) return { status: "failed" as const, delaySeconds: 0 }
    const index = Math.min(Math.max(attemptCount - 1, 0), DEEP_RESEARCH_RETRY_BACKOFF_SECONDS.length - 1)
    return { status: "retry_wait" as const, delaySeconds: DEEP_RESEARCH_RETRY_BACKOFF_SECONDS[index] }
}

export async function failDeepResearchJob(input: {
    jobId: number
    workerId: string
    errorCode: DeepResearchErrorCode
    now?: Date
}) {
    const now = input.now ?? new Date()
    const errorCode = deepResearchErrorCodeSchema.parse(input.errorCode)
    const [current] = await getDb().select().from(deepResearchJobs).where(and(
        eq(deepResearchJobs.id, input.jobId),
        eq(deepResearchJobs.status, "running"),
        eq(deepResearchJobs.leaseOwner, input.workerId),
    )).limit(1)
    if (!current) return null

    const plan = deepResearchRetryPlan(current.attemptCount, current.maxAttempts)
    const [job] = await getDb().update(deepResearchJobs).set({
        status: plan.status,
        availableAt: new Date(now.getTime() + plan.delaySeconds * 1_000),
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        errorCode,
        completedAt: plan.status === "failed" ? now : null,
        updatedAt: now,
    }).where(and(
        eq(deepResearchJobs.id, current.id),
        eq(deepResearchJobs.status, "running"),
        eq(deepResearchJobs.leaseOwner, input.workerId),
    )).returning()
    return job ?? null
}

export async function recoverExpiredDeepResearchJobs(now = new Date()) {
    const client = getSqlClient()
    try {
        return await client.begin(async (sql) => {
            const retryRows = await sql<Array<{ id: number }>>`
                update petrichor_deep_research_job
                set status = 'retry_wait',
                    available_at = ${now},
                    lease_owner = null,
                    lease_expires_at = null,
                    heartbeat_at = null,
                    error_code = 'lease_expired',
                    updated_at = ${now}
                where status = 'running'
                  and lease_expires_at <= ${now}
                  and attempt_count < max_attempts
                returning id
            `
            const failedRows = await sql<Array<{ id: number }>>`
                update petrichor_deep_research_job
                set status = 'failed',
                    lease_owner = null,
                    lease_expires_at = null,
                    heartbeat_at = null,
                    error_code = 'lease_expired',
                    completed_at = ${now},
                    updated_at = ${now}
                where status = 'running'
                  and lease_expires_at <= ${now}
                  and attempt_count >= max_attempts
                returning id
            `
            return { retried: retryRows.length, failed: failedRows.length }
        })
    } finally {
        await client.end({ timeout: 5 })
    }
}

export async function completeDeepResearchJob(input: {
    jobId: number
    workerId: string
    message: DeepResearchFinalMessage
    now?: Date
}) {
    const message = deepResearchFinalMessageSchema.parse(input.message)
    const now = input.now ?? new Date()
    return await getDb().transaction(async (tx) => {
        const [current] = await tx.select().from(deepResearchJobs)
            .where(eq(deepResearchJobs.id, input.jobId)).limit(1)
        if (!current) return null
        if (current.status === "succeeded" && current.resultMessageId != null) {
            const [existingMessage] = await tx.select().from(assistantMessages)
                .where(eq(assistantMessages.id, current.resultMessageId)).limit(1)
            return existingMessage ? { job: current, message: existingMessage } : null
        }
        if (current.status !== "running" || current.leaseOwner !== input.workerId) return null

        const [createdMessage] = await tx.insert(assistantMessages).values({
            threadId: current.threadId,
            role: "assistant",
            contentJson: JSON.stringify(message),
        }).returning()
        const [completed] = await tx.update(deepResearchJobs).set({
            status: "succeeded",
            resultMessageId: createdMessage.id,
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            errorCode: null,
            completedAt: now,
            updatedAt: now,
        }).where(and(
            eq(deepResearchJobs.id, current.id),
            eq(deepResearchJobs.status, "running"),
            eq(deepResearchJobs.leaseOwner, input.workerId),
        )).returning()
        if (!completed) throw new Error("深度检索完成状态竞争")
        return { job: completed, message: createdMessage }
    })
}

export async function requestDeepResearchJobCancellation(runKey: string, userId: number) {
    const db = getDb()
    const now = new Date()
    const [cancelled] = await db
        .update(deepResearchJobs)
        .set({ status: "cancelled", cancelledAt: now, completedAt: now, updatedAt: now })
        .where(and(
            eq(deepResearchJobs.runKey, runKey),
            eq(deepResearchJobs.userId, userId),
            inArray(deepResearchJobs.status, cancellableStatuses),
        ))
        .returning()
    if (cancelled) return cancelled

    const [requested] = await db
        .update(deepResearchJobs)
        .set({ status: "cancel_requested", cancelledAt: now, updatedAt: now })
        .where(and(
            eq(deepResearchJobs.runKey, runKey),
            eq(deepResearchJobs.userId, userId),
            eq(deepResearchJobs.status, "running"),
        ))
        .returning()
    return requested ?? await getDeepResearchJob(runKey, userId)
}

export async function acknowledgeDeepResearchJobCancellation(input: {
    jobId: number
    workerId: string
    now?: Date
}) {
    const now = input.now ?? new Date()
    const [job] = await getDb().update(deepResearchJobs).set({
        status: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        errorCode: "cancelled",
        cancelledAt: now,
        completedAt: now,
        updatedAt: now,
    }).where(and(
        eq(deepResearchJobs.id, input.jobId),
        eq(deepResearchJobs.status, "cancel_requested"),
        eq(deepResearchJobs.leaseOwner, input.workerId),
    )).returning()
    return job ?? null
}

export function toDeepResearchJobResponse(job: DeepResearchJobRecord) {
    const snapshot = deepResearchCapabilitySnapshotSchema.parse(JSON.parse(job.capabilitySnapshotJson))
    return {
        runKey: job.runKey,
        status: job.status as DeepResearchJobStatus,
        fastRunKey: job.fastRunKey,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
        errorCode: job.errorCode,
        resultMessageId: job.resultMessageId == null ? null : String(job.resultMessageId),
        capabilitySnapshot: snapshot,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
        startedAt: job.startedAt?.toISOString() ?? null,
        completedAt: job.completedAt?.toISOString() ?? null,
        cancelledAt: job.cancelledAt?.toISOString() ?? null,
    }
}
