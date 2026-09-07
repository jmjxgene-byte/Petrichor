import { and, desc, eq, sql } from "drizzle-orm"
import { isSqliteDatabase } from "@/server/db/client"
import { withReadBudget } from "@/server/db/read-budget"
import { docLibraries, docDocuments, docIndexGenerations } from "@/server/db/schema"
import { notFound } from "@/server/http/response"
import type { DocumentIndexStatus, DocumentIndexGenerationView } from "@/lib/document-index-types"
import { parseStoredIndexManifest } from "./index-contract"
import { parseIndexProviderPolicies } from "./index-provider"

type Generation = typeof docIndexGenerations.$inferSelect
const safeCodes = new Set(["source_changed", "model_failed", "validation_failed", "budget_exceeded", "model_outcome_unknown", "cancelled", "lease_exhausted"])
function view(row: Generation | undefined): DocumentIndexGenerationView | null {
    return row ? { id: String(row.id), status: row.status, expectedDocuments: row.expectedDocuments,
        completedDocuments: row.completedDocuments, passageCount: row.passageCount, manifestHash: row.manifestHash,
        errorCode: row.errorCode ? safeCodes.has(row.errorCode) ? row.errorCode : "index_failed" : null,
        updatedAt: row.updatedAt.toISOString() } : null
}

/** 查看状态不解析原文、不解密凭证、不调用provider；configured不代表进程健康或网络连通。 */
export async function getDocumentIndexStatus(userId: number, libraryId: number, abortSignal?: AbortSignal): Promise<DocumentIndexStatus> {
    const keywordDocuments = await withReadBudget(async (reader, checkpoint) => {
        const [library] = await reader.select({ id: docLibraries.id }).from(docLibraries)
            .where(and(eq(docLibraries.id, libraryId), eq(docLibraries.userId, userId))).limit(1)
        if (!library) throw notFound("文档库不存在或无权访问")
        await checkpoint()
        const [count] = await reader.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(docDocuments)
            .where(and(eq(docDocuments.userId, userId), eq(docDocuments.libraryId, libraryId), eq(docDocuments.status, "ready")))
        return count?.count ?? 0
    }, { abortSignal })
    const enabled = process.env.PETRICHOR_DOC_INDEX_ENABLED === "true" && !isSqliteDatabase()
    const result: DocumentIndexStatus = { libraryId: String(libraryId), enabled,
        workerConfigured: enabled && process.env.PETRICHOR_DOC_INDEX_WORKER_ENABLED === "true",
        hybridConfigured: false, keywordDocuments, phase: enabled ? "not_built" : "disabled", currentReady: false, current: null, latest: null }
    if (!enabled) return result
    try {
        return await withReadBudget(async (reader, checkpoint) => {
            const scope = and(eq(docIndexGenerations.userId, userId), eq(docIndexGenerations.libraryId, libraryId))
            const [latest] = await reader.select().from(docIndexGenerations).where(scope)
                .orderBy(desc(docIndexGenerations.createdAt), desc(docIndexGenerations.id)).limit(1)
            await checkpoint()
            const [current] = await reader.select().from(docIndexGenerations).where(and(scope, eq(docIndexGenerations.isCurrent, true))).limit(1)
            result.latest = view(latest); result.current = view(current)
            if (current) {
                const manifest = parseStoredIndexManifest(current.manifestJson, current.manifestHash)
                await checkpoint()
                const documents = await reader.select({ id: docDocuments.id, updatedAt: docDocuments.updatedAt }).from(docDocuments)
                    .where(and(eq(docDocuments.userId, userId), eq(docDocuments.libraryId, libraryId), eq(docDocuments.status, "ready"))).limit(10_001)
                const versions = new Map(documents.map((doc) => [doc.id, doc.updatedAt.toISOString()]))
                result.currentReady = current.status === "ready" && documents.length === manifest.documents.length
                    && manifest.documents.every((doc) => versions.get(doc.documentId) === doc.updatedAt)
                result.phase = result.currentReady ? "ready" : "stale"
                if (result.currentReady && process.env.PETRICHOR_DOC_HYBRID_ENABLED === "true") {
                    try {
                        const policies = parseIndexProviderPolicies(JSON.parse(process.env.PETRICHOR_DOC_INDEX_PROVIDER_POLICY ?? "null"))
                        result.hybridConfigured = policies.some((p) => p.profileKey === manifest.profile.key && Date.parse(p.expiresAt) > Date.now())
                    } catch { result.hybridConfigured = false }
                }
            }
            if (latest?.status === "building" || latest?.status === "failed" || latest?.status === "cancelled") result.phase = latest.status
            if (latest?.status === "ready" && latest.id !== current?.id) result.phase = "ready_to_activate"
            return result
        }, { abortSignal })
    } catch {
        return { ...result, phase: "unavailable", currentReady: false, hybridConfigured: false, current: null, latest: null }
    }
}
