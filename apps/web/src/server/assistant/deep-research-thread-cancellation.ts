import { and, eq, inArray, sql } from "drizzle-orm"
import type { getDb } from "@/server/db/client"
import { agentRuns, deepResearchJobs } from "@/server/db/schema"

/** 由会话变更事务调用，只作用于已确认归属的thread/question集合。 */
export async function cancelDeepResearchForScope(tx: Pick<ReturnType<typeof getDb>, "update">, userId: number, threadIds: number[], questionIds?: number[]) {
    if (!threadIds.length || questionIds?.length === 0) return
    const filters = [eq(deepResearchJobs.userId, userId), inArray(deepResearchJobs.threadId, threadIds),
        ...(questionIds ? [inArray(deepResearchJobs.questionMessageId, questionIds)] : [])]
    const now = new Date()
    await tx.update(deepResearchJobs).set({ status: "cancelled", cancelledAt: now, completedAt: now, updatedAt: now,
        leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, errorCode: "cancelled" })
        .where(and(...filters, inArray(deepResearchJobs.status, ["queued", "retry_wait"])))
    await tx.update(deepResearchJobs).set({ status: "cancel_requested", cancelledAt: now, updatedAt: now })
        .where(and(...filters, eq(deepResearchJobs.status, "running")))
    // 旧FK会随问题删除级联删除Job，先保留Run的停止状态，不清除已有费用元数据。
    await tx.update(agentRuns).set({ status: "cancelled", stopReason: "cancelled", completedAt: now })
        .where(and(eq(agentRuns.userId, userId), eq(agentRuns.status, "running"),
            sql`exists (select 1 from ${deepResearchJobs} where ${deepResearchJobs.runKey} = ${agentRuns.runKey}
                and ${and(...filters, inArray(deepResearchJobs.status, ["cancel_requested", "cancelled"]))})`))
}
