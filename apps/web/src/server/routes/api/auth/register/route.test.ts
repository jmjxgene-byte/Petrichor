import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AppRequest } from "@/server/http/request"

const authMocks = vi.hoisted(() => ({
    signInEmail: vi.fn(),
}))
const bridgeMocks = vi.hoisted(() => ({
    createLocalUserWithBetterAuth: vi.fn(),
}))

vi.mock("@/server/auth/better-auth", () => ({
    auth: { api: { signInEmail: authMocks.signInEmail } },
}))
vi.mock("@/server/auth/better-auth-bridge", () => bridgeMocks)
vi.mock("@/server/mappers", () => ({
    toUserResponse: (user: unknown) => user,
}))

import { POST } from "./route"

function createRequest() {
    return new AppRequest("https://example.com/api/auth/register", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200) + 1}`,
        },
        body: JSON.stringify({
            email: "member@example.com",
            name: "Member",
            password: "correct-horse-battery-staple",
        }),
    })
}

describe("POST /api/auth/register", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        process.env.PETRICHOR_REGISTRATION_MODE = "disabled"
    })

    afterEach(() => {
        process.env.PETRICHOR_REGISTRATION_MODE = "disabled"
    })

    it("服务端关闭注册时直接拒绝，不能通过调用 API 绕过前端", async () => {
        const response = await POST(createRequest(), { params: Promise.resolve({}) })

        expect(response.status).toBe(403)
        expect(await response.json()).toMatchObject({ code: 403, msg: "公开注册已关闭" })
        expect(bridgeMocks.createLocalUserWithBetterAuth).not.toHaveBeenCalled()
    })

    it("显式开放时只能创建普通用户", async () => {
        process.env.PETRICHOR_REGISTRATION_MODE = "open"
        bridgeMocks.createLocalUserWithBetterAuth.mockResolvedValue({
            id: 1,
            email: "member@example.com",
            systemRole: "USER",
        })
        authMocks.signInEmail.mockResolvedValue({
            headers: new Headers(),
            response: { token: "test-token" },
        })

        const response = await POST(createRequest(), { params: Promise.resolve({}) })

        expect(response.status).toBe(200)
        expect(bridgeMocks.createLocalUserWithBetterAuth).toHaveBeenCalledWith(expect.objectContaining({
            systemRole: "USER",
        }))
    })
})
