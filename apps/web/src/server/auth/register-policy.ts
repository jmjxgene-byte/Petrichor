import { badRequest, forbidden } from "@/server/http/response"

export type RegistrationMode = "disabled" | "open"

export const REGISTRATION_MODE_ENV = "PETRICHOR_REGISTRATION_MODE"

export function resolveRegistrationMode(
    env: Record<string, string | undefined> = process.env,
): RegistrationMode {
    const raw = env[REGISTRATION_MODE_ENV]?.trim().toLowerCase()
    if (!raw) {
        return "disabled"
    }
    if (raw === "disabled" || raw === "open") {
        return raw
    }

    throw badRequest(`${REGISTRATION_MODE_ENV} 只支持 disabled 或 open`)
}

export function requirePublicRegistrationEnabled(
    env: Record<string, string | undefined> = process.env,
) {
    if (resolveRegistrationMode(env) !== "open") {
        throw forbidden("公开注册已关闭")
    }
}
