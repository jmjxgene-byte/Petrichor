import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
const mocks = vi.hoisted(() => ({ getDb: vi.fn(), isSqliteDatabase: vi.fn() }))
vi.mock("@/server/db/client", () => mocks)
import { completeDocumentIndexJob, activateDocumentIndexGeneration } from "./index-complete"
import { prepareIndexManifest, serializeIndexVectors } from "./index-contract"
import { hashDocumentText } from "./passage-builder"

const now = new Date("2026-09-08T00:00:00Z"), source = "合成正文"
const profile = { modelRefId: 1, model: "synthetic", dimensions: 2, version: 1, key: "synthetic" }
const snapshot = { documentId: 1, updatedAt: now.toISOString(), sourceHash: hashDocumentText(source) }
const prepared = prepareIndexManifest([snapshot], profile)
const generation = { id: 3, userId: 7, libraryId: 2, status: "building", manifestJson: JSON.stringify(prepared.manifest),
    manifestHash: prepared.manifestHash, expectedDocuments: 1, embeddingProfileJson: JSON.stringify(profile), preprocessingVersion: 1 }
const job = { id: 4, userId: 7, libraryId: 2, documentId: 1, generationId: 3, sourceHash: snapshot.sourceHash, status: "running",
    leaseOwner: "worker", leaseExpiresAt: new Date(now.getTime() + 60000), consumedInputTokens: 10 }
const document = { id: 1, updatedAt: now, title: "合成标题" }
const completeInput = { userId: 7, jobId: 4, workerId: "worker", source, embeddings: [[1, 0]], profile }
const activateInput = { userId: 7, generationId: 3, manifestHash: generation.manifestHash, profile }

function fixture(results: unknown[][]) {
    let index = 0
    const settings: unknown[] = []
    const tx = {
        execute: vi.fn(async (_statement: SQL) => []),
        select: () => {
            const rows = results[index++] ?? []
            const chain = { from: () => chain, where: () => chain, for: () => chain, limit: () => chain,
                then: <T>(resolve: (rows: unknown[]) => T) => Promise.resolve(rows).then(resolve) }
            return chain
        },
        update: () => ({ set: (value: unknown) => { settings.push(value); return { where: async () => [] } } }),
    }
    mocks.getDb.mockReturnValue({ transaction: async (run: (tx: object) => unknown) => run(tx) })
    return { tx, settings }
}
beforeEach(() => { vi.clearAllMocks(); mocks.isSqliteDatabase.mockReturnValue(false) })

describe("索引向量与发布门", () => {
    it("拒绝数量、维度、float32溢出与零向量", () => {
        expect(serializeIndexVectors([[1, 0]], 1, 2)).toEqual(["[1,0]"])
        expect(() => serializeIndexVectors([], 1, 2)).toThrow("数量")
        expect(() => serializeIndexVectors([[1]], 1, 2)).toThrow("维度")
        for (const value of [NaN, Infinity, 1e100]) expect(() => serializeIndexVectors([[value, 0]], 1, 2)).toThrow("数值")
        expect(() => serializeIndexVectors([[1e-100, 0]], 1, 2)).toThrow("零向量")
    })
    it("所有任务通过后写ready，不自动切current", async () => {
        const f = fixture([[job], [generation], [document], [{ count: 0 }], [{ ...job, status: "succeeded" }], [document], [{ passages: 1, documents: 1, invalid: 0 }]])
        expect(await completeDocumentIndexJob(completeInput, now)).toEqual({ jobId: 4, alreadyCompleted: false })
        const insert = new PgDialect().sqlToQuery(f.tx.execute.mock.calls[1][0])
        expect(insert.sql).toContain("insert into petrichor_doc_passage")
        expect(insert.params).toContain("[1,0]")
        expect(f.settings).toContainEqual(expect.objectContaining({ status: "succeeded" }))
        expect(f.settings).toContainEqual(expect.objectContaining({ status: "ready", completedDocuments: 1, passageCount: 1 }))
        expect(f.settings.every((item) => !(item as Record<string, unknown>).isCurrent)).toBe(true)
    })
    it("重复完成不再写片段或计数", async () => {
        const f = fixture([[{ ...job, status: "succeeded" }]])
        expect((await completeDocumentIndexJob(completeInput, now)).alreadyCompleted).toBe(true)
        expect(f.tx.execute).toHaveBeenCalledTimes(1)
        expect(f.settings).toEqual([])
    })
    it("hash、租约或文档版本变化时不写向量", async () => {
        for (const results of [
            [[{ ...job, sourceHash: "b".repeat(64) }]],
            [[{ ...job, leaseExpiresAt: now }]],
            [[job], [generation], [{ ...document, updatedAt: new Date(0) }]],
        ]) {
            const f = fixture(results)
            await expect(completeDocumentIndexJob(completeInput, now)).rejects.toThrow()
            expect(f.tx.execute).toHaveBeenCalledTimes(1)
            expect(f.settings).toEqual([])
        }
    })
    it("发布先核验，再按旧current关闭、新current开启的顺序更新", async () => {
        const f = fixture([[{ ...generation, status: "ready" }], [{ ...job, status: "succeeded" }], [document], [{ passages: 1, documents: 1, invalid: 0 }]])
        expect(await activateDocumentIndexGeneration(activateInput, now)).toEqual({ generationId: 3, manifestHash: generation.manifestHash })
        expect(f.settings[0]).toMatchObject({ isCurrent: false, status: "retired" })
        expect(f.settings[1]).toMatchObject({ isCurrent: true, status: "ready" })
    })
    it("任务未完成或分片验收失败都不能关闭旧current", async () => {
        for (const results of [
            [[generation], [job]],
            [[generation], [{ ...job, status: "succeeded" }], [document], [{ passages: 1, documents: 1, invalid: 1 }]],
        ]) {
            const f = fixture(results)
            await expect(activateDocumentIndexGeneration(activateInput, now)).rejects.toThrow()
            expect(f.settings).toEqual([])
        }
    })
    it("模型档案不匹配不发布", async () => {
        const f = fixture([[generation]])
        await expect(activateDocumentIndexGeneration({ ...activateInput, profile: { ...profile, key: "changed" } }, now)).rejects.toThrow("档案")
        expect(f.settings).toEqual([])
    })
})
