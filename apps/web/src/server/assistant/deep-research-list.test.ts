import { beforeEach, describe, expect, it, vi } from "vitest"
import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
const mocks = vi.hoisted(() => ({ rows: [] as unknown[][], predicates: [] as unknown[], worker: false }))
vi.mock("@/server/auth/current-user", () => ({ requireCurrentUser: async () => ({ id: 7 }) }))
vi.mock("@/config/server", () => ({ getServerConfig: () => ({ deepResearch: { enabled: true, workerEnabled: mocks.worker } }) }))
vi.mock("@/server/db/client", () => ({ getDb: () => ({ select: () => {
    const chain = { from: () => chain, where: (value: unknown) => { mocks.predicates.push(value); return chain }, orderBy: () => chain, limit: async () => mocks.rows.shift() ?? [] }
    return chain
} }) }))
import { listThreadDeepResearch } from "./deep-research-handlers"
import { AppRequest } from "@/server/http/request"
const request = () => new AppRequest("https://example.invalid/api/assistant/deep-research/list", { method: "POST", headers: { "content-type": "application/json" }, body: '{"threadId":11}' })
beforeEach(() => { mocks.rows = []; mocks.predicates = []; mocks.worker = false })
describe("Deep会话任务发现", () => {
    it("不属于用户或已删除的会话不查询任务", async () => {
        expect((await listThreadDeepResearch(request())).status).toBe(404)
        expect(mocks.predicates).toHaveLength(1)
        expect(new PgDialect().sqlToQuery(mocks.predicates[0] as SQL).params).toEqual([11, 7])
    })
    it("按用户和会话限制任务，关闭Worker时仍可恢复历史状态", async () => {
        mocks.rows = [[{ id: 11 }], []]
        const response = await listThreadDeepResearch(request())
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ enabled: false, jobs: [], sourceScope: { mode: "local" }, sourceScopeHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
        expect(new PgDialect().sqlToQuery(mocks.predicates[1] as SQL).params).toEqual([7, 11])
    })
})
