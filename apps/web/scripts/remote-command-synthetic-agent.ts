import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { createCanaryCommandPort, containerRuntimeIdentity, runCanaryDockerCommand, type CanaryCommand } from "./canary-command-port"
import { advanceCanaryHost, initializeCanaryHost } from "./canary-host-controller"
import { readPrivateSpoolFile, publishSpoolFile } from "./canary-artifact-spool"
declare const SYNTHETIC_PROCESS_FIXTURE: string
const [action, owner] = process.argv.slice(2)
if (process.getuid?.() !== 0 || !/^[a-f0-9-]{36}$/.test(owner) || !["controller", "cleanup"].includes(action)) throw new Error("host_gate")
const host = `/tmp/petrichor-spool-${owner}`, root = `/tmp/petrichor-runtime-${owner}`
const st = fs.lstatSync(host)
if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 63) || readPrivateSpoolFile(path.join(host, "owner"), 100).toString() !== owner) throw new Error("owner_gate")
const hash = (v: string) => createHash("sha256").update(v).digest("hex")
const docker = (args: string[], input?: string) => JSON.parse(execFileSync("docker", args, { input, encoding: "utf8", timeout: 15000, maxBuffer: 65536 }))
const inspect = (id: string) => docker(["inspect", "--format", '{"id":{{json .Id}},"image":{{json .Image}},"startedAt":{{json .State.StartedAt}},"running":{{json .State.Running}},"health":{{json .State.Health.Status}}}', id])
const cleanup = () => {
    const targetFile = path.join(host, "synthetic-target.json")
    if (!fs.existsSync(targetFile)) return true
    const id: string = JSON.parse(readPrivateSpoolFile(targetFile, 1000).toString()).id
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("target_gate")
    const code = `const fs=require('fs'),p=${JSON.stringify(root)},owner=${JSON.stringify(owner)};if(!fs.existsSync(p)){console.log('{"absent":true}');process.exit(0)}const s=fs.lstatSync(p);if(process.getuid()!==1000||s.uid!==1000||!s.isDirectory()||s.isSymbolicLink()||(s.mode&63)||fs.readFileSync(p+'/owner','utf8')!==owner)throw Error('owner');fs.rmSync(p,{recursive:true});console.log(JSON.stringify({absent:!fs.existsSync(p)}));`
    return docker(["exec", "--user", "1000", id, "bun", "-e", code]).absent === true
}
if (action === "cleanup") console.log(JSON.stringify({ runtimeCleaned: cleanup() }))
else {
    const report: Record<string, unknown> = { passed: false, modelCalls: 0, databaseCalls: 0 }
    const before = inspect("petrichor-web-1")
    if (!before.running || before.health !== "healthy" || !/^[a-f0-9]{64}$/.test(before.id)) throw new Error("web_gate")
    publishSpoolFile(path.join(host, "synthetic-target.json"), Buffer.from(JSON.stringify({ id: before.id })))
    try {
        const shim = `import process from 'node:process';const [a,o,v]=process.argv.slice(2);process.argv=[process.execPath,import.meta.filename,${JSON.stringify(root)},'exec','--user','1000',${JSON.stringify(before.id)},'bun',${JSON.stringify(root + "/entry.js")},a,o,v];await import('./fixture.mjs');`
        const c = { containerId: before.id, executionId: owner, runtimeIdentity: containerRuntimeIdentity(before.id, before.image, before.startedAt),
            codeSha: hash(shim), planHash: "a".repeat(64), requestSetHash: "b".repeat(64), providerProfileHash: "c".repeat(64) }
        const identity = { executionId: owner, codeSha: c.codeSha, planHash: c.planHash, requestSetHash: c.requestSetHash, providerProfileHash: c.providerProfileHash }
        const payload = JSON.stringify({ shim, fixture: SYNTHETIC_PROCESS_FIXTURE, config: { syntheticOnly: true, container: before, identity } })
        const bootstrap = `const fs=require('fs'),c=require('crypto'),p=${JSON.stringify(root)},owner=${JSON.stringify(owner)},b=fs.readFileSync(0);if(process.getuid()!==1000||c.createHash('sha256').update(b).digest('hex')!==${JSON.stringify(hash(payload))})throw Error('gate');const x=JSON.parse(b);fs.mkdirSync(p,{mode:448});for(const [n,v] of Object.entries({'owner':owner,'entry.js':x.shim,'fixture.mjs':x.fixture,'fixture.json':JSON.stringify(x.config)}))fs.writeFileSync(p+'/'+n,v,{flag:'wx',mode:384});console.log('{"ready":true}');`
        docker(["exec", "-i", "--user", "1000", before.id, "bun", "-e", bootstrap], payload)
        const binding = { ...identity, runtimeIdentity: c.runtimeIdentity, version: 1, calls: 22, expiresAt: new Date(Date.now() + 60000).toISOString() }
        const directory = path.join(host, "handoff")
        initializeCanaryHost(directory, binding)
        let executes = 0, recoveryBlocks = 0, recovering = false
        const runner = (command: CanaryCommand) => {
            if (command.args[6] === "execute-one") executes++
            if (recovering && command.args[6] === "block") recoveryBlocks++
            return runCanaryDockerCommand(command)
        }
        const input = { directory, binding, ordinal: 0 }
        let lost = false
        try { await advanceCanaryHost({ ...input, port: createCanaryCommandPort(c, runner), mode: "execute-one" }) }
        catch (e) { if (e instanceof Error && e.message === "host_ack_unconfirmed") lost = true; else throw e }
        if (!lost || executes !== 1) throw new Error("loss_gate")
        recovering = true
        const result = await advanceCanaryHost({ ...input, port: createCanaryCommandPort(c, runner), mode: "recover" })
        if (executes !== 1 || recoveryBlocks !== 0) throw new Error("recovery_gate")
        Object.assign(report, { passed: true, simulatedInvocations: executes, ackLossRecovered: true, recoveryInvocations: 0, recoveryBlocks,
            bytes: result.bytes, sha256: result.sha256, fixtureSha: hash(SYNTHETIC_PROCESS_FIXTURE) })
    } catch { report.error = "command_rehearsal_failed" }
    finally {
        try { report.runtimeCleaned = cleanup() } catch { report.runtimeCleaned = false }
        try { const after = inspect(before.id); report.webHealthy = after.health === "healthy"; report.webImageUnchanged = after.image === before.image; report.webInstanceUnchanged = after.startedAt === before.startedAt } catch { report.webHealthy = false }
        if (!report.runtimeCleaned || !report.webHealthy || !report.webImageUnchanged || !report.webInstanceUnchanged) report.passed = false
        console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1
    }
}
