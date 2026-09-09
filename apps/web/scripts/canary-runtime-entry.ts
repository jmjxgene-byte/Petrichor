import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import postgres from "postgres"
import { z } from "zod"
import { canonicalCanaryRequests, frozenEmbeddingRequests, runPersistedProviderBatch } from "./canary-provider-adapter"
import { withCanaryCredential } from "./canary-credential-bridge"
import { assertPrivateSpoolDirectory, publishSpoolFile, readPrivateSpoolFile } from "./canary-artifact-spool"
import { inspectCanaryCall, openCanaryCallJournal } from "./canary-call-journal"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const runtimeApprovalSchema = z.object({ version: z.literal(1), executionId: z.string().uuid(),
    planHash: digest, codeSha: digest, providerProfileHash: digest, requestSetHash: digest,
    userId: z.union([z.number().int().positive(), z.literal("Gene")]), phase: z.literal("embed"), maxCalls: z.literal(22), expiresAt: z.string().datetime(),
}).strict()
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex")
export function runtimePreflight() {
    const frozen = frozenEmbeddingRequests()
    return { mode: "preflight", modelCalls: 0, databaseCalls: 0, planHash: frozen.planHash,
        requestSetHash: hash(JSON.stringify(frozen.requests)), calls: 22, documentCalls: 14, queryCalls: 8,
        phase: "embed", needsNewApproval: true, actions: ["execute-one", "status", "manifest", "block", "ack"] }
}
export function assertRuntimeApproval(raw: unknown, owner: string, codeSha: string, now = Date.now(), executing = true) {
    const approval = runtimeApprovalSchema.parse(raw), expected = runtimePreflight()
    if (approval.executionId !== owner || approval.codeSha !== codeSha || approval.planHash !== expected.planHash || approval.requestSetHash !== expected.requestSetHash) throw new Error("runtime_approval_mismatch")
    if (executing && Date.parse(approval.expiresAt) <= now) throw new Error("runtime_approval_expired")
    return approval
}

async function main() {
    const [action, owner, raw] = process.argv.slice(2)
    if (action === "--preflight") { console.log(JSON.stringify(runtimePreflight())); return }
    if (process.platform !== "linux" || process.getuid?.() !== 1000 || !z.string().uuid().safeParse(owner).success) throw new Error("controlled_runtime_required")
    if (!["execute-one", "status", "manifest", "block", "ack"].includes(action)) throw new Error("runtime_action_invalid")
    const root = `/tmp/petrichor-runtime-${owner}`
    assertPrivateSpoolDirectory(root)
    if (fs.lstatSync(root).uid !== 1000 || readPrivateSpoolFile(path.join(root, "owner"), 100).toString() !== owner) throw new Error("runtime_owner_mismatch")
    const file = fileURLToPath(import.meta.url), codeSha = hash(readPrivateSpoolFile(file, 4 * 1024 * 1024))
    const approval = assertRuntimeApproval(JSON.parse(readPrivateSpoolFile(path.join(root, "approval-embed.json"), 8192).toString()), owner, codeSha, Date.now(), action === "execute-one")
    const frozen = frozenEmbeddingRequests(), journal = path.join(root, "journal-embed")
    const contract = { version: 1, executionId: owner, planHash: approval.planHash, providerProfileHash: approval.providerProfileHash,
        calls: canonicalCanaryRequests(frozen.requests).map(r => ({ kind: r.kind, requestHash: hash(JSON.stringify(r.body)) })) }
    const ordinal = (value: string) => { const n = Number(value); if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isInteger(n) || n < 0 || n >= 22) throw new Error("runtime_call_index"); return n }
    const responseRoot = (n: number) => path.join(journal, `call-${String(n).padStart(2, "0")}`, "response")
    const requirePersisted = (n: number) => { if (inspectCanaryCall(journal, contract, n) !== "persisted") throw new Error("runtime_result_incomplete") }
    const receipt = (n: number) => { requirePersisted(n); return JSON.parse(readPrivateSpoolFile(path.join(responseRoot(n), "receipt.json"), 4096).toString()) }
    if (action === "status") {
        console.log(JSON.stringify({ executionId: owner, codeSha, planHash: approval.planHash, requestSetHash: approval.requestSetHash,
            providerProfileHash: approval.providerProfileHash,
            states: frozen.requests.map((_, n) => fs.existsSync(journal) ? inspectCanaryCall(journal, contract, n) : "not_started"), modelCalls: 0, databaseCalls: 0 })); return
    }
    if (action === "manifest") { const n = ordinal(raw); requirePersisted(n); console.log(readPrivateSpoolFile(path.join(responseRoot(n), "manifest.json"), 16384).toString()); return }
    if (action === "block") {
        const [n, b] = raw.split(":"), index = Number(b), dir = responseRoot(ordinal(n))
        requirePersisted(ordinal(n))
        if (!/^(0|[1-9][0-9]*)$/.test(b) || raw.split(":").length !== 2) throw new Error("runtime_block_index")
        const manifest = JSON.parse(readPrivateSpoolFile(path.join(dir, "manifest.json"), 16384).toString())
        if (!Number.isInteger(index) || index < 0 || index >= manifest.blocks.length) throw new Error("runtime_block_index")
        const bytes = readPrivateSpoolFile(path.join(dir, `block-${String(index).padStart(3, "0")}`), 32768)
        if (hash(bytes) !== manifest.blocks[index].sha256) throw new Error("runtime_block_hash")
        console.log(JSON.stringify({ index, data: bytes.toString("base64") })); return
    }
    if (action === "ack") {
        if (raw.length > 8192) throw new Error("runtime_ack_limit")
        const ack = JSON.parse(Buffer.from(raw, "base64").toString()), n = ordinal(String(ack.ordinal))
        const expected = receipt(n)
        if (JSON.stringify(ack.receipt) !== JSON.stringify(expected)) throw new Error("runtime_ack_mismatch")
        publishSpoolFile(path.join(root, `ack-${n}.json`), Buffer.from(JSON.stringify(expected)))
        console.log(JSON.stringify({ acknowledged: n, modelCalls: 0, databaseCalls: 0 })); return
    }
    const n = ordinal(raw)
    openCanaryCallJournal(journal, contract)
    if (inspectCanaryCall(journal, contract, n) === "persisted") { console.log(JSON.stringify({ reused: true, ordinal: n, receipt: receipt(n), modelCalls: 0, databaseCalls: 0 })); return }
    if (inspectCanaryCall(journal, contract, n) !== "not_started") throw new Error("runtime_unknown_no_retry")
    for (let i = 0; i < n; i++) {
        if (inspectCanaryCall(journal, contract, i) !== "persisted" || JSON.stringify(receipt(i)) !== readPrivateSpoolFile(path.join(root, `ack-${i}.json`), 4096).toString()) throw new Error("runtime_previous_ack_required")
    }
    // 只有有效新授权的单项执行能到此；恢复/取块从不读取连接串或加载解密模块。
    const url = process.env.DATABASE_URL
    if (!url) throw new Error("runtime_database_missing")
    const client = postgres(url, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} })
    try {
        const decoderPath = "/app/apps/web/src/server/ai/config-logic.ts"
        const decoder = await import(decoderPath)
        await withCanaryCredential({ client, userId: approval.userId, expectedProviderProfileHash: approval.providerProfileHash,
            decrypt: cipher => { const key: unknown = decoder.decodeApiKey(cipher); if (typeof key !== "string") throw new Error("runtime_decrypt_failed"); return key },
            use: credential => runPersistedProviderBatch({ directory: journal, executionId: owner, planHash: approval.planHash,
                providerProfileHash: credential.providerProfileHash, apiKey: credential.apiKey, requests: frozen.requests, throughOrdinal: n, transport: fetch }),
        })
        console.log(JSON.stringify({ ordinal: n, receipt: receipt(n), waitingForHostAck: true }))
    } finally { await client.end({ timeout: 2 }) }
}
if (import.meta.main) main().catch(() => { console.error(JSON.stringify({ failed: true, category: "runtime_action_failed", retryAllowed: false })); process.exitCode = 1 })
