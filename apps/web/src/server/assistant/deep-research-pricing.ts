import { isIP } from "node:net"
import { z } from "zod"

const QUOTA_PER_USD = 500_000
const MAX_PRICING_RESPONSE_CHARS = 1_000_000

const pricingResponseSchema = z.object({
    success: z.boolean(),
    data: z.array(z.object({
        model_name: z.string().max(200),
        quota_type: z.number().int(),
        model_ratio: z.number().finite().nonnegative().max(1_000_000).optional().default(0),
        completion_ratio: z.number().finite().nonnegative().max(1_000_000).optional().default(0),
        model_price: z.number().finite().nonnegative().max(1_000_000).optional().default(0),
        enable_groups: z.array(z.string().max(64)).max(50).optional(),
        enable_group: z.array(z.string().max(64)).max(50).optional(),
    }).passthrough()),
    group_ratio: z.record(
        z.string(),
        z.number().finite().nonnegative().max(1_000_000),
    ).optional().default({}),
}).passthrough()

export type DeepResearchPricingSnapshot = {
    status: "available"
    source: "new-api-public"
    capturedAt: string
    modelId: string
    quotaType: number
    modelRatio: number
    completionRatio: number
    modelPrice: number
    groupRatios: Record<string, number>
} | {
    status: "unavailable"
    reason: "unsupported_provider" | "unsafe_base_url" | "request_failed" | "invalid_response" | "model_missing"
}

export type DeepResearchCostEstimate = {
    status: "available"
    minUsd: number
    maxUsd: number
    groupRatios: Record<string, number>
} | {
    status: "unavailable"
    reason: string
}

export async function fetchDeepResearchPricingSnapshot(input: {
    providerKey: string
    baseUrl: string | null
    modelId: string
    fetcher?: typeof fetch
    now?: Date
}): Promise<DeepResearchPricingSnapshot> {
    if (input.providerKey !== "openai-compatible") {
        return { status: "unavailable", reason: "unsupported_provider" }
    }
    const endpoint = pricingEndpoint(input.baseUrl)
    if (!endpoint) return { status: "unavailable", reason: "unsafe_base_url" }

    try {
        const response = await (input.fetcher ?? fetch)(endpoint, {
            method: "GET",
            headers: { accept: "application/json" },
            redirect: "error",
            signal: AbortSignal.timeout(2_000),
        })
        if (!response.ok) return { status: "unavailable", reason: "request_failed" }
        const raw = await response.text()
        if (raw.length > MAX_PRICING_RESPONSE_CHARS) {
            return { status: "unavailable", reason: "invalid_response" }
        }
        const parsed = pricingResponseSchema.safeParse(JSON.parse(raw) as unknown)
        if (!parsed.success || !parsed.data.success) {
            return { status: "unavailable", reason: "invalid_response" }
        }
        const model = parsed.data.data.find((item) => item.model_name === input.modelId)
        if (!model) return { status: "unavailable", reason: "model_missing" }
        const enabledGroups = model.enable_groups ?? model.enable_group ?? []
        const groupRatios = Object.fromEntries(Object.entries(parsed.data.group_ratio)
            .filter(([group]) => group.length <= 64
                && (enabledGroups.length === 0 || enabledGroups.includes(group)))
            .slice(0, 50))
        return {
            status: "available",
            source: "new-api-public",
            capturedAt: (input.now ?? new Date()).toISOString(),
            modelId: input.modelId,
            quotaType: model.quota_type,
            modelRatio: model.model_ratio,
            completionRatio: model.completion_ratio,
            modelPrice: model.model_price,
            groupRatios,
        }
    } catch {
        return { status: "unavailable", reason: "request_failed" }
    }
}

export function estimateDeepResearchCost(input: {
    snapshot: DeepResearchPricingSnapshot
    inputTokens: number
    outputTokens: number
    modelCalls: number
}): DeepResearchCostEstimate {
    if (input.snapshot.status !== "available") return input.snapshot
    const snapshot = input.snapshot
    const ratios = Object.values(snapshot.groupRatios)
    if (ratios.length === 0) {
        return { status: "unavailable", reason: "group_ratio_missing" }
    }
    const costs = ratios.map((groupRatio) => snapshot.quotaType === 1
        ? snapshot.modelPrice * input.modelCalls * groupRatio
        : ((input.inputTokens + input.outputTokens * snapshot.completionRatio)
            * snapshot.modelRatio * groupRatio) / QUOTA_PER_USD)
    return {
        status: "available",
        minUsd: Math.min(...costs),
        maxUsd: Math.max(...costs),
        groupRatios: snapshot.groupRatios,
    }
}

function pricingEndpoint(baseUrl: string | null) {
    if (!baseUrl) return null
    try {
        const url = new URL(baseUrl)
        if (url.protocol !== "https:" || isIP(url.hostname) !== 0) return null
        const hostname = url.hostname.toLowerCase()
        if (hostname === "localhost" || hostname.endsWith(".local") || !hostname.includes(".")) return null
        return new URL("/api/pricing", url.origin)
    } catch {
        return null
    }
}
