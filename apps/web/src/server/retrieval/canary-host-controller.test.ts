import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { advanceCanaryHost, initializeCanaryHost, type CanaryRuntimePort } from "../../../scripts/canary-host-controller"
import { inspectCanaryCall, openCanaryCallJournal, runDurableCanaryCall } from "../../../scripts/canary-call-journal"
const roots: string[] = []
afterEach(() => { for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true }) })
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "petrichor-host-control-")); roots.push(root)
    const directory = path.join(root, "host"), journal = path.join(root, "runtime"), executionId = randomUUID()
    const binding = { version: 1, executionId, planHash: "a".repeat(64), runtimeIdentity: "b".repeat(64), codeSha: "c".repeat(64),
        requestSetHash: "d".repeat(64), providerProfileHash: "e".repeat(64), calls: 2, expiresAt: "2030-01-01T00:00:00.000Z" }
    const requests = ["synthetic-0", "synthetic-1"]
    const contract = { version: 1, executionId, planHash: binding.planHash, providerProfileHash: binding.providerProfileHash,
        calls: requests.map(r => ({ kind: "document_embedding", requestHash: createHash("sha256").update(r).digest("hex") })) }
    openCanaryCallJournal(journal, contract); initializeCanaryHost(directory, binding)
    const invoke = vi.fn(async () => Buffer.from("synthetic".repeat(20000)))
    const response = (n: number) => path.join(journal, `call-${String(n).padStart(2, "0")}`, "response")
    const port = {
        inspect: vi.fn(async () => ({ runtimeIdentity: binding.runtimeIdentity, states: requests.map((_, n) => inspectCanaryCall(journal, contract, n)) })),
        executeOne: vi.fn(async (n: number) => { await runDurableCanaryCall({ directory: journal, contract, ordinal: n, requestJson: requests[n], invoke }) }),
        manifest: vi.fn(async (n: number) => JSON.parse(fs.readFileSync(path.join(response(n), "manifest.json"), "utf8"))),
        block: vi.fn(async (n: number, i: number) => fs.readFileSync(path.join(response(n), `block-${String(i).padStart(3, "0")}`))),
        acknowledge: vi.fn<CanaryRuntimePort["acknowledge"]>(async () => {}),
    } satisfies CanaryRuntimePort
    return { directory, binding, port, invoke, run: (ordinal = 0, mode: "execute-one" | "recover" = "execute-one") => advanceCanaryHost({ directory, binding, port, ordinal, mode, now: 0 }) }
}
describe("宿主调度/恢复（本地文件journal和合成结果）", () => {
    it("结果未知时不恢复调用；错误块不ACK", async () => {
        const f = fixture(); f.invoke.mockRejectedValueOnce(new Error("timeout"))
        await expect(f.run()).rejects.toThrow("uncertain")
        await expect(f.run(0, "recover")).rejects.toThrow("outcome_unknown")
        expect(f.port.executeOne).toHaveBeenCalledTimes(1)
        const g = fixture(); g.port.block.mockResolvedValueOnce(Buffer.from("corrupt"))
        await expect(g.run()).rejects.toThrow("integrity")
        expect(g.port.acknowledge).not.toHaveBeenCalled()
        await g.run(0, "recover"); expect(g.port.executeOne).toHaveBeenCalledTimes(1)
    })
    it("宽权限宿主目录在调用port前拒绝", async () => {
        const f = fixture(); fs.chmodSync(f.directory, 0o755)
        await expect(f.run()).rejects.toThrow("unsafe")
        expect(f.port.inspect).not.toHaveBeenCalled()
    })
    it("正常单项交接后显式推进下一项，恢复不再调用", async () => {
        const f = fixture()
        await f.run(); expect(f.invoke).toHaveBeenCalledTimes(1)
        await f.run(0, "recover"); expect(f.port.executeOne).toHaveBeenCalledTimes(1)
        await f.run(1); expect(f.invoke).toHaveBeenCalledTimes(2)
    })
    it("执行返回丢失：只恢复已保存结果", async () => {
        const f = fixture(), execute = f.port.executeOne.getMockImplementation()!
        f.port.executeOne.mockImplementationOnce(async n => { await execute(n); throw new Error("lost") })
        await expect(f.run()).rejects.toThrow("uncertain")
        await f.run(0, "recover"); expect(f.port.executeOne).toHaveBeenCalledTimes(1)
    })
    it("执行前中断也不重新派发", async () => {
        const f = fixture(); f.port.executeOne.mockRejectedValueOnce(new Error("lost"))
        await expect(f.run()).rejects.toThrow("uncertain")
        await expect(f.run()).rejects.toThrow("no_retry")
        expect(f.port.executeOne).toHaveBeenCalledTimes(1); expect(f.invoke).not.toHaveBeenCalled()
    })
    it("取块中断只补缺失块；ACK丢失阻止下一项", async () => {
        const f = fixture(), block = f.port.block.getMockImplementation()!
        f.port.block.mockImplementationOnce(block).mockRejectedValueOnce(new Error("lost"))
        await expect(f.run()).rejects.toThrow("lost")
        f.port.block.mockClear(); f.port.acknowledge.mockRejectedValueOnce(new Error("lost"))
        await expect(f.run(0, "recover")).rejects.toThrow("ack_unconfirmed")
        expect(f.port.block.mock.calls.every(([, index]) => index !== 0)).toBe(true)
        await expect(f.run(1)).rejects.toThrow()
        await f.run(0, "recover"); await f.run(1)
        expect(f.port.executeOne).toHaveBeenCalledTimes(2)
    })
    it("运行时身份漂移、过期和跨身份产物不允许推进", async () => {
        const f = fixture()
        f.port.inspect.mockResolvedValueOnce({ runtimeIdentity: "f".repeat(64), states: ["not_started", "not_started"] })
        await expect(f.run()).rejects.toThrow("identity_changed")
        await expect(advanceCanaryHost({ ...f, ordinal: 0, mode: "execute-one", now: Date.parse(f.binding.expiresAt) })).rejects.toThrow("expired")
        expect(f.port.executeOne).not.toHaveBeenCalled()
        const manifest = f.port.manifest.getMockImplementation()!
        f.port.manifest.mockImplementationOnce(async n => ({ ...await manifest(n), executionId: "wrong" }))
        await expect(f.run()).rejects.toThrow()
        expect(f.port.acknowledge).not.toHaveBeenCalled()
    })
    it("恢复未开始项、重复初始化及并发派发均不增加执行次数", async () => {
        const f = fixture()
        await expect(f.run(0, "recover")).rejects.toThrow("no_retry")
        expect(() => initializeCanaryHost(f.directory, f.binding)).toThrow()
        await Promise.allSettled([f.run(), f.run()])
        expect(f.port.executeOne).toHaveBeenCalledTimes(1)
    })
})
