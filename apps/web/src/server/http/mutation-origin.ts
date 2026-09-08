import type { AppRequest } from "./request"
import { forbidden } from "./response"

export function assertMutationOrigin(request: AppRequest, operation = "操作") {
    const origin = request.headers.get("origin")
    const fetchSite = request.headers.get("sec-fetch-site")
    if (fetchSite === "cross-site" || (!origin && fetchSite === "same-site")) throw forbidden(`不允许跨站${operation}`)
    if (origin) {
        const allowed = new Set([request.urlObject.origin])
        for (const value of [process.env.APP_BASE_URL, process.env.BETTER_AUTH_URL]) {
            if (value) allowed.add(new URL(value).origin)
        }
        if (!allowed.has(origin)) throw forbidden(`不允许跨域${operation}`)
    }
}
