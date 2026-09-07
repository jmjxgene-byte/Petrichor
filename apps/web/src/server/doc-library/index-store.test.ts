import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ getDb: vi.fn(), isSqliteDatabase: vi.fn() }))
vi.mock("@/server/db/client", () => mocks)
import { createDocumentIndexGeneration } from "./index-store"
import { prepareIndexManifest } from "./index-contract"
const profile = { modelRefId: 1, model: "synthetic", dimensions: 1024, version: 1, key: "synthetic:v1" }
const documents = [{ documentId: 1, sourceHash: "a".repeat(64), updatedAt: "2026-09-08T00:00:00.000Z" }]
const approval = { approvalId: "synthetic", manifestHash: prepareIndexManifest(documents, profile).manifestHash,
    maxInputTokens: 100, maxCostMicrousd: 100, expiresAt: "2099-01-01T00:00:00.000Z" }
const input = { userId: 7, libraryId: 3, documents, profile, approval }

function fixture(results: unknown[][]) {
    let cursor = 0
    const values = vi.fn((_input: unknown) => ({ returning: async () => [{ id: 10 }] }))
    const tx = {
        execute: vi.fn(async () => []),
        select: vi.fn(() => {
            const rows = results[cursor++] ?? []
            const chain = { from: () => chain, where: () => chain, for: () => chain, limit: () => chain,
                then: <T>(resolve: (rows: unknown[]) => T) => Promise.resolve(rows).then(resolve) }
            return chain
        }),
        insert: vi.fn(() => ({ values })),
    }
    mocks.getDb.mockReturnValue({ transaction: async (callback: (tx: object) => unknown) => callback(tx) })
    return { tx, values }
}
beforeEach(() => { vi.clearAllMocks(); mocks.isSqliteDatabase.mockReturnValue(false) })

describe("受控索引任务准备", () => {
    it("manifest版本匹配才创建generation和待处理job，不标记current", async () => {
        const f = fixture([[{ id: 3 }], [{ id: 1, updatedAt: new Date(documents[0].updatedAt) }], [], []])
        expect(await createDocumentIndexGeneration(input)).toEqual({ id: 10 })
        expect(f.tx.execute).toHaveBeenCalledOnce()
        expect(f.values).toHaveBeenNthCalledWith(1, expect.objectContaining({ expectedDocuments: 1, manifestHash: approval.manifestHash }))
        expect(f.values).toHaveBeenNthCalledWith(2, [expect.objectContaining({ generationId: 10, sourceHash: documents[0].sourceHash, documentId: 1 })])
        expect(f.values.mock.calls[0][0]).not.toHaveProperty("isCurrent")
    })
    it("同一manifest已在构建则返回已有generation不重复创建", async () => {
        const f = fixture([[{ id: 3 }], [{ id: 1, updatedAt: new Date(documents[0].updatedAt) }], [{ id: 10 }]])
        expect(await createDocumentIndexGeneration(input)).toEqual({ id: 10 })
        expect(f.tx.insert).not.toHaveBeenCalled()
    })
    it("输入版本变化阻止任务准备", async () => {
        const f = fixture([[{ id: 3 }], [{ id: 1, updatedAt: new Date("2026-09-09T00:00:00.000Z") }]])
        await expect(createDocumentIndexGeneration(input)).rejects.toThrow("文档已变化")
        expect(f.tx.insert).not.toHaveBeenCalled()
    })
    it("无权访问文档库或文档都不创建任务", async () => {
        const f = fixture([[]])
        await expect(createDocumentIndexGeneration(input)).rejects.toThrow("无权访问")
        expect(f.tx.insert).not.toHaveBeenCalled()
        const other = fixture([[{ id: 3 }], []])
        await expect(createDocumentIndexGeneration(input)).rejects.toThrow("不可访问")
        expect(other.tx.insert).not.toHaveBeenCalled()
    })
    it("失败任务的审批不得复用创建新generation", async () => {
        const f = fixture([[{ id: 3 }], [{ id: 1, updatedAt: new Date(documents[0].updatedAt) }], [], [{ id: 9 }]])
        await expect(createDocumentIndexGeneration(input)).rejects.toThrow("不能复用")
        expect(f.tx.insert).not.toHaveBeenCalled()
    })
})
