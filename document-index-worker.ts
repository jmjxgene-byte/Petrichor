import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { claimDocumentIndexJob } from "./apps/web/src/server/doc-library/index-jobs"
import { documentIndexWorkerEnabled, executeDocumentIndexJob } from "./apps/web/src/server/doc-library/index-runtime"
import { parseIndexProviderPolicies } from "./apps/web/src/server/doc-library/index-provider"

if (!documentIndexWorkerEnabled()) {
    console.log("Petrichor document index Worker disabled")
    process.exit(0)
}
let policyExpiresAt = 0
try {
    const policies = parseIndexProviderPolicies(JSON.parse(process.env.PETRICHOR_DOC_INDEX_PROVIDER_POLICY ?? "null"))
    policyExpiresAt = Math.min(...policies.map((policy) => Date.parse(policy.expiresAt)))
    if (policyExpiresAt <= Date.now()) throw new Error("expired")
} catch {
    console.error("Document index Worker stopped: provider_policy_missing_or_expired")
    process.exit(1)
}
const workerId = `${hostname()}:${process.pid}:${randomUUID()}`
const controller = new AbortController()
process.on("SIGTERM", () => controller.abort())
process.on("SIGINT", () => controller.abort())
try {
    while (!controller.signal.aborted) {
        if (Date.now() >= policyExpiresAt) throw new Error("provider_policy_expired")
        const job = await claimDocumentIndexJob(workerId)
        if (!job) { await Bun.sleep(2_000); continue }
        const outcome = await executeDocumentIndexJob(job.id, workerId, controller.signal)
        console.log(JSON.stringify({ event: "document_index_turn", outcome }))
    }
} catch {
    console.error("Document index Worker stopped: metadata_or_runtime_error")
    process.exitCode = 1
}
