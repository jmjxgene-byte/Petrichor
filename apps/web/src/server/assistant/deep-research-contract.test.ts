import { describe, expect, it } from "vitest"
import { buildDeepResearchCapabilitySnapshot, deepResearchModeFocuses, searchDeepResearchMode } from "./deep-research-contract"
import { deepResearchCapabilitySnapshotSchema } from "./deep-research-job-store"
import type { AssistantSourceCatalogItem } from "@/lib/assistant-source-contract"
const flags = { enabled: false, workerEnabled: false, autoStart: false, hybridEnabled: false, wikiEnabled: false, graphV2Enabled: false }
const date = new Date("2026-09-08T00:00:00Z")
function source(id: string, kind: AssistantSourceCatalogItem["kind"], capabilities: AssistantSourceCatalogItem["capabilities"] = null): AssistantSourceCatalogItem {
    return { id, ref: `${kind}:${id}`, kind, name: "合成", description: "", availability: "ready", selectable: true, unavailableReason: null, updatedAt: date.toISOString(), capabilities }
}
describe("Deep逐源能力快照", () => {
    it("一个来源批次失败不丢弃其他批次，失败计数单独保留", async () => {
        const snapshot = buildDeepResearchCapabilitySnapshot(Array.from({ length: 41 }, (_, index) => source(String(index + 1), "doc-library")), flags, date)
        let calls = 0
        const result = await searchDeepResearchMode(snapshot, {}, "exact", new AbortController().signal, async () => {
            if (++calls === 2) throw new Error("private_error")
            return { candidates: [{ candidateKey: String(calls), title: "合成", sourceName: "合成", url: null, score: 1, read: {} }] }
        })
        expect(calls).toBe(3)
        expect(result.candidates.map((candidate) => candidate.candidateKey)).toEqual(["1", "3"])
        expect(result.failedSearches).toBe(1)
        expect(JSON.stringify(result)).not.toContain("private_error")
    })
    it("保留不同外部版本/cutoff，本地只参加exact而不重复fuzzy", () => {
        const a = source("1", "external-source", { searchModes: ["exact", "fuzzy"], contractVersion: 1, sourceCutoffs: { source: "old" } })
        const b = source("2", "external-source", { searchModes: ["exact"], contractVersion: 2, sourceCutoffs: { source: "new" } })
        const local = source("3", "doc-library")
        const snapshot = buildDeepResearchCapabilitySnapshot([a, b, local], flags, date)
        expect(snapshot.sources).toEqual(expect.arrayContaining([expect.objectContaining({ sourceRef: a.ref, contractVersion: 1, sourceCutoffs: { source: "old" } }), expect.objectContaining({ sourceRef: b.ref, contractVersion: 2, sourceCutoffs: { source: "new" } })]))
        expect(deepResearchModeFocuses(snapshot, {}, "fuzzy")).toEqual([{ sourceScope: { mode: "selected", refs: [a.ref] } }])
        expect(buildDeepResearchCapabilitySnapshot([local, b, a], flags, date)).toEqual(snapshot)
    })
    it("陈旧外部源不扩展权限，混合范围仍能查询本地", () => {
        const stale = source("1", "external-source", { searchModes: ["exact", "fuzzy", "hybrid"], qualityStale: true })
        const snapshot = buildDeepResearchCapabilitySnapshot([stale, source("2", "doc-library")], flags, date)
        expect(snapshot.allowedModes).toEqual(["exact"])
        expect(deepResearchModeFocuses(snapshot, {}, "exact")).toEqual([{ sourceScope: { mode: "selected", refs: ["doc-library:2"] } }])
        expect(deepResearchModeFocuses(snapshot, {}, "fuzzy")).toEqual([])
    })
    it("all超过20来源分批完整覆盖，旧快照保留原focus", () => {
        const snapshot = buildDeepResearchCapabilitySnapshot(Array.from({ length: 41 }, (_, index) => source(String(index + 1), "doc-library")), flags, date)
        const batches = deepResearchModeFocuses(snapshot, {}, "exact") as Array<{ sourceScope: { refs: string[] } }>
        expect(batches.map((batch) => batch.sourceScope.refs.length)).toEqual([20, 20, 1])
        expect(new Set(batches.flatMap((batch) => batch.sourceScope.refs)).size).toBe(41)
        const { sources: _sources, ...legacy } = snapshot
        const focus = { libraryId: "3" }
        expect(deepResearchModeFocuses(legacy, focus, "fuzzy")).toEqual([focus])
        expect(deepResearchCapabilitySnapshotSchema.safeParse({ ...snapshot, sources: [snapshot.sources![0], snapshot.sources![0]] }).success).toBe(false)
    })
})
