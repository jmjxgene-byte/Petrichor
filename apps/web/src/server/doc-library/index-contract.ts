import { z } from "zod"
import { DOCUMENT_PREPROCESSING_VERSION, hashDocumentText, type DocumentPreprocessingVersion } from "./passage-builder"

export const indexEmbeddingProfileSchema = z.object({
    modelRefId: z.number().int().positive(), model: z.string().min(1).max(200),
    dimensions: z.number().int().min(1).max(16_000), version: z.number().int().positive(),
    key: z.string().min(1).max(500),
}).strict()
export const indexSnapshotSchema = z.object({
    documentId: z.number().int().positive(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    updatedAt: z.string().datetime(),
    sourceFormat: z.enum(["raw_markdown", "extracted_text_v1"]).optional(),
}).strict()
/** 此结构只能由服务端已确认的预算记录构造，不能直接接受浏览器自报授权。 */
export const indexApprovalSchema = z.object({
    approvalId: z.string().min(1).max(100), manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    maxInputTokens: z.number().int().positive(), maxCostMicrousd: z.number().int().positive(),
    expiresAt: z.string().datetime(),
}).strict()

export function prepareIndexManifest(rawDocuments: unknown, rawProfile: unknown, version: DocumentPreprocessingVersion = DOCUMENT_PREPROCESSING_VERSION) {
    if (version !== 1 && version !== 2) throw new Error("不支持的索引预处理版本")
    const profile = indexEmbeddingProfileSchema.parse(rawProfile)
    const documents = z.array(indexSnapshotSchema).min(1).max(10_000).parse(rawDocuments)
        .sort((a, b) => a.documentId - b.documentId)
    if (new Set(documents.map((doc) => doc.documentId)).size !== documents.length) throw new Error("manifest含重复文档")
    const manifest = { preprocessingVersion: version, profile, documents }
    return { manifest, manifestHash: hashDocumentText(JSON.stringify(manifest)) }
}

export function requireIndexApproval(raw: unknown, manifestHash: string, now = Date.now()) {
    const approval = indexApprovalSchema.parse(raw)
    if (approval.manifestHash !== manifestHash) throw new Error("索引审批与manifest不匹配")
    if (Date.parse(approval.expiresAt) <= now) throw new Error("索引审批已过期")
    return approval
}

export function parseStoredIndexManifest(raw: string, expectedHash: string) {
    const parsed = z.object({ preprocessingVersion: z.union([z.literal(1), z.literal(2)]),
        documents: z.array(indexSnapshotSchema), profile: indexEmbeddingProfileSchema,
    }).strict().parse(JSON.parse(raw))
    const prepared = prepareIndexManifest(parsed.documents, parsed.profile, parsed.preprocessingVersion)
    if (prepared.manifestHash !== expectedHash) throw new Error("索引manifest校验失败")
    return prepared.manifest
}

/** pgvector存储float32；提前拒绝维度漂移、NaN/Infinity、float32溢出及零向量。 */
export function serializeIndexVectors(embeddings: number[][], expectedCount: number, dimensions: number): string[] {
    if (embeddings.length !== expectedCount || !expectedCount) throw new Error("分片与向量数量不匹配")
    return embeddings.map((vector) => {
        if (!Array.isArray(vector) || vector.length !== dimensions) throw new Error("向量维度不匹配")
        const values = vector.map((value) => {
            if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw new Error("向量数值无效")
            return Math.fround(value)
        })
        if (!values.some((value) => value !== 0)) throw new Error("零向量不可用于语义检索")
        return `[${values.join(",")}]`
    })
}
