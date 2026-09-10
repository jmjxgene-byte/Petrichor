import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { assertPrivateSpoolDirectory, describeArtifact, readPrivateSpoolFile } from "./canary-artifact-spool"
import { frozenEmbeddingRequests, type CanaryRequest } from "./canary-provider-adapter"
import { buildDocumentPassages, hashDocumentText, type BuiltPassage } from "../src/server/doc-library/passage-builder"
import { buildEvidenceWindow } from "../src/server/doc-library/evidence-window"
import { bm25Search } from "../src/server/retrieval/bm25"
import { reciprocalRankFusion, toRecallHits, type FusedCandidate } from "../src/server/retrieval/fusion"
import { planGroundedCanary } from "../src/server/retrieval/grounded-canary-plan"
import { syntheticQaDataset, type SyntheticQaCase } from "../src/server/retrieval/fixtures/grounded-qa-v1"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const vectorRow = z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number().finite()).length(1024) }).strict()
const responseSchema = z.object({
    data: z.array(vectorRow).min(1).max(4),
    usage: z.object({ total_tokens: z.number().int().nonnegative().nullable() }).strict(),
}).strict()
const receiptSchema = z.object({ version: z.literal(1), executionId: z.string().min(1).max(100), manifestHash: digest,
    bytes: z.number().int().positive().max(262144), sha256: digest, verified: z.literal(true) }).strict()
const terminalSchema = z.object({ passed: z.literal(true), executionId: z.string().uuid(), completed: z.literal(22), dispatchedSteps: z.literal(22),
    receipts: z.array(z.object({ ordinal: z.number().int().min(0).max(21), bytes: z.number().int().positive(), sha256: digest }).strict()).length(22),
    finalStatus: z.object({ states: z.array(z.literal("persisted")).length(22), acknowledged: z.array(z.literal(true)).length(22) }).strict(),
    modelCalls: z.literal(0).optional(), databaseCalls: z.literal(0).optional(), productionIndexWrites: z.literal(0).optional(),
}).passthrough()

export type OfflinePassage = BuiltPassage & { id: string; documentId: string; title: string; vector: number[]; sourceHash: string }
export type OfflineEmbeddingCorpus = {
    executionId: string
    planHash: string
    documents: OfflinePassage[]
    queryVectors: number[][]
}

const hashBytes = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function readStoredResponse(directory: string, ordinal: number, executionId: string, planHash: string, request: CanaryRequest) {
    const responseDirectory = path.join(directory, "received", String(ordinal))
    assertPrivateSpoolDirectory(responseDirectory)
    const payload = readPrivateSpoolFile(path.join(responseDirectory, "artifact.bin"), 262144)
    const manifest = JSON.parse(readPrivateSpoolFile(path.join(responseDirectory, "manifest.json"), 16384).toString())
    const expectedManifest = describeArtifact(payload, `${executionId}-${ordinal}`, planHash)
    if (!sameJson(manifest, expectedManifest)) throw new Error(`embedding_manifest_mismatch_${ordinal}`)
    const receipt = receiptSchema.parse(JSON.parse(readPrivateSpoolFile(path.join(responseDirectory, "receipt.json"), 4096).toString()))
    if (receipt.executionId !== `${executionId}-${ordinal}` || receipt.manifestHash !== hashBytes(JSON.stringify(expectedManifest))
        || receipt.sha256 !== hashBytes(payload) || receipt.bytes !== payload.length) throw new Error(`embedding_receipt_mismatch_${ordinal}`)
    const response = responseSchema.parse(JSON.parse(payload.toString("utf8")))
    const input = request.kind === "rerank" ? [] : z.array(z.string()).parse((request.body as { input: unknown }).input)
    if (response.data.length !== input.length || response.data.some((row, index) => row.index !== index
        || row.embedding.some(value => !Number.isFinite(Math.fround(value))) || !row.embedding.some(value => Math.fround(value) !== 0))) {
        throw new Error(`embedding_vector_contract_${ordinal}`)
    }
    return response
}

/** 只读取已完成的安全artifact；不返回或持久化原始JSON/向量。 */
export function loadOfflineEmbeddingCorpus(directory: string): OfflineEmbeddingCorpus {
    assertPrivateSpoolDirectory(directory)
    const terminal = terminalSchema.parse(JSON.parse(readPrivateSpoolFile(path.join(directory, "terminal.json"), 16384).toString()))
    const frozen = frozenEmbeddingRequests(), plan = planGroundedCanary()
    if (terminal.receipts.some((receipt, index) => receipt.ordinal !== index)) throw new Error("embedding_terminal_binding")
    const started = JSON.parse(readPrivateSpoolFile(path.join(directory, "real.started"), 4096).toString()) as { owner?: unknown }
    if (started.owner !== terminal.executionId) throw new Error("embedding_execution_binding")
    const responses = frozen.requests.map((request, ordinal) => readStoredResponse(directory, ordinal, terminal.executionId, plan.planHash, request))
    const documents: OfflinePassage[] = []
    let requestOrdinal = 0
    for (const item of plan.documents) {
        const document = syntheticQaDataset.documents.find(row => row.id === item.id)
        if (!document) throw new Error("embedding_document_missing")
        const passages = buildDocumentPassages(document.text, document.title)
        const vectors: number[][] = []
        for (let offset = 0; offset < passages.length; offset += 4) {
            const request = frozen.requests[requestOrdinal]
            const expectedInputs = passages.slice(offset, offset + 4).map(passage => `${document.title}\n${passage.locator}\n${passage.text}`)
            const actualInputs = (request.body as { input: string[] }).input
            if (request.kind !== "document_embedding" || !sameJson(actualInputs, expectedInputs)) throw new Error(`embedding_input_binding_${requestOrdinal}`)
            vectors.push(...responses[requestOrdinal].data.map(row => row.embedding.map(Math.fround)))
            requestOrdinal++
        }
        if (vectors.length !== passages.length) throw new Error("embedding_passage_count")
        passages.forEach((passage, index) => documents.push({ ...passage, id: `${document.id}:${index}`, documentId: document.id,
            title: document.title, vector: vectors[index], sourceHash: hashDocumentText(document.text) }))
    }
    if (requestOrdinal !== 14 || documents.length !== 48) throw new Error("embedding_document_mapping")
    const queryVectors = responses.slice(14).flatMap(response => response.data.map(row => row.embedding.map(Math.fround)))
    for (let index = 0; index < 8; index++) {
        const item = syntheticQaDataset.cases.find(row => row.id === plan.caseIds[index])
        const expectedQuery = item ? [...item.history.map(history => history.content), item.question].join("\n") : ""
        const actualQuery = (frozen.requests[14 + index].body as { input: string[] }).input
        if (!item || frozen.requests[14 + index].kind !== "query_embedding" || actualQuery.length !== 1 || actualQuery[0] !== expectedQuery) throw new Error(`embedding_query_input_${index}`)
    }
    if (queryVectors.length !== 8 || frozen.requests.slice(14).some(request => request.kind !== "query_embedding")) throw new Error("embedding_query_mapping")
    return { executionId: terminal.executionId, planHash: plan.planHash, documents, queryVectors }
}

export function cosineSimilarity(left: number[], right: number[]) {
    if (left.length !== 1024 || right.length !== 1024) throw new Error("embedding_dimensions")
    let dot = 0, leftNorm = 0, rightNorm = 0
    for (let index = 0; index < 1024; index++) {
        const a = Math.fround(left[index]), b = Math.fround(right[index])
        if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("embedding_nonfinite")
        dot += a * b; leftNorm += a * a; rightNorm += b * b
    }
    if (leftNorm === 0 || rightNorm === 0) throw new Error("embedding_zero_vector")
    return dot / Math.sqrt(leftNorm * rightNorm)
}

function rankSemantic(passages: OfflinePassage[], queryVector: number[]) {
    return passages.map(passage => ({ id: passage.id, score: cosineSimilarity(passage.vector, queryVector) }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 20)
}

function expectedPassageIds(item: SyntheticQaCase, passages: OfflinePassage[]) {
    return item.evidence.map(evidence => passages.filter(passage => passage.documentId === evidence.documentId && passage.text.includes(evidence.quote)).map(passage => passage.id))
}

function recallAt20(gold: string[], ranked: string[]) {
    if (!gold.length) return null
    const top = new Set(ranked.slice(0, 20))
    return gold.filter(id => top.has(id)).length / gold.length
}

function anchorFor(passages: OfflinePassage[], id: string) {
    const anchor = passages.find(passage => passage.id === id)
    if (!anchor) throw new Error("embedding_anchor_missing")
    const siblings = passages.filter(passage => passage.documentId === anchor.documentId)
    const window = buildEvidenceWindow(siblings.map(passage => ({ chunkIndex: passage.passageIndex, text: passage.text })), anchor.passageIndex)
    if (!window.content.includes(anchor.text) || window.anchorEnd <= window.anchorStart) throw new Error("embedding_anchor_invalid")
    return { id, indices: window.indices, anchorStart: window.anchorStart, anchorEnd: window.anchorEnd, contentHash: hashBytes(window.content) }
}

export function evaluateOfflineEmbeddingCorpus(corpus: OfflineEmbeddingCorpus) {
    const plan = planGroundedCanary(), results = plan.caseIds.map((caseId, index) => {
        const item = syntheticQaDataset.cases.find(row => row.id === caseId)
        if (!item) throw new Error("embedding_case_missing")
        const query = [...item.history.map(history => history.content), item.question].join("\n")
        const scoped = corpus.documents.filter(passage => item.scope.includes(passage.documentId))
        const lexical = bm25Search(scoped.map(passage => ({ id: passage.id, title: passage.title, content: passage.text })), query, { topK: 20 })
        const semantic = rankSemantic(scoped, corpus.queryVectors[index])
        const fused: FusedCandidate[] = reciprocalRankFusion([
            toRecallHits("chunk_bm25", lexical.map(row => ({ nodeKey: row.id, score: row.score }))),
            toRecallHits("chunk_vector", semantic.map(row => ({ nodeKey: row.id, score: row.score }))),
        ], { topK: 20 })
        const gold = expectedPassageIds(item, scoped)
        if (gold.some(ids => ids.length === 0)) throw new Error(`embedding_gold_unmapped_${caseId}`)
        const anchors = gold.flatMap(ids => ids.slice(0, 1).map(id => anchorFor(scoped, id)))
        return { id: caseId, group: item.group, expectedResolution: item.expectedResolution, goldCount: gold.length,
            lexicalRecall20: recallAt20(gold.flat(), lexical.map(row => row.id)), semanticRecall20: recallAt20(gold.flat(), semantic.map(row => row.id)),
            fusedRecall20: recallAt20(gold.flat(), fused.map(row => row.nodeKey)), unmappedGold: gold.filter(ids => ids.length === 0).length,
            lexicalIds: lexical.map(row => row.id), semanticIds: semantic.map(row => row.id), fusedIds: fused.map(row => row.nodeKey), anchors }
    })
    return { scope: "offline_component_preview", executionId: corpus.executionId, planHash: corpus.planHash, documents: 3, passages: corpus.documents.length,
        cases: results, modelCalls: 0, databaseCalls: 0, rawVectorsPersisted: false, rawTextPersisted: false, productionIndexWrites: 0 }
}

async function main() {
    const directory = process.argv[2], outputName = process.argv[3] ?? "consumer-report.json"
    if (!directory || process.argv.length > 4 || !/^consumer-report(?:-v[1-9][0-9]*)?\.json$/.test(outputName)) throw new Error("usage: canary-embedding-consumer <embedding-artifact-directory> [consumer-report-vN.json]")
    const report = evaluateOfflineEmbeddingCorpus(loadOfflineEmbeddingCorpus(path.resolve(directory)))
    const output = path.join(path.resolve(directory), outputName)
    if (fs.existsSync(output)) throw new Error("consumer_report_exists")
    fs.writeFileSync(output, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 })
    const safeCases = report.cases.map(item => {
        const { lexicalIds: _lexicalIds, semanticIds: _semanticIds, fusedIds: _fusedIds, ...safe } = item
        return safe
    })
    console.log(JSON.stringify({ ...report, cases: safeCases }))
}
if (import.meta.main) main().catch(error => { console.error(JSON.stringify({ failed: true, category: error instanceof Error ? error.message : "consumer_failed" })); process.exitCode = 1 })
