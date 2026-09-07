import { z } from "zod"
import type { docIndexJobs } from "@/server/db/schema"
import { indexApprovalSchema } from "./index-contract"

export const INDEX_LEASE_MS = 60_000
export const INDEX_MAX_PRECALL_ATTEMPTS = 3
export type IndexJob = typeof docIndexJobs.$inferSelect

export function hasLiveIndexLease(job: Pick<IndexJob, "status" | "leaseOwner" | "leaseExpiresAt">, workerId: string, now: Date): boolean {
    return job.status === "running" && job.leaseOwner === workerId && job.leaseExpiresAt != null && job.leaseExpiresAt > now
}

export function expiredIndexJobState(job: Pick<IndexJob, "status" | "attemptCount" | "consumedInputTokens" | "consumedCostMicrousd">) {
    if (job.status === "cancel_requested") return { status: "cancelled", errorCode: "cancelled" } as const
    if (job.consumedInputTokens > 0 || job.consumedCostMicrousd > 0) return { status: "failed", errorCode: "model_outcome_unknown" } as const
    if (job.attemptCount >= INDEX_MAX_PRECALL_ATTEMPTS) return { status: "failed", errorCode: "lease_exhausted" } as const
    return { status: "queued", errorCode: null } as const
}

export const indexReservationSchema = z.object({
    inputTokens: z.number().int().positive(), costMicrousd: z.number().int().nonnegative(),
}).strict()

/** consumed字段表示保守占用的预算上界，实际账单另由provider用量报告核对。 */
export function checkIndexReservation(approval: z.infer<typeof indexApprovalSchema>,
    spent: { inputTokens: number; costMicrousd: number }, requested: unknown) {
    const reservation = indexReservationSchema.parse(requested)
    for (const value of Object.values(spent)) if (!Number.isSafeInteger(value) || value < 0) throw new Error("索引预算累计值无效")
    if (reservation.inputTokens > approval.maxInputTokens - spent.inputTokens
        || reservation.costMicrousd > approval.maxCostMicrousd - spent.costMicrousd) throw new Error("索引generation预算不足")
    return reservation
}
