import { z } from "zod"

const link = (kind: "image" | "contact" | "web") => z.string().trim().max(500).refine(value => {
    if (!value) return true
    if (/[\\\u0000-\u0020]/.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return false
    if (value.startsWith("/") && !value.startsWith("//")) return kind === "image"
    try {
        const url = new URL(value)
        if (url.username || url.password) return false
        if (kind === "contact" && url.protocol === "mailto:") return /^[^?@]+@[^?@]+$/.test(url.pathname) && !url.search && !url.hash
        return url.protocol === "https:"
    } catch { return false }
}, "请输入 HTTPS 地址（头像也支持站内路径，联系方式支持 mailto），不得包含账号密码")

export const siteBrandingSchema = z.object({
    title: z.string().trim().min(1).max(100).default("Petrichor"),
    subtitle: z.string().trim().max(200).default(""),
    copyrightOwner: z.string().trim().max(100).default(""),
    startYear: z.number().int().min(1900).max(2100).nullable().default(null),
    contactLabel: z.string().trim().max(80).default(""),
    contactHref: link("contact").default(""),
    repositoryUrl: link("web").default(""),
    avatarUrl: link("image").default(""),
    maintainer: z.string().trim().max(100).default(""),
    showContact: z.boolean().default(false),
    showMaintainer: z.boolean().default(false),
    showProjectPage: z.boolean().default(false),
    showProjectActions: z.boolean().default(false),
}).strict()
export type SiteBranding = z.infer<typeof siteBrandingSchema>
export const DEFAULT_SITE_BRANDING = siteBrandingSchema.parse({})
export function readSiteBranding(raw: unknown): SiteBranding {
    try { return siteBrandingSchema.parse(typeof raw === "string" ? JSON.parse(raw) : raw ?? {}) }
    catch { return DEFAULT_SITE_BRANDING }
}
