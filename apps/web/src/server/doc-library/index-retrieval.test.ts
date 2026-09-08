import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
const mocks = vi.hoisted(() => ({ reader: null as unknown, budget: vi.fn(), provider: vi.fn() }))
vi.mock("@/server/db/client", () => ({ isSqliteDatabase: () => false }))
vi.mock("@/server/db/read-budget", () => ({ withReadBudget: async (run: (reader: unknown, checkpoint: () => Promise<void>) => Promise<unknown>) => {
    mocks.budget(); return run(mocks.reader, async () => {})
} }))
vi.mock("./index-provider", () => ({ resolveDocumentIndexProvider: mocks.provider }))
import { searchDocumentIndex, readDocumentIndexPassage, createDocumentIndexReadSession } from "./index-retrieval"
import { prepareIndexManifest } from "./index-contract"
import { hashDocumentText } from "./passage-builder"
const date = new Date(0), profile = { modelRefId: 1, model: "synthetic", dimensions: 2, version: 1, key: "fixture" }
const sourceHash = "a".repeat(64)
const prepared = prepareIndexManifest([{ documentId: 1, sourceHash, updatedAt: date.toISOString() }], profile)
const generation = { id: 3, userId: 7, libraryId: 2, manifestJson: JSON.stringify(prepared.manifest), manifestHash: prepared.manifestHash, embeddingProfileJson: JSON.stringify(profile) }
const document = { id: 1, libraryId: 2, title: "合成文档", updatedAt: date }
const hit = { passageId: 4, generationId: 3, documentId: 1, libraryId: 2, title: "合成文档", text: "翻新条件", contentHash: hashDocumentText("翻新条件"), sourceHash, locator: "章节", passageIndex: 0 }
function fixture(results: unknown[][]) {
    let cursor = 0
    const predicates: SQL[] = []
    mocks.reader = { select: () => {
        const rows = results[cursor++] ?? []
        const chain = { from: () => chain, innerJoin: () => chain, where: (p: SQL) => { predicates.push(p); return chain }, orderBy: () => chain, limit: () => chain,
            then: <T>(resolve: (rows: unknown[]) => T) => Promise.resolve(rows).then(resolve) }
        return chain
    } }
    return predicates
}
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("PETRICHOR_DOC_INDEX_ENABLED", "true"); vi.stubEnv("PETRICHOR_DOC_HYBRID_ENABLED", "false") })
afterEach(() => vi.unstubAllEnvs())
describe("代际检索与引用", () => {
    it("第二轮使用固定代际并允许retired，不再读取current", async () => {
        const session = createDocumentIndexReadSession()
        fixture([[generation], [document], [hit]])
        await searchDocumentIndex({ userId: 7, libraryIds: [2], query: "翻新", session })
        expect(session.pins.get(2)).toBe(3)
        const predicates = fixture([[{ ...generation, status: "retired" }], [document], [hit]])
        const result = await searchDocumentIndex({ userId: 7, libraryIds: [2], query: "条件", session })
        expect(result.hits[0].generationId).toBe(3)
        const query = new PgDialect().sqlToQuery(predicates[0])
        expect(query.sql).not.toContain("is_current")
        expect(query.params).toEqual(expect.arrayContaining([7, 2, 3, "retired"]))
    })
    it("首次无索引固定legacy，后续不自动切换新generation", async () => {
        const session = createDocumentIndexReadSession()
        fixture([[]])
        await searchDocumentIndex({ userId: 7, libraryIds: [2], query: "翻新", session })
        expect(session.pins.get(2)).toBeNull()
        mocks.budget.mockClear()
        expect((await searchDocumentIndex({ userId: 7, libraryIds: [2], query: "条件", session })).hits).toEqual([])
        expect(mocks.budget).not.toHaveBeenCalled()
    })
    it("已固定版本失效或原文变化时拒绝，不改写pin", async () => {
        const session = createDocumentIndexReadSession()
        session.pins.set(2, 3)
        fixture([[]])
        await expect(searchDocumentIndex({ userId: 7, libraryIds: [2], query: "条件", session })).rejects.toThrow("版本已失效")
        fixture([[generation], [{ ...document, updatedAt: new Date(1) }]])
        await expect(searchDocumentIndex({ userId: 7, libraryIds: [2], query: "条件", session })).rejects.toThrow("原文已变化")
        expect(session.pins.get(2)).toBe(3)
    })
    it("并发调用首次确定版本后，下一次才执行；失败不会卡住队列", async () => {
        const session = createDocumentIndexReadSession()
        const predicates = fixture([[generation], [document], [hit], [generation], [document], [hit]])
        const input = { userId: 7, libraryIds: [2], query: "翻新", session }
        const results = await Promise.all([searchDocumentIndex(input), searchDocumentIndex(input)])
        expect(results.map((r) => r.hits[0].generationId)).toEqual([3, 3])
        expect(new PgDialect().sqlToQuery(predicates[3]).sql).not.toContain("is_current")
        fixture([[], [generation], [document], [hit]])
        const settled = await Promise.allSettled([searchDocumentIndex(input), searchDocumentIndex(input)])
        expect(settled.map((r) => r.status)).toEqual(["rejected", "fulfilled"])
    })
    it("关闭开关不查询索引或调用provider", async () => {
        vi.stubEnv("PETRICHOR_DOC_INDEX_ENABLED", "false")
        expect((await searchDocumentIndex({ userId: 7, libraryIds: [2], query: "翻新" })).hits).toEqual([])
        expect(mocks.budget).not.toHaveBeenCalled(); expect(mocks.provider).not.toHaveBeenCalled()
    })
    it("新增文档导致快照不完整时不隐藏新文档，交回词法降级", async () => {
        fixture([[generation], [document, { ...document, id: 2 }]])
        const result = await searchDocumentIndex({ userId: 7, libraryIds: [2], query: "翻新" })
        expect(result.indexedLibraryIds).toEqual([])
        expect(result.degraded).toContain("index_snapshot_stale")
        expect(mocks.provider).not.toHaveBeenCalled()
    })
    it("词法检索限制用户、库和代际，并携带稳定片段身份", async () => {
        const predicates = fixture([[generation], [document], [hit]])
        const result = await searchDocumentIndex({ userId: 7, libraryIds: [2], query: "翻新" })
        expect(result.hits[0]).toMatchObject({ passageId: 4, generationId: 3, contentHash: hit.contentHash, mode: "lexical" })
        const query = new PgDialect().sqlToQuery(predicates[2])
        expect(query.params).toContain(7); expect(query.params).toContain(2); expect(query.params).toContain(3)
        expect(query.sql).toContain("search_vector @@")
    })
    it("同一模型组只生成一次query向量，融合后不重复同一片段", async () => {
        vi.stubEnv("PETRICHOR_DOC_HYBRID_ENABLED", "true")
        fixture([[generation], [document], [hit], [hit]])
        const embed = vi.fn(async () => [[1, 0]])
        mocks.provider.mockResolvedValue({ embed })
        const result = await searchDocumentIndex({ userId: 7, libraryIds: [2], query: "翻新" })
        expect(embed).toHaveBeenCalledOnce()
        expect(result.hits).toHaveLength(1)
        expect(result.hits[0].mode).toBe("hybrid")
    })
    it("语义故障保留先完成的词法结果并报告降级", async () => {
        vi.stubEnv("PETRICHOR_DOC_HYBRID_ENABLED", "true")
        fixture([[generation], [document], [hit]])
        mocks.provider.mockRejectedValueOnce(new Error("private provider failure"))
        const result = await searchDocumentIndex({ userId: 7, libraryIds: [2], query: "翻新" })
        expect(result.hits).toHaveLength(1)
        expect(result.degraded).toEqual(["semantic_unavailable"])
    })
    it("片段身份/hash精确匹配才允许读原文，保留定位URL", async () => {
        const anchor = { ...hit, id: 4, startOffset: 0, endOffset: 4, parentStartOffset: 0, parentEndOffset: 4 }
        fixture([[generation], [document], [anchor], [anchor]])
        const output = await readDocumentIndexPassage({ userId: 7, libraryId: 2, documentId: 1, generationId: 3, passageId: 4, contentHash: hit.contentHash })
        expect(output.content).toBe("翻新条件")
        expect(output.href).toContain("generationId=3&passageId=4")
        fixture([[generation], [document], [anchor]])
        await expect(readDocumentIndexPassage({ userId: 7, libraryId: 2, documentId: 1, generationId: 3, passageId: 4, contentHash: "b".repeat(64) })).rejects.toThrow("hash")
    })
})
