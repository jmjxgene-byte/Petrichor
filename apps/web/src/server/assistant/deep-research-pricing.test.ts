import { describe, expect, it, vi } from "vitest"

import { estimateDeepResearchCost, fetchDeepResearchPricingSnapshot } from "./deep-research-pricing"

describe("deep research pricing snapshot", () => {
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
