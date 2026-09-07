import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { getServerConfig } from "@/config/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { isSqliteDatabase } from "@/server/db/client"
import { withReadBudget } from "@/server/db/read-budget"
import { docIndexGenerations } from "@/server/db/schema"
import { badRequest, forbidden, notFound, ok, readJson } from "@/server/http/response"
import type { AppRequest } from "@/server/http/request"
import { assertIndexMutationOrigin, safeError } from "./index-handlers"
import { prepareDocumentIndexQuote, verifyIndexQuote } from "./index-quote"
import { createDocumentIndexGeneration } from "./index-store"
import { activateDocumentIndexGeneration } from "./index-complete"
import { indexEmbeddingProfileSchema } from "./index-contract"
import { resolveDocumentIndexProvider, resolveDocumentIndexQuotePolicy } from "./index-provider"
import { hashDocumentText } from "./passage-builder"

function enabled() {
    if (process.env.PETRICHOR_DOC_INDEX_ENABLED !== "true" || isSqliteDatabase()) throw forbidden("增强索引尚未启用")
}
const id = z.coerce.number().int().positive()
export async function quoteDocumentIndex(request: AppRequest) {
    try {
        assertIndexMutationOrigin(request)
        const user = await requireCurrentUser(request); enabled()
        const input = z.object({ libraryId: id }).strict().parse(await readJson(request))
        return ok(await prepareDocumentIndexQuote(user.id, input.libraryId, getServerConfig().sessionSecret, request.signal))
    } catch (error) { return safeError(error, request) }
}
export async function buildDocumentIndex(request: AppRequest) {
    try {
        assertIndexMutationOrigin(request)
        const user = await requireCurrentUser(request); enabled()
        const input = z.object({ libraryId: id, token: z.string().max(3 * 1024 * 1024 + 100), confirm: z.literal(true) }).strict().parse(await readJson(request))
        const quote = verifyIndexQuote(input.token, getServerConfig().sessionSecret, user.id, input.libraryId)
        const current = await resolveDocumentIndexQuotePolicy(user.id, JSON.parse(process.env.PETRICHOR_DOC_INDEX_PROVIDER_POLICY ?? "null"))
        if (JSON.stringify(current.profile) !== JSON.stringify(quote.profile) || hashDocumentText(JSON.stringify(current.policy)) !== quote.policyHash) throw badRequest("模型或核验策略已变化，请重新预估")
        const generation = await createDocumentIndexGeneration({ userId: user.id, libraryId: input.libraryId,
            documents: quote.documents, profile: quote.profile, approval: quote.approval })
        return ok({ generationId: String(generation.id), status: generation.status })
    } catch (error) { return safeError(error, request) }
}
export async function activateDocumentIndex(request: AppRequest) {
    try {
        assertIndexMutationOrigin(request)
        const user = await requireCurrentUser(request); enabled()
        const input = z.object({ generationId: id, manifestHash: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) }).strict().parse(await readJson(request))
        const [generation] = await withReadBudget((reader) => reader.select({ profile: docIndexGenerations.embeddingProfileJson }).from(docIndexGenerations)
            .where(and(eq(docIndexGenerations.id, input.generationId), eq(docIndexGenerations.userId, user.id))).limit(1), { abortSignal: request.signal })
        if (!generation) throw notFound("索引不存在或无权访问")
        const expected = indexEmbeddingProfileSchema.parse(JSON.parse(generation.profile))
        const provider = await resolveDocumentIndexProvider(user.id, JSON.parse(process.env.PETRICHOR_DOC_INDEX_PROVIDER_POLICY ?? "null"), expected)
        return ok(await activateDocumentIndexGeneration({ userId: user.id, generationId: input.generationId, manifestHash: input.manifestHash, profile: provider.profile }))
    } catch (error) { return safeError(error, request) }
}
