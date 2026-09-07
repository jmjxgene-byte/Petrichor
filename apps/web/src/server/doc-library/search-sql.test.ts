import { describe, expect, it, vi } from "vitest"
import { drizzle } from "drizzle-orm/pg-proxy"
const mocks = vi.hoisted(() => ({ reader: { value: null as unknown } }))
vi.mock("@/server/db/read-budget", () => ({ withReadBudget: async (run: (db: unknown) => Promise<unknown>) => run(mocks.reader.value) }))
import { searchChunks } from "./library-logic"

describe("词项检索SQL契约", () => {
    it("绑定中文词项与归属，先排序后LIMIT，不使用无序候选预截断", async () => {
        const execute = vi.fn(async () => ({ rows: [] }))
        mocks.reader.value = drizzle(execute)
        await searchChunks({ userId: 7, libraryId: 3, query: "翻新怎么翻？", limit: 8 })
        const [query, params] = execute.mock.calls[0] as unknown as [string, unknown[]]
        expect(query).toContain("order by")
        expect(query.indexOf("order by")).toBeLessThan(query.indexOf("limit"))
        expect(params).toContain("%翻新%")
        expect(params).not.toContain("%翻新怎么翻？%")
        expect(params).toContain(7)
        expect(params).toContain(3)
        expect(query).toContain('"petrichor_doc_document"."user_id"')
        expect(query).toContain('"petrichor_doc_chunk"."user_id"')
    })
    it("纯标点没有关键词时不访问数据库", async () => {
        const execute = vi.fn(async () => ({ rows: [] }))
        mocks.reader.value = drizzle(execute)
        expect(await searchChunks({ userId: 7, libraryId: 3, query: "？！" })).toEqual([])
        expect(execute).not.toHaveBeenCalled()
    })
})
