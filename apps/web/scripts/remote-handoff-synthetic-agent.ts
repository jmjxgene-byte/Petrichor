import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { openCanaryCallJournal, runDurableCanaryBatch } from "./canary-call-journal"
import { acceptArtifactBlock, finalizeArtifactSpool, openArtifactSpool, publishSpoolFile, readPrivateSpoolFile } from "./canary-artifact-spool"
const [action, owner, raw] = process.argv.slice(2)
if (!/^[a-f0-9-]{36}$/.test(owner)) throw new Error("owner_gate")
const hostRoot = `/tmp/petrichor-spool-${owner}`, runtimeRoot = `/tmp/petrichor-runtime-${owner}`
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex")
function directoryGate(root: string, uid: number) {
    const s = fs.lstatSync(root)
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== uid || (s.mode & 0o077) !== 0 || readPrivateSpoolFile(path.join(root, "owner"), 100).toString() !== owner) throw new Error("directory_gate")
}
if (action === "controller") {
    if (process.getuid?.() !== 0) throw new Error("root_gate")
    directoryGate(hostRoot, 0)
    const report: Record<string, unknown> = { passed: false, modelCalls: 0, databaseCalls: 0 }
    const beforeImage = execFileSync("docker", ["inspect", "petrichor-web-1", "--format", "{{.Image}}"], { encoding: "utf8", timeout: 10000 }).trim()
    const runtime = (mode: string, value = "") => JSON.parse(execFileSync("docker", ["exec", "--user", "1000", "petrichor-web-1", "bun", `${runtimeRoot}/agent.mjs`, mode, owner, value], { encoding: "utf8", timeout: 15000, maxBuffer: 65536 }))
    try {
        const bundle = fs.readFileSync(fileURLToPath(import.meta.url))
        const bootstrap = `const fs=require("fs"),c=require("crypto"),root=${JSON.stringify(runtimeRoot)},owner=${JSON.stringify(owner)};if(process.getuid()!==1000)throw Error("uid");const b=fs.readFileSync(0);if(c.createHash("sha256").update(b).digest("hex")!==${JSON.stringify(hash(bundle))})throw Error("sha");fs.mkdirSync(root,{mode:448});fs.writeFileSync(root+"/owner",owner,{mode:384,flag:"wx"});fs.writeFileSync(root+"/agent.mjs",b,{mode:384,flag:"wx"});console.log(JSON.stringify({ready:true}));`
        execFileSync("docker", ["exec", "-i", "--user", "1000", "petrichor-web-1", "bun", "-e", bootstrap], { input: bundle, timeout: 15000, maxBuffer: 65536 })
        const first = runtime("execute")
        if (first.waiting !== 0 || first.invocations !== 1) throw new Error("first_gate")
        const mirror = (ordinal: number) => {
            const manifest = runtime("manifest", String(ordinal)), receiver = path.join(hostRoot, `received-${ordinal}`)
            openArtifactSpool(receiver, manifest)
            for (const block of manifest.blocks) {
                const row = runtime("block", `${ordinal}:${block.index}`)
                if (row.index !== block.index) throw new Error("block_gate")
                acceptArtifactBlock(receiver, manifest, row.index, Buffer.from(row.data, "base64"))
            }
            return finalizeArtifactSpool(receiver, manifest)
        }
        const receipt0 = mirror(0)
        // 宿主已持久化，但故意不发送ACK；再次执行仍只能等0，不能调用1。
        const lostAck = runtime("execute")
        if (lostAck.waiting !== 0 || lostAck.invocations !== 1) throw new Error("lost_ack_gate")
        const ack0 = runtime("ack", Buffer.from(JSON.stringify({ ordinal: 0, receipt: receipt0 })).toString("base64"))
        const afterRecovery = runtime("status")
        if (!ack0.accepted || afterRecovery.invocations !== 1) throw new Error("recovery_invoked_model")
        const second = runtime("execute")
        if (second.waiting !== 1 || second.invocations !== 2) throw new Error("second_gate")
        const receipt1 = mirror(1)
        runtime("ack", Buffer.from(JSON.stringify({ ordinal: 1, receipt: receipt1 })).toString("base64"))
        const finished = runtime("execute")
        if (!finished.complete || finished.invocations !== 2) throw new Error("completion_gate")
        Object.assign(report, { passed: true, simulatedInvocations: 2, ackLossBlockedNext: true, recoveryInvocations: 0,
            receipts: [receipt0, receipt1].map(r => ({ bytes: r.bytes, sha256: r.sha256 })) })
    } catch { report.error = "handoff_rehearsal_failed" }
    finally {
        const cleanup = `const fs=require("fs"),root=${JSON.stringify(runtimeRoot)},owner=${JSON.stringify(owner)};if(!fs.existsSync(root)){console.log(JSON.stringify({absent:true}));process.exit(0)}const s=fs.lstatSync(root);if(s.uid!==1000||!s.isDirectory()||s.isSymbolicLink()||(s.mode&63)!==0||fs.readFileSync(root+"/owner","utf8")!==owner)throw Error("owner_gate");fs.rmSync(root,{recursive:true});console.log(JSON.stringify({absent:!fs.existsSync(root)}));`
        try { report.runtimeCleaned = JSON.parse(execFileSync("docker", ["exec", "--user", "1000", "petrichor-web-1", "bun", "-e", cleanup], { encoding: "utf8", timeout: 10000 })).absent === true } catch { report.runtimeCleaned = false }
        report.webHealthy = execFileSync("docker", ["inspect", "petrichor-web-1", "--format", "{{.State.Health.Status}}"], { encoding: "utf8", timeout: 10000 }).trim() === "healthy"
        report.webImageUnchanged = execFileSync("docker", ["inspect", "petrichor-web-1", "--format", "{{.Image}}"], { encoding: "utf8", timeout: 10000 }).trim() === beforeImage
        if (!report.webHealthy || !report.webImageUnchanged) report.passed = false
        console.log(JSON.stringify(report))
        if (!report.passed || !report.runtimeCleaned) process.exitCode = 1
    }
} else {
    if (process.getuid?.() !== 1000) throw new Error("runtime_uid_gate")
    directoryGate(runtimeRoot, 1000)
    const journal = path.join(runtimeRoot, "journal")
    const requests = [0, 1].map(ordinal => JSON.stringify({ synthetic: true, ordinal }))
    const contract = { version: 1 as const, executionId: owner, planHash: "a".repeat(64), providerProfileHash: "b".repeat(64), calls: requests.map(body => ({ kind: "document_embedding" as const, requestHash: hash(body) })) }
    const responseRoot = (ordinal: number) => {
        if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 1) throw new Error("ordinal_gate")
        return path.join(journal, `call-${String(ordinal).padStart(2, "0")}`, "response")
    }
    const invocations = () => fs.readdirSync(runtimeRoot).filter(name => /^invocation-[01]$/.test(name)).length
    if (action === "execute") {
        openCanaryCallJournal(journal, contract)
        let waiting: number | null = null
        try {
            await runDurableCanaryBatch({ directory: journal, contract, requests,
                invoke: async (_body, ordinal) => {
                    fs.writeFileSync(path.join(runtimeRoot, `invocation-${ordinal}`), "synthetic", { flag: "wx", mode: 0o600 })
                    return Buffer.from(JSON.stringify({ ordinal, data: "x".repeat(180000) }))
                }, afterPersist: async receipt => {
                    waiting = receipt.ordinal
                    const expected = readPrivateSpoolFile(path.join(responseRoot(receipt.ordinal), "receipt.json"), 4096)
                    const ack = readPrivateSpoolFile(path.join(runtimeRoot, `ack-${receipt.ordinal}.json`), 4096)
                    if (!ack.equals(expected)) throw new Error("ack_mismatch")
                    waiting = null
                },
            })
            console.log(JSON.stringify({ complete: true, invocations: invocations() }))
        } catch (e) {
            if (!(e instanceof Error) || e.message !== "handoff_unconfirmed" || waiting === null) throw e
            console.log(JSON.stringify({ waiting, invocations: invocations() }))
        }
    } else if (action === "status") console.log(JSON.stringify({ invocations: invocations() }))
    else if (action === "manifest") console.log(readPrivateSpoolFile(path.join(responseRoot(Number(raw)), "manifest.json"), 16384).toString())
    else if (action === "block") {
        const [ordinal, index] = raw.split(":").map(Number)
        const root = responseRoot(ordinal), manifest = JSON.parse(readPrivateSpoolFile(path.join(root, "manifest.json"), 16384).toString())
        if (!Number.isInteger(index) || index < 0 || index >= manifest.blocks.length) throw new Error("block_index_gate")
        const bytes = readPrivateSpoolFile(path.join(root, `block-${String(index).padStart(3, "0")}`), 32768)
        if (hash(bytes) !== manifest.blocks[index].sha256) throw new Error("block_hash_gate")
        console.log(JSON.stringify({ index, data: bytes.toString("base64") }))
    } else if (action === "ack") {
        const ack = JSON.parse(Buffer.from(raw, "base64").toString())
        const expected = readPrivateSpoolFile(path.join(responseRoot(ack.ordinal), "receipt.json"), 4096)
        if (JSON.stringify(ack.receipt) !== expected.toString()) throw new Error("ack_gate")
        publishSpoolFile(path.join(runtimeRoot, `ack-${ack.ordinal}.json`), expected)
        console.log(JSON.stringify({ accepted: true }))
    } else throw new Error("action_gate")
}
