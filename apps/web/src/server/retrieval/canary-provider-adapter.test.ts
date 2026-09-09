import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { frozenEmbeddingRequests, runPersistedProviderBatch, type CanaryRequest } from "../../../scripts/canary-provider-adapter"
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true }) })
const request: CanaryRequest = { kind: "query_embedding", body: { model: "BAAI/bge-m3", input: ["synthetic-query"], encoding_format: "float" } }
function fixture(requests = [request]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "petrichor-adapter-")); roots.push(root)
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string)
        return Response.json({ data: body.input.map((_: string, index: number) => ({ index, embedding: [1, ...Array(1023).fill(0)], privateEcho: "synthetic-secret" })), usage: { total_tokens: 10 }, privateEcho: "synthetic-secret" })
    })
    return { directory: path.join(root, "journal"), executionId: "synthetic", planHash: "a".repeat(64), providerProfileHash: "b".repeat(64), apiKey: "synthetic-secret", requests, transport }
}
describe("持久化provider适配器（假服务）", () => {
    it("8次重排批次完整持久化，恢复无需凭证或新调用", async () => {
        const f = fixture(Array.from({ length: 8 }, (_, i) => ({ kind: "rerank", body: {
            model: "BAAI/bge-reranker-v2-m3", query: `synthetic-${i}`, documents: ["a", "b", "c", "d"], top_n: 4, return_documents: false,
        } })))
        f.transport.mockImplementation(async () => Response.json({ results: [3, 2, 1, 0].map((index, i) => ({ index, relevance_score: 1 - i / 10 })) }))
        expect((await runPersistedProviderBatch(f)).results).toHaveLength(8)
        expect((await runPersistedProviderBatch({ ...f, apiKey: undefined })).results.every(r => r.reused)).toBe(true)
        expect(f.transport).toHaveBeenCalledTimes(8)
    })
    it("冻结22次嵌入全部逐次保存，恢复不发出新请求", async () => {
        const frozen = frozenEmbeddingRequests(), f = { ...fixture(frozen.requests), planHash: frozen.planHash }
        const first = await runPersistedProviderBatch(f)
        expect(first.results).toHaveLength(22)
        expect(first.results.every(r => !r.reused)).toBe(true)
        expect((await runPersistedProviderBatch({ ...f, apiKey: undefined })).results.every(r => r.reused)).toBe(true)
        expect(f.transport).toHaveBeenCalledTimes(22)
        expect(f.transport).toHaveBeenCalledWith("https://api.siliconflow.cn/v1/embeddings", expect.objectContaining({ redirect: "error" }))
        const saved = fs.readFileSync(path.join(f.directory, "call-00/response/artifact.bin"), "utf8")
        expect(saved).not.toContain("synthetic-secret"); expect(saved).not.toContain("privateEcho")
    })
    it("HTTP失败不重试、不执行后续项", async () => {
        const f = fixture([request, request]); f.transport.mockResolvedValueOnce(new Response("private", { status: 429 }))
        await expect(runPersistedProviderBatch(f)).rejects.toThrow("no_retry")
        await expect(runPersistedProviderBatch(f)).rejects.toThrow("no_retry")
        expect(f.transport).toHaveBeenCalledTimes(1)
    })
    it.each([
        { data: [{ index: 0, embedding: [1, 2] }] },
        { data: [{ index: 0, embedding: Array(1024).fill(0) }] },
        { data: [{ index: 1, embedding: [1, ...Array(1023).fill(0)] }] },
        { data: [{ index: 0, embedding: [1e100, ...Array(1023).fill(0)] }] },
        { data: [{ index: 0, embedding: [1e-100, ...Array(1023).fill(0)] }] },
    ])("无效向量响应不发布完成收据", async raw => {
        const f = fixture(); f.transport.mockResolvedValueOnce(Response.json(raw))
        await expect(runPersistedProviderBatch(f)).rejects.toThrow("no_retry")
        expect(fs.existsSync(path.join(f.directory, "call-00/response/receipt.json"))).toBe(false)
    })
    it("缺失用量保存null，不伪造零", async () => {
        const f = fixture(); f.transport.mockResolvedValueOnce(Response.json({ data: [{ index: 0, embedding: [1, ...Array(1023).fill(0)] }] }))
        await runPersistedProviderBatch(f)
        expect(JSON.parse(fs.readFileSync(path.join(f.directory, "call-00/response/artifact.bin"), "utf8")).usage.total_tokens).toBeNull()
    })
    it("重排只保留候选index/分数，不保留回显正文", async () => {
        const f = fixture([{ kind: "rerank", body: { model: "BAAI/bge-reranker-v2-m3", query: "q", documents: ["a", "b"], top_n: 2, return_documents: false } }])
        f.transport.mockResolvedValueOnce(Response.json({ results: [{ index: 1, relevance_score: 0.9, document: { text: "privateEcho" } }, { index: 0, relevance_score: 0.1 }] }))
        await runPersistedProviderBatch(f)
        const saved = fs.readFileSync(path.join(f.directory, "call-00/response/artifact.bin"), "utf8")
        expect(saved).not.toContain("privateEcho"); expect(JSON.parse(saved).results[0].index).toBe(1)
    })
    it("错误请求/额外敏感字段在第一次调用前拒绝", async () => {
        const f = fixture([{ ...request, body: { ...(request.body as object), apiKey: "forbidden" } }])
        await expect(runPersistedProviderBatch(f)).rejects.toThrow()
        expect(f.transport).not.toHaveBeenCalled()
    })
    it("预先取消不预约或调用", async () => {
        const f = fixture(), controller = new AbortController(); controller.abort(new Error("cancelled"))
        await expect(runPersistedProviderBatch({ ...f, signal: controller.signal })).rejects.toThrow("cancelled")
        expect(f.transport).not.toHaveBeenCalled(); expect(fs.existsSync(f.directory)).toBe(false)
    })
    it("过大输入在调用前拒绝", async () => {
        const f = fixture([{ ...request, body: { model: "BAAI/bge-m3", input: ["中".repeat(2000)], encoding_format: "float" } }])
        await expect(runPersistedProviderBatch(f)).rejects.toThrow("canary_input_limit")
        expect(f.transport).not.toHaveBeenCalled()
    })
    it("256KiB响应上限失败，不发布收据或重试", async () => {
        const f = fixture(); f.transport.mockResolvedValueOnce(new Response("x".repeat(262145)))
        await expect(runPersistedProviderBatch(f)).rejects.toThrow("no_retry")
        expect(f.transport).toHaveBeenCalledTimes(1)
        expect(fs.existsSync(path.join(f.directory, "call-00/response/receipt.json"))).toBe(false)
    })
    it("新批次缺凭证时不预约，不调用", async () => {
        const f = fixture()
        await expect(runPersistedProviderBatch({ ...f, apiKey: undefined })).rejects.toThrow("credential_missing")
        expect(f.transport).not.toHaveBeenCalled(); expect(fs.existsSync(f.directory)).toBe(false)
    })
    it.each([
        [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 0 }],
        [{ index: 0, relevance_score: 0 }, { index: 1, relevance_score: 1 }],
        [{ index: 0, relevance_score: 1 }],
    ])("无效重排结果不保存完成收据", async (...results) => {
        const f = fixture([{ kind: "rerank", body: { model: "BAAI/bge-reranker-v2-m3", query: "q", documents: ["a", "b"], top_n: 2, return_documents: false } }])
        f.transport.mockResolvedValueOnce(Response.json({ results }))
        await expect(runPersistedProviderBatch(f)).rejects.toThrow("no_retry")
        expect(fs.existsSync(path.join(f.directory, "call-00/response/receipt.json"))).toBe(false)
    })
    it("服务端声明其他模型时拒绝", async () => {
        const f = fixture(); f.transport.mockResolvedValueOnce(Response.json({ model: "other", data: [{ index: 0, embedding: [1, ...Array(1023).fill(0)] }] }))
        await expect(runPersistedProviderBatch(f)).rejects.toThrow("no_retry")
    })
})
