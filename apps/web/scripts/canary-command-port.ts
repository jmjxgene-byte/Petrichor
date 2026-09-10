import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { z } from "zod"
import type { CanaryRuntimePort } from "./canary-host-controller"
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const configSchema = z.object({ containerId: digest, executionId: z.string().uuid(), runtimeIdentity: digest,
    codeSha: digest, planHash: digest, requestSetHash: digest, providerProfileHash: digest,
    calls: z.number().int().min(1).max(22), runtimeDirectory: z.string().regex(/^[a-z0-9-]{1,40}$/).default("petrichor-runtime") }).strict()
export type CanaryCommand = { args: string[]; timeout: number; maxBuffer: number }
export type CanaryCommandRunner = (command: CanaryCommand) => Promise<string>

/** 仅在宿主显式调用；不使用shell、不传env/Key，不返回原始stderr。 */
export const runCanaryDockerCommand: CanaryCommandRunner = command => new Promise((resolve, reject) => {
    execFile("docker", command.args, { encoding: "utf8", timeout: command.timeout, maxBuffer: command.maxBuffer,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C" } }, (error, stdout, stderr) => {
        if (error) {
            const category = /"category":"([A-Za-z0-9_]+)"/.exec(stderr)?.[1] ?? (/timeout|timed out/i.test(stderr) ? "timeout" : "command")
            reject(new Error(`canary_command_failed_${category}`))
        } else resolve(stdout)
    })
})
export function containerRuntimeIdentity(id: string, image: string, startedAt: string) {
    return createHash("sha256").update(JSON.stringify({ id, image, startedAt })).digest("hex")
}

export function createCanaryCommandPort(raw: unknown, runner: CanaryCommandRunner): CanaryRuntimePort {
    const c = configSchema.parse(raw)
    const index = (n: number) => { if (!Number.isInteger(n) || n < 0 || n >= c.calls) throw new Error("command_ordinal_invalid"); return String(n) }
    const call = async (args: string[], timeout = 10000) => {
        let output: string
        try { output = await runner({ args, timeout, maxBuffer: 65536 }) } catch (error) {
            if (error instanceof Error && /^canary_command_failed_[A-Za-z0-9_]+$/.test(error.message)) throw error
            throw new Error("canary_command_failed")
        }
        if (Buffer.byteLength(output) > 65536) throw new Error("command_output_limit")
        try { return JSON.parse(output) as unknown } catch { throw new Error("command_output_invalid") }
    }
    const checkContainer = async () => {
        const shape = z.object({ id: digest, image: z.string().regex(/^sha256:[a-f0-9]{64}$/), startedAt: z.string().min(1).max(100), running: z.literal(true) }).strict()
        const inspected = shape.safeParse(await call(["inspect", "--format", '{"id":{{json .Id}},"image":{{json .Image}},"startedAt":{{json .State.StartedAt}},"running":{{json .State.Running}}}', c.containerId]))
        if (!inspected.success || inspected.data.id !== c.containerId) throw new Error("command_container_invalid")
        const r = inspected.data
        if (containerRuntimeIdentity(r.id, r.image, r.startedAt) !== c.runtimeIdentity) throw new Error("command_runtime_changed")
    }
    const action = async (name: string, value = "") => {
        await checkContainer()
        const result = await call(["exec", "--user", "1000", c.containerId, "bun", `/tmp/${c.runtimeDirectory}-${c.executionId}/entry.js`, name, c.executionId, value], name === "execute-one" ? 45000 : 10000)
        await checkContainer()
        return result
    }
    const receiptSchema = z.object({ version: z.literal(1), executionId: z.string(), manifestHash: digest,
        bytes: z.number().int().positive().max(262144), sha256: digest, verified: z.literal(true) }).strict()
    const inspect = async () => {
        const s = z.object({ executionId: z.literal(c.executionId), codeSha: z.literal(c.codeSha), planHash: z.literal(c.planHash),
            requestSetHash: z.literal(c.requestSetHash), providerProfileHash: z.literal(c.providerProfileHash),
            states: z.array(z.enum(["not_started", "outcome_unknown", "persisted"])).length(c.calls), modelCalls: z.literal(0), databaseCalls: z.literal(0) }).strict().safeParse(await action("status"))
        if (!s.success) throw new Error("command_status_mismatch")
        return { runtimeIdentity: c.runtimeIdentity, states: s.data.states }
    }
    return {
        inspect,
        executeOne: async n => {
            index(n); await inspect()
            const result = z.object({ ordinal: z.literal(n), receipt: receiptSchema, waitingForHostAck: z.literal(true) }).strict()
                .or(z.object({ ordinal: z.literal(n), receipt: receiptSchema, reused: z.literal(true), modelCalls: z.literal(0), databaseCalls: z.literal(0) }).strict())
                .safeParse(await action("execute-one", index(n)))
            if (!result.success || result.data.receipt.executionId !== `${c.executionId}-${n}`) throw new Error("command_execute_receipt_invalid")
        },
        manifest: async n => { index(n); await inspect(); return action("manifest", index(n)) },
        block: async (n, b) => {
            index(n)
            if (!Number.isInteger(b) || b < 0 || b >= 8) throw new Error("command_block_invalid")
            const result = z.object({ index: z.literal(b), data: z.string().max(43692).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict().safeParse(await action("block", `${n}:${b}`))
            if (!result.success) throw new Error("command_block_invalid")
            const bytes = Buffer.from(result.data.data, "base64")
            if (!bytes.length || bytes.length > 32768 || bytes.toString("base64") !== result.data.data) throw new Error("command_block_invalid")
            return bytes
        },
        acknowledge: async (n, receipt) => {
            index(n); receiptSchema.parse(receipt)
            if (receipt.executionId !== `${c.executionId}-${n}`) throw new Error("command_ack_identity")
            const result = z.object({ acknowledged: z.literal(n), modelCalls: z.literal(0), databaseCalls: z.literal(0) }).strict()
                .safeParse(await action("ack", Buffer.from(JSON.stringify({ ordinal: n, receipt })).toString("base64")))
            if (!result.success) throw new Error("command_ack_invalid")
        },
    }
}
