import { asc, eq, or } from "drizzle-orm"

import {
    assistantSourceRef,
    assistantSourceScopeFromFocus,
    type AssistantSourceCatalogItem,
    type AssistantSourceRef,
    type AssistantSourceScope,
} from "@/lib/assistant-source-contract"
import { getServerConfig } from "@/config/server"
import { getDb } from "@/server/db/client"
import { docLibraries, externalSources, knowledgeBases } from "@/server/db/schema"
import {
    GENEOPS_PREFERRED_CONTRACT_VERSION,
    isSupportedGeneOpsContractVersion,
} from "@/server/external-source/logic"
import { forbidden } from "@/server/http/response"
import type { AssistantFocus } from "./domain-types"

export type ResolvedAssistantSources = {
    scope: AssistantSourceScope
    selected: AssistantSourceCatalogItem[]
    unavailable: AssistantSourceCatalogItem[]
}

export async function listAssistantSourceCatalog(userId: number): Promise<AssistantSourceCatalogItem[]> {
    const db = getDb()
    const [kbRows, libraryRows, sourceRows] = await Promise.all([
        db.select({
            id: knowledgeBases.id,
            name: knowledgeBases.name,
            description: knowledgeBases.description,
            updatedAt: knowledgeBases.updatedAt,
        }).from(knowledgeBases)
            .where(eq(knowledgeBases.userId, userId))
            .orderBy(asc(knowledgeBases.name)),
        db.select({
            id: docLibraries.id,
            name: docLibraries.name,
            description: docLibraries.description,
            updatedAt: docLibraries.updatedAt,
        }).from(docLibraries)
            .where(eq(docLibraries.userId, userId))
            .orderBy(asc(docLibraries.name)),
        db.select({
            id: externalSources.id,
            name: externalSources.name,
            sourceType: externalSources.sourceType,
            enabled: externalSources.enabled,
            capabilitiesJson: externalSources.capabilitiesJson,
            contractVersion: externalSources.contractVersion,
            lastCheckedAt: externalSources.lastCheckedAt,
            lastCheckStatus: externalSources.lastCheckStatus,
            lastCheckMessage: externalSources.lastCheckMessage,
            updatedAt: externalSources.updatedAt,
        }).from(externalSources)
            .where(or(
                eq(externalSources.globalShared, true),
                eq(externalSources.createdByUserId, userId),
            ))
            .orderBy(asc(externalSources.name)),
    ])

    const featureEnabled = getServerConfig().geneOpsConnector.enabled
    return [
        ...kbRows.map((row): AssistantSourceCatalogItem => ({
            ref: assistantSourceRef("knowledge-base", row.id),
            kind: "knowledge-base",
            id: String(row.id),
            name: row.name,
            description: row.description,
            availability: "ready",
            selectable: true,
            unavailableReason: null,
            updatedAt: row.updatedAt.toISOString(),
            capabilities: null,
        })),
        ...libraryRows.map((row): AssistantSourceCatalogItem => ({
            ref: assistantSourceRef("doc-library", row.id),
            kind: "doc-library",
            id: String(row.id),
            name: row.name,
            description: row.description,
            availability: "ready",
            selectable: true,
            unavailableReason: null,
            updatedAt: row.updatedAt.toISOString(),
            capabilities: null,
        })),
        ...sourceRows.map((row): AssistantSourceCatalogItem => {
            const capabilities = parseCapabilities(row.capabilitiesJson)
            const quality = readRecord(capabilities?.quality_status)
            const stale = row.lastCheckedAt == null
                || Date.now() - row.lastCheckedAt.getTime() > 48 * 60 * 60 * 1_000
            let reason: string | null = null
            let selectable = true
            let availability: AssistantSourceCatalogItem["availability"] = "ready"
            if (!featureEnabled) reason = "生产功能开关未开启"
            else if (!row.enabled) reason = "数据源已停用"
            else if (!isSupportedGeneOpsContractVersion(row.contractVersion)) {
                reason = "RPC contract 不兼容"
            }
            else if (row.lastCheckStatus !== "OK") reason = row.lastCheckMessage ?? "最近连接检查未通过"
            else if (stale) reason = "连接健康检查已超过 48 小时"
            if (reason != null) {
                selectable = false
                availability = row.enabled && featureEnabled ? "degraded" : "disabled"
            } else if (row.contractVersion !== GENEOPS_PREFERRED_CONTRACT_VERSION) {
                reason = "质量契约尚未升级，仅 Exact / Fuzzy 可用"
                availability = "degraded"
            } else if (!quality) {
                reason = "质量状态缺失，仅使用已声明的检索能力"
                availability = "degraded"
            } else if (quality.stale === true) {
                reason = "质量状态已过期，仅使用已声明的检索能力"
                availability = "degraded"
            }
            return {
                ref: assistantSourceRef("external-source", row.id),
                kind: "external-source",
                id: String(row.id),
                name: row.name,
                description: "GeneOps 社区内容与知识图谱的实时只读来源",
                availability,
                selectable,
                unavailableReason: reason,
                updatedAt: row.updatedAt.toISOString(),
                capabilities: {
                    sourceType: row.sourceType,
                    allowedSources: readStringArray(capabilities?.allowed_sources),
                    searchModes: readStringArray(capabilities?.search_modes),
                    wikiReady: quality?.wiki_ready === true && quality.stale !== true,
                    graphEnabled: quality?.graph_ready === true && quality.stale !== true,
                    graphReady: quality?.graph_ready === true && quality.stale !== true,
                    qualityStale: quality?.stale === true,
                    sourceCutoffs: readStringRecord(quality?.source_cutoffs),
                    searchHashCoverage: readNumber(quality?.search_hash_coverage),
                    embeddingCoverage: readNumber(quality?.embedding_coverage),
                    semanticReplyCoverage: readNumber(quality?.semantic_reply_coverage),
                    semanticCharCoverage: readNumber(quality?.semantic_char_coverage),
                    contractVersion: row.contractVersion ?? undefined,
                    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
                },
            }
        }),
    ]
}

export async function resolveAssistantSources(
    userId: number,
    focus: AssistantFocus | null | undefined,
): Promise<ResolvedAssistantSources> {
    const scope = assistantSourceScopeFromFocus(focus)
    const catalog = await listAssistantSourceCatalog(userId)
    let scoped: AssistantSourceCatalogItem[]
    if (scope.mode === "all") {
        scoped = catalog
    } else if (scope.mode === "local") {
        scoped = catalog.filter((item) => item.kind !== "external-source")
    } else {
        const byRef = new Map<AssistantSourceRef, AssistantSourceCatalogItem>(
            catalog.map((item) => [item.ref, item]),
        )
        const missing = scope.refs.filter((ref) => !byRef.has(ref))
        if (missing.length > 0) throw forbidden("无权访问所选资料源")
        scoped = scope.refs.map((ref) => byRef.get(ref)!)
    }
    return {
        scope,
        selected: scoped.filter((item) => item.selectable),
        unavailable: scoped.filter((item) => !item.selectable),
    }
}

function parseCapabilities(value: string | null): Record<string, unknown> | null {
    if (!value) return null
    try {
        const parsed = JSON.parse(value)
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null
    } catch {
        return null
    }
}

function readStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined
    const items = value.filter((item): item is string => typeof item === "string")
    return items.length > 0 ? items : undefined
}

function readRecord(value: unknown): Record<string, unknown> | null {
    return value != null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function readStringRecord(value: unknown): Record<string, string | null> | undefined {
    const record = readRecord(value)
    if (!record) return undefined
    return Object.fromEntries(Object.entries(record).flatMap(([key, item]) => (
        typeof item === "string" || item == null ? [[key, item ?? null]] : []
    )))
}

function readNumber(value: unknown): number | undefined {
    const resolved = typeof value === "number" ? value : Number(value)
    return Number.isFinite(resolved) ? resolved : undefined
}
