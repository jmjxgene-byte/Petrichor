import { describe, expect, it } from "vitest"
import { sanitizeExternalTracePayload, shouldPersistEvidence } from "./store"

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

    it("GeneOps 与显式 ephemeral Evidence 不落证据表", () => {
        const base = {
            id: "e1",
            title: "title",
            content: "content",
            createdAt: 1,
        }
        expect(shouldPersistEvidence({ ...base, source: "geneops" })).toBe(false)
        expect(shouldPersistEvidence({ ...base, source: "web", metadata: { ephemeral: true } })).toBe(false)
        expect(shouldPersistEvidence({ ...base, source: "knowledge" })).toBe(true)
    })
})
