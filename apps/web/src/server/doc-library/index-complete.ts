import { and, eq, inArray, sql } from "drizzle-orm"
import { getDb, isSqliteDatabase } from "@/server/db/client"
import { docDocuments, docIndexGenerations, docIndexJobs, docPassages } from "@/server/db/schema"
import { buildDocumentPassages, hashDocumentText } from "./passage-builder"
import { hasLiveIndexLease } from "./index-job-policy"
import { indexEmbeddingProfileSchema, parseStoredIndexManifest, serializeIndexVectors } from "./index-contract"

type Transaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0]
type Generation = typeof docIndexGenerations.$inferSelect

function pgDb() {
    if (isSqliteDatabase()) throw new Error("索引完成要求PostgreSQL")
    return getDb()
}
function requireProfile(generation: Generation, actualProfile: unknown) {
    const profile = indexEmbeddingProfileSchema.parse(actualProfile)
    const stored = indexEmbeddingProfileSchema.parse(JSON.parse(generation.embeddingProfileJson))
    const manifest = parseStoredIndexManifest(generation.manifestJson, generation.manifestHash)
    if (generation.preprocessingVersion !== manifest.preprocessingVersion || JSON.stringify(stored) !== JSON.stringify(manifest.profile)) throw new Error("索引档案与manifest不一致")
    if (JSON.stringify(profile) !== JSON.stringify(stored)) throw new Error("索引模型档案已变化")
    return profile
}

async function verifyCompleteGeneration(tx: Transaction, generation: Generation) {
    const manifest = parseStoredIndexManifest(generation.manifestJson, generation.manifestHash)
    if (generation.expectedDocuments !== manifest.documents.length) throw new Error("索引预期文档数不一致")
    const jobs = await tx.select().from(docIndexJobs).where(eq(docIndexJobs.generationId, generation.id))
    if (jobs.length !== manifest.documents.length || jobs.some((job) => job.status !== "succeeded")) throw new Error("索引任务尚未全部完成")
    const byDocument = new Map(jobs.map((job) => [job.documentId, job]))
    if (manifest.documents.some((doc) => byDocument.get(doc.documentId)?.sourceHash !== doc.sourceHash)) throw new Error("索引任务与manifest不匹配")
    const documents = await tx.select({ id: docDocuments.id, updatedAt: docDocuments.updatedAt }).from(docDocuments).where(and(
        eq(docDocuments.userId, generation.userId), eq(docDocuments.libraryId, generation.libraryId), eq(docDocuments.status, "ready"),
        inArray(docDocuments.id, manifest.documents.map((doc) => doc.documentId)),
    )).for("share")
    const versions = new Map(documents.map((doc) => [doc.id, doc.updatedAt.toISOString()]))
    if (manifest.documents.some((doc) => versions.get(doc.documentId) !== doc.updatedAt)) throw new Error("发布前文档已变化")
    const [counts] = await tx.select({
        passages: sql<number>`count(*)::integer`, documents: sql<number>`count(distinct ${docPassages.documentId})::integer`,
        invalid: sql<number>`count(*) filter (where embedding is null or vector_dims(embedding) <> ${manifest.profile.dimensions}
            or ${docPassages.embeddingDimensions} is distinct from ${manifest.profile.dimensions} or ${docPassages.embeddingStatus} <> 'ready'
            or not exists (select 1 from petrichor_doc_index_job j where j.generation_id = ${docPassages.generationId}
                and j.document_id = ${docPassages.documentId} and j.source_hash = ${docPassages.sourceHash} and j.status = 'succeeded'))::integer`,
    }).from(docPassages).where(eq(docPassages.generationId, generation.id))
    if (!counts || counts.passages <= 0 || counts.documents !== manifest.documents.length || counts.invalid !== 0) throw new Error("索引分片或向量验收失败")
    return { completedDocuments: documents.length, passageCount: counts.passages }
}

/** 调用已结束后一次事务登记所有片段与job成功；不在事务内调用模型/S3。 */
export async function completeDocumentIndexJob(input: {
    userId: number; jobId: number; workerId: string; source: string; embeddings: number[][]; profile: unknown
}, clock?: Date) {
    const sourceHash = hashDocumentText(input.source)
    return await pgDb().transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('petrichor-doc-index-slot'))`)
        const [job] = await tx.select().from(docIndexJobs).where(and(eq(docIndexJobs.id, input.jobId), eq(docIndexJobs.userId, input.userId))).for("update")
        if (!job || job.sourceHash !== sourceHash) throw new Error("源内容hash不匹配")
        if (job.status === "succeeded") return { jobId: job.id, alreadyCompleted: true }
        if (!hasLiveIndexLease(job, input.workerId, clock ?? new Date()) || job.consumedInputTokens <= 0) throw new Error("任务租约或模型预算无效")
        const [generation] = await tx.select().from(docIndexGenerations).where(and(eq(docIndexGenerations.id, job.generationId), eq(docIndexGenerations.status, "building"))).for("update")
        if (!generation) throw new Error("索引generation不可写入")
        const profile = requireProfile(generation, input.profile)
        const manifest = parseStoredIndexManifest(generation.manifestJson, generation.manifestHash)
        const snapshot = manifest.documents.find((doc) => doc.documentId === job.documentId)
        const [document] = await tx.select().from(docDocuments).where(and(eq(docDocuments.id, job.documentId),
            eq(docDocuments.userId, job.userId), eq(docDocuments.libraryId, job.libraryId), eq(docDocuments.status, "ready"))).for("share")
        if (!document || !snapshot || snapshot.updatedAt !== document.updatedAt.toISOString() || snapshot.sourceHash !== sourceHash) throw new Error("源文档快照已变化")
        const passages = buildDocumentPassages(input.source, document.title)
        const vectors = serializeIndexVectors(input.embeddings, passages.length, profile.dimensions)
        for (let offset = 0; offset < passages.length; offset += 50) {
            if (!hasLiveIndexLease(job, input.workerId, clock ?? new Date())) throw new Error("写入期间租约已过期")
            const values = passages.slice(offset, offset + 50).map((p, index) => sql`(
                ${generation.id}, ${job.userId}, ${job.libraryId}, ${job.documentId}, ${p.passageIndex},
                ${p.sourceHash}, ${p.contentHash}, ${p.startOffset}, ${p.endOffset}, ${p.parentStartOffset}, ${p.parentEndOffset},
                ${p.locator}, ${p.text}, ${p.searchTokens}, 'ready', ${profile.dimensions}, ${vectors[offset + index]}::vector)`)
            await tx.execute(sql`insert into petrichor_doc_passage
                (generation_id,user_id,library_id,document_id,passage_index,source_hash,content_hash,start_offset,end_offset,parent_start_offset,parent_end_offset,locator,text,search_tokens,embedding_status,embedding_dimensions,embedding)
                values ${sql.join(values, sql`,`)}`)
        }
        const now = clock ?? new Date()
        if (!hasLiveIndexLease(job, input.workerId, now)) throw new Error("提交期间租约已过期")
        await tx.update(docIndexJobs).set({ status: "succeeded", leaseOwner: null, leaseExpiresAt: null, errorCode: null, updatedAt: now }).where(eq(docIndexJobs.id, job.id))
        const [remaining] = await tx.select({ count: sql<number>`count(*)::integer` }).from(docIndexJobs)
            .where(and(eq(docIndexJobs.generationId, generation.id), sql`${docIndexJobs.status} <> 'succeeded'`))
        if (remaining?.count === 0) {
            const counts = await verifyCompleteGeneration(tx, generation)
            await tx.update(docIndexGenerations).set({ ...counts, status: "ready", updatedAt: now }).where(eq(docIndexGenerations.id, generation.id))
        }
        return { jobId: job.id, alreadyCompleted: false }
    })
}

/** 独立发布门：任务ready不自动切current，只有经过授权的调用者才能触发此服务。 */
export async function activateDocumentIndexGeneration(input: { userId: number; generationId: number; manifestHash: string; profile: unknown }, now = new Date()) {
    return await pgDb().transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('petrichor-doc-index-slot'))`)
        const [generation] = await tx.select().from(docIndexGenerations).where(and(eq(docIndexGenerations.id, input.generationId),
            eq(docIndexGenerations.userId, input.userId), inArray(docIndexGenerations.status, ["ready", "retired"]))).for("update")
        if (!generation || generation.manifestHash !== input.manifestHash) throw new Error("索引发布目标不匹配或未就绪")
        requireProfile(generation, input.profile)
        const counts = await verifyCompleteGeneration(tx, generation)
        await tx.update(docIndexGenerations).set({ isCurrent: false, status: "retired", updatedAt: now })
            .where(and(eq(docIndexGenerations.userId, input.userId), eq(docIndexGenerations.libraryId, generation.libraryId), eq(docIndexGenerations.isCurrent, true)))
        await tx.update(docIndexGenerations).set({ ...counts, isCurrent: true, status: "ready", updatedAt: now }).where(eq(docIndexGenerations.id, generation.id))
        return { generationId: generation.id, manifestHash: generation.manifestHash }
    })
}
