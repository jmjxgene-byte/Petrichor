import { beforeEach, describe, expect, it, vi } from "vitest"
import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"

const mocks = vi.hoisted(() => ({ reader: null as unknown, checkpoint: vi.fn(async () => {}) }))
vi.mock("@/server/db/read-budget", () => ({
    withReadBudget: async (run: (reader: unknown, checkpoint: () => Promise<void>) => Promise<unknown>) => run(mocks.reader, mocks.checkpoint),
}))
import { readDocumentChunks } from "./library-logic"
import { hashDocumentText } from "./passage-builder"

function readerFixture(results: unknown[][]) {
    const predicates: SQL[] = []
    let cursor = 0
    const select = vi.fn(() => {
        const rows = results[cursor++] ?? []
        const chain = {
            from: () => chain, where: (condition: SQL) => { predicates.push(condition); return chain },
            orderBy: () => chain, limit: () => chain, offset: () => chain,
            then: <T>(resolve: (value: unknown[]) => T) => Promise.resolve(rows).then(resolve),
        }
        return chain
    })
    mocks.reader = { select }
    return { select, predicates }
}

beforeEach(() => vi.clearAllMocks())

describe("锚点reader权限与事务内检查", () => {
    it("搜索后文档变化在读锚点前停止，chunk正文变化在读窗口前停止", async () => {
        const doc = { id: 12, libraryId: 3, updatedAt: new Date(0) }
        let fixture = readerFixture([[doc]])
        await expect(readDocumentChunks({ userId: 7, libraryId: 3, documentId: 12, anchorChunkId: 901,
            expectedUpdatedAt: new Date(1).toISOString() })).rejects.toThrow("文档版本已变化")
        expect(fixture.select).toHaveBeenCalledTimes(1)
        fixture = readerFixture([[doc], [{ chunkIndex: 900, text: "新内容" }]])
        await expect(readDocumentChunks({ userId: 7, libraryId: 3, documentId: 12, anchorChunkId: 901,
            expectedUpdatedAt: new Date(0).toISOString(), anchorContentHash: hashDocumentText("旧内容") })).rejects.toThrow("命中片段已变化")
        expect(fixture.select).toHaveBeenCalledTimes(2)
    })
    it("先核验用户/文档库，再核验锚点，最后才读取命中窗口", async () => {
        const fixture = readerFixture([
            [{ id: 12, libraryId: 3, title: "合成文档", fileName: "demo.md", fileType: "markdown", updatedAt: new Date(0) }],
            [{ chunkIndex: 900, text: "尾部证据" }],
            [{ chunkIndex: 900, text: "尾部证据", page: null, locator: "结尾" }],
        ])
        const output = await readDocumentChunks({ userId: 7, libraryId: 3, documentId: 12, anchorChunkId: 901,
            expectedUpdatedAt: new Date(0).toISOString(), anchorContentHash: hashDocumentText("尾部证据") })
        expect(output.updatedAt).toBe(new Date(0).toISOString())
        expect(output.anchorIndex).toBe(900)
        expect(output.chunks[0].text).toBe("尾部证据")
        const dialect = new PgDialect()
        expect(dialect.sqlToQuery(fixture.predicates[0]).params).toEqual([12, 7, 3])
        expect(dialect.sqlToQuery(fixture.predicates[1]).params).toEqual([901, 12, 7])
        expect(dialect.sqlToQuery(fixture.predicates[2]).params).toEqual([12, 7, 899, 901])
        expect(mocks.checkpoint).toHaveBeenCalledTimes(2)
    })
    it("文档库归属不匹配则不读取锚点或正文", async () => {
        const fixture = readerFixture([[]])
        await expect(readDocumentChunks({ userId: 7, libraryId: 9, documentId: 12, anchorChunkId: 901 })).rejects.toThrow("不属于当前文档库")
        expect(fixture.select).toHaveBeenCalledTimes(1)
    })
    it("锚点失效后不读取其他正文", async () => {
        const fixture = readerFixture([[{ id: 12, libraryId: 3 }], []])
        await expect(readDocumentChunks({ userId: 7, libraryId: 3, documentId: 12, anchorChunkId: 901 })).rejects.toThrow("命中片段已失效")
        expect(fixture.select).toHaveBeenCalledTimes(2)
    })
})
