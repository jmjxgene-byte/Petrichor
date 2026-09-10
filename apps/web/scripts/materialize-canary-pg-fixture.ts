import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { buildDocumentPassages } from "../src/server/doc-library/passage-builder"
import { planGroundedCanary } from "../src/server/retrieval/grounded-canary-plan"
import { syntheticQaDataset } from "../src/server/retrieval/fixtures/grounded-qa-v1"
import { loadOfflineEmbeddingCorpus } from "./canary-embedding-consumer"
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const dataRoot = path.join(repositoryRoot, ".data")

export function materializeCanaryPostgresFixture(directory: string) {
    const target = path.resolve(repositoryRoot, directory)
    if (!target.startsWith(dataRoot + path.sep)) throw new Error("fixture_directory_gate")
    const sourceDirectory = path.resolve(repositoryRoot, process.env.CANARY_EMBEDDING_DIRECTORY ?? ".data/embedding-approved")
    if (!sourceDirectory.startsWith(dataRoot + path.sep)) throw new Error("embedding_directory_gate")
    const corpus = loadOfflineEmbeddingCorpus(sourceDirectory)
    const plan = planGroundedCanary()
    fs.mkdirSync(target, { recursive: true, mode: 0o700 })
    const output = path.join(target, "embed.json")
    if (fs.existsSync(output)) throw new Error("fixture_exists_no_overwrite")
    const documents = plan.documents.map(item => {
        const source = syntheticQaDataset.documents.find(document => document.id === item.id)!
        const passages = buildDocumentPassages(source.text, source.title).map((passage, index) => {
            const stored = corpus.documents.find(row => row.documentId === source.id && row.passageIndex === index)
            if (!stored) throw new Error("fixture_passage_missing")
            return { ...passage, input: `${source.title}\n${passage.locator}\n${passage.text}`, vector: stored.vector }
        })
        return { ...source, passages }
    })
    const cases = plan.caseIds.map((id, index) => {
        const item = syntheticQaDataset.cases.find(row => row.id === id)!
        return { ...item, query: [...item.history.map(history => history.content), item.question].join("\n"), vector: corpus.queryVectors[index] }
    })
    const artifact = { passed: true, calls: 22, syntheticMock: true, planHash: plan.planHash, executionId: corpus.executionId, documents, cases }
    fs.writeFileSync(output, JSON.stringify(artifact), { flag: "wx", mode: 0o600 })
    const bytes = fs.readFileSync(output)
    return { path: output, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), documents: documents.length,
        passages: documents.reduce((sum, document) => sum + document.passages.length, 0), cases: cases.length, modelCalls: 0, databaseCalls: 0 }
}

async function main() {
    const directory = process.argv[2]
    if (!directory || process.argv.length !== 3) throw new Error("usage: materialize-canary-pg-fixture <.data-directory>")
    console.log(JSON.stringify(materializeCanaryPostgresFixture(directory)))
}
if (import.meta.main) main().catch(error => { console.error(JSON.stringify({ failed: true, category: error instanceof Error ? error.message : "fixture_failed" })); process.exitCode = 1 })
