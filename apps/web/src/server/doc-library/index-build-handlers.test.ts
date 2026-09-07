import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ user: vi.fn(), prepare: vi.fn(), verify: vi.fn(), create: vi.fn(), policy: vi.fn(), read: vi.fn(), provider: vi.fn(), activate: vi.fn() }))
vi.mock("@/server/auth/current-user", () => ({ requireCurrentUser: mocks.user }))
vi.mock("@/server/db/client", () => ({ isSqliteDatabase: () => false }))
vi.mock("@/config/server", () => ({ getServerConfig: () => ({ sessionSecret: "synthetic-only-signing-key-32-characters" }) }))
vi.mock("./index-quote", () => ({ prepareDocumentIndexQuote: mocks.prepare, verifyIndexQuote: mocks.verify }))
vi.mock("./index-store", () => ({ createDocumentIndexGeneration: mocks.create }))
vi.mock("./index-provider", () => ({ resolveDocumentIndexQuotePolicy: mocks.policy, resolveDocumentIndexProvider: mocks.provider }))
vi.mock("@/server/db/read-budget", () => ({ withReadBudget: mocks.read }))
vi.mock("./index-complete", () => ({ activateDocumentIndexGeneration: mocks.activate }))
import { AppRequest } from "@/server/http/request"
import { quoteDocumentIndex, buildDocumentIndex, activateDocumentIndex } from "./index-build-handlers"
import { hashDocumentText } from "./passage-builder"
const req = (body: unknown) => new AppRequest("https://example.invalid/api/doc-library/index/build", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("PETRICHOR_DOC_INDEX_ENABLED", "true"); mocks.user.mockResolvedValue({ id: 7 }) })
afterEach(() => vi.unstubAllEnvs())
describe("报价与显式构建入口", () => {
    it("启用必须明确确认，且目标不可见时不解析provider", async () => {
        expect((await activateDocumentIndex(req({ generationId: 3, manifestHash: "a".repeat(64) }))).status).toBe(400)
        expect(mocks.read).not.toHaveBeenCalled()
        mocks.read.mockResolvedValueOnce([])
        expect((await activateDocumentIndex(req({ generationId: 3, manifestHash: "a".repeat(64), confirm: true }))).status).toBe(404)
        expect(mocks.provider).not.toHaveBeenCalled(); expect(mocks.activate).not.toHaveBeenCalled()
    })
    it("启用只使用服务端核验的profile与当前用户", async () => {
        const profile = { modelRefId: 1, model: "fixture", dimensions: 2, version: 1, key: "fixture" }
        mocks.read.mockResolvedValueOnce([{ profile: JSON.stringify(profile) }])
        mocks.provider.mockResolvedValueOnce({ profile })
        mocks.activate.mockResolvedValueOnce({ generationId: 3, manifestHash: "a".repeat(64) })
        expect((await activateDocumentIndex(req({ generationId: 3, manifestHash: "a".repeat(64), confirm: true }))).status).toBe(200)
        expect(mocks.activate).toHaveBeenCalledWith({ userId: 7, generationId: 3, manifestHash: "a".repeat(64), profile })
    })
    it("开关关闭不读取文件或创建任务", async () => {
        vi.stubEnv("PETRICHOR_DOC_INDEX_ENABLED", "false")
        expect((await quoteDocumentIndex(req({ libraryId: 2 }))).status).toBe(403)
        expect(mocks.prepare).not.toHaveBeenCalled()
    })
    it("没有明确确认不校验报价或创建任务", async () => {
        expect((await buildDocumentIndex(req({ libraryId: 2, token: "fixture" }))).status).toBe(400)
        expect(mocks.verify).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled()
    })
    it("只使用签名内容及当前用户，不接受客户端预算", async () => {
        const profile = { key: "fixture" }, policy = { marker: "fixture" }, documents = [{ documentId: 1 }], approval = { approvalId: "fixture" }
        mocks.verify.mockReturnValue({ profile, policyHash: hashDocumentText(JSON.stringify(policy)), documents, approval })
        mocks.policy.mockResolvedValue({ profile, policy }); mocks.create.mockResolvedValue({ id: 3, status: "building" })
        const result = await buildDocumentIndex(req({ libraryId: 2, token: "fixture", confirm: true }))
        expect(await result.json()).toEqual({ generationId: "3", status: "building" })
        expect(mocks.create).toHaveBeenCalledWith({ userId: 7, libraryId: 2, documents, profile, approval })
    })
    it("报价后模型变化不创建任务", async () => {
        mocks.verify.mockReturnValue({ profile: { key: "old" }, policyHash: "a".repeat(64) })
        mocks.policy.mockResolvedValue({ profile: { key: "new" }, policy: {} })
        expect((await buildDocumentIndex(req({ libraryId: 2, token: "fixture", confirm: true }))).status).toBe(400)
        expect(mocks.create).not.toHaveBeenCalled()
    })
})
