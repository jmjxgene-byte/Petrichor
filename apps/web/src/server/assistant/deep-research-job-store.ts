import { and, eq, inArray } from "drizzle-orm"
import { z } from "zod"

import { getDb } from "@/server/db/client"
import { deepResearchJobs, type DeepResearchJobRecord } from "@/server/db/schema"

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
