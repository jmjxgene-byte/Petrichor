import { describe, expect, it, vi } from "vitest"

import { estimateDeepResearchCost, fetchDeepResearchPricingSnapshot } from "./deep-research-pricing"

describe("deep research pricing snapshot", () => {
    it.each([
        { quota_type: 0 },
        { quota_type: 0, model_ratio: 1 },
        { quota_type: 1 },
        { quota_type: 9, model_ratio: 1, completion_ratio: 1 },
    ])("价格字段缺失或未知计费类型不是免费：%j", async (fields) => {
        const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: true, data: [{ model_name: "fixture", ...fields }], group_ratio: { default: 1 } }))) as unknown as typeof fetch
        expect(await fetchDeepResearchPricingSnapshot({ providerKey: "openai-compatible", baseUrl: "https://example.invalid/v1", modelId: "fixture", fetcher }))
            .toEqual({ status: "unavailable", reason: "invalid_response" })
    })
    it("明确的按次零价仍可识别，非法usage不能产生负费用", async () => {
        const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: true, data: [{ model_name: "fixture", quota_type: 1, model_price: 0 }], group_ratio: { default: 1 } }))) as unknown as typeof fetch
        const snapshot = await fetchDeepResearchPricingSnapshot({ providerKey: "openai-compatible", baseUrl: "https://example.invalid/v1", modelId: "fixture", fetcher })
        expect(estimateDeepResearchCost({ snapshot, inputTokens: 100, outputTokens: 10, modelCalls: 2 })).toMatchObject({ status: "available", maxUsd: 0 })
        expect(estimateDeepResearchCost({ snapshot, inputTokens: 0, outputTokens: 0, modelCalls: 2, usageComplete: false })).toEqual({ status: "unavailable", reason: "usage_incomplete" })
        expect(estimateDeepResearchCost({ snapshot, inputTokens: -1, outputTokens: 10, modelCalls: 2 })).toEqual({ status: "unavailable", reason: "invalid_usage" })
        expect(estimateDeepResearchCost({ snapshot, inputTokens: 100, outputTokens: NaN, modelCalls: 2 })).toEqual({ status: "unavailable", reason: "invalid_usage" })
    })
    it("匿名读取并校验New API倍率，按真实token估算费用", async () => {
        const fetcher = vi.fn(async () => new Response(JSON.stringify({
            success: true,
            data: [{
                model_name: "gpt-5.6-terra",
                quota_type: 0,
                model_ratio: 1.25,
                completion_ratio: 6,
                model_price: 0,
                enable_groups: ["default"],
            }],
            group_ratio: { default: 1, ignored: 9 },
        }), { status: 200 })) as unknown as typeof fetch

        const snapshot = await fetchDeepResearchPricingSnapshot({
            providerKey: "openai-compatible",
            baseUrl: "https://new.example.com/v1",
            modelId: "gpt-5.6-terra",
            fetcher,
            now: new Date("2026-09-01T00:00:00.000Z"),
        })
        expect(fetcher).toHaveBeenCalledWith(new URL("https://new.example.com/api/pricing"), expect.objectContaining({
            method: "GET",
            headers: { accept: "application/json" },
            redirect: "error",
        }))
        expect(snapshot).toMatchObject({
            status: "available",
            modelRatio: 1.25,
            completionRatio: 6,
            groupRatios: { default: 1 },
        })
        expect(estimateDeepResearchCost({
            snapshot,
            inputTokens: 19_957,
            outputTokens: 1_619,
            modelCalls: 2,
        })).toEqual({
            status: "available",
            minUsd: 0.0741775,
            maxUsd: 0.0741775,
            groupRatios: { default: 1 },
        })
    })

    it("拒绝非HTTPS、IP与非OpenAI-compatible端点", async () => {
        await expect(fetchDeepResearchPricingSnapshot({
            providerKey: "anthropic",
            baseUrl: "https://example.com/v1",
            modelId: "model",
        })).resolves.toEqual({ status: "unavailable", reason: "unsupported_provider" })
        await expect(fetchDeepResearchPricingSnapshot({
            providerKey: "openai-compatible",
            baseUrl: "http://127.0.0.1:3000/v1",
            modelId: "model",
        })).resolves.toEqual({ status: "unavailable", reason: "unsafe_base_url" })
    })
})
