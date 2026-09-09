import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { ARTIFACT_BLOCK_BYTES, acceptArtifactBlock, assertPrivateSpoolDirectory, describeArtifact, finalizeArtifactSpool, openArtifactSpool, publishSpoolFile, readPrivateSpoolFile } from "./canary-artifact-spool"

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const contractSchema = z.object({ version: z.literal(1), executionId: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/), planHash: digest, providerProfileHash: digest,
    calls: z.array(z.object({ kind: z.enum(["document_embedding", "query_embedding", "rerank"]), requestHash: digest }).strict()).min(1).max(30),
}).strict().superRefine((c, ctx) => {
    for (const [kind, max] of [["document_embedding", 14], ["query_embedding", 8], ["rerank", 8]] as const) {
        if (c.calls.filter(call => call.kind === kind).length > max) ctx.addIssue({ code: "custom", message: "call_limit" })
    }
})
type Contract = z.infer<typeof contractSchema>

function bound(directory: string, raw: unknown) {
    assertPrivateSpoolDirectory(directory)
    const contract = contractSchema.parse(raw)
    const stored = contractSchema.parse(JSON.parse(readPrivateSpoolFile(path.join(directory, "contract.json"), 16384).toString()))
    if (JSON.stringify(contract) !== JSON.stringify(stored)) throw new Error("call_contract_mismatch")
    return contract
}
function callDirectory(directory: string, contract: Contract, ordinal: number) {
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= contract.calls.length) throw new Error("call_index_invalid")
    return path.join(directory, `call-${String(ordinal).padStart(2, "0")}`)
}
export function openCanaryCallJournal(directory: string, raw: unknown) {
    const contract = contractSchema.parse(raw)
    try { fs.mkdirSync(directory, { mode: 0o700 }) } catch (e) { if (!e || typeof e !== "object" || !("code" in e) || e.code !== "EEXIST") throw e }
    assertPrivateSpoolDirectory(directory)
    publishSpoolFile(path.join(directory, "contract.json"), Buffer.from(JSON.stringify(contract)))
    return contract
}
function readCompleted(directory: string, contract: Contract, ordinal: number) {
    const call = callDirectory(directory, contract, ordinal)
    assertPrivateSpoolDirectory(call)
    const intent = JSON.parse(readPrivateSpoolFile(path.join(call, "intent.json"), 4096).toString())
    if (intent.ordinal !== ordinal || intent.contractHash !== sha(JSON.stringify(contract))) throw new Error("call_intent_mismatch")
    const artifact = path.join(call, "response")
    assertPrivateSpoolDirectory(artifact)
    const manifest = JSON.parse(readPrivateSpoolFile(path.join(artifact, "manifest.json"), 16384).toString())
    if (manifest.executionId !== `${contract.executionId}-${ordinal}` || manifest.planHash !== contract.planHash) throw new Error("call_artifact_identity")
    const payload = readPrivateSpoolFile(path.join(artifact, "artifact.bin"), 262144)
    const receipt = JSON.parse(readPrivateSpoolFile(path.join(artifact, "receipt.json"), 4096).toString())
    if (receipt.version !== 1 || receipt.executionId !== manifest.executionId || receipt.verified !== true || receipt.manifestHash !== sha(JSON.stringify(manifest)) || receipt.sha256 !== manifest.sha256
        || manifest.bytes !== payload.length || receipt.bytes !== payload.length || sha(payload) !== receipt.sha256) throw new Error("call_artifact_integrity")
    return payload
}
export function inspectCanaryCall(directory: string, raw: unknown, ordinal: number): "not_started" | "outcome_unknown" | "persisted" {
    const contract = bound(directory, raw), call = callDirectory(directory, contract, ordinal)
    try { fs.lstatSync(call) } catch (e) { if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return "not_started"; throw e }
    assertPrivateSpoolDirectory(call)
    try { readCompleted(directory, contract, ordinal); return "persisted" }
    catch (e) { if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return "outcome_unknown"; throw e }
}

/** callback不得携带凭证到返回值；仅在校验/脱敏响应后返回可保存的字节。 */
export async function runDurableCanaryCall(input: {
    directory: string; contract: unknown; ordinal: number; requestJson: string
    invoke: (requestJson: string) => Promise<Uint8Array>
}) {
    const contract = bound(input.directory, input.contract), call = callDirectory(input.directory, contract, input.ordinal)
    if (Buffer.byteLength(input.requestJson) > 128 * 1024 || sha(input.requestJson) !== contract.calls[input.ordinal].requestHash) throw new Error("request_hash_mismatch")
    const state = inspectCanaryCall(input.directory, contract, input.ordinal)
    if (state === "persisted") return { reused: true, payload: readCompleted(input.directory, contract, input.ordinal) }
    if (state === "outcome_unknown") throw new Error("call_outcome_unknown_no_retry")
    for (let i = 0; i < input.ordinal; i++) if (inspectCanaryCall(input.directory, contract, i) !== "persisted") throw new Error("previous_call_incomplete")
    // mkdir是跨进程的排他预约；任何进程失败后都不删除该标记来重获执行权。
    try { fs.mkdirSync(call, { mode: 0o700 }) } catch (e) { if (e && typeof e === "object" && "code" in e && e.code === "EEXIST") throw new Error("call_already_reserved"); throw e }
    publishSpoolFile(path.join(call, "intent.json"), Buffer.from(JSON.stringify({ version: 1, ordinal: input.ordinal, kind: contract.calls[input.ordinal].kind,
        contractHash: sha(JSON.stringify(contract)), requestHash: contract.calls[input.ordinal].requestHash })))
    let payload: Uint8Array
    try { payload = await input.invoke(input.requestJson) }
    catch { throw new Error("call_outcome_unknown_no_retry") }
    if (!payload.length || payload.length > 262144) throw new Error("response_size_invalid")
    const artifact = path.join(call, "response")
    const manifest = describeArtifact(payload, `${contract.executionId}-${input.ordinal}`, contract.planHash)
    openArtifactSpool(artifact, manifest)
    for (const block of manifest.blocks) acceptArtifactBlock(artifact, manifest, block.index, payload.subarray(block.index * ARTIFACT_BLOCK_BYTES, (block.index + 1) * ARTIFACT_BLOCK_BYTES))
    finalizeArtifactSpool(artifact, manifest)
    return { reused: false, payload: readCompleted(input.directory, contract, input.ordinal) }
}

export async function runDurableCanaryBatch(input: {
    directory: string; contract: unknown; requests: string[]
    invoke: (requestJson: string, ordinal: number) => Promise<Uint8Array>
    throughOrdinal?: number
    afterPersist?: (receipt: { ordinal: number; reused: boolean; bytes: number; sha256: string }) => Promise<void>
}) {
    const contract = contractSchema.parse(input.contract), requests = [...input.requests]
    const last = input.throughOrdinal ?? requests.length - 1
    if (!Number.isInteger(last) || last < 0 || last >= requests.length) throw new Error("call_index_invalid")
    // 全部请求先对账，再允许第一次调用；不把query/body副本写入日志。
    if (requests.length !== contract.calls.length || requests.some((body, i) => Buffer.byteLength(body) > 128 * 1024 || sha(body) !== contract.calls[i].requestHash)) throw new Error("batch_request_mismatch")
    openCanaryCallJournal(input.directory, contract)
    const results = []
    for (let ordinal = 0; ordinal <= last; ordinal++) {
        const result = await runDurableCanaryCall({ directory: input.directory, contract, ordinal, requestJson: requests[ordinal],
            invoke: body => input.invoke(body, ordinal) })
        const receipt = { ordinal, reused: result.reused, bytes: result.payload.length, sha256: sha(result.payload) }
        if (input.afterPersist) {
            try { await input.afterPersist(receipt) } catch { throw new Error("handoff_unconfirmed") }
        }
        results.push(receipt)
    }
    return { executionId: contract.executionId, planHash: contract.planHash, persisted: true, results }
}
