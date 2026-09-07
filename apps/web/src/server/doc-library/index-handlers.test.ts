import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ user: vi.fn(), status: vi.fn(), cancel: vi.fn() }))
vi.mock("@/server/auth/current-user", () => ({ requireCurrentUser: mocks.user }))
vi.mock("./index-status", () => ({ getDocumentIndexStatus: mocks.status }))
vi.mock("./index-jobs", () => ({ cancelDocumentIndexGeneration: mocks.cancel }))
import { AppRequest } from "@/server/http/request"
import { unauthorized } from "@/server/http/response"
import { documentIndexStatus, cancelDocumentIndex } from "./index-handlers"
const request = (body: unknown) => new AppRequest("https://example.invalid/api/doc-library/index/status", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })
beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 7 }) })
describe("索引状态与取消HTTP", () => {
    it("跨域取消请求在写入前被拒绝", async () => {
        const req = request({ generationId: 3 })
        req.headers.set("origin", "https://untrusted.invalid")
        expect((await cancelDocumentIndex(req)).status).toBe(403)
        expect(mocks.cancel).not.toHaveBeenCalled()
    })
    it("未登录不执行状态查询", async () => {
        mocks.user.mockRejectedValueOnce(unauthorized())
        expect((await documentIndexStatus(request({ libraryId: 2 }))).status).toBe(401)
        expect(mocks.status).not.toHaveBeenCalled()
    })
    it("客户端不能覆盖userId", async () => {
        expect((await documentIndexStatus(request({ libraryId: 2, userId: 8 }))).status).toBe(400)
        expect(mocks.status).not.toHaveBeenCalled()
    })
    it("状态传入当前用户与请求取消信号", async () => {
        mocks.status.mockResolvedValueOnce({ libraryId: "2", phase: "disabled" })
        const req = request({ libraryId: "2" })
        expect((await documentIndexStatus(req)).status).toBe(200)
        expect(mocks.status).toHaveBeenCalledWith(7, 2, req.signal)
    })
    it("取消只作用于当前用户且不输出完整generation", async () => {
        mocks.cancel.mockResolvedValueOnce({ id: 3, manifestJson: "private" })
        const response = await cancelDocumentIndex(request({ generationId: 3 }))
        expect(mocks.cancel).toHaveBeenCalledWith(7, 3)
        expect(await response.json()).toEqual({ generationId: "3", status: "cancelled" })
    })
    it("未知数据库错误不回显", async () => {
        mocks.status.mockRejectedValueOnce(new Error("private connection error"))
        const response = await documentIndexStatus(request({ libraryId: 2 }))
        expect(response.status).toBe(503)
        expect(await response.text()).not.toContain("private")
    })
})
