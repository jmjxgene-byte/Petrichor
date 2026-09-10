import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { loadOfflineEmbeddingCorpus, evaluateOfflineEmbeddingCorpus, type OfflineEmbeddingCorpus } from "./canary-embedding-consumer"
import { syntheticQaDataset } from "../src/server/retrieval/fixtures/grounded-qa-v1"
import { planGroundedCanary } from "../src/server/retrieval/grounded-canary-plan"
import type { CanaryRequest } from "./canary-provider-adapter"

const rerankBodySchema = z.object({ model: z.literal("BAAI/bge-reranker-v2-m3"), query: z.string().min(1).max(2000),
    documents: z.array(z.string().min(1).max(4000)).min(1).max(20), top_n: z.number().int().positive(), return_documents: z.literal(false) }).strict()
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const bytes = (value: string) => Buffer.byteLength(value, "utf8")

export function prepareRerankPreflight(corpus: OfflineEmbeddingCorpus) {
    const embeddingReport = evaluateOfflineEmbeddingCorpus(corpus), plan = planGroundedCanary()
    const requests: CanaryRequest[] = []
    const summary = embeddingReport.cases.map((result, index) => {
        const item = syntheticQaDataset.cases.find(row => row.id === result.id)!
        const query = [...item.history.map(history => history.content), item.question].join("\n")
        const candidates = result.fusedIds.map(id => corpus.documents.find(passage => passage.id === id)).filter((passage): passage is OfflineEmbeddingCorpus["documents"][number] => Boolean(passage))
        if (candidates.length > 20) throw new Error(`rerank_candidate_limit_${result.id}`)
        if (!candidates.length) return { id: result.id, index, candidateCount: 0, requestHash: null, requestBytes: 0, skipped: true }
        const body = rerankBodySchema.parse({ model: "BAAI/bge-reranker-v2-m3", query, documents: candidates.map(passage => passage.text),
            top_n: candidates.length, return_documents: false })
        const serialized = JSON.stringify(body)
        requests.push({ kind: "rerank", body })
        return { id: result.id, index, candidateCount: candidates.length, requestHash: hash(serialized), requestBytes: bytes(serialized), skipped: false }
    })
    const serializedRequests = requests.map(request => JSON.stringify(rerankBodySchema.parse(request.body)))
    return { planHash: plan.planHash, embeddingExecutionId: corpus.executionId, phase: "rerank" as const,
        requestSetHash: hash(JSON.stringify(serializedRequests)), model: "BAAI/bge-reranker-v2-m3" as const,
        requestCount: requests.length, maxCandidates: Math.max(0, ...summary.map(item => item.candidateCount)),
        totalRequestBytes: serializedRequests.reduce((total, request) => total + bytes(request), 0),
        maxRequestBytes: Math.max(0, ...serializedRequests.map(bytes)),
        skippedCases: summary.filter(item => item.skipped).map(item => item.id), modelCalls: 0, databaseCalls: 0,
        requiresSeparateApproval: true, rerankerProfileVerified: false, cases: summary,
        requests,
    }
}

async function main() {
    const directory = process.argv[2], outputName = process.argv[3] ?? "rerank-preflight.json"
    if (!directory || process.argv.length > 4 || !/^rerank-preflight(?:-v[1-9][0-9]*)?\.json$/.test(outputName)) throw new Error("usage: canary-rerank-preflight <embedding-artifact-directory> [rerank-preflight-vN.json]")
    const repositoryRoot = path.resolve(import.meta.dir, "../../.."), resolved = path.resolve(repositoryRoot, directory)
    if (!resolved.startsWith(path.join(repositoryRoot, ".data") + path.sep)) throw new Error("rerank_directory_gate")
    const preflight = prepareRerankPreflight(loadOfflineEmbeddingCorpus(resolved))
    const { requests: _requests, ...safe } = preflight
    const output = path.join(resolved, outputName)
    if (fs.existsSync(output)) throw new Error("rerank_preflight_exists")
    fs.writeFileSync(output, JSON.stringify(safe, null, 2), { flag: "wx", mode: 0o600 })
    console.log(JSON.stringify(safe))
}
if (import.meta.main) main().catch(error => { console.error(JSON.stringify({ failed: true, category: error instanceof Error ? error.message : "rerank_preflight_failed" })); process.exitCode = 1 })
