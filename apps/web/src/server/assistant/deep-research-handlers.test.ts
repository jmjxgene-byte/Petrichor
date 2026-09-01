import { describe, expect, it } from "vitest"

import type { AssistantSourceCatalogItem } from "@/lib/assistant-source-contract"
import { buildDeepResearchCapabilitySnapshot, buildDeepResearchSourceScopeHash } from "./deep-research-contract"

const externalSource: AssistantSourceCatalogItem = {
    ref: "external-source:1",
    kind: "external-source",
    id: "1",
    name: "GeneOps",
    description: null,
    availability: "ready",
    selectable: true,
    unavailableReason: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    capabilities: {
        searchModes: ["exact", "fuzzy", "hybrid"],
        contractVersion: 2,
        sourceCutoffs: { wearesellers: "2026-08-27T00:00:00.000Z" },
        wikiReady: true,
        graphReady: true,
        qualityStale: false,
    },
}

describe("deep research capability snapshot", () => {
    it("默认 flags 只允许已声明的 Exact/Fuzzy", () => {
        const snapshot = buildDeepResearchCapabilitySnapshot([externalSource], {
            enabled: false,
            autoStart: false,
            workerEnabled: false,
            hybridEnabled: false,
            wikiEnabled: false,
            graphV2Enabled: false,
        }, new Date("2026-09-01T00:00:00.000Z"))

        expect(snapshot).toEqual({
            contractVersion: 2,
            sourceCutoffs: { wearesellers: "2026-08-27T00:00:00.000Z" },
            allowedModes: ["exact", "fuzzy"],
            wikiReady: false,
            graphReady: false,
            qualityStale: false,
            capturedAt: "2026-09-01T00:00:00.000Z",
        })
    })

    it("仅本地资料仍允许确定性的 Exact 检索", () => {
        const localSource: AssistantSourceCatalogItem = {
            ...externalSource,
            ref: "knowledge-base:1",
            kind: "knowledge-base",
            capabilities: null,
        }
        const snapshot = buildDeepResearchCapabilitySnapshot([localSource], {
            enabled: true,
            autoStart: false,
            workerEnabled: true,
            hybridEnabled: false,
            wikiEnabled: false,
            graphV2Enabled: false,
        })
        expect(snapshot.allowedModes).toEqual(["exact"])
        expect(snapshot.contractVersion).toBeNull()
    })

    it("source scope hash 只由规范化请求范围决定", () => {
        const first = buildDeepResearchSourceScopeHash({
            sourceScope: { mode: "selected", refs: ["external-source:2", "knowledge-base:1"] },
        })
        const second = buildDeepResearchSourceScopeHash({
            sourceScope: { mode: "selected", refs: ["knowledge-base:1", "external-source:2"] },
        })
        expect(second).toBe(first)
    })

    it("Hybrid/Wiki/Graph 必须同时被 capability 与 feature flag 允许", () => {
        const snapshot = buildDeepResearchCapabilitySnapshot([externalSource], {
            enabled: true,
            autoStart: false,
            workerEnabled: true,
            hybridEnabled: true,
            wikiEnabled: true,
            graphV2Enabled: true,
        })
        expect(snapshot.allowedModes).toContain("hybrid")
        expect(snapshot.wikiReady).toBe(true)
        expect(snapshot.graphReady).toBe(true)
    })
})
