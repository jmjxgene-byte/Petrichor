import { describe, expect, it } from "vitest"
import {
    focusFromThread,
    focusToRequestBody,
    readPersistedTiming,
    sourceScopesEqual,
} from "./assistant-message-utils"

describe("assistant source scope messages", () => {
    it("new messages persist explicit all scope", () => {
        expect(focusToRequestBody({ mode: "all" })).toEqual({ sourceScope: { mode: "all" } })
        expect(focusToRequestBody({ mode: "selected", refs: ["knowledge-base:3"] })).toEqual({
            sourceScope: { mode: "selected", refs: ["knowledge-base:3"] },
            knowledgeBaseId: "3",
        })
    })

    it("legacy empty focus remains local-only", () => {
        expect(focusFromThread(null)).toEqual({ mode: "local" })
        expect(focusFromThread({ knowledgeBaseId: "3" })).toEqual({
            mode: "selected",
            refs: ["knowledge-base:3"],
        })
    })

    it("compares canonical multi-source scopes", () => {
        expect(sourceScopesEqual(
            { mode: "selected", refs: ["doc-library:1", "external-source:2"] },
            { mode: "selected", refs: ["doc-library:1", "external-source:2"] },
        )).toBe(true)
    })
})

describe("readPersistedTiming", () => {
    it("从 custom 扁平字段读取", () => {
        expect(readPersistedTiming({
            custom: { totalStreamTime: 1200, tokensPerSecond: 40, firstTokenTime: 200 },
        })).toEqual({
            firstTokenTime: 200,
            totalStreamTime: 1200,
            tokensPerSecond: 40,
            totalChunks: 0,
        })
    })

    it("兼容 metadata.timing 嵌套", () => {
        expect(readPersistedTiming({
            timing: { totalStreamTime: 800, tokensPerSecond: 12.5, totalChunks: 3 },
        })).toEqual({
            firstTokenTime: undefined,
            totalStreamTime: 800,
            tokensPerSecond: 12.5,
            totalChunks: 3,
        })
    })

    it("无耗时时返回 undefined", () => {
        expect(readPersistedTiming({ custom: { usage: { totalTokens: 10 } } })).toBeUndefined()
        expect(readPersistedTiming(null)).toBeUndefined()
    })
})
