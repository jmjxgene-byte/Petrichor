import { createHash } from "node:crypto"
import { z } from "zod"
import type { RerankConfig } from "../src/server/assistant/agent-runtime/config"

const snapshotSchema = z.object({ enabled: z.boolean(), provider: z.enum(["openai-compatible", "bge", "cross-encoder"]),
    model: z.string().min(1).max(200), topN: z.number().int().min(1).max(20), baseUrl: z.string().url().nullable(), timeoutMs: z.number().int().min(1_000).max(20_000),
    apiKeyPresent: z.boolean(), endpointProtocol: z.enum(["https", "none"]), endpointHost: z.string().max(253).nullable() }).strict()
export type SafeRerankProfile = z.infer<typeof snapshotSchema>

export function snapshotRerankProfile(config: RerankConfig) {
    const baseUrl = config.baseUrl?.trim().replace(/\/+$/, "") || null
    let protocol: "https" | "none" = "none", host: string | null = null
    if (baseUrl) {
        let parsed: URL
        try { parsed = new URL(baseUrl) } catch { throw new Error("rerank_profile_url") }
        if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.protocol !== "https:") throw new Error("rerank_profile_url")
        protocol = "https"; host = parsed.hostname
    }
    const parsed = snapshotSchema.safeParse({ enabled: config.enabled, provider: config.provider, model: config.model,
        topN: config.topN, baseUrl, timeoutMs: config.timeoutMs, apiKeyPresent: Boolean(config.apiKey?.trim()), endpointProtocol: protocol, endpointHost: host })
    if (!parsed.success) throw new Error("rerank_profile_invalid")
    const snapshot = parsed.data
    const profileHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")
    return { snapshot, profileHash }
}

/** 真实canary要求启用且使用固定BGE reranker；只校验快照，不读取密文。 */
export function assertCanaryRerankProfile(raw: unknown) {
    const parsed = snapshotSchema.safeParse(raw)
    if (!parsed.success) throw new Error("rerank_profile_invalid")
    const snapshot = parsed.data, profileHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")
    if (!snapshot.enabled || snapshot.model !== "BAAI/bge-reranker-v2-m3" || snapshot.endpointProtocol !== "https" || !snapshot.baseUrl
        || !snapshot.apiKeyPresent || snapshot.topN < 1 || snapshot.topN > 20) throw new Error("rerank_profile_not_ready")
    return { snapshot, profileHash }
}
