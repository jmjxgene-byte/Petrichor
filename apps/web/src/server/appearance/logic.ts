import type { SiteAppearanceRecord } from "@/server/db/schema"
import { readSiteBranding, siteBrandingSchema, type SiteBranding } from "@/lib/site-branding"
import { badRequest } from "@/server/http/response"
import {
    DEFAULT_RETYPESET_APPEARANCE,
    type RetypesetAppearanceConfig,
} from "@/lib/retypeset-themes"

export const SITE_APPEARANCE_ID = 1

export interface SiteAppearanceResponse extends RetypesetAppearanceConfig {
    branding: SiteBranding
    createdAt: string | null
    updatedAt: string | null
}

export function buildSiteAppearanceResponse(record?: Omit<SiteAppearanceRecord, "brandingJson"> & { brandingJson?: string } | null): SiteAppearanceResponse {
    if (!record) {
        return {
            ...DEFAULT_RETYPESET_APPEARANCE,
            branding: readSiteBranding(null),
            createdAt: null,
            updatedAt: null,
        }
    }
    return {
        branding: readSiteBranding(record.brandingJson),
        publicQaEnabled: record.publicQaEnabled ?? DEFAULT_RETYPESET_APPEARANCE.publicQaEnabled,
        createdAt: formatDate(record.createdAt),
        updatedAt: formatDate(record.updatedAt),
    }
}

export function validateSiteAppearanceInput(raw: unknown): RetypesetAppearanceConfig & { branding?: SiteBranding } {
    const value = isRecord(raw) ? raw : {}
    if (value.branding !== undefined && typeof value.publicQaEnabled !== "boolean") {
        throw badRequest("保存品牌时必须显式保留公开问答开关")
    }
    const publicQaEnabled =
        typeof value.publicQaEnabled === "boolean"
            ? value.publicQaEnabled
            : DEFAULT_RETYPESET_APPEARANCE.publicQaEnabled

    if (value.branding === undefined) return { publicQaEnabled }
    const branding = siteBrandingSchema.safeParse(value.branding)
    if (!branding.success) throw badRequest("站点品牌配置无效，请检查必填项、年份及链接协议")
    return { publicQaEnabled, branding: branding.data }
}

function formatDate(value: Date | string | null | undefined) {
    if (!value) return null
    const date = value instanceof Date ? value : new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
