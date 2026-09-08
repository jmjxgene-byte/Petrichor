import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { decodeCanaryFrame, encodeCanaryFrame } from "./canary-transport"

if (process.argv[2] !== "--synthetic-only") throw new Error("diagnostic_mode_required")
const target = process.env.QA_SSH_TARGET, port = process.env.QA_SSH_PORT, identity = process.env.QA_SSH_IDENTITY
if (!target || !port || !identity) throw new Error("ssh_configuration_missing")
const sha = (value: string) => createHash("sha256").update(value).digest("hex")
const root = path.resolve(import.meta.dir, "../../..")
const dir = path.join(root, `.data/transport-diagnostic-${Date.now()}`)
fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
const records = []
for (const mode of (process.argv[3] === "--frame-only" ? ["framed"] : ["console", "awaited", "large-input"]) as Array<"console" | "awaited" | "large-input" | "framed">) {
    // 确定性浮点矩阵+中文，形状接近合成canary但不包含任何原始结果/环境信息。
    const expression = 'JSON.stringify({vectors:Array.from({length:56},(_,i)=>Array.from({length:1024},(_,j)=>(i*1024+j)/100003)),text:"合成传输诊断".repeat(16384)})'
    const payload = JSON.stringify({ vectors: Array.from({ length: 56 }, (_, i) => Array.from({ length: 1024 }, (_, j) => (i * 1024 + j) / 100003)), text: "合成传输诊断".repeat(16384) })
    const expected = mode === "framed" ? encodeCanaryFrame(payload) : payload + "\n"
    const prefix = mode === "large-input" ? `const padding=${JSON.stringify("虚构输入\n".repeat(32768))};if(padding.length!==${"虚构输入\n".repeat(32768).length})throw Error("input_truncated");` : ""
    const source = mode === "framed"
        ? `import {createHash} from "node:crypto";const value=${expression};const hash=createHash("sha256").update(value).digest("hex");await Bun.write(Bun.stdout,"PETRICHOR_CANARY_V1 "+Buffer.byteLength(value)+" "+hash+"\\n"+value+"\\nEND "+hash+"\\n")`
        : `${prefix}const value=${expression}; ${mode === "console" ? "console.log(value)" : 'await Bun.write(Bun.stdout,value+"\\n")'}`
    const child = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-p", port, "-i", identity, target,
        "docker exec -i -w /app/apps/web petrichor-web-1 bun run -"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    child.stdin.write(source); await child.stdin.end()
    const timer = setTimeout(() => child.kill(), 60000)
    try {
        const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        let jsonValid = false
        try { const parsed = JSON.parse(mode === "framed" ? decodeCanaryFrame(output) : output); jsonValid = parsed.vectors.length === 56 && parsed.text.length === "合成传输诊断".length * 16384 } catch { /* 只记录失败布尔值 */ }
        const row = { mode, expectedBytes: Buffer.byteLength(expected), receivedBytes: Buffer.byteLength(output),
            expectedSha: sha(expected), receivedSha: sha(output), stderrBytes: Buffer.byteLength(error), stderrSha: sha(error),
            exitCode: code, jsonValid, exact: output === expected, modelCalls: 0, databaseCalls: 0 }
        records.push(row); console.log(JSON.stringify(row))
    } finally { clearTimeout(timer) }
}
fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(records, null, 2), { mode: 0o600 })
if (records.some(row => !row.exact || !row.jsonValid || row.exitCode !== 0)) process.exitCode = 1
