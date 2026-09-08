import { describe, expect, it } from "vitest"

import {
    buildDeepResearchReferenceKey,
    normalizeDeepResearchAnswer,
    normalizeDeepResearchUrl,
    toDeepResearchReferences,
    toMetadataOnlyAgentEvidence,
    deepResearchCitationIndices,
    validateDeepResearchCitations,
} from "./deep-research-output"
import type { DeepResearchEvidence } from "./deep-research-pipeline"
import { deepResearchFinalMessageSchema } from "./deep-research-job-store"
import { deepResearchRetryPlan } from "./deep-research-job-store"
import { persistedDeepResearchEvidence, extractPersistedMessageMetadata } from "@/features/pages/assistant/assistant-message-utils"

const evidence: DeepResearchEvidence[] = [{
    referenceKey: "url:example.com/source",
    title: "来源标题",
    content: "仅在当前Run内使用的正文",
    source: "geneops",
    sourceName: "GeneOps 生产知识",
    url: "https://example.com/source",
    queriedAt: "2026-09-01T00:00:00.000Z",
}]

describe("deep research output contract", () => {
    it("Deep引用也不允许以辅助总结代替资料原文", () => {
        for (const source of ["subagent", "memory", "tool", "graph", "web"]) {
            expect(validateDeepResearchCitations("总结结论[1]", [{ ...evidence[0], source }]).valid).toBe(false)
        }
        expect(validateDeepResearchCitations("资料结论[1]", evidence).valid).toBe(true)
    })
    it("位置未核验标记随Deep历史恢复，正文不随引用保存", () => {
        const items = [{ ...evidence[0], anchorVerified: false as const }]
        const references = toDeepResearchReferences(items)
        const message = deepResearchFinalMessageSchema.parse({ parts: [{ type: "text", text: "合成回答[1]" }], agentRunId: "deep-fixture", deepResearch: { runKey: "deep-fixture", fastRunKey: null, references } })
        expect(persistedDeepResearchEvidence(extractPersistedMessageMetadata(message))[0].anchorVerified).toBe(false)
        expect(toMetadataOnlyAgentEvidence(items)[0].metadata?.anchorVerified).toBe(false)
        expect(JSON.stringify(references)).not.toContain("仅在当前Run内使用的正文")
    })
    it("已消耗模型调用的失败不重新排队", () => {
        expect(deepResearchRetryPlan(1, 3, false)).toEqual({ status: "failed", delaySeconds: 0 })
        expect(deepResearchRetryPlan(1, 3, true).status).toBe("retry_wait")
    })
    it("本地多锚点与外部混合引用在保存、刷新后共享同一编号", () => {
        const local = [1, 2].map((passage): DeepResearchEvidence => {
            const url = `/dashboard/doc-library/3?documentId=9&generationId=4&passageId=${passage}&contentHash=${"a".repeat(64)}`
            return { ...evidence[0], source: "document", sourceName: "本地", url, referenceKey: buildDeepResearchReferenceKey({ source: "document", title: "本地", url, fallbackKey: "fallback" }) }
        })
        expect(local[0].referenceKey).not.toBe(local[1].referenceKey)
        const items = [...local, evidence[0]]
        expect(deepResearchCitationIndices(items)).toEqual([1, 1, 2])
        expect(validateDeepResearchCitations("合成结论[1][2]", items).valid).toBe(true)
        expect(validateDeepResearchCitations("并不存在第三来源[3]", items).valid).toBe(false)
        expect(validateDeepResearchCitations("不存在[99]", items).valid).toBe(false)
        expect(validateDeepResearchCitations("无引用结论", items).valid).toBe(false)
        const references = toDeepResearchReferences(items)
        const message = deepResearchFinalMessageSchema.parse({ parts: [{ type: "text", text: "合成结论[1][2]" }], agentRunId: "deep-fixture", deepResearch: { runKey: "deep-fixture", fastRunKey: null, references } })
        const restored = persistedDeepResearchEvidence(extractPersistedMessageMetadata(message))
        expect(restored.map((item) => item.citationIndex)).toEqual([1, 1, 2])
        expect(restored.map((item) => item.url)).toEqual(items.map((item) => item.url))
        expect(toMetadataOnlyAgentEvidence(items).map((item) => item.metadata?.citationIndex)).toEqual([1, 1, 2])
    })
    it("仅允许已知本站路由，正文参数不落引用元数据", () => {
        const raw = `/dashboard/doc-library/3?documentId=9&citeSnippet=private-body&hlText=private-body`
        expect(normalizeDeepResearchUrl(raw, "document")).toBe("/dashboard/doc-library/3?documentId=9")
        expect(normalizeDeepResearchUrl(raw, "geneops")).toBeNull()
        for (const url of ["//external.invalid", "/admin", "javascript:alert(1)", "https://user:secret@example.invalid"]) expect(normalizeDeepResearchUrl(url, "document")).toBeNull()
        const references = toDeepResearchReferences([{ ...evidence[0], source: "document", url: raw }])
        expect(JSON.stringify(references)).not.toContain("private-body")
        expect(JSON.stringify(toMetadataOnlyAgentEvidence([{ ...evidence[0], source: "document", url: raw }]))).not.toContain("private-body")
    })
    it("规范化URL作为稳定引用键", () => {
        expect(buildDeepResearchReferenceKey({
            source: "geneops",
            title: "标题",
            url: "http://www.example.com/source/?utm_source=test#answer",
            fallbackKey: "fallback",
        })).toBe("url:https://example.com/source")
        expect(normalizeDeepResearchUrl("https://example.com/source#!answer_1"))
            .toBe("https://example.com/source#!answer_1")
    })

    it("移除模型重复标题并由系统统一添加一次", () => {
        expect(normalizeDeepResearchAnswer("## 深度检索补充\n\n# 深度检索补充\n\n结论 [1]"))
            .toBe("结论 [1]")
    })

    it("references与Agent Evidence保持同序且不持久化正文", () => {
        expect(toDeepResearchReferences(evidence)).toEqual([{
            title: "来源标题",
            url: "https://example.com/source",
            source: "GeneOps 生产知识",
            sourceKind: "geneops",
            queriedAt: "2026-09-01T00:00:00.000Z",
        }])
        const persisted = toMetadataOnlyAgentEvidence(evidence, 1_000)
        expect(persisted).toHaveLength(1)
        expect(persisted[0]).toMatchObject({
            source: "geneops",
            title: "来源标题",
            content: "",
            url: "https://example.com/source",
            metadata: {
                sourceName: "GeneOps 生产知识",
                queriedAt: "2026-09-01T00:00:00.000Z",
                citationIndex: 1,
                persistedMetadataOnly: true,
            },
        })
        expect(JSON.stringify(persisted)).not.toContain("当前Run内使用")
    })
})
