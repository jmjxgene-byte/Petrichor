import { describe, expect, it } from "vitest"
import { DEFAULT_SITE_BRANDING, readSiteBranding, siteBrandingSchema, publicSiteBranding } from "./site-branding"
import { validateSiteAppearanceInput } from "../server/appearance/logic"
import { validateAboutProfileInput } from "../server/about/logic"
describe("站点品牌配置边界", () => {
    it("隐藏联系方式和署名时公开投影不暴露存档值", () => {
        const stored = { ...DEFAULT_SITE_BRANDING, contactHref: "mailto:private@example.test", contactLabel: "联系", maintainer: "存档维护者" }
        expect(publicSiteBranding(stored)).toMatchObject({ contactHref: "", contactLabel: "", maintainer: "" })
        expect(stored.contactHref).toBe("mailto:private@example.test")
        expect(publicSiteBranding({ ...stored, showContact: true }).contactHref).toBe(stored.contactHref)
    })
    it("空配置隐藏个人信息与推广入口", () => {
        expect(DEFAULT_SITE_BRANDING).toMatchObject({ showContact: false, showMaintainer: false, showProjectPage: false, contactHref: "", avatarUrl: "" })
        expect(readSiteBranding("{broken")).toEqual(DEFAULT_SITE_BRANDING)
    })
    it.each(["javascript:alert(1)", "data:text/html,x", "//evil.test", "https://user:pass@example.com", "https://a.test\n", "http://a.test"]) ("拒绝危险链接%s", value => {
        // 尾部空白会规范化，控制字符在URL内部必须拒绝。
        const link = value.endsWith("\n") ? "https://a.test/\nx" : value
        expect(siteBrandingSchema.safeParse({ repositoryUrl: link }).success).toBe(false)
    })
    it("允许站内头像、HTTPS与简单mailto", () => {
        expect(siteBrandingSchema.parse({ avatarUrl: "/custom-avatar.png", contactHref: "mailto:hello@example.test", repositoryUrl: "https://example.test/source" }).avatarUrl).toBe("/custom-avatar.png")
        expect(siteBrandingSchema.safeParse({ contactHref: "mailto:hello@example.test?bcc=other@example.test" }).success).toBe(false)
        expect(siteBrandingSchema.safeParse({ contactHref: "mailto:hello%0d%0a@example.test" }).success).toBe(false)
    })
    it("旧客户端不携带品牌时不产生覆盖值，非法管理输入拒绝", () => {
        expect(validateSiteAppearanceInput({ publicQaEnabled: false }).branding).toBeUndefined()
        expect(() => validateSiteAppearanceInput({ branding: {} })).toThrow("公开问答开关")
        expect(() => validateSiteAppearanceInput({ publicQaEnabled: false, branding: { contactHref: "javascript:x" } })).toThrow()
    })
    it("关于我允许清空介绍/技能且不回填作者，阻止恶意联系方式", () => {
        expect(validateAboutProfileInput({ displayName: "站长", expertise: [], toolkit: [], intro: "", roleTitle: "", quote: "" })).toMatchObject({ intro: "", expertise: [], contactHref: "" })
        expect(() => validateAboutProfileInput({ displayName: "站长", contactHref: "javascript:x" })).toThrow()
    })
})
