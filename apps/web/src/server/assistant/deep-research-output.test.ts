import { describe, expect, it } from "vitest"

import {
    buildDeepResearchReferenceKey,
    normalizeDeepResearchAnswer,
    normalizeDeepResearchUrl,
    toDeepResearchReferences,
    toMetadataOnlyAgentEvidence,
} from "./deep-research-output"
import type { DeepResearchEvidence } from "./deep-research-pipeline"

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
