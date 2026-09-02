import { describe, expect, it } from "vitest"
import { evidenceForPersistence, sanitizeExternalTracePayload, shouldPersistEvidence } from "./store"

describe("GeneOps Agent 持久化脱敏", () => {
    it("Trace 不保存 GeneOps observation data", () => {
        expect(sanitizeExternalTracePayload({
            source: "geneops.search",
            summary: "命中 2 条",
            data: { rows: [{ content: "sensitive" }] },
        })).toEqual({
            source: "geneops.search",
            summary: "命中 2 条",
            data: { redacted: true },
        })
    })

    it("GeneOps 只落安全引用元数据，其他 ephemeral Evidence 不落证据表", () => {
        const base = {
            id: "e1",
            title: "title",
            content: "content",
            createdAt: 1,
        }
        const geneops = {
            ...base,
            source: "geneops" as const,
            sourceId: "raw-document-id",
            url: "https://example.com/source",
            metadata: {
                ephemeral: true,
                sourceRef: "external-source:1",
                sourceName: "GeneOps",
                queriedAt: "2026-08-27T00:00:00.000Z",
                citationIndex: 1,
                author: "private",
            },
        }
        expect(shouldPersistEvidence(geneops)).toBe(true)
        expect(evidenceForPersistence(geneops)).toMatchObject({
            source: "geneops",
            content: "",
            url: "https://example.com/source",
            metadata: {
                sourceRef: "external-source:1",
                sourceName: "GeneOps",
                queriedAt: "2026-08-27T00:00:00.000Z",
                citationIndex: 1,
                persistedMetadataOnly: true,
            },
        })
        expect(evidenceForPersistence(geneops)).not.toHaveProperty("sourceId")
        expect(JSON.stringify(evidenceForPersistence(geneops))).not.toContain("private")
        expect(shouldPersistEvidence({ ...base, source: "web", metadata: { ephemeral: true } })).toBe(false)
        expect(shouldPersistEvidence({ ...base, source: "knowledge" })).toBe(true)
    })

    it("统一来源工具 Trace 同样脱敏", () => {
        expect(sanitizeExternalTracePayload({
            toolId: "source.search",
            input: { query: "secret query" },
            output: { candidates: ["secret result"] },
        })).toEqual({
            toolId: "source.search",
            input: { redacted: true },
            output: { redacted: true },
        })
    })

    it("调用外部资料源的 Run 不在 Trace 保存问题或计划正文", () => {
        expect(sanitizeExternalTracePayload({ goal: "private query" }, { externalRun: true }))
            .toEqual({ goal: "[redacted]" })
        expect(sanitizeExternalTracePayload({
            steps: [{ label: "研究 private query" }, { label: "回答" }],
        }, { externalRun: true })).toEqual({
            steps: { redacted: true, count: 2 },
        })
    })
})
