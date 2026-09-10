import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { DEFAULT_SITE_BRANDING, type SiteBranding } from "@/lib/site-branding"
const mock = vi.hoisted(() => ({ branding: {} as SiteBranding }))
vi.mock("@/lib/use-site-branding", () => ({ useSiteBranding: () => mock.branding }))
import { RetypesetSiteFooter, RetypesetSiteNav } from "./RetypesetSiteChrome"
import { PetrichorPage } from "../petrichor/PetrichorPage"
import { AboutPage } from "../about/AboutPage"
beforeEach(() => { mock.branding = { ...DEFAULT_SITE_BRANDING } })
describe("品牌公开渲染", () => {
    it("关于我联系方式与页脚共享品牌开关", () => {
        mock.branding = { ...DEFAULT_SITE_BRANDING, showContact: true, contactLabel: "新联系入口", contactHref: "mailto:new@example.test" }
        expect(renderToStaticMarkup(<MemoryRouter><AboutPage /></MemoryRouter>)).toContain("mailto:new@example.test")
        mock.branding.showContact = false
        expect(renderToStaticMarkup(<MemoryRouter><AboutPage /></MemoryRouter>)).not.toContain("mailto:new@example.test")
    })
    it("未加载的关于页不展示上游头像、个人简介或空引用便签", () => {
        const html = renderToStaticMarkup(<MemoryRouter><AboutPage /></MemoryRouter>)
        expect(html).not.toContain("/about-avatar.png")
        expect(html).not.toContain("Frontend Architecture")
        expect(html).not.toContain("Code is just another medium")
        expect(html).not.toContain("&quot;&quot;")
    })
    it("默认隐藏原作者邮箱与个人署名，保留软件声明", () => {
        const html = renderToStaticMarkup(<RetypesetSiteFooter dockVisible />)
        expect(html).not.toContain("zang@")
        expect(html).not.toContain("Powered by")
        expect(html).toContain("Apache-2.0")
        expect(html).toContain("/atom.xml")
    })
    it("配置后展示运营信息，文字按文本转义", () => {
        mock.branding = { ...DEFAULT_SITE_BRANDING, copyrightOwner: "Gene", maintainer: "<script>x</script>", showMaintainer: true,
            showContact: true, contactLabel: "联系", contactHref: "mailto:hello@example.test" }
        const html = renderToStaticMarkup(<RetypesetSiteFooter dockVisible />)
        expect(html).toContain("Gene")
        expect(html).toContain("mailto:hello@example.test")
        expect(html).not.toContain("<script>x")
        expect(html).toContain("站点维护")
    })
    it("项目页与导航默认不宣传，不能通过直接路由显示旧按钮", () => {
        const nav = renderToStaticMarkup(<MemoryRouter><RetypesetSiteNav activeSection="articles" dockVisible /></MemoryRouter>)
        expect(nav).not.toContain('href="/petrichor"')
        const page = renderToStaticMarkup(<MemoryRouter><PetrichorPage /></MemoryRouter>)
        expect(page).toContain("未启用项目宣传页")
        expect(page).not.toContain("一键部署")
    })
    it("开关开启且配置仓库后显示自有源码入口", () => {
        mock.branding = { ...DEFAULT_SITE_BRANDING, showProjectPage: true, showProjectActions: true, repositoryUrl: "https://example.test/my-source" }
        const page = renderToStaticMarkup(<MemoryRouter><PetrichorPage /></MemoryRouter>)
        expect(page).toContain('href="https://example.test/my-source"')
        expect(page).not.toContain('href="https://vercel.com/new/clone')
    })
})
