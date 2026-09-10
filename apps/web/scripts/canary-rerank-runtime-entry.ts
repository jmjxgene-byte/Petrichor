import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import postgres from "postgres"
import { z } from "zod"
import { canonicalCanaryRequests, runPersistedProviderBatch } from "./canary-provider-adapter"
import { withCanaryCredential } from "./canary-credential-bridge"
import { assertPrivateSpoolDirectory, publishSpoolFile, readPrivateSpoolFile } from "./canary-artifact-spool"
import { inspectCanaryCall, openCanaryCallJournal } from "./canary-call-journal"
import { planGroundedCanary } from "../src/server/retrieval/grounded-canary-plan"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const rerankBody = z.object({ model: z.literal("BAAI/bge-reranker-v2-m3"), query: z.string().min(1).max(2000),
    documents: z.array(z.string().min(1).max(4000)).min(1).max(20), top_n: z.number().int().positive(), return_documents: z.literal(false) }).strict()
const requestPackSchema = z.object({ version: z.literal(1), executionId: z.string().uuid(), planHash: digest, requestSetHash: digest,
    requests: z.array(z.object({ kind: z.literal("rerank"), body: rerankBody }).strict()).length(8) }).strict()
const approvalSchema = z.object({ version: z.literal(1), executionId: z.string().uuid(), planHash: digest, codeSha: digest,
    providerProfileHash: digest, requestSetHash: digest, userId: z.union([z.number().int().positive(), z.literal("Gene")]),
    phase: z.literal("rerank"), maxCalls: z.literal(8), expiresAt: z.string().datetime() }).strict()
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")

export function rerankRuntimePreflight() {
    return { mode: "preflight", phase: "rerank", planHash: planGroundedCanary().planHash, calls: 8, modelCalls: 0, databaseCalls: 0,
        needsNewApproval: true, actions: ["execute-one", "status", "manifest", "block", "ack"] }
}

export function assertRerankRuntimeApproval(raw: unknown, owner: string, codeSha: string, requestSetHash: string, now = Date.now(), executing = true) {
    const approval = approvalSchema.parse(raw)
    if (approval.executionId !== owner || approval.codeSha !== codeSha || approval.planHash !== planGroundedCanary().planHash || approval.requestSetHash !== requestSetHash) throw new Error("rerank_runtime_approval_mismatch")
    if (executing && Date.parse(approval.expiresAt) <= now) throw new Error("rerank_runtime_approval_expired")
    return approval
}

async function main() {
    const [action, owner, raw] = process.argv.slice(2)
    if (action === "--preflight") { console.log(JSON.stringify(rerankRuntimePreflight())); return }
    if (process.platform !== "linux" || process.getuid?.() !== 1000 || !z.string().uuid().safeParse(owner).success) throw new Error("controlled_runtime_required")
    if (!["execute-one", "status", "manifest", "block", "ack"].includes(action)) throw new Error("rerank_runtime_action_invalid")
    const root = `/tmp/petrichor-rerank-runtime-${owner}`
    assertPrivateSpoolDirectory(root)
    if (fs.lstatSync(root).uid !== 1000 || readPrivateSpoolFile(path.join(root, "owner"), 100).toString() !== owner) throw new Error("rerank_runtime_owner_mismatch")
    const entry = fileURLToPath(import.meta.url), codeSha = hash(readPrivateSpoolFile(entry, 4 * 1024 * 1024))
    const pack = requestPackSchema.parse(JSON.parse(readPrivateSpoolFile(path.join(root, "requests-rerank.json"), 512 * 1024).toString()))
    if (pack.executionId !== owner) throw new Error("rerank_request_owner_mismatch")
    const canonical = canonicalCanaryRequests(pack.requests)
    const bodies = canonical.map(request => JSON.stringify(request.body))
    const requestSetHash = hash(JSON.stringify(bodies))
    const approval = assertRerankRuntimeApproval(JSON.parse(readPrivateSpoolFile(path.join(root, "approval-rerank.json"), 8192).toString()), owner, codeSha, requestSetHash, Date.now(), action === "execute-one")
    const contract = { version: 1 as const, executionId: owner, planHash: approval.planHash, providerProfileHash: approval.providerProfileHash,
        calls: canonical.map(request => ({ kind: request.kind, requestHash: hash(JSON.stringify(request.body)) })) }
    const ordinal = (value: string) => { const n = Number(value); if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isInteger(n) || n < 0 || n >= 8) throw new Error("rerank_runtime_call_index"); return n }
    const journal = path.join(root, "journal-rerank"), responseRoot = (n: number) => path.join(journal, `call-${String(n).padStart(2, "0")}`, "response")
    const requirePersisted = (n: number) => { if (inspectCanaryCall(journal, contract, n) !== "persisted") throw new Error("rerank_runtime_result_incomplete") }
    const receipt = (n: number) => { requirePersisted(n); return JSON.parse(readPrivateSpoolFile(path.join(responseRoot(n), "receipt.json"), 4096).toString()) }
    if (action === "status") {
        console.log(JSON.stringify({ executionId: owner, codeSha, planHash: approval.planHash, requestSetHash, providerProfileHash: approval.providerProfileHash,
            states: fs.existsSync(journal) ? canonical.map((_, n) => inspectCanaryCall(journal, contract, n)) : canonical.map(() => "not_started"), modelCalls: 0, databaseCalls: 0 })); return
    }
    if (action === "manifest") { const n = ordinal(raw); requirePersisted(n); console.log(readPrivateSpoolFile(path.join(responseRoot(n), "manifest.json"), 16384).toString()); return }
    if (action === "block") {
        if (raw.split(":").length !== 2) throw new Error("rerank_runtime_block_index")
        const [nRaw, bRaw] = raw.split(":"), n = ordinal(nRaw), index = Number(bRaw); requirePersisted(n)
        if (!/^(0|[1-9][0-9]*)$/.test(bRaw) || !Number.isInteger(index) || index < 0 || index >= 8) throw new Error("rerank_runtime_block_index")
        const dir = responseRoot(n), manifest = JSON.parse(readPrivateSpoolFile(path.join(dir, "manifest.json"), 16384).toString())
        if (index >= manifest.blocks.length) throw new Error("rerank_runtime_block_index")
        const bytes = readPrivateSpoolFile(path.join(dir, `block-${String(index).padStart(3, "0")}`), 32768)
        if (hash(bytes) !== manifest.blocks[index].sha256) throw new Error("rerank_runtime_block_hash")
        console.log(JSON.stringify({ index, data: bytes.toString("base64") })); return
    }
    if (action === "ack") {
        if (raw.length > 8192) throw new Error("rerank_runtime_ack_limit")
        const parsed = JSON.parse(Buffer.from(raw, "base64").toString()), n = ordinal(String(parsed.ordinal)), expected = receipt(n)
        if (JSON.stringify(parsed.receipt) !== JSON.stringify(expected)) throw new Error("rerank_runtime_ack_mismatch")
        publishSpoolFile(path.join(root, `ack-${n}.json`), Buffer.from(JSON.stringify(expected)))
        console.log(JSON.stringify({ acknowledged: n, modelCalls: 0, databaseCalls: 0 })); return
    }
    const n = ordinal(raw)
    openCanaryCallJournal(journal, contract)
    if (inspectCanaryCall(journal, contract, n) === "persisted") { console.log(JSON.stringify({ reused: true, ordinal: n, receipt: receipt(n), modelCalls: 0, databaseCalls: 0 })); return }
    if (inspectCanaryCall(journal, contract, n) !== "not_started") throw new Error("rerank_runtime_unknown_no_retry")
    for (let i = 0; i < n; i++) if (inspectCanaryCall(journal, contract, i) !== "persisted" || JSON.stringify(receipt(i)) !== readPrivateSpoolFile(path.join(root, `ack-${i}.json`), 4096).toString()) throw new Error("rerank_runtime_previous_ack_required")
    const url = process.env.DATABASE_URL
    if (!url) throw new Error("rerank_runtime_database_missing")
    const client = postgres(url, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} })
    try {
        const decoderPath = "/app/apps/web/src/server/ai/config-logic.ts"
        const decoder = await import(decoderPath)
        await withCanaryCredential({ client, userId: approval.userId, expectedProviderProfileHash: approval.providerProfileHash,
            decrypt: cipher => { const key: unknown = decoder.decodeApiKey(cipher); if (typeof key !== "string") throw new Error("rerank_runtime_decrypt_failed"); return key },
            use: credential => runPersistedProviderBatch({ directory: journal, executionId: owner, planHash: approval.planHash,
                providerProfileHash: credential.providerProfileHash, apiKey: credential.apiKey, requests: canonical, throughOrdinal: n, transport: fetch }),
        })
        console.log(JSON.stringify({ ordinal: n, receipt: receipt(n), waitingForHostAck: true }))
    } finally { await client.end({ timeout: 2 }) }
}
if (import.meta.main) main().catch(() => { console.error(JSON.stringify({ failed: true, category: "rerank_runtime_action_failed", retryAllowed: false })); process.exitCode = 1 })
