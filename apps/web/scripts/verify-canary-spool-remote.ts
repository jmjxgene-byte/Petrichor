import fs from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { acceptArtifactBlock, finalizeArtifactSpool, missingArtifactBlocks, openArtifactSpool } from "./canary-artifact-spool"

if (process.argv[2] !== "--synthetic-only-approved") throw new Error("approval_gate")
if (process.argv[3] && !["--fake-provider", "--handoff"].includes(process.argv[3])) throw new Error("mode_gate")
const providerMode = process.argv[3] === "--fake-provider"
const handoffMode = process.argv[3] === "--handoff"
const target = process.env.QA_SSH_TARGET, identity = process.env.QA_SSH_IDENTITY, port = process.env.QA_SSH_PORT, node = process.env.QA_REMOTE_NODE
if (!target || !identity || !port || !/^\d+$/.test(port) || !node || !/^\/[a-zA-Z0-9/._-]+$/.test(node)) throw new Error("ssh_gate")
const owner = randomUUID(), remoteRoot = `/tmp/petrichor-spool-${owner}`
const root = path.resolve(import.meta.dir, "../../../.data"), local = path.join(root, `remote-spool-${owner}`)
fs.mkdirSync(local, { recursive: true, mode: 0o700 })
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
const report: Record<string, unknown> = { scope: handoffMode ? "synthetic_runtime_host_handoff" : providerMode ? "fake_provider_remote_spool" : "synthetic_remote_spool", modelCalls: 0, databaseCalls: 0, passed: false }
async function ssh(command: string, input?: string, allowFailureReport = false) {
    const child = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-p", port!, "-i", identity!, target!, command], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text()
    const timer = setTimeout(() => child.kill(), 30000)
    try {
        if (input) child.stdin.write(input)
        await child.stdin.end()
        const [output, , code] = await Promise.all([stdout, stderr, child.exited])
        if ((!allowFailureReport && code !== 0) || Buffer.byteLength(output) > 64 * 1024) throw new Error("ssh_transfer_failed")
        const result = JSON.parse(output)
        return allowFailureReport ? { ...result, controllerExitCode: code } : result
    } finally { clearTimeout(timer) }
}
const call = (action: string, index?: number) => ssh(`${node} ${quote(remoteRoot + "/agent.mjs")} ${action} ${owner}${index == null ? "" : ` ${index}`}`)
let remoteMayExist = false
try {
    const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, handoffMode ? "remote-handoff-synthetic-agent.ts" : "remote-spool-synthetic-agent.ts")], target: "node", minify: true })
    if (!build.success || build.outputs.length !== 1) throw new Error("bundle_gate")
    const bundle = await build.outputs[0].text(), sha = createHash("sha256").update(bundle).digest("hex")
    const bootstrap = `const fs=require("fs"),crypto=require("crypto");const root=${JSON.stringify(remoteRoot)},owner=${JSON.stringify(owner)};if(process.getuid()!==0)throw Error("root");const b=fs.readFileSync(0);if(crypto.createHash("sha256").update(b).digest("hex")!==${JSON.stringify(sha)})throw Error("sha");fs.mkdirSync(root,{mode:448});fs.writeFileSync(root+"/owner",owner,{mode:384,flag:"wx"});fs.writeFileSync(root+"/agent.mjs",b,{mode:384,flag:"wx"});console.log(JSON.stringify({ready:true}));`
    remoteMayExist = true
    await ssh(`${node} -e ${quote(bootstrap)}`, bundle)
    if (handoffMode) {
        const result = await ssh(`${node} ${quote(remoteRoot + "/agent.mjs")} controller ${owner}`, undefined, true)
        Object.assign(report, result)
        if (!result.passed || !result.runtimeCleaned || result.controllerExitCode !== 0) { report.passed = false; throw new Error("handoff_failed") }
    } else {
    const produced = await call(providerMode ? "init-provider" : "init")
    if (providerMode && (produced.simulatedRequests !== 30 || produced.recoveredWithoutInvocation !== true)) throw new Error("provider_stage_failed")
    const manifest = await call("manifest"), receiver = path.join(local, "receiver")
    openArtifactSpool(receiver, manifest)
    for (const index of [0, 1]) {
        const block = await call("block", index)
        acceptArtifactBlock(receiver, manifest, index, Buffer.from(block.data, "base64"))
    }
    const partial = await call("partial-block", 2)
    let rejected = false
    try { acceptArtifactBlock(receiver, manifest, 2, Buffer.from(partial.data, "base64")) } catch (e) { rejected = e instanceof Error && e.message === "block_integrity_failed" }
    if (!rejected) throw new Error("partial_accepted")
    const again = await call("manifest")
    openArtifactSpool(receiver, again)
    const missing = missingArtifactBlocks(receiver, again)
    if (missing.length !== manifest.blocks.length - 2) throw new Error("missing_count")
    console.log(JSON.stringify({ phase: "resume", initialBlocks: 2, partialRejected: true, missingBlocks: missing.length }))
    for (let i = 0; i < missing.length; i++) {
        const index = missing[i], block = await call("block", index)
        if (block.index !== index) throw new Error("block_identity")
        acceptArtifactBlock(receiver, again, index, Buffer.from(block.data, "base64"))
        if ((i + 1) % 10 === 0) console.log(JSON.stringify({ phase: "resume", recoveredBlocks: i + 1, total: missing.length }))
    }
    const receipt = finalizeArtifactSpool(receiver, again)
    if (receipt.sha256 !== produced.sha256 || receipt.bytes !== produced.bytes || (!providerMode && receipt.bytes !== 1680201)) throw new Error("final_receipt")
    Object.assign(report, { passed: true, bytes: receipt.bytes, sha256: receipt.sha256, blocks: manifest.blocks.length, resumedBlocks: missing.length,
        partialRejected: true, simulatedRequests: produced.simulatedRequests, recoveredWithoutInvocation: produced.recoveredWithoutInvocation })
    }
} catch (e) { report.error = e instanceof Error && /^[a-z_]+$/.test(e.message) ? e.message : "verification_failed" }
finally {
    if (remoteMayExist) {
        const cleanup = `const fs=require("fs");const root=${JSON.stringify(remoteRoot)},owner=${JSON.stringify(owner)};if(!fs.existsSync(root)){console.log(JSON.stringify({absent:true}));process.exit(0)}const s=fs.lstatSync(root);if(process.getuid()!==0||s.uid!==0||!s.isDirectory()||s.isSymbolicLink()||(s.mode&63)!==0||fs.readFileSync(root+"/owner","utf8")!==owner)throw Error("owner_gate");fs.rmSync(root,{recursive:true});console.log(JSON.stringify({absent:!fs.existsSync(root)}));`
        try { report.remoteCleaned = (await ssh(`${node} -e ${quote(cleanup)}`)).absent === true } catch { report.remoteCleaned = false }
    }
    const receiver = path.join(local, "receiver")
    if (fs.existsSync(receiver)) fs.rmSync(receiver, { recursive: true })
    report.localCleaned = !fs.existsSync(receiver)
    fs.writeFileSync(path.join(local, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(report))
    if (!report.passed || !report.remoteCleaned || !report.localCleaned) process.exitCode = 1
}
