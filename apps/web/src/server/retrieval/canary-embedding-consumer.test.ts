import { describe, expect, it } from "vitest"
import { buildDocumentPassages, hashDocumentText } from "@/server/doc-library/passage-builder"
import { planGroundedCanary } from "@/server/retrieval/grounded-canary-plan"
import { syntheticQaDataset } from "@/server/retrieval/fixtures/grounded-qa-v1"
import { cosineSimilarity, evaluateOfflineEmbeddingCorpus, type OfflineEmbeddingCorpus, type OfflinePassage } from "../../../scripts/canary-embedding-consumer"

function vector(seed: number) {
    const result: number[] = Array.from({ length: 1024 }, (_, index) => index === seed % 1024 ? 1 : 0)
    result[(seed + 1) % 1024] = 0.25
    return result
}

function corpus(): OfflineEmbeddingCorpus {
    const plan = planGroundedCanary(), documents: OfflinePassage[] = []
    for (const item of plan.documents) {
        const source = syntheticQaDataset.documents.find(document => document.id === item.id)!
        const passages = buildDocumentPassages(source.text, source.title)
        passages.forEach((passage, index) => documents.push({ ...passage, id: `${source.id}:${index}`, documentId: source.id,
            title: source.title, sourceHash: hashDocumentText(source.text), vector: vector(index) }))
    }
    return { executionId: "00000000-0000-4000-8000-000000000001", planHash: plan.planHash, documents, queryVectors: Array.from({ length: 8 }, (_, index) => vector(index)) }
}

describe("已持久化嵌入消费与锚点映射", () => {
    it("余弦相似度固定维度并拒绝零/非有限向量", () => {
        expect(cosineSimilarity(vector(1), vector(1))).toBe(1)
        expect(cosineSimilarity(vector(1), vector(2))).toBeLessThan(1)
        expect(() => cosineSimilarity(Array(1024).fill(0), vector(1))).toThrow("zero_vector")
        const invalid = vector(1); invalid[5] = Number.NaN
        expect(() => cosineSimilarity(invalid, vector(1))).toThrow("nonfinite")
        expect(() => cosineSimilarity(Array(1023).fill(1), vector(1))).toThrow("dimensions")
    })
    it("生成词法/语义/RRF报告并为靠后片段建立窗口锚点", () => {
        const report = evaluateOfflineEmbeddingCorpus(corpus())
        expect(report).toMatchObject({ scope: "offline_component_preview", documents: 3, passages: 48, modelCalls: 0, databaseCalls: 0,
            rawVectorsPersisted: false, rawTextPersisted: false, productionIndexWrites: 0 })
        expect(report.cases).toHaveLength(8)
        expect(report.cases.filter(item => item.goldCount > 0).every(item => item.unmappedGold === 0 && item.anchors.length === item.goldCount)).toBe(true)
        const late = report.cases.find(item => item.id === "late-1")!
        expect(late.anchors[0].id).toMatch(/:45$/)
        expect(late.anchors[0].indices).toContain(45)
        expect(report.cases.every(item => !("query" in item) && !("text" in item) && !("vector" in item))).toBe(true)
    })
    it("缺失或不完整的真实批次终态拒绝消费", async () => {
        await expect(import("../../../scripts/canary-embedding-consumer").then(({ loadOfflineEmbeddingCorpus }) => loadOfflineEmbeddingCorpus("/private/tmp/does-not-exist"))).rejects.toThrow()
    })
})
