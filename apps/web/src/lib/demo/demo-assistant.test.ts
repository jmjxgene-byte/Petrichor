import { describe, expect, it } from "vitest"

import { normalizeDemoAssistantFocus } from "@/lib/demo/demo-assistant"

describe("normalizeDemoAssistantFocus", () => {
    it("keeps a valid multi-source scope for thread restore", () => {
        expect(normalizeDemoAssistantFocus({
            sourceScope: {
                mode: "selected",
                refs: ["knowledge-base:456260224", "external-source:1"],
            },
        })).toEqual({
            sourceScope: {
                mode: "selected",
                refs: ["external-source:1", "knowledge-base:456260224"],
            },
        })
    })

    it("rejects malformed source refs instead of persisting them", () => {
        expect(normalizeDemoAssistantFocus({
            sourceScope: { mode: "selected", refs: ["knowledge-base:demo-kb-product"] },
        })).toBeNull()
    })
})
