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
            const stale = row.lastCheckedAt == null
                || Date.now() - row.lastCheckedAt.getTime() > 48 * 60 * 60 * 1_000
            let reason: string | null = null
            if (!featureEnabled) reason = "生产功能开关未开启"
            else if (!row.enabled) reason = "数据源已停用"
            else if (row.contractVersion !== 1) reason = "RPC contract 不兼容"
            else if (row.lastCheckStatus !== "OK") reason = row.lastCheckMessage ?? "最近连接检查未通过"
            else if (stale) reason = "连接健康检查已超过 48 小时"
            const availability = reason == null
                ? "ready" as const
                : row.enabled && featureEnabled
                    ? "degraded" as const
                    : "disabled" as const
            return {
                ref: assistantSourceRef("external-source", row.id),
                kind: "external-source",
                id: String(row.id),
                name: row.name,
                description: "GeneOps 社区内容与知识图谱的实时只读来源",
                availability,
                selectable: availability === "ready",
                unavailableReason: reason,
                updatedAt: row.updatedAt.toISOString(),
                capabilities: {
                    sourceType: row.sourceType,
                    allowedSources: readStringArray(capabilities?.allowed_sources),
                    searchModes: readStringArray(capabilities?.search_modes),
                    graphEnabled: capabilities?.graph_enabled === true,
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
