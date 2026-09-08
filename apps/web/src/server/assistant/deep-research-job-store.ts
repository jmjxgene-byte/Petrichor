import { and, eq, gt, inArray, isNull } from "drizzle-orm"
import { z } from "zod"
import { normalizeDeepEvidenceUrl } from "@/lib/deep-evidence-url"
import { assistantSourceRefSchema } from "@/lib/assistant-source-contract"

import { getDb, getSqlClient, isSqliteDatabase } from "@/server/db/client"
import { agentRuns, assistantMessages, assistantThreads, deepResearchJobs, type DeepResearchJobRecord } from "@/server/db/schema"

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
    reservationVersion: z.literal(1).optional(),
    sources: z.array(z.object({
        sourceRef: assistantSourceRefSchema,
        kind: z.enum(["knowledge-base", "doc-library", "external-source"]),
        contractVersion: z.number().int().nonnegative().nullable(),
        sourceCutoffs: z.record(z.string(), z.string().nullable()),
        allowedModes: z.array(z.enum(["exact", "fuzzy", "hybrid"])).max(3),
        qualityStale: z.boolean(),
        wikiReady: z.boolean(),
        graphReady: z.boolean(),
    }).strict().refine((source) => source.sourceRef.startsWith(`${source.kind}:`), "source_kind_mismatch")).max(200)
        .refine((sources) => new Set(sources.map((source) => source.sourceRef)).size === sources.length, "duplicate_source").optional(),
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
            anchorVerified: z.literal(false).optional(),
            title: z.string().trim().min(1).max(500),
            url: z.string().max(2_000).nullable(),
            citationIndex: z.number().int().min(1).max(40).optional(),
            source: z.string().trim().min(1).max(100),
            sourceKind: z.enum([
                "knowledge", "document", "wiki", "web", "memory",
                "graph", "tool", "subagent", "geneops",
            ]).optional(),
            queriedAt: z.string().datetime(),
        }).strict().refine((reference) => reference.url == null || normalizeDeepEvidenceUrl(reference.url, reference.sourceKind) === reference.url, "unsafe_reference_url")).max(40),
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

export function deepResearchRetryPlan(attemptCount: number, maxAttempts: number, retryable = true) {
    if (!retryable || attemptCount >= maxAttempts) return { status: "failed" as const, delaySeconds: 0 }
    const index = Math.min(Math.max(attemptCount - 1, 0), DEEP_RESEARCH_RETRY_BACKOFF_SECONDS.length - 1)
    return { status: "retry_wait" as const, delaySeconds: DEEP_RESEARCH_RETRY_BACKOFF_SECONDS[index] }
}

export async function failDeepResearchJob(input: {
    jobId: number
    workerId: string
    errorCode: DeepResearchErrorCode
    retryable?: boolean
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

    const plan = deepResearchRetryPlan(current.attemptCount, current.maxAttempts, input.retryable !== false && errorCode !== "validation_failed")
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
                  and capability_snapshot_json::jsonb ->> 'reservationVersion' = '1'
                  and not exists (select 1 from petrichor_agent_run r where r.run_key = petrichor_deep_research_job.run_key)
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
                  and (attempt_count >= max_attempts
                       or (capability_snapshot_json::jsonb ->> 'reservationVersion') is distinct from '1'
                       or exists (select 1 from petrichor_agent_run r where r.run_key = petrichor_deep_research_job.run_key))
                returning id
            `
            const cancelledRows = await sql<Array<{ id: number }>>`
                with cancelled as (
                    update petrichor_deep_research_job
                    set status = 'cancelled', lease_owner = null, lease_expires_at = null,
                        heartbeat_at = null, error_code = 'cancelled',
                        cancelled_at = coalesce(cancelled_at, ${now}), completed_at = ${now}, updated_at = ${now}
                    where status = 'cancel_requested'
                      and (lease_expires_at <= ${now} or lease_expires_at is null)
                    returning id, run_key, user_id
                ), closed_runs as (
                    update petrichor_agent_run r
                    set status = 'cancelled', stop_reason = 'cancelled', completed_at = coalesce(completed_at, ${now})
                    where r.status = 'running'
                      and exists (select 1 from cancelled c where c.run_key = r.run_key and c.user_id = r.user_id)
                    returning r.id
                )
                select id from cancelled
            `
            return { retried: retryRows.length, failed: failedRows.length, cancelled: cancelledRows.length }
        })
    } finally {
        await client.end({ timeout: 5 })
    }
}

/** 有效租约下原子创建唯一Run；未成功落盘不得开始任何模型调用。旧Run一律保守视为可能已计费。 */
export async function reserveDeepResearchExecution(jobId: number, workerId: string, now = new Date()) {
    const client = getSqlClient()
    try {
        return await client.begin(async (sql) => {
            const rows = await sql<Array<{ id: number }>>`
                with active_job as (
                    select run_key, thread_id, user_id, question_message_id, fast_run_key
                    from petrichor_deep_research_job
                    where id = ${jobId} and status = 'running' and lease_owner = ${workerId}
                      and lease_expires_at > ${now}
                    for update
                )
                insert into petrichor_agent_run
                    (run_key, conversation_id, thread_id, user_id, model, goal, complexity, status, retry_of_run_key, metrics_json)
                select run_key, thread_id::text, thread_id, user_id, 'unresolved',
                       '[deep-research-message:' || question_message_id::text || ']', 'complex', 'running', fast_run_key,
                       '{"modelWorkReserved":true}'
                from active_job
                on conflict (run_key) do nothing
                returning id
            `
            return rows.length === 1
        })
    } finally { await client.end({ timeout: 5 }) }
}

export async function completeDeepResearchJob(input: {
    jobId: number
    workerId: string
    message: DeepResearchFinalMessage
    runCompletion?: { answer: string; metricsJson: string; inputTokens: number; outputTokens: number; totalTokens: number; durationMs: number }
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
        if (!current.leaseExpiresAt || current.leaseExpiresAt <= now) return null
        if (input.runCompletion && message.agentRunId !== current.runKey) throw new Error("深度检索Run关联不匹配")
        const threadQuery = tx.select({ id: assistantThreads.id }).from(assistantThreads).where(and(eq(assistantThreads.id, current.threadId), eq(assistantThreads.userId, current.userId), isNull(assistantThreads.deletedAt))).limit(1)
        const [thread] = isSqliteDatabase() ? await threadQuery : await threadQuery.for("update")
        if (!thread) return null
        const [question] = await tx.select({ id: assistantMessages.id }).from(assistantMessages).where(and(eq(assistantMessages.id, current.questionMessageId), eq(assistantMessages.threadId, current.threadId), eq(assistantMessages.role, "user"))).limit(1)
        if (!question) return null

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
            gt(deepResearchJobs.leaseExpiresAt, now),
        )).returning()
        if (!completed) throw new Error("深度检索完成状态竞争")
        if (input.runCompletion) {
            const [run] = await tx.update(agentRuns).set({ ...input.runCompletion, status: "completed", completedAt: now })
                .where(and(eq(agentRuns.runKey, current.runKey), eq(agentRuns.userId, current.userId), eq(agentRuns.threadId, current.threadId), eq(agentRuns.status, "running")))
                .returning({ id: agentRuns.id })
            if (!run) throw new Error("深度检索Run完成状态竞争")
        }
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
