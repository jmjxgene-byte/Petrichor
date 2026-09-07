import { z } from "zod"
import { requireCurrentUser } from "@/server/auth/current-user"
import { ok, readJson } from "@/server/http/response"
import type { AppRequest } from "@/server/http/request"
import { readDocumentIndexPassage } from "./index-retrieval"
import { safeError } from "./index-handlers"

const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export async function readDocumentCitation(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = z.object({ libraryId: id, documentId: id, generationId: id, passageId: id, contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await readJson(request))
        const result = await readDocumentIndexPassage({ ...input, userId: user.id, abortSignal: request.signal })
        // 不把数据库完整行（向量、档案等）发送到浏览器。
        return ok({ title: result.title, content: result.content, anchorStart: result.anchorStart, anchorEnd: result.anchorEnd })
    } catch (error) { return safeError(error, request) }
}
