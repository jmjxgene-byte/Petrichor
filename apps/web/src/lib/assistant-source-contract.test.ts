import { describe, expect, it } from "vitest"

import {
  ASSISTANT_SOURCE_SELECTION_MAX,
  assistantSourceRef,
  assistantSourceScopeSchema,
  parseAssistantSourceRef,
} from "./assistant-source-contract"

describe("assistant source contract", () => {
  it("creates and parses stable source refs", () => {
    expect(assistantSourceRef("external-source", 7)).toBe("external-source:7")
    expect(parseAssistantSourceRef("knowledge-base:12")).toEqual({
      kind: "knowledge-base",
      id: 12,
    })
  })

  it("deduplicates and sorts selected refs", () => {
    expect(assistantSourceScopeSchema.parse({
      mode: "selected",
      refs: ["external-source:2", "doc-library:3", "external-source:2"],
    })).toEqual({
      mode: "selected",
      refs: ["doc-library:3", "external-source:2"],
    })
  })

  it("rejects empty selections, invalid ids and more than twenty refs", () => {
    expect(() => assistantSourceScopeSchema.parse({ mode: "selected", refs: [] })).toThrow()
    expect(() => assistantSourceScopeSchema.parse({ mode: "selected", refs: ["external-source:0"] })).toThrow()
    expect(() => assistantSourceScopeSchema.parse({
      mode: "selected",
      refs: Array.from({ length: ASSISTANT_SOURCE_SELECTION_MAX + 1 }, (_, index) => `knowledge-base:${index + 1}`),
    })).toThrow()
  })

})
