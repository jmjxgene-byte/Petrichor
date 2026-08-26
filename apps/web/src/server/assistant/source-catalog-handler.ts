import type { AppRequest } from "@/server/http/request"
import { requireCurrentUser } from "@/server/auth/current-user"
import { ok, toErrorResponse } from "@/server/http/response"
import { listAssistantSourceCatalog } from "./source-catalog"

export async function assistantSourceCatalog(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        return ok({ items: await listAssistantSourceCatalog(user.id) })
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}
