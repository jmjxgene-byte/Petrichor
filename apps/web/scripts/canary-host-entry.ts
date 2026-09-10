import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { createCanaryCommandPort, runCanaryDockerCommand } from "./canary-command-port"
import { advanceCanaryHost, initializeCanaryHost } from "./canary-host-controller"
import { assertPrivateSpoolDirectory, readPrivateSpoolFile, publishSpoolFile } from "./canary-artifact-spool"

async function main() {
    const [action, owner, raw] = process.argv.slice(2)
    if (process.platform !== "linux" || process.getuid?.() !== 0 || !z.string().uuid().safeParse(owner).success
        || !["initialize", "step", "status"].includes(action)) throw new Error("host_gate")
    const root = `/root/petrichor-canary-${owner}`
    assertPrivateSpoolDirectory(root)
    if (fs.lstatSync(root).uid !== 0 || readPrivateSpoolFile(path.join(root, "owner"), 100).toString() !== owner) throw new Error("owner_gate")
    const config = JSON.parse(readPrivateSpoolFile(path.join(root, "command-config.json"), 8192).toString())
    const binding = JSON.parse(readPrivateSpoolFile(path.join(root, "binding.json"), 8192).toString())
    if (config.executionId !== owner || binding.executionId !== owner || binding.calls !== config.calls) throw new Error("binding_gate")
    for (const field of ["codeSha", "planHash", "requestSetHash", "providerProfileHash", "runtimeIdentity"]) if (config[field] !== binding[field]) throw new Error("binding_gate")
    const port = createCanaryCommandPort(config, runCanaryDockerCommand), directory = path.join(root, "journal")
    if (action === "initialize") {
        const snapshot = await port.inspect()
        if (snapshot.states.some(s => s !== "not_started")) throw new Error("runtime_already_started")
        initializeCanaryHost(directory, binding)
        console.log(JSON.stringify({ initialized: true, calls: 22 })); return
    }
    if (action === "status") {
        const snapshot = await port.inspect()
        console.log(JSON.stringify({ states: snapshot.states, acknowledged: Array.from({ length: 22 }, (_, i) => fs.existsSync(path.join(directory, `ack-${i}.json`))) })); return
    }
    if (fs.existsSync(path.join(root, "terminal-failure.json"))) throw new Error("batch_terminal_no_retry")
    if (!/^(0|[1-9][0-9]*)$/.test(raw) || Number(raw) >= 22) throw new Error("ordinal_gate")
    try {
        const result = await advanceCanaryHost({ directory, binding, port, ordinal: Number(raw), mode: "execute-one" })
        console.log(JSON.stringify(result))
    } catch {
        publishSpoolFile(path.join(root, "terminal-failure.json"), Buffer.from(JSON.stringify({ failed: true, ordinal: Number(raw), retryAllowed: false })))
        throw new Error("batch_step_failed")
    }
}
if (import.meta.main) main().catch(() => { console.error(JSON.stringify({ failed: true, category: "host_execution_failed", retryAllowed: false })); process.exitCode = 1 })
