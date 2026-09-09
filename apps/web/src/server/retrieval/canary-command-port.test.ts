import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { containerRuntimeIdentity, createCanaryCommandPort, type CanaryCommand } from "../../../scripts/canary-command-port"
import { advanceCanaryHost, initializeCanaryHost } from "../../../scripts/canary-host-controller"
import { describeArtifact, openArtifactSpool, acceptArtifactBlock, finalizeArtifactSpool } from "../../../scripts/canary-artifact-spool"
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true }) })
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "petrichor-command-port-")); roots.push(root)
    const container = { id: "a".repeat(64), image: `sha256:${"b".repeat(64)}`, startedAt: "2026-09-09T00:00:00Z", running: true }
    const c = { containerId: container.id, executionId: randomUUID(), runtimeIdentity: containerRuntimeIdentity(container.id, container.image, container.startedAt),
        codeSha: "c".repeat(64), planHash: "d".repeat(64), requestSetHash: "e".repeat(64), providerProfileHash: "f".repeat(64) }
    const states = Array<"not_started" | "persisted">(22).fill("not_started"), bytes = Buffer.from("synthetic-result".repeat(9000))
    let executions = 0, loseAck = false
    const manifests = new Map<number, ReturnType<typeof describeArtifact>>()
    const receipts = new Map<number, ReturnType<typeof finalizeArtifactSpool>>()
    const runner = vi.fn(async ({ args }: CanaryCommand) => {
        if (args[0] === "inspect") return JSON.stringify(container)
        const action = args[6], raw = args[8], n = Number(raw)
        if (action === "status") return JSON.stringify({ executionId: c.executionId, codeSha: c.codeSha, planHash: c.planHash,
            requestSetHash: c.requestSetHash, providerProfileHash: c.providerProfileHash, states, modelCalls: 0, databaseCalls: 0 })
        if (action === "execute-one") {
            executions++
            const manifest = describeArtifact(bytes, `${c.executionId}-${n}`, c.planHash), dir = path.join(root, `runtime-${n}`)
            openArtifactSpool(dir, manifest)
            for (const b of manifest.blocks) acceptArtifactBlock(dir, manifest, b.index, bytes.subarray(b.index * 32768, (b.index + 1) * 32768))
            manifests.set(n, manifest); receipts.set(n, finalizeArtifactSpool(dir, manifest)); states[n] = "persisted"
            return JSON.stringify({ ordinal: n, receipt: receipts.get(n), waitingForHostAck: true })
        }
        if (action === "manifest") return JSON.stringify(manifests.get(n))
        if (action === "block") { const b = Number(raw.split(":")[1]); return JSON.stringify({ index: b, data: bytes.subarray(b * 32768, (b + 1) * 32768).toString("base64") }) }
        if (action === "ack") {
            if (loseAck) { loseAck = false; throw new Error("synthetic-sensitive-stderr") }
            return JSON.stringify({ acknowledged: JSON.parse(Buffer.from(raw, "base64").toString()).ordinal, modelCalls: 0, databaseCalls: 0 })
        }
        throw new Error("unexpected_action")
    })
    return { root, c, container, runner, port: createCanaryCommandPort(c, runner), executions: () => executions, loseAck: () => { loseAck = true } }
}
describe("受控命令port（无Docker/网络的完整宿主交接）", () => {
    it("宿主→命令协议→合成产物→ACK，ACK中断恢复不重新执行", async () => {
        const f = fixture(), directory = path.join(f.root, "host")
        const { containerId: _containerId, ...identity } = f.c
        const binding = { ...identity, version: 1, calls: 22, expiresAt: "2030-01-01T00:00:00Z" }
        initializeCanaryHost(directory, binding); f.loseAck()
        const input = { directory, binding, port: f.port, ordinal: 0, now: 0 }
        await expect(advanceCanaryHost({ ...input, mode: "execute-one" })).rejects.toThrow("ack_unconfirmed")
        expect((await advanceCanaryHost({ ...input, mode: "recover" })).acknowledged).toBe(true)
        expect(f.executions()).toBe(1)
        for (const [command] of f.runner.mock.calls) {
            expect(command.maxBuffer).toBe(65536)
            if (command.args[0] === "exec") expect(command.args.slice(0, 6)).toEqual(["exec", "--user", "1000", f.c.containerId, "bun", `/tmp/petrichor-runtime-${f.c.executionId}/entry.js`])
        }
    })
    it("容器重启或代码身份不符时拒绝执行", async () => {
        const f = fixture(); f.container.startedAt = "2026-09-09T01:00:00Z"
        await expect(f.port.executeOne(0)).rejects.toThrow("runtime_changed")
        expect(f.executions()).toBe(0)
        const g = fixture(), invoke = g.runner.getMockImplementation()!
        g.runner.mockImplementation(async cmd => { const out = await invoke(cmd); return cmd.args[6] === "status" ? JSON.stringify({ ...JSON.parse(out), codeSha: "0".repeat(64) }) : out })
        await expect(g.port.executeOne(0)).rejects.toThrow("status_mismatch")
        expect(g.executions()).toBe(0)
    })
    it("超限、混杂JSON与命令异常均安全拒绝", async () => {
        const f = fixture()
        f.runner.mockResolvedValueOnce("x".repeat(65537))
        await expect(f.port.inspect()).rejects.toThrow("output_limit")
        f.runner.mockResolvedValueOnce('{}\n{"extra":true}')
        await expect(f.port.inspect()).rejects.toThrow("output_invalid")
        f.runner.mockRejectedValueOnce(new Error("sensitive-stderr"))
        await expect(f.port.inspect()).rejects.toThrow(/^canary_command_failed$/)
    })
    it("参数注入和无效索引在发出命令前拒绝", async () => {
        const f = fixture()
        expect(() => createCanaryCommandPort({ ...f.c, containerId: "x;echo unsafe" }, f.runner)).toThrow()
        await expect(f.port.executeOne(22)).rejects.toThrow("ordinal")
        await expect(f.port.block(0, 8)).rejects.toThrow("block")
        expect(f.runner).not.toHaveBeenCalled()
    })
})
