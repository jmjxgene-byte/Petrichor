import { describe, expect, it } from "vitest"

import { assistantSourceRefSchema } from "@/lib/assistant-source-contract"
import { demoAssistantSourceRef } from "@/lib/demo/demo-mode"

describe("demoAssistantSourceRef", () => {
    it("maps readable demo IDs to stable production-shaped refs", () => {
        const first = demoAssistantSourceRef("knowledge-base", "demo-kb-product")
        const second = demoAssistantSourceRef("knowledge-base", "demo-kb-product")

        expect(first).toBe(second)
        expect(assistantSourceRefSchema.safeParse(first).success).toBe(true)
    })

    it("keeps source kinds isolated", () => {
        expect(demoAssistantSourceRef("knowledge-base", "demo-source"))
            .not.toBe(demoAssistantSourceRef("doc-library", "demo-source"))
    })
})
