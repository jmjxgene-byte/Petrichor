import { describe, expect, it } from "vitest"
import {
    isExternalMetadataOnlyTool,
    redactAssistantStepInput,
    sanitizeAssistantMessageContentForPersistence,
    sanitizeAssistantStepPayload,
} from "./thread-logic"

describe("redactAssistantStepInput", () => {
    it("脱敏 apiKey 等敏感字段", () => {
        expect(redactAssistantStepInput({
            configId: 1,
            apiKey: "sk-secret",
            nested: { password: "p", keep: "ok" },
        })).toEqual({
            configId: 1,
            apiKey: "[redacted]",
            nested: { password: "[redacted]", keep: "ok" },
        })
    })

    it("非对象原样返回", () => {
        expect(redactAssistantStepInput("x")).toBe("x")
        expect(redactAssistantStepInput(null)).toBeNull()
    })
})

describe("外部资料源 Assistant Step 脱敏", () => {
    it.each([
        "source.lookup",
        "lookup_sources",
        "search_sources",
        "read_source",
        "geneops.search",
        "geneops_read_chunks",
        "geneops_graph_expand",
    ])("%s 只保存元数据标记", (toolName) => {
        expect(isExternalMetadataOnlyTool(toolName)).toBe(true)
        expect(sanitizeAssistantStepPayload(toolName, {
            query: "private query",
            content: "private result",
        })).toEqual({
            redacted: true,
            reason: "external-source-metadata-only",
        })
    })

    it("普通站内工具仍沿用现有载荷策略", () => {
        const payload = { query: "knowledge query" }
        expect(sanitizeAssistantStepPayload("search_knowledge", payload)).toBe(payload)
    })
})

describe("外部资料源 Assistant Message 脱敏", () => {
    it("保留对话问题、最终回答和安全引用元数据，但移除 GeneOps snippet", () => {
        const content = {
            parts: [
                { type: "text", text: "允许保存的最终回答" },
                {
                    type: "data-agent-event",
                    data: {
                        runId: "run-1",
                        sequence: 1,
                        type: "agent_started",
                        payload: { goal: "private query", model: "m", conversationId: "c" },
                    },
                },
                {
                    type: "data-agent-event",
                    data: {
                        runId: "run-1",
                        sequence: 2,
                        type: "tool_completed",
                        payload: { toolId: "source.lookup", summary: "命中 1 条" },
                    },
                },
                {
                    type: "data-agent-event",
                    data: {
                        runId: "run-1",
                        sequence: 3,
                        type: "evidence_created",
                        payload: { evidence: [{
                            id: "e1",
                            source: "geneops",
                            title: "安全标题",
                            snippet: "private result",
                            url: "https://example.com/source",
                            sourceName: "GeneOps",
                            queriedAt: "2026-08-27T00:00:00.000Z",
                            citationIndex: 1,
                        }] },
                    },
                },
            ],
            agentRunId: "run-1",
        }

        const persisted = sanitizeAssistantMessageContentForPersistence(content)
        expect(JSON.stringify(persisted)).toContain("允许保存的最终回答")
        expect(JSON.stringify(persisted)).toContain("安全标题")
        expect(JSON.stringify(persisted)).toContain("private query")
        expect(JSON.stringify(persisted)).not.toContain("private result")
    })

    it("没有外部资料事件时保持现有消息形状", () => {
        const content = { parts: [{ type: "text", text: "local" }] }
        expect(sanitizeAssistantMessageContentForPersistence(content)).toBe(content)
    })
})
