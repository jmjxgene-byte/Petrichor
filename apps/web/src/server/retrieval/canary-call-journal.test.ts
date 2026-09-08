import { describe, expect, it, afterEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { inspectCanaryCall, openCanaryCallJournal, runDurableCanaryBatch, runDurableCanaryCall } from "../../../scripts/canary-call-journal"
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true }) })
const requestJson = '{"synthetic":true}', requestHash = createHash("sha256").update(requestJson).digest("hex")
function fixture(count = 1) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "petrichor-journal-")); roots.push(root)
    const directory = path.join(root, "journal")
    const contract = openCanaryCallJournal(directory, { version: 1, executionId: "synthetic-run", planHash: "a".repeat(64), providerProfileHash: "b".repeat(64), calls: Array.from({ length: count }, () => ({ kind: "document_embedding", requestHash })) })
    return { directory, contract, ordinal: 0, requestJson }
}
describe("调用前预约与逐响应持久化", () => {
    it("provider档案变更不能复用执行日志", async () => {
        const f = fixture(), invoke = vi.fn(async () => Buffer.from("synthetic"))
        await expect(runDurableCanaryCall({ ...f, contract: { ...f.contract, providerProfileHash: "c".repeat(64) }, invoke })).rejects.toThrow("call_contract_mismatch")
        expect(invoke).not.toHaveBeenCalled()
    })
    it("批次先逐响应落盘再进入下一请求，二次读取完全复用", async () => {
        const f = fixture(2)
        const invoke = vi.fn(async (_body: string, ordinal: number) => {
            if (ordinal === 1) expect(inspectCanaryCall(f.directory, f.contract, 0)).toBe("persisted")
            return Buffer.from("synthetic")
        })
        const args = { ...f, requests: [requestJson, requestJson], invoke }
        expect((await runDurableCanaryBatch(args)).results.every(r => !r.reused)).toBe(true)
        expect((await runDurableCanaryBatch(args)).results.every(r => r.reused)).toBe(true)
        expect(invoke).toHaveBeenCalledTimes(2)
    })
    it("批次第二项失败后停止，恢复也不能再次调用未知项或跳到第三项", async () => {
        const f = fixture(3), invoke = vi.fn(async (_body: string, ordinal: number) => {
            if (ordinal === 1) throw new Error("failure")
            return Buffer.from("synthetic")
        })
        const args = { ...f, requests: [requestJson, requestJson, requestJson], invoke }
        await expect(runDurableCanaryBatch(args)).rejects.toThrow("no_retry")
        await expect(runDurableCanaryBatch(args)).rejects.toThrow("no_retry")
        expect(invoke).toHaveBeenCalledTimes(2)
        expect(inspectCanaryCall(f.directory, f.contract, 0)).toBe("persisted")
        expect(inspectCanaryCall(f.directory, f.contract, 2)).toBe("not_started")
    })
    it("批次末项hash不匹配时连第一项也不调用", async () => {
        const f = fixture(2), invoke = vi.fn(async () => Buffer.from("synthetic"))
        await expect(runDurableCanaryBatch({ ...f, requests: [requestJson, "changed"], invoke })).rejects.toThrow("batch_request_mismatch")
        expect(invoke).not.toHaveBeenCalled()
    })
    it("先落intent再调用，完成后从文件复用而非重调模型", async () => {
        const f = fixture()
        const invoke = vi.fn(async () => {
            expect(inspectCanaryCall(f.directory, f.contract, 0)).toBe("outcome_unknown")
            return Buffer.from('{"result":"synthetic"}')
        })
        const first = await runDurableCanaryCall({ ...f, invoke })
        openCanaryCallJournal(f.directory, f.contract)
        const second = await runDurableCanaryCall({ ...f, invoke })
        expect(first.reused).toBe(false); expect(second.reused).toBe(true)
        expect(second.payload).toEqual(first.payload); expect(invoke).toHaveBeenCalledTimes(1)
    })
    it("同一请求并发只有一个调用", async () => {
        const f = fixture(), invoke = vi.fn(async () => { await new Promise(r => setTimeout(r, 20)); return Buffer.from("synthetic") })
        const results = await Promise.allSettled([runDurableCanaryCall({ ...f, invoke }), runDurableCanaryCall({ ...f, invoke })])
        expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1)
        expect(invoke).toHaveBeenCalledTimes(1)
    })
    it("调用抛错后禁止重试，不保存原始异常", async () => {
        const f = fixture(), invoke = vi.fn(async () => { throw new Error("private-key-example") })
        await expect(runDurableCanaryCall({ ...f, invoke })).rejects.toThrow()
        expect(inspectCanaryCall(f.directory, f.contract, 0)).toBe("outcome_unknown")
        await expect(runDurableCanaryCall({ ...f, invoke })).rejects.toThrow("no_retry")
        expect(invoke).toHaveBeenCalledTimes(1)
        expect(fs.readFileSync(path.join(f.directory, "call-00/intent.json"), "utf8")).not.toContain("private-key-example")
    })
    it("响应超限或落盘失败仍禁止再次调用", async () => {
        const f = fixture(), invoke = vi.fn(async () => Buffer.alloc(262145))
        await expect(runDurableCanaryCall({ ...f, invoke })).rejects.toThrow("response_size_invalid")
        await expect(runDurableCanaryCall({ ...f, invoke })).rejects.toThrow("no_retry")
        expect(invoke).toHaveBeenCalledTimes(1)
    })
    it("响应返回后的fsync失败保留未知状态，不重复模型回调", async () => {
        const f = fixture(), invoke = vi.fn(async () => {
            vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => { throw new Error("synthetic_disk_failure") })
            return Buffer.from("synthetic")
        })
        await expect(runDurableCanaryCall({ ...f, invoke })).rejects.toThrow("synthetic_disk_failure")
        expect(inspectCanaryCall(f.directory, f.contract, 0)).toBe("outcome_unknown")
        await expect(runDurableCanaryCall({ ...f, invoke })).rejects.toThrow("no_retry")
        expect(invoke).toHaveBeenCalledTimes(1)
    })
    it("前一调用未完成不允许跳过", async () => {
        const f = fixture(2), invoke = vi.fn(async () => Buffer.from("synthetic"))
        await expect(runDurableCanaryCall({ ...f, ordinal: 1, invoke })).rejects.toThrow("previous_call_incomplete")
        expect(invoke).not.toHaveBeenCalled()
    })
    it("请求hash不符和超授权调用数在调用前拒绝", async () => {
        const f = fixture(), invoke = vi.fn(async () => Buffer.from("synthetic"))
        await expect(runDurableCanaryCall({ ...f, requestJson: "changed", invoke })).rejects.toThrow("request_hash_mismatch")
        expect(() => fixture(15)).toThrow()
        expect(invoke).not.toHaveBeenCalled()
    })
    it("已保存响应被损坏时失败，不借机重新生成", async () => {
        const f = fixture(), invoke = vi.fn(async () => Buffer.from("synthetic"))
        await runDurableCanaryCall({ ...f, invoke })
        fs.writeFileSync(path.join(f.directory, "call-00/response/artifact.bin"), "corrupted")
        await expect(runDurableCanaryCall({ ...f, invoke })).rejects.toThrow("call_artifact_integrity")
        expect(invoke).toHaveBeenCalledTimes(1)
    })
    it("已有响应但完成收据缺失仍保守阻止重调", async () => {
        const f = fixture(), invoke = vi.fn(async () => Buffer.from("synthetic"))
        await runDurableCanaryCall({ ...f, invoke })
        fs.unlinkSync(path.join(f.directory, "call-00/response/receipt.json"))
        expect(inspectCanaryCall(f.directory, f.contract, 0)).toBe("outcome_unknown")
        await expect(runDurableCanaryCall({ ...f, invoke })).rejects.toThrow("no_retry")
        expect(invoke).toHaveBeenCalledTimes(1)
        expect(fs.existsSync(path.join(f.directory, "call-00/response/artifact.bin"))).toBe(true)
    })
})
