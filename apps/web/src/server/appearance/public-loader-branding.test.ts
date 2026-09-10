import { beforeEach, describe, expect, it, vi } from "vitest"
const mocked = vi.hoisted(() => ({ limit: vi.fn() }))
vi.mock("@/server/db/client", () => ({ getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: mocked.limit }) }) }) }) }))
vi.mock("@/server/public-content-cache", () => ({ cachePublicContent: (_key: string, fn: unknown) => fn }))
import { loadSiteAppearanceOrNull } from "./public-loader"
beforeEach(() => mocked.limit.mockReset())
describe("品牌字段迁移兼容", () => {
    it("缺少新列保留旧问答关闭状态，不默认开启", async () => {
        mocked.limit.mockRejectedValueOnce({ code: "42703", message: "branding_json does not exist" }).mockResolvedValueOnce([{ id: 1, publicQaEnabled: false }])
        expect(await loadSiteAppearanceOrNull()).toEqual({ id: 1, publicQaEnabled: false, brandingJson: "{}" })
    })
    it("权限错误不能冒充未迁移", async () => {
        mocked.limit.mockRejectedValueOnce({ code: "42501", message: "permission denied branding_json" })
        await expect(loadSiteAppearanceOrNull()).rejects.toMatchObject({ code: "42501" })
        expect(mocked.limit).toHaveBeenCalledOnce()
    })
})
