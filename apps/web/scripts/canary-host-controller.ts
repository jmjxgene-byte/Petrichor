import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { acceptArtifactBlock, assertPrivateSpoolDirectory, finalizeArtifactSpool, missingArtifactBlocks, openArtifactSpool, publishSpoolFile, readPrivateSpoolFile } from "./canary-artifact-spool"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const bindingSchema = z.object({ version: z.literal(1), executionId: z.string().uuid(), planHash: digest,
    runtimeIdentity: digest, codeSha: digest, requestSetHash: digest, providerProfileHash: digest,
    calls: z.number().int().min(1).max(22), expiresAt: z.string().datetime() }).strict()
type Binding = z.infer<typeof bindingSchema>
const stateSchema = z.enum(["not_started", "outcome_unknown", "persisted"])
/** port由受控宿主显式注入；此模块不连接SSH、数据库或provider，也不持有Key。 */
export interface CanaryRuntimePort {
    inspect(): Promise<{ runtimeIdentity: string; states: Array<z.infer<typeof stateSchema>> }>
    executeOne(ordinal: number): Promise<void>
    manifest(ordinal: number): Promise<unknown>
    block(ordinal: number, index: number): Promise<Uint8Array>
    acknowledge(ordinal: number, receipt: ReturnType<typeof finalizeArtifactSpool>): Promise<void>
}

export function initializeCanaryHost(directory: string, raw: unknown) {
    const binding = bindingSchema.parse(raw)
    // 初始化不可重入；恢复必须使用原目录，不重新创建已消费身份。
    fs.mkdirSync(directory, { mode: 0o700 })
    publishSpoolFile(path.join(directory, "binding.json"), Buffer.from(JSON.stringify(binding)))
}
function bound(directory: string, raw: unknown): Binding {
    assertPrivateSpoolDirectory(directory)
    const expected = bindingSchema.parse(raw)
    const stored = bindingSchema.parse(JSON.parse(readPrivateSpoolFile(path.join(directory, "binding.json"), 8192).toString()))
    if (JSON.stringify(stored) !== JSON.stringify(expected)) throw new Error("host_binding_mismatch")
    return stored
}

/** 每次最多派发一个新项；recover永远不调用executeOne。错误保持原预约，不自动重试。 */
export async function advanceCanaryHost(input: {
    directory: string; binding: unknown; port: CanaryRuntimePort; ordinal: number
    mode: "execute-one" | "recover"; now?: number
}) {
    const b = bound(input.directory, input.binding), n = input.ordinal
    if (!Number.isInteger(n) || n < 0 || n >= b.calls || !["execute-one", "recover"].includes(input.mode)) throw new Error("host_action_invalid")
    const inspect = async () => {
        const snapshot = z.object({ runtimeIdentity: digest, states: z.array(stateSchema).length(b.calls) }).strict().parse(await input.port.inspect())
        if (snapshot.runtimeIdentity !== b.runtimeIdentity) throw new Error("runtime_identity_changed")
        return snapshot.states
    }
    let states = await inspect()
    const receiver = (i: number) => path.join(input.directory, `received-${i}`)
    for (let i = 0; i < n; i++) {
        const manifest = JSON.parse(readPrivateSpoolFile(path.join(receiver(i), "manifest.json"), 16384).toString())
        const receipt = finalizeArtifactSpool(receiver(i), manifest)
        if (manifest.executionId !== `${b.executionId}-${i}` || manifest.planHash !== b.planHash || states[i] !== "persisted"
            || readPrivateSpoolFile(path.join(input.directory, `ack-${i}.json`), 4096).toString() !== JSON.stringify(receipt)) throw new Error("host_previous_ack_required")
    }
    const dispatch = path.join(input.directory, `dispatch-${n}`)
    if (states[n] === "not_started") {
        if (input.mode === "recover" || fs.existsSync(dispatch)) throw new Error("host_dispatch_uncertain_no_retry")
        if (Date.parse(b.expiresAt) <= (input.now ?? Date.now())) throw new Error("host_approval_expired")
        // mkdir跨进程排他；dispatch由fsync发布完成后才允许任何外部执行。
        fs.mkdirSync(dispatch, { mode: 0o700 })
        publishSpoolFile(path.join(dispatch, "intent.json"), Buffer.from(JSON.stringify({ ordinal: n, executionId: b.executionId })))
        try { await input.port.executeOne(n) } catch { throw new Error("host_dispatch_uncertain_no_retry") }
        states = await inspect()
    }
    if (states[n] !== "persisted") throw new Error("host_outcome_unknown_no_retry")
    const raw = await input.port.manifest(n)
    z.object({ executionId: z.literal(`${b.executionId}-${n}`), planHash: z.literal(b.planHash), bytes: z.number().int().positive().max(262144) }).parse(raw)
    const manifest = openArtifactSpool(receiver(n), raw)
    if (manifest.bytes > 262144) throw new Error("host_artifact_limit")
    for (const index of missingArtifactBlocks(receiver(n), manifest)) {
        acceptArtifactBlock(receiver(n), manifest, index, await input.port.block(n, index))
    }
    const receipt = finalizeArtifactSpool(receiver(n), manifest)
    if ((await inspect())[n] !== "persisted") throw new Error("host_outcome_unknown_no_retry")
    // 宿主持久化完成后才能ACK；ACK返回丢失时recover仅重复幂等ACK。
    try { await input.port.acknowledge(n, receipt) } catch { throw new Error("host_ack_unconfirmed") }
    publishSpoolFile(path.join(input.directory, `ack-${n}.json`), Buffer.from(JSON.stringify(receipt)))
    return { ordinal: n, acknowledged: true, sha256: receipt.sha256, bytes: receipt.bytes }
}
