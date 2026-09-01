import { randomUUID } from "node:crypto"
import { hostname } from "node:os"

import { getServerConfig } from "./apps/web/src/config/server"
import {
    claimDeepResearchJob,
    recoverExpiredDeepResearchJobs,
} from "./apps/web/src/server/assistant/deep-research-job-store"
import { executeDeepResearchJob } from "./apps/web/src/server/assistant/deep-research-executor"

const config = getServerConfig()
if (!config.deepResearch.enabled || !config.deepResearch.workerEnabled) {
    console.log("Petrichor Deep Research Worker disabled")
    process.exit(0)
}

const workerId = `${hostname()}:${process.pid}:${randomUUID()}`
let stopping = false
let nextRecoveryAt = 0
process.on("SIGTERM", () => { stopping = true })
process.on("SIGINT", () => { stopping = true })

console.log("Petrichor Deep Research Worker started")
while (!stopping) {
    if (Date.now() >= nextRecoveryAt) {
        await recoverExpiredDeepResearchJobs()
        nextRecoveryAt = Date.now() + 30_000
    }
    const job = await claimDeepResearchJob({ workerId })
    if (!job) {
        await Bun.sleep(2_000)
        continue
    }
    await executeDeepResearchJob(job.id, workerId)
}
console.log("Petrichor Deep Research Worker stopped")
