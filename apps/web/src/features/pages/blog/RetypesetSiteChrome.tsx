"use client"

import * as React from "react"
import { Github, MessageCircleQuestion, Search } from "@/components/iconimate"
import { Link } from "react-router-dom"
import { useSiteBranding } from "@/lib/use-site-branding"

import { BlogSearchDialog, useBlogSearchHotkey } from "@/components/blog-search-dialog"
import { StaticNoise } from "@/cuicui/other/creative-effects/animated-noise/static-noise"

export type RetypesetSiteActiveSection = "articles" | "tags" | "graph" | "ask" | "projects" | "petrichor" | "about"
type RetypesetSiteNavSection = RetypesetSiteActiveSection
type RetypesetSiteNavItem = {
    section: RetypesetSiteNavSection
    href: string
    label: string
    internal?: boolean
}

let retypesetScrollbarMounts = 0

const RETYPESET_SCROLLBAR_HIDDEN_CLASS = "retypeset-scrollbar-hidden"
const RETYPESET_SITE_RSS_HREF = "/atom.xml"

const retypesetSiteCopy = {
    siteTitle: "Petrichor",
    siteSubtitle: "Knowledge, Articles & Inspiration",
    navLabel: "站点导航",
    navPosts: "文章",
    navGraph: "星图",
    navAsk: "问答",
    navProjects: "开源",
    navPetrichor: "项目",
    navAbout: "关于",
    searchTrigger: "搜索文章",
    githubTrigger: "GitHub 仓库",
} as const


const retypesetSiteNavItems: RetypesetSiteNavItem[] = [
    { section: "articles", href: "/#articles", label: retypesetSiteCopy.navPosts, internal: true },
    // 标签页不进导航栏（仍保留 /tags 路由，由文章标签与图谱标签节点跳入）
    { section: "graph", href: "/graph", label: retypesetSiteCopy.navGraph, internal: true },
    { section: "projects", href: "/projects", label: retypesetSiteCopy.navProjects, internal: true },
    { section: "petrichor", href: "/petrichor", label: retypesetSiteCopy.navPetrichor, internal: true },
    { section: "about", href: "/about", label: retypesetSiteCopy.navAbout, internal: true },
] as const

function getDockVisibilityClass(dockVisible: boolean) {
    return dockVisible ? "lg:opacity-100" : "lg:pointer-events-none lg:opacity-0"
}

function getCopyrightYearRange(startYear: number | null) {
    const currentYear = new Date().getFullYear()
    return !startYear || startYear >= currentYear ? `${currentYear}` : `${startYear}-${currentYear}`
}

function getChromeLinkClassName(active: boolean) {
    return active
        ? "retypeset-highlight-static retypeset-c-primary font-bold"
        : "retypeset-highlight-hover transition-colors hover:font-bold"
}

function useRetypesetScrollbarVisibility() {
    React.useLayoutEffect(() => {
        const root = document.documentElement
        const body = document.body
        retypesetScrollbarMounts += 1
        root.classList.add(RETYPESET_SCROLLBAR_HIDDEN_CLASS)
        body.classList.add(RETYPESET_SCROLLBAR_HIDDEN_CLASS)

        return () => {
            retypesetScrollbarMounts = Math.max(0, retypesetScrollbarMounts - 1)

            if (retypesetScrollbarMounts === 0) {
                root.classList.remove(RETYPESET_SCROLLBAR_HIDDEN_CLASS)
                body.classList.remove(RETYPESET_SCROLLBAR_HIDDEN_CLASS)
            }
        }
    }, [])
}

export function RetypesetSiteHeader({ dockVisible }: { dockVisible: boolean }) {
    const branding = useSiteBranding()
    useRetypesetScrollbarVisibility()
    const dockVisibilityClass = getDockVisibilityClass(dockVisible)

    return (
        <div className="retypeset-home contents">
            {/* 噪点纹理：与后台右侧内容区（SidebarInset）同一组件、同一档透明度，
                前台整页铺满故改为 fixed。头部在每个公开页都渲染，挂这里即全站覆盖。 */}
            <StaticNoise opacity={0.08} className="fixed" />

            <header
                className={`${dockVisibilityClass} retypeset-c-secondary mb-[2.625rem] transition-opacity duration-150 lg:fixed lg:right-[max(5rem,calc(50vw-35rem))] lg:top-20 lg:z-30 lg:mb-0 lg:w-56`}
            >
                <h1 className="retypeset-font-title retypeset-c-primary mb-[0.45rem] w-3/4 break-words text-[2rem] font-bold leading-none lg:w-full lg:text-4xl">
                    <span className="box-content inline-block pr-1">
                        <Link id="site-title-link" to="/#articles">
                            {branding.title}
                        </Link>
                    </span>
                </h1>
                {branding.subtitle ? <h2 className="retypeset-font-navbar w-3/4 break-words text-sm leading-snug lg:w-full lg:text-base">
                    {branding.subtitle}
                </h2> : null}
            </header>
        </div>
    )
}

export function RetypesetSiteNav({
    activeSection,
    dockVisible,
}: {
    activeSection: RetypesetSiteActiveSection
    dockVisible: boolean
}) {
    const branding = useSiteBranding()
    const dockVisibilityClass = getDockVisibilityClass(dockVisible)
    const [searchOpen, setSearchOpen] = React.useState(false)
    const openSearch = React.useCallback(() => setSearchOpen(true), [])
    useBlogSearchHotkey(openSearch)

    return (
        <div className="retypeset-home contents">
            <nav
                aria-label={retypesetSiteCopy.navLabel}
                className={`${dockVisibilityClass} retypeset-font-navbar mb-[2.625rem] text-[0.9rem] font-semibold leading-[2.45em] transition-opacity duration-150 lg:fixed lg:right-[max(5rem,calc(50vw-35rem))] lg:bottom-[min(calc(9.04rem+3.85vw),12.5rem)] lg:z-30 lg:mb-0 lg:w-56 lg:text-base`}
            >
                <ul>
                    {retypesetSiteNavItems.filter(item => item.section !== "petrichor" || branding.showProjectPage).map((item) => {
                        const active = item.section === activeSection
                        const className = getChromeLinkClassName(active)

                        return (
                            <li key={item.href}>
                                {item.internal ? (
                                    <Link className={className} to={item.href}>
                                        {item.label}
                                    </Link>
                                ) : (
                                    <a className={className} href={item.href}>
                                        {item.label}
                                    </a>
                                )}
                            </li>
                        )
                    })}
                </ul>
                <div className="mt-3 flex items-center gap-3 lg:mt-4">
                    <button
                        type="button"
                        onClick={openSearch}
                        aria-label={retypesetSiteCopy.searchTrigger}
                        title={retypesetSiteCopy.searchTrigger}
                        className="retypeset-c-secondary inline-flex size-7 cursor-pointer items-center justify-center rounded-full"
                    >
                        <Search className="size-4" aria-hidden="true" />
                        <span className="sr-only">{retypesetSiteCopy.searchTrigger}</span>
                    </button>
                    <Link
                        to="/ask"
                        aria-label={retypesetSiteCopy.navAsk}
                        aria-current={activeSection === "ask" ? "page" : undefined}
                        title={retypesetSiteCopy.navAsk}
                        className={`${activeSection === "ask" ? "retypeset-c-primary" : "retypeset-c-secondary"} inline-flex size-7 cursor-pointer items-center justify-center rounded-full transition-colors`}
                    >
                        <MessageCircleQuestion className="size-4" aria-hidden="true" />
                        <span className="sr-only">{retypesetSiteCopy.navAsk}</span>
                    </Link>
                    {branding.repositoryUrl ? <a
                        href={branding.repositoryUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={retypesetSiteCopy.githubTrigger}
                        title={retypesetSiteCopy.githubTrigger}
                        className="retypeset-c-secondary inline-flex size-7 cursor-pointer items-center justify-center rounded-full"
                    >
                        <Github className="size-4" aria-hidden="true" />
                        <span className="sr-only">{retypesetSiteCopy.githubTrigger}</span>
                    </a> : null}
                </div>
            </nav>
            <BlogSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
        </div>
    )
}

export function RetypesetSiteFooter({ dockVisible }: { dockVisible: boolean }) {
    const branding = useSiteBranding()
    const dockVisibilityClass = getDockVisibilityClass(dockVisible)
    const year = getCopyrightYearRange(branding.startYear)

    return (
        <div className="retypeset-home contents">
            <footer
                className={`${dockVisibilityClass} retypeset-font-navbar text-xs leading-[1.25em] transition-opacity duration-150 lg:fixed lg:right-[max(5rem,calc(50vw-35rem))] lg:bottom-20 lg:z-30 lg:w-56 lg:text-sm`}
            >
                <p>
                    <a className="retypeset-highlight-hover retypeset-footer-link py-[0.2rem] transition-colors" href={RETYPESET_SITE_RSS_HREF}>
                        RSS
                    </a>
                    {branding.showContact && branding.contactHref && branding.contactLabel ? <> / <a
                        className="retypeset-highlight-hover retypeset-footer-link py-[0.2rem] transition-colors"
                        href={branding.contactHref}
                    >
                        {branding.contactLabel}
                    </a></> : null}
                </p>
                <p>© {year} {branding.copyrightOwner || branding.title}</p>
                {branding.showMaintainer && branding.maintainer ? <p>站点维护：{branding.maintainer}</p> : null}
                <p><a href="https://github.com/Ciao1019/Petrichor/blob/master/LICENSE" target="_blank" rel="noopener noreferrer">Petrichor · Apache-2.0</a></p>
            </footer>
        </div>
    )
}
