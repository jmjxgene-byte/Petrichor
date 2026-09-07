import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ user: vi.fn(), read: vi.fn() }))
vi.mock("@/server/auth/current-user", () => ({ requireCurrentUser: mocks.user }))
vi.mock("./index-retrieval", () => ({ readDocumentIndexPassage: mocks.read }))
vi.mock("./index-handlers", async () => {
    const { HttpError, toErrorResponse } = await import("@/server/http/response")
    const { ZodError } = await import("zod")
    return { safeError: (error: unknown) => toErrorResponse(error instanceof HttpError || error instanceof ZodError ? error : new HttpError(503, "引用不可用"), "/citation") }
})
import { readDocumentCitation } from "./citation-handlers"
import { AppRequest } from "@/server/http/request"
const input = { libraryId: "2", documentId: "3", generationId: "4", passageId: "5", contentHash: "a".repeat(64) }
const req = (body: unknown) => new AppRequest("https://example.invalid/citation", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })
beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 7 }) })
describe("引用只读接口", () => {
    it("使用登录用户与完整锚点，返回白名单而非数据库行", async () => {
        const position = { sourceHash: "b".repeat(64), contentHash: input.contentHash, startOffset: 100, endOffset: 102 }
        mocks.read.mockResolvedValue({ title: "合成", content: "前命中后", anchorStart: 1, anchorEnd: 3, sourceFormat: "raw_markdown", anchor: { ...position, embedding: [1, 2] } })
        const response = await readDocumentCitation(req(input))
        expect(await response.json()).toEqual({ title: "合成", content: "前命中后", anchorStart: 1, anchorEnd: 3, sourceAnchor: { ...position, sourceFormat: "raw_markdown" } })
        expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, libraryId: 2, documentId: 3, generationId: 4, passageId: 5, contentHash: input.contentHash }))
    })
    it("缺少hash或伪造用户字段不得读取", async () => {
        expect((await readDocumentCitation(req({ ...input, contentHash: undefined }))).status).toBe(400)
        expect((await readDocumentCitation(req({ ...input, userId: 8 }))).status).toBe(400)
        expect(mocks.read).not.toHaveBeenCalled()
    })
    it("失效不返回任何替代正文", async () => {
        mocks.read.mockRejectedValue(new Error("private_database_error"))
        const response = await readDocumentCitation(req(input))
        expect(response.status).toBe(503)
        expect(await response.text()).not.toContain("private_database_error")
    })
})
