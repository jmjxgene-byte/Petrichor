import { isIP } from "node:net"
import { z } from "zod"

const QUOTA_PER_USD = 500_000
const MAX_PRICING_RESPONSE_BYTES = 1_000_000

const pricingResponseSchema = z.object({
    success: z.boolean(),
    data: z.array(z.object({
        model_name: z.string().max(200),
        quota_type: z.number().int(),
        model_ratio: z.number().finite().nonnegative().max(1_000_000).optional(),
        completion_ratio: z.number().finite().nonnegative().max(1_000_000).optional(),
        model_price: z.number().finite().nonnegative().max(1_000_000).optional(),
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
    formulaCeilingMicrousd: number
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
        const signal = AbortSignal.timeout(2_000)
        const response = await (input.fetcher ?? fetch)(endpoint, {
            method: "GET",
            headers: { accept: "application/json" },
            redirect: "error",
            signal,
        })
        if (!response.ok) { void response.body?.cancel().catch(() => {}); return { status: "unavailable", reason: "request_failed" } }
        const raw = await readPricingBody(response, signal)
        const parsed = pricingResponseSchema.safeParse(JSON.parse(raw) as unknown)
        if (!parsed.success || !parsed.data.success) {
            return { status: "unavailable", reason: "invalid_response" }
        }
        const model = parsed.data.data.find((item) => item.model_name === input.modelId)
        if (!model) return { status: "unavailable", reason: "model_missing" }
        if ((model.quota_type !== 0 && model.quota_type !== 1)
            || (model.quota_type === 0 && (model.model_ratio == null || model.completion_ratio == null))
            || (model.quota_type === 1 && model.model_price == null)) return { status: "unavailable", reason: "invalid_response" }
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
            modelRatio: model.model_ratio ?? 0,
            completionRatio: model.completion_ratio ?? 0,
            modelPrice: model.model_price ?? 0,
            groupRatios,
        }
    } catch {
        return { status: "unavailable", reason: "request_failed" }
    }
}

async function readPricingBody(response: Response, signal: AbortSignal) {
    if (Number(response.headers.get("content-length")) > MAX_PRICING_RESPONSE_BYTES) {
        void response.body?.cancel().catch(() => {})
        throw new Error("pricing_body_too_large")
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error("pricing_body_missing")
    const abort = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener("abort", abort, { once: true })
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let bytes = 0, text = ""
    try {
        while (true) {
            signal.throwIfAborted()
            const chunk = await reader.read()
            signal.throwIfAborted()
            if (chunk.done) break
            bytes += chunk.value.byteLength
            if (bytes > MAX_PRICING_RESPONSE_BYTES) throw new Error("pricing_body_too_large")
            text += decoder.decode(chunk.value, { stream: true })
        }
        return text + decoder.decode()
    } finally {
        signal.removeEventListener("abort", abort)
        void reader.cancel().catch(() => {})
        reader.releaseLock()
    }
}

export function estimateDeepResearchCost(input: {
    snapshot: DeepResearchPricingSnapshot
    inputTokens: number
    outputTokens: number
    modelCalls: number
    usageComplete?: boolean
}): DeepResearchCostEstimate {
    if (input.snapshot.status !== "available") return input.snapshot
    if (input.usageComplete === false) return { status: "unavailable", reason: "usage_incomplete" }
    if (![input.inputTokens, input.outputTokens, input.modelCalls].every((value) => Number.isSafeInteger(value) && value >= 0)) return { status: "unavailable", reason: "invalid_usage" }
    const snapshot = input.snapshot
    if (snapshot.quotaType !== 0 && snapshot.quotaType !== 1) return { status: "unavailable", reason: "unsupported_quota_type" }
    const ratios = Object.values(snapshot.groupRatios)
    if (ratios.length === 0) {
        return { status: "unavailable", reason: "group_ratio_missing" }
    }
    const costs = ratios.map((groupRatio) => snapshot.quotaType === 1
        ? snapshot.modelPrice * input.modelCalls * groupRatio
        : ((input.inputTokens + input.outputTokens * snapshot.completionRatio)
            * snapshot.modelRatio * groupRatio) / QUOTA_PER_USD)
    let formulaCeilingMicrousd: number
    try {
        const ceilings = ratios.map((group) => formulaCeiling(snapshot, input.inputTokens, input.outputTokens, input.modelCalls, group))
        const maximum = ceilings.reduce((a, b) => a > b ? a : b, 0n)
        if (maximum > BigInt(Number.MAX_SAFE_INTEGER)) return { status: "unavailable", reason: "cost_overflow" }
        formulaCeilingMicrousd = Number(maximum)
    } catch { return { status: "unavailable", reason: "invalid_pricing" } }
    return {
        status: "available",
        minUsd: Math.min(...costs),
        maxUsd: Math.max(...costs),
        formulaCeilingMicrousd,
        groupRatios: snapshot.groupRatios,
    }
}

/** Number已解析的公开十进制值按有理数运算，不把浮点乘积用于预算比较。 */
function decimal(value: number) {
    if (!Number.isFinite(value) || value < 0) throw new Error("invalid_rate")
    const match = String(value).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/)
    if (!match) throw new Error("invalid_rate")
    const fraction = match[2] ?? ""
    const exponent = Number(match[3] ?? 0) - fraction.length
    const digits = BigInt(match[1] + fraction)
    return exponent >= 0 ? { n: digits * 10n ** BigInt(exponent), d: 1n } : { n: digits, d: 10n ** BigInt(-exponent) }
}
function formulaCeiling(snapshot: Extract<DeepResearchPricingSnapshot, { status: "available" }>, input: number, output: number, calls: number, group: number) {
    const g = decimal(group)
    let numerator: bigint, denominator: bigint
    if (snapshot.quotaType === 1) {
        const price = decimal(snapshot.modelPrice)
        numerator = price.n * BigInt(calls) * g.n * 1_000_000n
        denominator = price.d * g.d
    } else {
        const model = decimal(snapshot.modelRatio), completion = decimal(snapshot.completionRatio)
        numerator = (BigInt(input) * completion.d + BigInt(output) * completion.n) * model.n * g.n * 1_000_000n
        denominator = completion.d * model.d * g.d * BigInt(QUOTA_PER_USD)
    }
    return (numerator + denominator - 1n) / denominator
}

function pricingEndpoint(baseUrl: string | null) {
    if (!baseUrl) return null
    try {
        const url = new URL(baseUrl)
        if (url.protocol !== "https:" || url.username || url.password || isIP(url.hostname) !== 0) return null
        const hostname = url.hostname.toLowerCase()
        if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || !hostname.includes(".")) return null
        return new URL("/api/pricing", url.origin)
    } catch {
        return null
    }
}
