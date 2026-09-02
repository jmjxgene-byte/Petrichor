// @vitest-environment jsdom

import { renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

const assistantState = vi.hoisted(() => ({
    message: {
        metadata: {
            custom: {
                deepResearch: {
                    references: [{
                        title: "来源一",
                        url: "https://example.com/source",
                        source: "GeneOps",
                        sourceKind: "geneops",
                        queriedAt: "2026-09-02T00:00:00.000Z",
                    }],
                },
            },
        },
    },
}))

vi.mock("@assistant-ui/react", () => ({
    useAuiState: (selector: (state: typeof assistantState) => unknown) => selector(assistantState),
}))

import { usePersistedDeepResearchEvidence } from "./use-persisted-deep-research-evidence"

describe("usePersistedDeepResearchEvidence", () => {
    it("metadata 未变化时保持派生 Evidence 引用稳定", () => {
        const { result, rerender } = renderHook(() => usePersistedDeepResearchEvidence())
        const initial = result.current

        rerender()

        expect(result.current).toBe(initial)
        expect(result.current).toHaveLength(1)
    })
})
