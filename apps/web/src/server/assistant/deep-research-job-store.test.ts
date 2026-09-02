import { describe, expect, it } from "vitest"

import type { DeepResearchJobRecord } from "@/server/db/schema"
import {
    DEEP_RESEARCH_JOB_STATUSES,
    deepResearchErrorCodeSchema,
    deepResearchFinalMessageSchema,
    deepResearchRetryPlan,
    deepResearchCapabilitySnapshotSchema,
    toDeepResearchJobResponse,
} from "./deep-research-job-store"

describe("deep research job metadata contract", () => {
    it("状态集合固定且 capability snapshot 拒绝正文载荷", () => {
        expect(DEEP_RESEARCH_JOB_STATUSES).toEqual([
            "queued",
            "running",
            "retry_wait",
            "cancel_requested",
            "cancelled",
            "succeeded",
            "failed",
        ])
        expect(() => deepResearchCapabilitySnapshotSchema.parse({
            contractVersion: 2,
            sourceCutoffs: {},
            allowedModes: ["exact", "fuzzy"],
            wikiReady: false,
            graphReady: false,
            qualityStale: false,
            capturedAt: "2026-09-01T00:00:00.000Z",
            rawChunks: ["forbidden"],
        })).toThrow()
    })

    it("重试退避与错误码保持有限集合", () => {
        expect(deepResearchRetryPlan(1, 3)).toEqual({ status: "retry_wait", delaySeconds: 10 })
        expect(deepResearchRetryPlan(2, 3)).toEqual({ status: "retry_wait", delaySeconds: 30 })
        expect(deepResearchRetryPlan(3, 3)).toEqual({ status: "failed", delaySeconds: 0 })
        expect(deepResearchErrorCodeSchema.safeParse("raw-database-error").success).toBe(false)
    })

    it("最终消息只允许文本答案与安全引用元数据", () => {
        const valid = {
            parts: [{ type: "text", text: "深度检索补充结论" }],
            agentRunId: "agent_deep_1",
            deepResearch: {
                runKey: "deep_1",
                fastRunKey: "fast_1",
                references: [{
                    title: "来源标题",
                    url: "https://example.com/source",
                    source: "geneops",
                    sourceKind: "geneops" as const,
                    queriedAt: "2026-09-01T00:00:00.000Z",
                }, {
                    title: "无外链的本地来源",
                    url: null,
                    source: "knowledge",
                    sourceKind: "knowledge" as const,
                    queriedAt: "2026-09-01T00:00:00.000Z",
                }],
            },
        }
        expect(deepResearchFinalMessageSchema.parse(valid)).toEqual(valid)
        expect(() => deepResearchFinalMessageSchema.parse({
            ...valid,
            rawChunks: ["forbidden"],
        })).toThrow()
    })

    it("公开响应不返回幂等键、scope hash 或 lease owner", () => {
        const now = new Date("2026-09-01T00:00:00.000Z")
        const job = {
            id: 1,
            runKey: "deep_1",
            idempotencyKey: "secret-internal-idempotency",
            threadId: 2,
            userId: 3,
            questionMessageId: 4,
            fastRunKey: "fast_1",
            sourceScopeHash: "internal-scope-hash",
            capabilitySnapshotJson: JSON.stringify({
                contractVersion: 2,
                sourceCutoffs: {},
                allowedModes: ["exact", "fuzzy"],
                wikiReady: false,
                graphReady: false,
                qualityStale: false,
                capturedAt: now.toISOString(),
            }),
            status: "queued",
            attemptCount: 0,
            maxAttempts: 3,
            availableAt: now,
            leaseOwner: "internal-worker-id",
            leaseExpiresAt: null,
            heartbeatAt: null,
            errorCode: null,
            resultMessageId: null,
            startedAt: null,
            completedAt: null,
            cancelledAt: null,
            createdAt: now,
            updatedAt: now,
        } satisfies DeepResearchJobRecord

        const response = toDeepResearchJobResponse(job)
        expect(response).toMatchObject({ runKey: "deep_1", status: "queued", maxAttempts: 3 })
        expect(response).not.toHaveProperty("idempotencyKey")
        expect(response).not.toHaveProperty("sourceScopeHash")
        expect(response).not.toHaveProperty("leaseOwner")
    })
})
