import { z } from "zod"
import { buildDocumentPassages, hashDocumentText } from "@/server/doc-library/passage-builder"
import { syntheticQaDataset } from "./fixtures/grounded-qa-v1"

export const FROZEN_QA_DATASET_SHA = "55eee733924fcda56d2ad3f6ff52bb4b546a6564db9e6bf858639f3d42d3ba1e"
const selection = z.array(z.string().min(1)).min(1).max(3).refine(ids => new Set(ids).size === ids.length, "duplicate_document")
export const DEFAULT_CANARY_DOCUMENTS = ["synthetic-topic-1", "timeline-old", "timeline-new"]

function freezeCheck() {
    if (hashDocumentText(JSON.stringify(syntheticQaDataset)) !== FROZEN_QA_DATASET_SHA) throw new Error("dataset_changed")
}

/** 只计算白名单合成资料；没有数据库、SDK、网络或execute入口。 */
export function planGroundedCanary(rawIds: unknown = DEFAULT_CANARY_DOCUMENTS) {
    freezeCheck()
    const ids = selection.parse(rawIds).sort()
    const documents = ids.map(id => {
        const document = syntheticQaDataset.documents.find(doc => doc.id === id)
        if (!document) throw new Error("unknown_synthetic_document")
        const passages = buildDocumentPassages(document.text, document.title)
        return { id, sourceHash: hashDocumentText(document.text), sourceBytes: Buffer.byteLength(document.text),
            passageCount: passages.length, passageTextBytes: passages.reduce((n, p) => n + Buffer.byteLength(p.text), 0),
            maxPassageBytes: Math.max(...passages.map(p => Buffer.byteLength(p.text))),
            passageSetHash: hashDocumentText(JSON.stringify(passages.map(p => ({ index: p.passageIndex, hash: p.contentHash, start: p.startOffset, end: p.endOffset })))),
            embeddingRequestsAtBatch4: Math.ceil(passages.length / 4),
        }
    })
    const included = syntheticQaDataset.cases.filter(row => row.scope.every(id => ids.includes(id)))
    const contract = { datasetSha: FROZEN_QA_DATASET_SHA, documents, caseIds: included.map(row => row.id) }
    return { mode: "plan_only", authorizedToExecute: false, planHash: hashDocumentText(JSON.stringify(contract)), ...contract,
        totals: { documents: documents.length, passages: documents.reduce((n, d) => n + d.passageCount, 0),
            sourceBytes: documents.reduce((n, d) => n + d.sourceBytes, 0), passageTextBytes: documents.reduce((n, d) => n + d.passageTextBytes, 0),
            embeddingRequestsAtBatch4: documents.reduce((n, d) => n + d.embeddingRequestsAtBatch4, 0),
            cases: included.length },
        pricing: { verifiedForThisBatch: false, cost: null, exactTokens: null },
        limits: { documents: 3, embeddingBatchSize: 4, concurrentRequests: 1, retries: 0 },
        notes: ["synthetic_only", "not_the_full_60_case_eval", "request_count_excludes_query_embeddings_and_rerank", "bytes_are_not_tokens", "no_production_or_models_called"],
    }
}

/** 人工评审草稿必须保持未知结果为空；不能直接作为通过报告输入。 */
export function createGroundedReviewTemplate() {
    freezeCheck()
    return { datasetSha: FROZEN_QA_DATASET_SHA, scope: "synthetic_engineering_draft", readyForEvaluation: false,
        cases: syntheticQaDataset.cases.map(row => ({ id: row.id, group: row.group, semantic: row.semantic,
            question: row.question, history: row.history, scope: row.scope,
            draftExpectedResolution: row.expectedResolution, draftExpectedEvidence: row.evidence,
            humanGoldStatus: "pending", reviewer: null, actualRunId: null, actualAnswer: null,
            actualRetrievedIds: null, actualReadIds: null, baselineRunId: null,
            claims: null, reviewedClaims: null, supportedClaims: null, notes: null,
        })),
    }
}
