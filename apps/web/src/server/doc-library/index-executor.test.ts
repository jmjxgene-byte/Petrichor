import { describe, expect, it, vi } from "vitest"
import { runDocumentIndexJob, type IndexExecutionDeps } from "./index-executor"
import { prepareIndexManifest } from "./index-contract"
import { hashDocumentText } from "./passage-builder"
const source = "合成正文"
const profile = { modelRefId: 1, model: "synthetic", dimensions: 2, version: 1, key: "synthetic" }
const job = { documentId: 1, sourceHash: hashDocumentText(source) }
const prepared = prepareIndexManifest([{ documentId: 1, sourceHash: job.sourceHash, updatedAt: "2026-09-08T00:00:00Z" }], profile)
function fixture() {
    const embed = vi.fn(async (_values: string[], _signal: AbortSignal) => [[1, 0]])
    const quote = vi.fn(() => ({ inputTokens: 100, costMicrousd: 100 }))
    const deps = {
        heartbeat: vi.fn(async () => true),
        load: vi.fn(async () => ({ source, title: "合成", sourceFormat: "raw_markdown" as const, manifestJson: JSON.stringify(prepared.manifest), manifestHash: prepared.manifestHash })),
        provider: vi.fn(async () => ({ profile, embed, quote })), reserve: vi.fn(async () => ({})),
        complete: vi.fn(async () => ({})), fail: vi.fn(async (_code: string) => ({})), cancelled: vi.fn(async () => null as unknown),
    } satisfies IndexExecutionDeps
    return { deps, embed, quote }
}
describe("索引执行链路（假provider）", () => {
    it("预算预占在模型调用前，成功后才完成登记", async () => {
        const f = fixture()
        expect(await runDocumentIndexJob(job, f.deps)).toBe("succeeded")
        expect(f.deps.reserve.mock.invocationCallOrder[0]).toBeLessThan(f.embed.mock.invocationCallOrder[0])
        expect(f.embed.mock.invocationCallOrder[0]).toBeLessThan(f.deps.complete.mock.invocationCallOrder[0])
        expect(f.deps.complete).toHaveBeenCalledWith({ source, embeddings: [[1,0]], profile })
        expect(f.deps.fail).not.toHaveBeenCalled()
    })
    it("源hash变化不预占不调模型", async () => {
        const f = fixture()
        expect(await runDocumentIndexJob({ ...job, sourceHash: "b".repeat(64) }, f.deps)).toBe("failed")
        expect(f.deps.reserve).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
        expect(f.deps.fail).toHaveBeenCalledWith("source_changed")
    })
    it("预算拒绝时不调模型", async () => {
        const f = fixture(); f.deps.reserve.mockRejectedValueOnce(new Error("budget"))
        expect(await runDocumentIndexJob(job, f.deps)).toBe("failed")
        expect(f.embed).not.toHaveBeenCalled()
    })
    it("模型失败只调用一次，保守记结果未知，不写完成", async () => {
        const f = fixture(); f.embed.mockRejectedValueOnce(new Error("private provider error"))
        expect(await runDocumentIndexJob(job, f.deps)).toBe("failed")
        expect(f.embed).toHaveBeenCalledOnce()
        expect(f.deps.fail).toHaveBeenCalledWith("model_outcome_unknown")
        expect(f.deps.complete).not.toHaveBeenCalled()
    })
    it("租约丢失不冒充数据库已取消", async () => {
        const f = fixture(); f.deps.heartbeat.mockResolvedValueOnce(false)
        expect(await runDocumentIndexJob(job, f.deps)).toBe("lease_lost")
        expect(f.deps.provider).not.toHaveBeenCalled()
    })
    it("取消期间即使模型返回也不写完成", async () => {
        const f = fixture(), controller = new AbortController()
        f.embed.mockImplementationOnce(async () => { controller.abort(); return [[1, 0]] })
        f.deps.cancelled.mockResolvedValueOnce({ status: "cancelled" })
        expect(await runDocumentIndexJob(job, f.deps, controller.signal)).toBe("cancelled")
        expect(f.deps.complete).not.toHaveBeenCalled()
    })
})
