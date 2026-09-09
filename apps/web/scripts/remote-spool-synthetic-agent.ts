import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { ARTIFACT_BLOCK_BYTES, acceptArtifactBlock, describeArtifact, finalizeArtifactSpool, openArtifactSpool } from "./canary-artifact-spool"
import { frozenEmbeddingRequests, runPersistedProviderBatch, type CanaryRequest } from "./canary-provider-adapter"
import type postgres from "postgres"
import { withCanaryCredential } from "./canary-credential-bridge"

const [action, owner, rawIndex] = process.argv.slice(2)
if (process.getuid?.() !== 0 || !/^[a-f0-9-]{36}$/.test(owner)) throw new Error("root_owner_gate")
const root = `/tmp/petrichor-spool-${owner}`, directory = path.join(root, "source")
const stat = fs.lstatSync(root)
if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) !== 0 || fs.readFileSync(path.join(root, "owner"), "utf8") !== owner) throw new Error("directory_gate")
if (action === "init" || action === "init-provider") {
    if (fs.existsSync(directory)) throw new Error("already_generated")
    let payload: Buffer
    let simulatedRequests = 0, recoveredWithoutInvocation = false
    if (action === "init-provider") {
        const frozen = frozenEmbeddingRequests()
        const fake = async (_url: string, init: RequestInit) => {
            simulatedRequests++
            const body = JSON.parse(init.body as string)
            if (body.model === "BAAI/bge-m3") return Response.json({
                data: body.input.map((_: string, index: number) => ({ index, embedding: Array.from({ length: 1024 }, (_, j) => Math.sin((index * 1024 + j + 1) / 997)), secretEcho: "synthetic-secret" })),
                usage: { total_tokens: 10 }, secretEcho: "synthetic-secret",
            })
            return Response.json({ results: [...body.documents.keys()].reverse().map((index: number, i: number) => ({ index, relevance_score: 1 - i / 10, document: { text: "discard-this-echo" } })) })
        }
        const args = { directory: path.join(root, "embedding"), executionId: `${owner}-embed`, planHash: frozen.planHash,
            providerProfileHash: "b".repeat(64), apiKey: "synthetic-secret", requests: frozen.requests, transport: fake }
        const fakeTx = async (parts: TemplateStringsArray) => {
            const sql = parts.join("?")
            if (sql.includes("set_config")) return []
            if (sql.includes("current_user")) return [{ role: "petrichor_runtime", ro: "on" }]
            return [{ binding_user: 1, model_user: 1, provider_user: 1, credential_user: 1, model_ref: 9,
                model_id: "BAAI/bge-m3", dimensions: 1024, model_enabled: true, provider_enabled: true,
                provider_id: 1, provider_key: "siliconflow", base_url: null, headers_json: "{}", credential_id: 2,
                api_key_enc: "synthetic-cipher", model_revision: "v1", provider_revision: "v1", credential_revision: "v1" }]
        }
        const fakeClient = { begin: async (options: string, run: (tx: unknown) => Promise<unknown>) => {
            if (options !== "read only isolation level repeatable read") throw new Error("fake_readonly_gate")
            return run(fakeTx)
        } } as unknown as postgres.Sql
        const embedding = await withCanaryCredential({ client: fakeClient, userId: 1,
            decrypt: cipher => { if (cipher !== "synthetic-cipher") throw new Error("fake_cipher_gate"); return "synthetic-secret" },
            use: async credential => { args.providerProfileHash = credential.providerProfileHash; return runPersistedProviderBatch({ ...args, apiKey: credential.apiKey }) },
        })
        const rankingRequests: CanaryRequest[] = Array.from({ length: 8 }, (_, i) => ({ kind: "rerank", body: {
            model: "BAAI/bge-reranker-v2-m3", query: `synthetic-${i}`, documents: ["a", "b", "c", "d"], top_n: 4, return_documents: false,
        } }))
        const rankArgs = { ...args, directory: path.join(root, "ranking"), executionId: `${owner}-rank`, requests: rankingRequests }
        const ranking = await runPersistedProviderBatch(rankArgs)
        const beforeRecovery = simulatedRequests
        const recovered = await runPersistedProviderBatch({ ...args, apiKey: undefined })
        const recoveredRanking = await runPersistedProviderBatch({ ...rankArgs, apiKey: undefined })
        recoveredWithoutInvocation = beforeRecovery === 30 && simulatedRequests === 30 && [...recovered.results, ...recoveredRanking.results].every(r => r.reused)
        if (!recoveredWithoutInvocation) throw new Error("provider_recovery_gate")
        const readResults = (base: string, count: number) => Array.from({ length: count }, (_, i) => JSON.parse(fs.readFileSync(path.join(base, `call-${String(i).padStart(2, "0")}`, "response/artifact.bin"), "utf8")))
        payload = Buffer.from(JSON.stringify({ synthetic: true, embedding, ranking,
            embeddingResponses: readResults(args.directory, 22), rankingResponses: readResults(rankArgs.directory, 8) }))
        if (payload.includes("synthetic-secret") || payload.includes("discard-this-echo")) throw new Error("sanitization_gate")
    } else payload = Buffer.from(JSON.stringify({ data: "x".repeat(1680190) }))
    const manifest = describeArtifact(payload, owner, "a".repeat(64))
    openArtifactSpool(directory, manifest)
    for (const b of manifest.blocks) acceptArtifactBlock(directory, manifest, b.index, payload.subarray(b.index * ARTIFACT_BLOCK_BYTES, (b.index + 1) * ARTIFACT_BLOCK_BYTES))
    console.log(JSON.stringify({ generated: true, simulatedRequests, recoveredWithoutInvocation, ...finalizeArtifactSpool(directory, manifest) }))
} else if (action === "manifest") {
    console.log(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"))
} else if (action === "block" || action === "partial-block") {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"))
    const index = Number(rawIndex)
    if (!Number.isInteger(index) || index < 0 || index >= manifest.blocks.length) throw new Error("index_gate")
    const file = path.join(directory, `block-${String(index).padStart(3, "0")}`), stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) !== 0 || stat.size !== manifest.blocks[index].bytes) throw new Error("block_gate")
    const bytes = fs.readFileSync(file)
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.blocks[index].sha256) throw new Error("hash_gate")
    console.log(JSON.stringify({ index, data: (action === "partial-block" ? bytes.subarray(0, 100) : bytes).toString("base64") }))
} else throw new Error("action_gate")
