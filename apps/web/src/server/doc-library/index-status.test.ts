import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ reader: null as unknown }))
vi.mock("@/server/db/client", () => ({ isSqliteDatabase: () => false }))
vi.mock("@/server/db/read-budget", () => ({ withReadBudget: async (run: (reader: unknown, checkpoint: () => Promise<void>) => Promise<unknown>) => run(mocks.reader, async () => {}) }))
import { getDocumentIndexStatus } from "./index-status"
import { prepareIndexManifest } from "./index-contract"
const date = new Date(0)
const prepared = prepareIndexManifest([{ documentId: 1, sourceHash: "a".repeat(64), updatedAt: date.toISOString() }], { modelRefId: 1, model: "fixture", dimensions: 2, version: 1, key: "fixture" })
const generation = { id: 3, status: "ready", expectedDocuments: 1, completedDocuments: 1, passageCount: 2,
    manifestJson: JSON.stringify(prepared.manifest), manifestHash: prepared.manifestHash, errorCode: null, updatedAt: date }
function fixture(results: unknown[][]) {
    let index = 0
    const select = vi.fn(() => {
        const rows = results[index++] ?? []
        const chain = { from: () => chain, where: () => chain, limit: () => chain, orderBy: () => chain,
            then: <T>(resolve: (rows: unknown[]) => T) => Promise.resolve(rows).then(resolve) }
        return chain
    })
    mocks.reader = { select }; return select
}
beforeEach(() => { vi.stubEnv("PETRICHOR_DOC_INDEX_ENABLED", "true"); vi.stubEnv("PETRICHOR_DOC_HYBRID_ENABLED", "false") })
afterEach(() => vi.unstubAllEnvs())
describe("安全索引状态", () => {
    it("已构建但未激活的generation不误显示成尚未构建", async () => {
        fixture([[{ id: 2 }], [{ count: 1 }], [generation], []])
        expect(await getDocumentIndexStatus(7, 2)).toMatchObject({ phase: "ready_to_activate", currentReady: false })
    })
    it("关闭开关只查归属和关键词计数，不读索引表", async () => {
        vi.stubEnv("PETRICHOR_DOC_INDEX_ENABLED", "false")
        const select = fixture([[{ id: 2 }], [{ count: 21 }]])
        expect(await getDocumentIndexStatus(7, 2)).toMatchObject({ phase: "disabled", keywordDocuments: 21, current: null })
        expect(select).toHaveBeenCalledTimes(2)
    })
    it("跨用户不可见库不返回进度", async () => {
        fixture([[]]); await expect(getDocumentIndexStatus(7, 2)).rejects.toThrow("无权访问")
    })
    it("最新构建失败和旧current仍有效分别表示，不返回manifest或正文", async () => {
        fixture([[{ id: 2 }], [{ count: 1 }], [{ ...generation, id: 4, status: "failed", errorCode: "untrusted sensitive error" }], [generation], [{ id: 1, updatedAt: date }]])
        const result = await getDocumentIndexStatus(7, 2)
        expect(result).toMatchObject({ phase: "failed", currentReady: true, latest: { errorCode: "index_failed" } })
        expect(JSON.stringify(result)).not.toContain("manifestJson")
        expect(JSON.stringify(result)).not.toContain("sensitive")
    })
    it("新增文档使current失效，不能标记语义ready", async () => {
        fixture([[{ id: 2 }], [{ count: 2 }], [generation], [generation], [{ id: 1, updatedAt: date }, { id: 2, updatedAt: date }]])
        expect(await getDocumentIndexStatus(7, 2)).toMatchObject({ phase: "stale", currentReady: false, hybridConfigured: false })
    })
})
