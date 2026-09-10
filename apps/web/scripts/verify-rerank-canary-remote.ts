import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { loadOfflineEmbeddingCorpus, evaluateOfflineEmbeddingCorpus } from "./canary-embedding-consumer"
import { prepareRerankPreflight } from "./canary-rerank-preflight"
import { buildSafeRerankReport } from "./canary-rerank-consumer"
import { syntheticQaDataset } from "../src/server/retrieval/fixtures/grounded-qa-v1"
import { planGroundedCanary } from "../src/server/retrieval/grounded-canary-plan"
import { acceptArtifactBlock, assertPrivateSpoolDirectory, finalizeArtifactSpool, openArtifactSpool, readPrivateSpoolFile } from "./canary-artifact-spool"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const dataRoot = path.join(repositoryRoot, ".data")
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
// 由不可覆盖的本机请求包固定执行身份；不得在运行时生成或替换。
const owner = "ae3a2166-4be4-4cd7-82ec-25e60d589039"
const remoteHostRoot = `/root/petrichor-canary-${owner}`
const runtimeRoot = `/tmp/petrichor-rerank-runtime-${owner}`
const outputRoot = path.join(dataRoot, process.argv[2] === "--remote-preflight" ? `rerank-runtime-preflight-${owner}-${process.pid}` : `rerank-canary-${owner}`)
const embeddingDirectory = path.join(dataRoot, "embedding-approved")
const packDirectory = path.join(dataRoot, "rerank-approved")
const profileHash = process.env.QA_RERANK_PROFILE_HASH

async function run(argv: string[], input?: string, timeout = 30_000) {
    const child = Bun.spawn(argv, { stdin: input == null ? undefined : "pipe", stdout: "pipe", stderr: "pipe" })
    const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text()
    const timer = setTimeout(() => child.kill(), timeout)
    try {
        if (input != null) { child.stdin.write(input); await child.stdin.end() }
        const [out, err, code] = await Promise.all([stdout, stderr, child.exited])
        if (code !== 0) {
            const category = /permission denied|publickey/i.test(err) ? "ssh_permission" : /timed? ?out|signal/i.test(err) ? "timeout" : /not found|no such file/i.test(err) ? "missing_path" : /EEXIST|already exists/i.test(err) ? "remote_existing" : /SyntaxError|ReferenceError|TypeError/i.test(err) ? "remote_script_error" : "process_failed"
            throw new Error(category)
        }
        return { output: out, stderr: err }
    } finally { clearTimeout(timer) }
}

async function ssh(command: string, input?: string, timeout = 30_000) {
    return run(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-p", "5533", "-i", "/Users/gene/Desktop/DEV/KEY/OVH.txt", "root@15.204.66.173", command], input, timeout)
}

function localPrivateDirectory(directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    assertPrivateSpoolDirectory(directory)
}

async function remoteJson(command: string, timeout = 30_000) {
    const result = await ssh(command, undefined, timeout)
    if (Buffer.byteLength(result.output) > 64 * 1024) throw new Error("remote_output_limit")
    try { return JSON.parse(result.output) as Record<string, unknown> } catch { throw new Error("remote_json_invalid") }
}

async function remoteText(command: string, timeout = 30_000) {
    const result = await ssh(command, undefined, timeout)
    if (Buffer.byteLength(result.output) > 64 * 1024) throw new Error("remote_output_limit")
    return result.output
}

async function main() {
    if (!profileHash || !/^[a-f0-9]{64}$/.test(profileHash)) throw new Error("rerank_profile_hash_missing")
    const plan = planGroundedCanary(), corpus = loadOfflineEmbeddingCorpus(embeddingDirectory), preflight = prepareRerankPreflight(corpus)
    if (preflight.requestSetHash !== JSON.parse(readPrivateSpoolFile(path.join(packDirectory, "requests-rerank.json"), 512 * 1024).toString()).requestSetHash) throw new Error("rerank_pack_changed")
    const pack = JSON.parse(readPrivateSpoolFile(path.join(packDirectory, "requests-rerank.json"), 512 * 1024).toString()) as { version: 1; executionId: string; planHash: string; requestSetHash: string; requests: unknown[] }
    if (pack.version !== 1 || pack.planHash !== plan.planHash || pack.requests.length !== 8 || pack.executionId !== "ae3a2166-4be4-4cd7-82ec-25e60d589039") throw new Error("rerank_pack_identity")
    localPrivateDirectory(outputRoot)
    const report: Record<string, unknown> = { passed: false, executionId: pack.executionId, planHash: pack.planHash, requestSetHash: pack.requestSetHash,
        model: "BAAI/bge-reranker-v2-m3", sharedProviderCredential: true, modelCalls: 0, databaseWrites: 0, retries: 0, completed: 0 }
    let before: { id: string; image: string; startedAt: string; health: string; user: string; readonly: boolean } | undefined
    let remoteRootCreated = false
    let runtimeCreated = false
    let stage = "inspect"
    try {
        const inspectFormat = quote('{"id":{{json .Id}},"image":{{json .Image}},"startedAt":{{json .State.StartedAt}},"health":{{json .State.Health.Status}},"user":{{json .Config.User}},"readonly":{{json .HostConfig.ReadonlyRootfs}}}')
        const raw = await remoteJson("docker inspect petrichor-web-1 --format " + inspectFormat)
        before = raw as typeof before
        if (!before || !/^[a-f0-9]{64}$/.test(before.id) || !/^sha256:[a-f0-9]{64}$/.test(before.image) || before.health !== "healthy" || before.user !== "bun" || before.readonly !== true) throw new Error("web_gate")
        stage = "build"
        const runtimeIdentity = hash(JSON.stringify({ id: before.id, image: before.image, startedAt: before.startedAt }))
        const codeBundle = await Bun.build({ entrypoints: [path.join(repositoryRoot, "apps/web/scripts/canary-rerank-runtime-entry.ts")], target: "bun", minify: true })
        const hostBundle = await Bun.build({ entrypoints: [path.join(repositoryRoot, "apps/web/scripts/canary-host-entry.ts")], target: "node", minify: true })
        if (!codeBundle.success || codeBundle.outputs.length !== 1 || !hostBundle.success || hostBundle.outputs.length !== 1) throw new Error("bundle_gate")
        const entry = Buffer.from(await codeBundle.outputs[0].arrayBuffer()), host = Buffer.from(await hostBundle.outputs[0].arrayBuffer())
        const codeSha = hash(entry), hostSha = hash(host)
        report.codeSha = codeSha; report.hostSha = hostSha
        const config = { containerId: before.id, executionId: pack.executionId, runtimeIdentity, codeSha, planHash: pack.planHash, requestSetHash: pack.requestSetHash, providerProfileHash: profileHash, calls: 8, runtimeDirectory: "petrichor-rerank-runtime" }
        const binding = { version: 1, executionId: pack.executionId, runtimeIdentity, codeSha, planHash: pack.planHash, requestSetHash: pack.requestSetHash, providerProfileHash: profileHash, calls: 8, expiresAt: new Date(Date.now() + 1_800_000).toISOString() }
        const hostPayload = JSON.stringify({ owner, host: host.toString(), config, binding })
        const hostBootstrap = `const fs=require('fs'),c=require('crypto'),p=${JSON.stringify(remoteHostRoot)},b=fs.readFileSync(0);if(process.getuid()!==0||c.createHash('sha256').update(b).digest('hex')!==${JSON.stringify(hash(hostPayload))})throw Error('gate');const x=JSON.parse(b);fs.mkdirSync(p,{mode:448});for(const [n,v] of Object.entries({'owner':x.owner,'host.mjs':x.host,'command-config.json':JSON.stringify(x.config),'binding.json':JSON.stringify(x.binding)}))fs.writeFileSync(p+'/'+n,v,{flag:'wx',mode:384});console.log('{"ready":true}')`
        stage = "host_transfer"
        remoteRootCreated = true
        const hostTransfer = await ssh(`/usr/bin/node -e ${quote(hostBootstrap)}`, hostPayload, 30_000)
        if (!JSON.parse(hostTransfer.output).ready) throw new Error("host_transfer_gate")
        const approval = { version: 1, executionId: pack.executionId, planHash: pack.planHash, codeSha, providerProfileHash: profileHash, requestSetHash: pack.requestSetHash, userId: "Gene", phase: "rerank", maxCalls: 8, expiresAt: binding.expiresAt }
        const runtimePayload = JSON.stringify({ owner, entry: entry.toString(), approval, pack })
        const runtimeBootstrap = `const fs=require('fs'),c=require('crypto'),p=${JSON.stringify(runtimeRoot)},b=fs.readFileSync(0);if(process.getuid()!==1000||c.createHash('sha256').update(b).digest('hex')!==${JSON.stringify(hash(runtimePayload))})throw Error('gate');const x=JSON.parse(b);fs.mkdirSync(p,{mode:448});for(const [n,v] of Object.entries({'owner':x.owner,'entry.js':x.entry,'approval-rerank.json':JSON.stringify(x.approval),'requests-rerank.json':JSON.stringify(x.pack)}))fs.writeFileSync(p+'/'+n,v,{flag:'wx',mode:384});console.log('{"ready":true}')`
        stage = "runtime_transfer"
        runtimeCreated = true
        const runtimeTransfer = await ssh(`docker exec -i --user 1000 ${before.id} bun -e ${quote(runtimeBootstrap)}`, runtimePayload, 30_000)
        if (!JSON.parse(runtimeTransfer.output).ready) throw new Error("runtime_transfer_gate")
        stage = "host_initialize"
        if (!(await remoteJson(`/usr/bin/node ${quote(remoteHostRoot + "/host.mjs")} initialize ${pack.executionId}`, 90_000)).initialized) throw new Error("host_initialize_gate")
        if (process.argv[2] === "--remote-preflight") {
            stage = "runtime_status"
            const status = await remoteJson(`/usr/bin/node ${quote(remoteHostRoot + "/host.mjs")} status ${pack.executionId}`, 30_000)
            if (!Array.isArray(status.states) || status.states.length !== 8 || status.states.some(state => state !== "not_started")
                || !Array.isArray(status.acknowledged) || status.acknowledged.some(value => value !== false)) throw new Error("preflight_status_gate")
            Object.assign(report, { passed: true, setupOnly: true, modelCalls: 0, databaseWrites: 0, retries: 0 })
            return
        }
        const localReceived = path.join(outputRoot, "received"); localPrivateDirectory(localReceived)
        const mirror = async (ordinal: number) => {
            const remoteDir = `${remoteHostRoot}/journal/received-${ordinal}`
            const manifest = JSON.parse(await remoteText(`/usr/bin/node -e ${quote(`process.stdout.write(require('fs').readFileSync(${JSON.stringify(remoteDir + "/manifest.json")},'utf8'))`)}`, 30_000))
            const destination = path.join(localReceived, String(ordinal)); openArtifactSpool(destination, manifest)
            for (const block of manifest.blocks as Array<{ index: number; bytes: number }>) {
                const data = JSON.parse(await remoteText(`/usr/bin/node -e ${quote(`const b=require('fs').readFileSync(${JSON.stringify(remoteDir + "/block-" + String(block.index).padStart(3, "0"))});if(b.length>${32768})throw Error('limit');process.stdout.write(JSON.stringify({index:${block.index},data:b.toString('base64')}))`)}`, 30_000))
                if (data.index !== block.index) throw new Error("block_identity")
                acceptArtifactBlock(destination, manifest, data.index, Buffer.from(data.data, "base64"))
            }
            return finalizeArtifactSpool(destination, manifest)
        }
        stage = "execute"
        for (let ordinal = 0; ordinal < 8; ordinal++) {
            const step = await remoteJson(`/usr/bin/node ${quote(remoteHostRoot + "/host.mjs")} step ${pack.executionId} ${ordinal}`, 90_000)
            if (step.ordinal !== ordinal || step.acknowledged !== true || typeof step.sha256 !== "string") throw new Error("host_step_gate")
            const receipt = await mirror(ordinal)
            if (receipt.sha256 !== step.sha256 || receipt.bytes !== step.bytes) throw new Error("receipt_gate")
            report.completed = ordinal + 1; report.modelCalls = ordinal + 1
            fs.writeFileSync(path.join(outputRoot, "progress.json"), JSON.stringify(report), { flag: ordinal === 0 ? "wx" : "w", mode: 0o600 })
        }
        stage = "final_status"
        const status = await remoteJson(`/usr/bin/node ${quote(remoteHostRoot + "/host.mjs")} status ${pack.executionId}`, 30_000)
        if (!Array.isArray(status.states) || status.states.length !== 8 || status.states.some(state => state !== "persisted") || !Array.isArray(status.acknowledged) || status.acknowledged.some(value => value !== true)) throw new Error("host_final_status_gate")
        stage = "consume_results"
        const evaluation = evaluateOfflineEmbeddingCorpus(corpus)
        const cases = evaluation.cases.map((item, index) => {
            const question = syntheticQaDataset.cases.find(row => row.id === item.id)!
            const goldIds = question.evidence.flatMap(evidence => corpus.documents.filter(passage => passage.documentId === evidence.documentId && passage.text.includes(evidence.quote)).map(passage => passage.id))
            const raw = JSON.parse(readPrivateSpoolFile(path.join(localReceived, String(index), "artifact.bin"), 262144).toString())
            return { caseId: item.id, candidateIds: item.fusedIds, goldIds, raw }
        })
        const safe = buildSafeRerankReport({ executionId: pack.executionId, planHash: plan.planHash, requestSetHash: pack.requestSetHash, cases })
        fs.writeFileSync(path.join(outputRoot, "rerank-result-v2.json"), JSON.stringify(safe, null, 2), { flag: "wx", mode: 0o600 })
        Object.assign(report, { passed: true, completed: 8, modelCalls: 8, allResultsConsumed: true, resultHash: safe.resultHash, rerankerProfileVerified: false,
            rawTextPersisted: false, rawVectorsPersisted: false, productionIndexWrites: 0 })
    } catch (error) {
        const reason = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "rerank_canary_failed"
        report.error = `${stage}_${reason}`
    } finally {
        if (runtimeCreated && before) {
            const cleanup = `const fs=require('fs'),p=${JSON.stringify(runtimeRoot)},o=${JSON.stringify(pack.executionId)};if(!fs.existsSync(p)){console.log('{"absent":true}');process.exit(0)}const s=fs.lstatSync(p);if(process.getuid()!==1000||s.uid!==1000||!s.isDirectory()||s.isSymbolicLink()||(s.mode&63)||fs.readFileSync(p+'/owner','utf8')!==o)throw Error('owner');fs.rmSync(p,{recursive:true});console.log(JSON.stringify({absent:!fs.existsSync(p)}));`
            try { report.runtimeCleaned = (await remoteJson(`docker exec --user 1000 ${before.id} bun -e ${quote(cleanup)}`)).absent === true } catch { report.runtimeCleaned = false }
        }
        if (remoteRootCreated) {
            const cleanup = `const fs=require('fs'),p=${JSON.stringify(remoteHostRoot)},o=${JSON.stringify(pack.executionId)};if(!fs.existsSync(p)){console.log('{"absent":true}');process.exit(0)}const s=fs.lstatSync(p);if(process.getuid()!==0||s.uid!==0||!s.isDirectory()||s.isSymbolicLink()||(s.mode&63)||fs.readFileSync(p+'/owner','utf8')!==o)throw Error('owner');fs.rmSync(p,{recursive:true});console.log(JSON.stringify({absent:!fs.existsSync(p)}));`
            try { report.hostCleaned = (await remoteJson(`/usr/bin/node -e ${quote(cleanup)}`)).absent === true } catch { report.hostCleaned = false }
        }
        if (before) {
            try {
                const afterFormat = quote('{"image":{{json .Image}},"startedAt":{{json .State.StartedAt}},"health":{{json .State.Health.Status}}}')
                const after = await remoteJson("docker inspect " + before.id + " --format " + afterFormat)
                report.webHealthy = after.health === "healthy"; report.webUnchanged = after.image === before.image && after.startedAt === before.startedAt
            } catch { report.webHealthy = false; report.webUnchanged = false }
        }
        if (report.passed !== true || report.runtimeCleaned !== true || report.hostCleaned !== true || report.webHealthy !== true || report.webUnchanged !== true) report.passed = false
        fs.writeFileSync(path.join(outputRoot, "terminal.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 })
        console.log(JSON.stringify(report)); if (report.passed !== true) process.exitCode = 1
    }
}

async function preflight() {
    const plan = planGroundedCanary(), corpus = loadOfflineEmbeddingCorpus(embeddingDirectory), prepared = prepareRerankPreflight(corpus)
    const pack = JSON.parse(readPrivateSpoolFile(path.join(packDirectory, "requests-rerank.json"), 512 * 1024).toString()) as { executionId: string; requestSetHash: string; requests: unknown[] }
    if (pack.executionId !== owner || pack.requestSetHash !== prepared.requestSetHash || pack.requests.length !== 8) throw new Error("rerank_preflight_pack")
    const [entryBuild, hostBuild] = await Promise.all([
        Bun.build({ entrypoints: [path.join(repositoryRoot, "apps/web/scripts/canary-rerank-runtime-entry.ts")], target: "bun", minify: true }),
        Bun.build({ entrypoints: [path.join(repositoryRoot, "apps/web/scripts/canary-host-entry.ts")], target: "node", minify: true }),
    ])
    if (!entryBuild.success || entryBuild.outputs.length !== 1 || !hostBuild.success || hostBuild.outputs.length !== 1) throw new Error("rerank_preflight_bundle")
    const entry = Buffer.from(await entryBuild.outputs[0].arrayBuffer()), host = Buffer.from(await hostBuild.outputs[0].arrayBuffer())
    console.log(JSON.stringify({ mode: "preflight", executionId: owner, planHash: plan.planHash, requestSetHash: prepared.requestSetHash,
        requests: 8, maxCandidates: prepared.maxCandidates, entrySha: hash(entry), hostSha: hash(host), modelCalls: 0, databaseCalls: 0,
        requiresProfileHash: true, requiresNewApproval: true }))
}

if (import.meta.main) {
    const run = process.argv[2] === "--preflight" ? preflight : main
    run().catch(error => { console.error(JSON.stringify({ passed: false, error: error instanceof Error ? error.message : "rerank_canary_failed" })); process.exitCode = 1 })
}
