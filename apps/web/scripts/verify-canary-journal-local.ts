import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { openCanaryCallJournal, runDurableCanaryCall } from "./canary-call-journal"
const root = fs.mkdtempSync(path.join(os.tmpdir(), "petrichor-call-recovery-"))
let passed = false
try {
    const requestJson = '{"synthetic":true}', hash = (v: string) => createHash("sha256").update(v).digest("hex")
    const directory = path.join(root, "journal")
    const contract = openCanaryCallJournal(directory, { version: 1, executionId: "synthetic", planHash: "a".repeat(64), providerProfileHash: "b".repeat(64), calls: [{ kind: "document_embedding", requestHash: hash(requestJson) }] })
    let callbacks = 0
    const payload = Buffer.from(JSON.stringify({ synthetic: "x".repeat(180000) }))
    await runDurableCanaryCall({ directory, contract, ordinal: 0, requestJson, invoke: async () => { callbacks++; return payload } })
    // 新进程只允许读取已持久化结果，invoke一旦被调用即失败。
    const code = `import fs from "node:fs";import {createHash} from "node:crypto";
      import {runDurableCanaryCall} from ${JSON.stringify(path.join(import.meta.dir, "canary-call-journal.ts"))};
      const directory=${JSON.stringify(directory)},requestJson=${JSON.stringify(requestJson)};
      const contract=JSON.parse(fs.readFileSync(directory+"/contract.json","utf8"));
      const result=await runDurableCanaryCall({directory,contract,ordinal:0,requestJson,invoke:async()=>{throw Error("forbidden_repeat")}});
      console.log(JSON.stringify({reused:result.reused,hash:createHash("sha256").update(result.payload).digest("hex")}));`
    const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } })
    const timer = setTimeout(() => child.kill(), 30000)
    try {
        const [output, , exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        const result = JSON.parse(output)
        passed = callbacks === 1 && exitCode === 0 && result.reused === true && result.hash === hash(payload.toString())
        console.log(JSON.stringify({ passed, simulatedInvocations: callbacks, recoveryReused: result.reused, bytes: payload.length, sha256: result.hash, modelCalls: 0, databaseCalls: 0 }))
    } finally { clearTimeout(timer) }
} finally {
    fs.rmSync(root, { recursive: true })
    const cleanupOk = !fs.existsSync(root)
    console.log(JSON.stringify({ cleanupOk }))
    if (!passed || !cleanupOk) process.exitCode = 1
}
