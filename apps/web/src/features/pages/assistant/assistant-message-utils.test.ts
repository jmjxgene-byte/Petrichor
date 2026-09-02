import { describe, expect, it } from "vitest"
import {
    focusFromThread,
    focusToRequestBody,
    extractPersistedMessageMetadata,
    persistedDeepResearchEvidence,
    readPersistedAgentRunId,
    readPersistedDeepResearchReferences,
    readPersistedTiming,
    sourceScopesEqual,
    toInitialMessages,
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

describe("deep research persisted message metadata", () => {
    it("保留Run关联与安全引用，过滤非法URL和多余字段", () => {
        const metadata = extractPersistedMessageMetadata({
            agentRunId: "deep_run_1",
            deepResearch: {
                runKey: "deep_run_1",
                references: [{
                    title: "来源一",
                    url: "https://example.com/source",
                    source: "GeneOps",
                    sourceKind: "geneops",
                    queriedAt: "2026-09-01T00:00:00.000Z",
                    snippet: "不得保留",
                }, {
                    title: "恶意链接",
                    url: "javascript:alert(1)",
                    source: "GeneOps",
                    queriedAt: "2026-09-01T00:00:00.000Z",
                }],
            },
        })

        expect(metadata).toEqual({
            custom: {
                agentRunId: "deep_run_1",
                deepResearch: {
                    runKey: "deep_run_1",
                    references: [{
                        title: "来源一",
                        url: "https://example.com/source",
                        source: "GeneOps",
                        sourceKind: "geneops",
                        queriedAt: "2026-09-01T00:00:00.000Z",
                    }],
                },
            },
        })
        expect(readPersistedDeepResearchReferences(metadata)).toHaveLength(1)
        expect(readPersistedAgentRunId(metadata)).toBe("deep_run_1")
        expect(persistedDeepResearchEvidence(metadata)).toEqual([{
            id: "deep-reference-1",
            source: "geneops",
            title: "来源一",
            url: "https://example.com/source",
            sourceName: "GeneOps",
            queriedAt: "2026-09-01T00:00:00.000Z",
            citationIndex: 1,
        }])
        expect(JSON.stringify(metadata)).not.toContain("不得保留")
    })

    it("历史Deep消息重复标题归一为一个", () => {
        const messages = toInitialMessages([{
            id: "1",
            role: "assistant",
            content: {
                parts: [{ type: "text", text: "## 深度检索补充\n\n# 深度检索补充\n\n结论 [1]" }],
                agentRunId: "deep_run_1",
                deepResearch: {
                    references: [{
                        title: "来源一",
                        url: "https://example.com/source",
                        source: "GeneOps",
                        sourceKind: "geneops",
                        queriedAt: "2026-09-01T00:00:00.000Z",
                    }],
                },
            },
        }])
        expect(messages[0]?.parts).toEqual([{ type: "text", text: "## 深度检索补充\n\n结论 [1]" }])
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
