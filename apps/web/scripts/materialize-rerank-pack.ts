import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID, createHash } from "node:crypto"
import { loadOfflineEmbeddingCorpus } from "./canary-embedding-consumer"
import { prepareRerankPreflight } from "./canary-rerank-preflight"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const dataRoot = path.join(root, ".data")
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

export function materializeRerankPack(embeddingDirectory: string, outputDirectory: string) {
    const source = path.resolve(root, embeddingDirectory), target = path.resolve(root, outputDirectory)
    if (!source.startsWith(dataRoot + path.sep) || !target.startsWith(dataRoot + path.sep)) throw new Error("rerank_pack_path_gate")
    const preflight = prepareRerankPreflight(loadOfflineEmbeddingCorpus(source)), executionId = randomUUID()
    const serialized = preflight.requests.map(request => JSON.stringify(request.body))
    const requestSetHash = hash(JSON.stringify(serialized))
    if (requestSetHash !== preflight.requestSetHash || preflight.requests.length !== 8) throw new Error("rerank_pack_contract")
    fs.mkdirSync(target, { recursive: true, mode: 0o700 })
    const output = path.join(target, "requests-rerank.json")
    if (fs.existsSync(output)) throw new Error("rerank_pack_exists")
    const pack = { version: 1, executionId, planHash: preflight.planHash, requestSetHash, requests: preflight.requests }
    fs.writeFileSync(output, JSON.stringify(pack), { flag: "wx", mode: 0o600 })
    const bytes = fs.readFileSync(output)
    return { path: output, executionId, planHash: preflight.planHash, requestSetHash, bytes: bytes.length, sha256: hash(bytes), requests: 8,
        maxCandidates: preflight.maxCandidates, modelCalls: 0, databaseCalls: 0 }
}

async function main() {
    const embeddingDirectory = process.argv[2], outputDirectory = process.argv[3]
    if (!embeddingDirectory || !outputDirectory || process.argv.length !== 4) throw new Error("usage: materialize-rerank-pack <embedding-dir> <output-dir>")
    console.log(JSON.stringify(materializeRerankPack(embeddingDirectory, outputDirectory)))
}
if (import.meta.main) main().catch(error => { console.error(JSON.stringify({ failed: true, category: error instanceof Error ? error.message : "rerank_pack_failed" })); process.exitCode = 1 })
