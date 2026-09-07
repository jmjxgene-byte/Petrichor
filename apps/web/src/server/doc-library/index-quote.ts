import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { and, asc, eq } from "drizzle-orm"
import { withReadBudget } from "@/server/db/read-budget"
import { docLibraries, docDocuments } from "@/server/db/schema"
import { badRequest, notFound } from "@/server/http/response"
import { indexApprovalSchema, indexEmbeddingProfileSchema, indexSnapshotSchema, prepareIndexManifest } from "./index-contract"
import { buildDocumentPassages, hashDocumentText } from "./passage-builder"
import { loadDocumentIndexSource } from "./index-source"
import { quoteIndexInputs, resolveDocumentIndexQuotePolicy } from "./index-provider"

const quoteSchema = z.object({
    version: z.literal(1), userId: z.number().int().positive(), libraryId: z.number().int().positive(),
    quoteExpiresAt: z.string().datetime(), approval: indexApprovalSchema,
    policyHash: z.string().regex(/^[a-f0-9]{64}$/),
    documents: z.array(indexSnapshotSchema).min(1).max(10_000), profile: indexEmbeddingProfileSchema,
    passageCount: z.number().int().positive(),
}).strict()
export type IndexQuotePayload = z.infer<typeof quoteSchema>
const DOMAIN = "petrichor-doc-index-quote-v1:"
function signature(payload: string, secret: string) {
    if (secret.length < 32) throw new Error("报价签名配置无效")
    return createHmac("sha256", secret).update(DOMAIN + payload).digest()
}
export function signIndexQuote(value: IndexQuotePayload, secret: string): string {
    const payload = Buffer.from(JSON.stringify(quoteSchema.parse(value))).toString("base64url")
    if (payload.length > 3 * 1024 * 1024) throw new Error("报价载荷超过上限")
    return `${payload}.${signature(payload, secret).toString("base64url")}`
}
export function verifyIndexQuote(token: string, secret: string, userId: number, libraryId: number, now = Date.now()): IndexQuotePayload {
    if (token.length > 3 * 1024 * 1024 + 100 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw badRequest("报价令牌无效")
    const [payload, mac] = token.split(".")
    const supplied = Buffer.from(mac, "base64url"), expected = signature(payload, secret)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw badRequest("报价签名无效")
    const parsed = quoteSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))
    if (parsed.userId !== userId || parsed.libraryId !== libraryId) throw badRequest("报价不属于当前用户或文档库")
    if (Date.parse(parsed.quoteExpiresAt) <= now || Date.parse(parsed.approval.expiresAt) <= now) throw badRequest("报价已过期，请重新预估")
    const prepared = prepareIndexManifest(parsed.documents, parsed.profile)
    if (prepared.manifestHash !== parsed.approval.manifestHash) throw badRequest("报价manifest不匹配")
    return parsed
}

export async function prepareDocumentIndexQuote(userId: number, libraryId: number, secret: string, signal?: AbortSignal) {
    const abortSignal = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])])
    const documents = await withReadBudget(async (reader, checkpoint) => {
        const [library] = await reader.select({ id: docLibraries.id }).from(docLibraries).where(and(eq(docLibraries.id, libraryId), eq(docLibraries.userId, userId))).limit(1)
        if (!library) throw notFound("文档库不存在或无权访问")
        await checkpoint()
        return reader.select({ id: docDocuments.id }).from(docDocuments).where(and(eq(docDocuments.userId, userId), eq(docDocuments.libraryId, libraryId), eq(docDocuments.status, "ready"))).orderBy(asc(docDocuments.id)).limit(10_001)
    }, { abortSignal })
    if (!documents.length || documents.length > 10_000) throw badRequest("可索引文档为空或超过安全上限")
    const { profile, policy } = await resolveDocumentIndexQuotePolicy(userId, JSON.parse(process.env.PETRICHOR_DOC_INDEX_PROVIDER_POLICY ?? "null"))
    const snapshots: z.infer<typeof indexSnapshotSchema>[] = []
    let inputTokens = 0, costMicrousd = 0, passageCount = 0
    for (const document of documents) {
        abortSignal.throwIfAborted()
        const loaded = await loadDocumentIndexSource(userId, libraryId, document.id, abortSignal)
        const passages = buildDocumentPassages(loaded.source, loaded.title)
        const quoted = quoteIndexInputs(passages.map((p) => `${loaded.title}\n${p.locator}\n${p.text}`), policy)
        inputTokens += quoted.inputTokens; costMicrousd += quoted.costMicrousd; passageCount += passages.length
        snapshots.push({ documentId: document.id, sourceHash: hashDocumentText(loaded.source), updatedAt: loaded.updatedAt, sourceFormat: loaded.sourceFormat })
    }
    if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(costMicrousd)) throw badRequest("报价预算超出安全范围")
    const { manifest, manifestHash } = prepareIndexManifest(snapshots, profile)
    const now = Date.now()
    const executionExpiry = Math.min(now + 24 * 60 * 60_000, Date.parse(policy.expiresAt))
    abortSignal.throwIfAborted()
    if (executionExpiry <= now) throw badRequest("核验策略已过期，请重新预估")
    const quoteExpiresAt = new Date(Math.min(now + 15 * 60_000, executionExpiry)).toISOString()
    const payload: IndexQuotePayload = { version: 1, userId, libraryId, quoteExpiresAt, policyHash: hashDocumentText(JSON.stringify(policy)),
        approval: { approvalId: randomUUID(), manifestHash, maxInputTokens: inputTokens, maxCostMicrousd: Math.max(1, costMicrousd), expiresAt: new Date(executionExpiry).toISOString() },
        documents: manifest.documents, profile, passageCount }
    return { token: signIndexQuote(payload, secret), libraryId: String(libraryId), documentCount: documents.length, passageCount,
        maxInputTokens: inputTokens, maxCostMicrousd: payload.approval.maxCostMicrousd, quoteExpiresAt,
        executionExpiresAt: payload.approval.expiresAt, model: profile.model, manifestHash }
}
