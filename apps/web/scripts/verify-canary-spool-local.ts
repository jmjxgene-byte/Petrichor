import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ARTIFACT_BLOCK_BYTES, acceptArtifactBlock, describeArtifact, finalizeArtifactSpool, missingArtifactBlocks, openArtifactSpool } from "./canary-artifact-spool"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "petrichor-spool-recovery-"))
let passed = false
try {
    const sender = path.join(root, "sender"), receiver = path.join(root, "receiver")
    const payload = Buffer.from(JSON.stringify({ data: "x".repeat(1680190) }))
    const manifest = describeArtifact(payload, "synthetic-recovery", "a".repeat(64))
    for (const directory of [sender, receiver]) openArtifactSpool(directory, manifest)
    for (const block of manifest.blocks) acceptArtifactBlock(sender, manifest, block.index, payload.subarray(block.index * ARTIFACT_BLOCK_BYTES, (block.index + 1) * ARTIFACT_BLOCK_BYTES))
    finalizeArtifactSpool(sender, manifest)
    for (let index = 0; index < 2; index++) acceptArtifactBlock(receiver, manifest, index, payload.subarray(index * ARTIFACT_BLOCK_BYTES, (index + 1) * ARTIFACT_BLOCK_BYTES))
    const missingBefore = missingArtifactBlocks(receiver, manifest).length
    // 独立进程仅恢复缺失块；不调用生成器、数据库、provider或模型。
    const source = `import fs from "node:fs";import path from "node:path";
      import {missingArtifactBlocks,acceptArtifactBlock,finalizeArtifactSpool} from ${JSON.stringify(path.join(import.meta.dir, "canary-artifact-spool.ts"))};
      const sender=${JSON.stringify(sender)},receiver=${JSON.stringify(receiver)};
      const m=JSON.parse(fs.readFileSync(path.join(sender,"manifest.json"),"utf8"));const missing=missingArtifactBlocks(receiver,m);
      for(const i of missing)acceptArtifactBlock(receiver,m,i,fs.readFileSync(path.join(sender,"block-"+String(i).padStart(3,"0"))));
      console.log(JSON.stringify({resumedBlocks:missing.length,...finalizeArtifactSpool(receiver,m)}));`
    const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } })
    const timer = setTimeout(() => child.kill(), 30000)
    try {
        const [output, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        const receipt = JSON.parse(output)
        passed = code === 0 && missingBefore === 50 && receipt.resumedBlocks === 50 && receipt.sha256 === manifest.sha256
            && receipt.verified === true && fs.readFileSync(path.join(receiver, "artifact.bin")).equals(payload)
        console.log(JSON.stringify({ scope: "local_synthetic_spool", passed, bytes: payload.length, blocks: manifest.blocks.length,
            initiallyReceived: 2, resumedBlocks: receipt.resumedBlocks, sha256: receipt.sha256, modelCalls: 0, databaseCalls: 0 }))
    } finally { clearTimeout(timer) }
} finally {
    fs.rmSync(root, { recursive: true })
    const cleanupOk = !fs.existsSync(root)
    console.log(JSON.stringify({ cleanupOk }))
    if (!passed || !cleanupOk) process.exitCode = 1
}
