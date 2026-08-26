import type { AppRequest } from "@/server/http/request"
import { z } from "zod"
import { auth } from "@/server/auth/better-auth"
import { createLocalUserWithBetterAuth } from "@/server/auth/better-auth-bridge"
import { appendBetterAuthCookies, toAuthHttpError } from "@/server/auth/better-auth-response"
import { toUserResponse } from "@/server/mappers"
import { readJson, toErrorResponse } from "@/server/http/response"
import { requirePublicRegistrationEnabled } from "@/server/auth/register-policy"
import { rateLimitPresets, withRateLimit } from "@/lib/with-rate-limit"

const schema = z.object({
    email: z.string().email(),
    password: z.string().min(12),
    name: z.string().trim().min(1),
})

async function register(request: AppRequest) {
    try {
        requirePublicRegistrationEnabled()
        const input = schema.parse(await readJson(request))
        const user = await createLocalUserWithBetterAuth({
            email: input.email,
            password: input.password,
            name: input.name,
            systemRole: "USER",
        })

        const result = await auth.api.signInEmail({
            body: {
                email: input.email,
                password: input.password,
                rememberMe: true,
            },
            headers: request.headers,
            returnHeaders: true,
        })
        const response = Response.json({
            token: result.response.token,
            user: toUserResponse(user),
        })
        return appendBetterAuthCookies(response, result.headers)
    } catch (error) {
        return toErrorResponse(toAuthHttpError(error, "注册失败"), request.urlObject.pathname)
    }
}

export const POST = withRateLimit(register, rateLimitPresets.strict)
