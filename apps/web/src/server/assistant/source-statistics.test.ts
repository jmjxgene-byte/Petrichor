import { beforeEach, describe, expect, it, vi } from "vitest"
import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
const mocks = vi.hoisted(() => ({ sources: vi.fn(), select: vi.fn(), where: vi.fn(), group: vi.fn() }))
vi.mock("./source-catalog", () => ({ resolveAssistantSources: mocks.sources }))
vi.mock("@/server/db/read-budget", () => ({ withReadBudget: async (run: (reader: unknown, checkpoint: () => Promise<void>) => unknown) => run({ select: mocks.select }, async () => {}) }))
import { isSourceStatisticsQuestion, readSourceStatistics, renderSourceStatistics } from "./source-statistics"
beforeEach(() => {
    vi.clearAllMocks()
    mocks.select.mockReturnValue({ from: () => ({ where: mocks.where }) })
    mocks.where.mockReturnValue({ groupBy: mocks.group })
})
describe("选定范围元数据统计", () => {
    it("只查询当前用户和选定库，外部总量未知而非零", async () => {
        mocks.sources.mockResolvedValue({ selected: [{ id: "3", ref: "doc-library:3", kind: "doc-library", name: "本地" }, { id: "4", ref: "external-source:4", kind: "external-source", name: "外部" }], unavailable: [] })
        mocks.group.mockResolvedValue([{ id: 3, total: 7, ready: 5 }])
        const focus = { libraryId: "3" }
        const result = await readSourceStatistics(9, focus)
        expect(mocks.sources).toHaveBeenCalledWith(9, focus)
        const query = new PgDialect().sqlToQuery(mocks.where.mock.calls[0][0] as SQL)
        expect(query.sql).toContain('"user_id"')
        expect(query.sql).toContain('"library_id"')
        expect(query.params).toEqual([9, 3])
        expect(mocks.select).toHaveBeenCalledOnce()
        expect(result.rows[1].total).toBeNull()
        expect(renderSourceStatistics(result)).toContain("7 份文件，其中 5 份关键词就绪")
        expect(renderSourceStatistics(result)).toContain("帖子与回复总量未知")
    })
    it("外部单选或权限拒绝时不读取本地表", async () => {
        mocks.sources.mockResolvedValueOnce({ selected: [{ id: "4", kind: "external-source", name: "外部" }], unavailable: [] })
        await readSourceStatistics(9, undefined)
        expect(mocks.select).not.toHaveBeenCalled()
        mocks.sources.mockRejectedValueOnce(new Error("forbidden"))
        await expect(readSourceStatistics(9, undefined)).rejects.toThrow("forbidden")
        expect(mocks.select).not.toHaveBeenCalled()
    })
    it("识别数量询问，不把业务问题和操作请求归为全库计数", () => {
        for (const goal of ["这个库有多少文档？", "现在有多少篇帖子和回复", "文档库总共有多少文件"]) expect(isSourceStatisticsQuestion(goal)).toBe(true)
        for (const goal of ["如何统计文档数量？", "退货需要多少费用？", "删除多少篇文章", "文档里说有多少种翻新方法？"]) expect(isSourceStatisticsQuestion(goal)).toBe(false)
    })
})
