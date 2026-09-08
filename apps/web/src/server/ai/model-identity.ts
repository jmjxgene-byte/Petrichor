import { createHash } from "node:crypto"
import type { ResolvedModel } from "./resolution"

type IdentityInput = {
    model: Pick<ResolvedModel["model"], "id" | "modelId" | "updatedAt">
    provider: Pick<ResolvedModel["provider"], "id" | "providerKey" | "baseUrl" | "updatedAt">
    credential: Pick<ResolvedModel["credential"], "id" | "updatedAt">
    options: ResolvedModel["options"]
}
/** 仅对模型/配置版本元数据取指纹，不读取或序列化runtime/API Key。 */
export function chatModelFingerprint(value: IdentityInput) {
    return createHash("sha256").update(JSON.stringify({
        model: [value.model.id, value.model.modelId, value.model.updatedAt],
        provider: [value.provider.id, value.provider.providerKey, value.provider.baseUrl, value.provider.updatedAt],
        credential: [value.credential.id, value.credential.updatedAt],
        options: Object.entries(value.options).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    })).digest("hex")
}
