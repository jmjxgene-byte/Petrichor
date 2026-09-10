import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { assertPrivateSpoolDirectory, describeArtifact, readPrivateSpoolFile } from "./canary-artifact-spool"
import { loadOfflineEmbeddingCorpus, evaluateOfflineEmbeddingCorpus } from "./canary-embedding-consumer"
import { buildSafeRerankReport } from "./canary-rerank-consumer"
import { syntheticQaDataset } from "../src/server/retrieval/fixtures/grounded-qa-v1"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const terminalSchema = z.object({ passed: z.boolean(), executionId: z.string().uuid(), planHash: digest, requestSetHash: digest,
    model: z.literal("BAAI/bge-reranker-v2-m3"), modelCalls: z.literal(8), databaseWrites: z.literal(0), retries: z.literal(0), completed: z.literal(8),
    runtimeCleaned: z.literal(true), hostCleaned: z.literal(true), webHealthy: z.literal(true), webUnchanged: z.literal(true) }).passthrough()
const receiptSchema = z.object({ version: z.literal(1), executionId: z.string(), manifestHash: digest, bytes: z.number().int().positive().max(262144), sha256: digest, verified: z.literal(true) }).strict()
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")

export function reconcileRerankCanary(directory: string, embeddingDirectory: string) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."), dataRoot = path.join(root, ".data"), output = path.resolve(root, directory), embeddings = path.resolve(root, embeddingDirectory)
    if (!output.startsWith(dataRoot + path.sep) || !embeddings.startsWith(dataRoot + path.sep)) throw new Error("reconcile_path_gate")
    assertPrivateSpoolDirectory(output)
    const terminal = terminalSchema.parse(JSON.parse(readPrivateSpoolFile(path.join(output, "terminal.json"), 16384).toString()))
    const corpus = loadOfflineEmbeddingCorpus(embeddings), evaluation = evaluateOfflineEmbeddingCorpus(corpus)
    const cases = []
    for (let index = 0; index < 8; index++) {
        const dir = path.join(output, "received", String(index)); assertPrivateSpoolDirectory(dir)
        const payload = readPrivateSpoolFile(path.join(dir, "artifact.bin"), 262144), manifest = JSON.parse(readPrivateSpoolFile(path.join(dir, "manifest.json"), 16384).toString())
        const expectedManifest = describeArtifact(payload, `${terminal.executionId}-${index}`, terminal.planHash)
        const receipt = receiptSchema.parse(JSON.parse(readPrivateSpoolFile(path.join(dir, "receipt.json"), 4096).toString()))
        if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest) || receipt.executionId !== `${terminal.executionId}-${index}` || receipt.manifestHash !== hash(JSON.stringify(expectedManifest))
            || receipt.sha256 !== hash(payload) || receipt.bytes !== payload.length) throw new Error(`reconcile_artifact_${index}`)
        const item = syntheticQaDataset.cases.find(row => row.id === evaluation.cases[index].id)!
        const goldIds = item.evidence.flatMap(evidence => corpus.documents.filter(passage => passage.documentId === evidence.documentId && passage.text.includes(evidence.quote)).map(passage => passage.id))
        cases.push({ caseId: evaluation.cases[index].id, candidateIds: evaluation.cases[index].fusedIds, goldIds, raw: JSON.parse(payload.toString("utf8")) })
    }
    const result = buildSafeRerankReport({ executionId: terminal.executionId, planHash: terminal.planHash, requestSetHash: terminal.requestSetHash, cases })
    const report = { scope: "rerank_canary_reconciled", executionId: terminal.executionId, planHash: terminal.planHash, requestSetHash: terminal.requestSetHash,
        sourceTerminalPassed: terminal.passed, terminalError: typeof terminal.error === "string" ? terminal.error : null, localResultsVerified: true, resultHash: result.resultHash,
        modelCalls: 8, databaseWrites: 0, retries: 0, rawTextPersisted: false, rawVectorsPersisted: false,
        remoteCleanupVerified: terminal.runtimeCleaned && terminal.hostCleaned, webHealthy: terminal.webHealthy, webUnchanged: terminal.webUnchanged,
        caseCount: result.caseCount, resultCases: result.cases.map(({ rankedIds, scores, ...item }) => ({ ...item, rankedCount: rankedIds.length, topScore: scores[0] ?? null })) }
    const target = path.join(output, "rerank-result-v2.json")
    if (fs.existsSync(target)) throw new Error("reconcile_result_exists")
    fs.writeFileSync(target, JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 })
    fs.writeFileSync(path.join(output, "reconciled-terminal.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 })
    return report
}

async function main() {
    const directory = process.argv[2], embeddingDirectory = process.argv[3] ?? ".data/embedding-approved"
    if (!directory || process.argv.length > 4) throw new Error("usage: reconcile-rerank-canary <rerank-output-directory> [embedding-directory]")
    console.log(JSON.stringify(reconcileRerankCanary(directory, embeddingDirectory)))
}
if (import.meta.main) main().catch(error => { console.error(JSON.stringify({ failed: true, category: error instanceof Error ? error.message : "reconcile_failed" })); process.exitCode = 1 })
