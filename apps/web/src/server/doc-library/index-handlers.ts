import { z, ZodError } from "zod"
import { requireCurrentUser } from "@/server/auth/current-user"
import type { AppRequest } from "@/server/http/request"
import { forbidden, HttpError, notFound, ok, readJson, toErrorResponse } from "@/server/http/response"
import { getDocumentIndexStatus } from "./index-status"
import { cancelDocumentIndexGeneration } from "./index-jobs"

const id = z.coerce.number().int().positive()
export function assertIndexMutationOrigin(request: AppRequest) {
    const origin = request.headers.get("origin")
    const fetchSite = request.headers.get("sec-fetch-site")
    if (fetchSite === "cross-site" || (!origin && fetchSite === "same-site")) throw forbidden("不允许跨站索引操作")
    if (origin) {
        const allowed = new Set([request.urlObject.origin])
        for (const value of [process.env.APP_BASE_URL, process.env.BETTER_AUTH_URL]) {
            if (value) allowed.add(new URL(value).origin)
        }
        if (!allowed.has(origin)) throw forbidden("不允许跨域索引操作")
    }
}
export function safeError(error: unknown, request: AppRequest) {
    return toErrorResponse(error instanceof HttpError || error instanceof ZodError
        ? error : new HttpError(503, "索引操作暂不可用，请稍后重试"), request.urlObject.pathname)
}
export async function documentIndexStatus(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = z.object({ libraryId: id }).strict().parse(await readJson(request))
        return ok(await getDocumentIndexStatus(user.id, input.libraryId, request.signal))
    } catch (error) { return safeError(error, request) }
}
export async function cancelDocumentIndex(request: AppRequest) {
    try {
        assertIndexMutationOrigin(request)
        const user = await requireCurrentUser(request)
        const input = z.object({ generationId: id }).strict().parse(await readJson(request))
        const generation = await cancelDocumentIndexGeneration(user.id, input.generationId)
        if (!generation) throw notFound("可取消的索引任务不存在")
        return ok({ generationId: String(generation.id), status: "cancelled" })
    } catch (error) { return safeError(error, request) }
}
