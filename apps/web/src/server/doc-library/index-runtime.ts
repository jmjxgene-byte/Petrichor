import { and, eq } from "drizzle-orm"
import { getDb } from "@/server/db/client"
import { docIndexJobs, docIndexGenerations } from "@/server/db/schema"
import { loadDocumentIndexSource } from "./index-source"
import { resolveDocumentIndexProvider } from "./index-provider"
import { runDocumentIndexJob } from "./index-executor"
import { completeDocumentIndexJob } from "./index-complete"
import { heartbeatDocumentIndexJob, reserveDocumentIndexBudget, failDocumentIndexJob, acknowledgeIndexCancellation } from "./index-jobs"

export function documentIndexWorkerEnabled() {
    return process.env.PETRICHOR_DOC_INDEX_ENABLED === "true" && process.env.PETRICHOR_DOC_INDEX_WORKER_ENABLED === "true"
}

export async function executeDocumentIndexJob(jobId: number, workerId: string, signal?: AbortSignal) {
    if (!documentIndexWorkerEnabled()) return "disabled" as const
    const [job] = await getDb().select().from(docIndexJobs).where(and(eq(docIndexJobs.id, jobId), eq(docIndexJobs.leaseOwner, workerId))).limit(1)
    if (!job) return "lease_lost" as const
    return await runDocumentIndexJob(job, {
        heartbeat: async () => Boolean(await heartbeatDocumentIndexJob(job.id, workerId)),
        provider: async () => resolveDocumentIndexProvider(job.userId, JSON.parse(process.env.PETRICHOR_DOC_INDEX_PROVIDER_POLICY ?? "null")),
        load: async (abortSignal) => {
            const [generation] = await getDb().select().from(docIndexGenerations).where(and(eq(docIndexGenerations.id, job.generationId), eq(docIndexGenerations.userId, job.userId))).limit(1)
            if (!generation) throw new Error("generation缺失")
            return { ...await loadDocumentIndexSource(job.userId, job.libraryId, job.documentId, abortSignal), manifestJson: generation.manifestJson, manifestHash: generation.manifestHash }
        },
        reserve: (reservation) => reserveDocumentIndexBudget({ userId: job.userId, jobId, workerId, reservation }),
        complete: (result) => completeDocumentIndexJob({ ...result, userId: job.userId, jobId, workerId }),
        fail: (errorCode) => failDocumentIndexJob({ userId: job.userId, jobId, workerId, errorCode }),
        cancelled: () => acknowledgeIndexCancellation(jobId, workerId),
    }, signal)
}
