import { and, eq, inArray, sql } from "drizzle-orm"
import { getDb, isSqliteDatabase } from "@/server/db/client"
import { docDocuments, docLibraries, docIndexGenerations, docIndexJobs } from "@/server/db/schema"
import { prepareIndexManifest, requireIndexApproval } from "./index-contract"
import { badRequest } from "@/server/http/response"

/** 只准备经过服务端批准的任务；不读取S3、不调用模型、不切current。 */
export async function createDocumentIndexGeneration(input: {
    userId: number; libraryId: number; documents: unknown; profile: unknown; approval: unknown
}) {
    const { manifest, manifestHash } = prepareIndexManifest(input.documents, input.profile)
    const approval = requireIndexApproval(input.approval, manifestHash)
    if (isSqliteDatabase()) throw badRequest("增强索引任务仅支持受控PostgreSQL环境，本地仍可使用关键词检索")
    return await getDb().transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`doc-index-approval:${input.userId}:${approval.approvalId}`}))`)
        const [library] = await tx.select({ id: docLibraries.id }).from(docLibraries)
            .where(and(eq(docLibraries.id, input.libraryId), eq(docLibraries.userId, input.userId))).for("update")
        if (!library) throw badRequest("文档库不存在或无权访问")
        requireIndexApproval(approval, manifestHash)
        const ids = manifest.documents.map((doc) => doc.documentId)
        const rows = await tx.select({ id: docDocuments.id, updatedAt: docDocuments.updatedAt }).from(docDocuments)
            .where(and(eq(docDocuments.userId, input.userId), eq(docDocuments.libraryId, input.libraryId), inArray(docDocuments.id, ids)))
        if (rows.length !== ids.length) throw badRequest("manifest包含不可访问的文档")
        const versions = new Map(rows.map((row) => [row.id, row.updatedAt.toISOString()]))
        if (manifest.documents.some((doc) => versions.get(doc.documentId) !== doc.updatedAt)) throw badRequest("文档已变化，请重新准备manifest")
        const [existing] = await tx.select().from(docIndexGenerations).where(and(
            eq(docIndexGenerations.userId, input.userId), eq(docIndexGenerations.libraryId, input.libraryId),
            eq(docIndexGenerations.manifestHash, manifestHash), inArray(docIndexGenerations.status, ["building", "ready"]),
        )).limit(1)
        if (existing) return existing
        const [usedApproval] = await tx.select({ id: docIndexJobs.id }).from(docIndexJobs).where(and(
            eq(docIndexJobs.userId, input.userId),
            sql`${docIndexJobs.approvedBudgetJson}::jsonb ->> 'approvalId' = ${approval.approvalId}`,
        )).limit(1)
        if (usedApproval) throw badRequest("该审批已绑定索引任务，失败后不能复用创建新代际")
        const [generation] = await tx.insert(docIndexGenerations).values({
            userId: input.userId, libraryId: input.libraryId, manifestHash,
            manifestJson: JSON.stringify(manifest), embeddingProfileJson: JSON.stringify(manifest.profile),
            preprocessingVersion: manifest.preprocessingVersion, expectedDocuments: ids.length,
        }).returning()
        if (!generation) throw new Error("索引generation创建失败")
        for (let offset = 0; offset < manifest.documents.length; offset += 100) {
            await tx.insert(docIndexJobs).values(manifest.documents.slice(offset, offset + 100).map((doc) => ({
                generationId: generation.id, userId: input.userId, libraryId: input.libraryId,
                documentId: doc.documentId, sourceHash: doc.sourceHash,
                idempotencyKey: `${generation.id}:${doc.documentId}`,
                // 同一generation共享审批总额；执行器必须汇总所有job消耗，不能逐job重置额度。
                approvedBudgetJson: JSON.stringify(approval),
            })))
        }
        return generation
    })
}
