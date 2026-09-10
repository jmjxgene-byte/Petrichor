import { describe, expect, it } from "vitest"
import { buildDocumentPassages, hashDocumentText } from "@/server/doc-library/passage-builder"
import { planGroundedCanary } from "@/server/retrieval/grounded-canary-plan"
import { syntheticQaDataset } from "@/server/retrieval/fixtures/grounded-qa-v1"
import { prepareRerankPreflight } from "../../../scripts/canary-rerank-preflight"
import type { OfflineEmbeddingCorpus, OfflinePassage } from "../../../scripts/canary-embedding-consumer"
function corpus(): OfflineEmbeddingCorpus {
    const plan = planGroundedCanary(), documents: OfflinePassage[] = []
    for (const item of plan.documents) {
        const source = syntheticQaDataset.documents.find(document => document.id === item.id)!
        buildDocumentPassages(source.text, source.title).forEach((passage, index) => documents.push({ ...passage, id: `${source.id}:${index}`, documentId: source.id,
            title: source.title, sourceHash: hashDocumentText(source.text), vector: Array.from({ length: 1024 }, (_, n) => n === index ? 1 : 0) }))
    }
    return { executionId: "00000000-0000-4000-8000-000000000001", planHash: plan.planHash, documents,
        queryVectors: Array.from({ length: 8 }, (_, index) => Array.from({ length: 1024 }, (_, n) => n === index ? 1 : 0)) }
}
describe("重排阶段预检", () => {
    it("只生成受限请求摘要，最多20候选且不写入正文", () => {
        const result = prepareRerankPreflight(corpus()), { requests, ...safe } = result
        expect(safe).toMatchObject({ phase: "rerank", model: "BAAI/bge-reranker-v2-m3", modelCalls: 0, databaseCalls: 0,
            requiresSeparateApproval: true, rerankerProfileVerified: false })
        expect(safe.requestCount).toBe(requests.length)
        expect(safe.maxCandidates).toBeLessThanOrEqual(20)
        expect(requests.every(request => request.kind === "rerank" && typeof request.body === "object")).toBe(true)
        expect(JSON.stringify(safe)).not.toContain("synthetic-topic")
        expect(JSON.stringify(safe)).not.toContain("来源发布时间")
    })
    it("同一候选集合的请求集哈希稳定，未来变更可被发现", () => {
        const one = prepareRerankPreflight(corpus()), two = prepareRerankPreflight(corpus())
        expect(one.requestSetHash).toBe(two.requestSetHash)
        const changed = corpus(); changed.documents[0].text += " drift"
        expect(prepareRerankPreflight(changed).requestSetHash).not.toBe(one.requestSetHash)
    })
})
