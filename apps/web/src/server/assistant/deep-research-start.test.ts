import { beforeEach, describe, expect, it, vi } from "vitest"
import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
const mocks = vi.hoisted(() => ({ rows: [] as unknown[][], where: vi.fn(), sources: vi.fn(), create: vi.fn() }))
vi.mock("@/config/server", () => ({ getServerConfig: () => ({ deepResearch: { enabled: true, workerEnabled: true } }) }))
vi.mock("@/server/auth/current-user", () => ({ requireCurrentUser: async () => ({ id: 7 }) }))
vi.mock("@/server/db/client", () => ({ getDb: () => ({ select: () => ({ from: () => ({ where: (condition: unknown) => { mocks.where(condition); return { limit: async () => mocks.rows.shift() ?? [] } } }) }) }) }))
vi.mock("./source-catalog", () => ({ resolveAssistantSources: mocks.sources }))
vi.mock("./deep-research-contract", () => ({ buildDeepResearchSourceScopeHash: () => "fixture", buildDeepResearchCapabilitySnapshot: () => ({ capturedAt: "synthetic" }) }))
vi.mock("./deep-research-job-store", () => ({ createDeepResearchJob: mocks.create, toDeepResearchJobResponse: (job: unknown) => job, getDeepResearchJob: vi.fn(), requestDeepResearchJobCancellation: vi.fn() }))
import { AppRequest } from "@/server/http/request"
import { startDeepResearch, cancelDeepResearch } from "./deep-research-handlers"
const request = (fastRunKey?: string) => new AppRequest("https://example.invalid/api/assistant/deep-research/start", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: 11, questionMessageId: 22, fastRunKey }),
})
beforeEach(() => {
    vi.clearAllMocks()
    mocks.rows = [[{ id: 11, focusJson: null }], [{ id: 22 }]]
    mocks.sources.mockResolvedValue({ selected: [{ id: "1" }] })
    mocks.create.mockResolvedValue({ runKey: "fixture", status: "queued" })
})
describe("Deep启动关联归属", () => {
    it.each(['{"questionMessageId":"23"}', "{}", "{broken"])("同会话错误轮次或缺少可靠关联不能创建任务：%s", async (metricsJson) => {
        mocks.rows.push([{ id: 33, metricsJson }])
        expect((await startDeepResearch(request("own-run"))).status).toBe(400)
        expect(mocks.sources).not.toHaveBeenCalled()
        expect(mocks.create).not.toHaveBeenCalled()
    })
    it.each(["{broken", '{"sourceScope":{"mode":"unknown"}}'])("损坏范围不回落到本地全范围：%s", async (focusJson) => {
        mocks.rows[0] = [{ id: 11, focusJson }]
        expect((await startDeepResearch(request())).status).toBe(400)
        expect(mocks.sources).not.toHaveBeenCalled()
        expect(mocks.create).not.toHaveBeenCalled()
    })
    it("跨域启动和取消在业务访问前拒绝", async () => {
        for (const handler of [startDeepResearch, cancelDeepResearch]) {
            const input = new AppRequest("https://example.invalid/api/deep", { method: "POST", headers: { origin: "https://other.invalid", "sec-fetch-site": "same-site", "content-type": "application/json" }, body: "{}" })
            expect((await handler(input)).status).toBe(403)
        }
        expect(mocks.where).not.toHaveBeenCalled()
        expect(mocks.create).not.toHaveBeenCalled()
    })
    it("关联Run不可见时不解析数据源、不创建Job", async () => {
        mocks.rows.push([])
        expect((await startDeepResearch(request("foreign-run"))).status).toBe(404)
        expect(mocks.sources).not.toHaveBeenCalled()
        expect(mocks.create).not.toHaveBeenCalled()
    })
    it("Run关联查询同时约束用户、会话与旧记录兼容路径", async () => {
        mocks.rows.push([{ id: 33, metricsJson: '{"questionMessageId":"22"}' }])
        expect((await startDeepResearch(request("own-run"))).status).toBe(200)
        const query = new PgDialect().sqlToQuery(mocks.where.mock.calls[2][0] as SQL)
        expect(query.sql).toContain('"user_id"')
        expect(query.sql).toContain('"thread_id"')
        expect(query.sql).toContain('"conversation_id"')
        expect(query.params).toEqual(["own-run", 7, 11, "11"])
        expect(mocks.create).toHaveBeenCalledOnce()
    })
    it("未指定fastRun仍可按已验证的问题发起任务", async () => {
        expect((await startDeepResearch(request())).status).toBe(200)
        expect(mocks.where).toHaveBeenCalledTimes(2)
        expect(mocks.create).toHaveBeenCalledOnce()
    })
})
