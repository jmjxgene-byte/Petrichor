import { describe, expect, it } from "vitest"

import type { DeepResearchJobRecord } from "@/server/db/schema"
import {
    DEEP_RESEARCH_JOB_STATUSES,
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
