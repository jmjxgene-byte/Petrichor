import { describe, expect, it } from "vitest"
import { requirePublicRegistrationEnabled, resolveRegistrationMode } from "./register-policy"

describe("register policy", () => {
    it("默认关闭公开注册", () => {
        expect(resolveRegistrationMode({})).toBe("disabled")
        expect(() => requirePublicRegistrationEnabled({})).toThrow("公开注册已关闭")
    })

    it("只在服务端明确配置 open 时开放", () => {
        expect(resolveRegistrationMode({
            PETRICHOR_REGISTRATION_MODE: "open",
        })).toBe("open")
        expect(() => requirePublicRegistrationEnabled({
            PETRICHOR_REGISTRATION_MODE: "open",
        })).not.toThrow()
    })

    it("兼容环境变量大小写和首尾空格", () => {
        expect(resolveRegistrationMode({
            PETRICHOR_REGISTRATION_MODE: " OPEN ",
        })).toBe("open")
    })

    it("非法注册模式会失败，避免误开放", () => {
        expect(() => resolveRegistrationMode({
            PETRICHOR_REGISTRATION_MODE: "bootstrap",
        })).toThrow("PETRICHOR_REGISTRATION_MODE")
    })
})
