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
for (const mode of (process.argv[3] === "--idle-only" ? ["async-idle-text", "async-idle-reader"] : process.argv[3] === "--async-only" ? ["async-framed", "async-chunked"] : process.argv[3] === "--frame-only" ? ["framed"] : ["console", "awaited", "large-input"]) as Array<"console" | "awaited" | "large-input" | "framed" | "async-framed" | "async-chunked" | "async-idle-text" | "async-idle-reader">) {
    // 确定性浮点矩阵+中文，形状接近合成canary但不包含任何原始结果/环境信息。
    const asynchronous = mode.startsWith("async-")
    const framed = mode === "framed" || asynchronous
    const expression = asynchronous ? 'JSON.stringify({data:"x".repeat(1680190)})' : 'JSON.stringify({vectors:Array.from({length:56},(_,i)=>Array.from({length:1024},(_,j)=>(i*1024+j)/100003)),text:"合成传输诊断".repeat(16384)})'
    const payload = asynchronous ? JSON.stringify({ data: "x".repeat(1680190) }) : JSON.stringify({ vectors: Array.from({ length: 56 }, (_, i) => Array.from({ length: 1024 }, (_, j) => (i * 1024 + j) / 100003)), text: "合成传输诊断".repeat(16384) })
    const expected = framed ? encodeCanaryFrame(payload) : payload + "\n"
    const prefix = mode === "large-input" ? `const padding=${JSON.stringify("虚构输入\n".repeat(32768))};if(padding.length!==${"虚构输入\n".repeat(32768).length})throw Error("input_truncated");` : ""
    const asyncPrefix = 'const watchdog=setTimeout(()=>process.exit(124),25000);watchdog.unref();for(let i=0;i<22;i++){await Bun.sleep(20);const r=new Response("synthetic");const reader=r.body.getReader();while(!(await reader.read()).done){}await reader.cancel();} '
    const asyncSource = `${asyncPrefix}${mode.startsWith("async-idle") ? "await Bun.sleep(10000);" : ""}const value=${JSON.stringify(expected)}; ${mode === "async-chunked"
        ? 'const bytes=Buffer.from(value);for(let i=0;i<bytes.length;i+=16384){await new Promise((resolve,reject)=>process.stdout.write(bytes.subarray(i,i+16384),error=>error?reject(error):resolve()));}'
        : 'await Bun.write(Bun.stdout,value);'}clearTimeout(watchdog);`
    const source = asynchronous ? asyncSource : mode === "framed"
        ? `import {createHash} from "node:crypto";const value=${expression};const hash=createHash("sha256").update(value).digest("hex");await Bun.write(Bun.stdout,"PETRICHOR_CANARY_V1 "+Buffer.byteLength(value)+" "+hash+"\\n"+value+"\\nEND "+hash+"\\n")`
        : `${prefix}const value=${expression}; ${mode === "console" ? "console.log(value)" : 'await Bun.write(Bun.stdout,value+"\\n")'}`
    const child = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-p", port, "-i", identity, target,
        "docker exec -i -w /app/apps/web petrichor-web-1 bun run -"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    const startedAt = Date.now()
    let firstByteMs: number | null = null
    const chunks: Array<{ bytes: number; elapsedMs: number }> = []
    const stdout = mode === "async-idle-text" ? new Response(child.stdout).text() : (async () => {
        const reader = child.stdout.getReader(), parts: Uint8Array[] = []; let size = 0
        try {
            for (;;) {
                const { value, done } = await reader.read(); if (done) break
                firstByteMs ??= Date.now() - startedAt
                size += value.byteLength
                if (size > 4 * 1024 * 1024) throw new Error("diagnostic_output_limit")
                chunks.push({ bytes: value.byteLength, elapsedMs: Date.now() - startedAt }); parts.push(value)
            }
            return Buffer.concat(parts).toString("utf8")
        } finally { reader.releaseLock() }
    })()
    const stderr = new Response(child.stderr).text()
    const timer = setTimeout(() => child.kill(), 40000)
    try {
        let inputFailure: string | null = null
        try { child.stdin.write(source); await child.stdin.end() }
        catch (error) { inputFailure = error && typeof error === "object" && "code" in error && error.code === "EPIPE" ? "EPIPE" : "stdin_failed" }
        const [output, error, code] = await Promise.all([stdout, stderr, child.exited])
        let jsonValid = false
        try { const parsed = JSON.parse(framed ? decodeCanaryFrame(output) : output); jsonValid = asynchronous ? parsed.data.length === 1680190 : parsed.vectors.length === 56 && parsed.text.length === "合成传输诊断".length * 16384 } catch { /* 只记录失败布尔值 */ }
        const row = { mode, expectedBytes: Buffer.byteLength(expected), receivedBytes: Buffer.byteLength(output),
            expectedSha: sha(expected), receivedSha: sha(output), stderrBytes: Buffer.byteLength(error), stderrSha: sha(error),
            exitCode: code, inputFailure, stderrCategory: !error ? "none" : /Permission denied/.test(error) ? "authentication_failed" : /timed out/.test(error) ? "timeout" : /Connection.*closed|Broken pipe/i.test(error) ? "connection_closed" : "other",
            jsonValid, exact: output === expected, firstByteMs, chunks, modelCalls: 0, databaseCalls: 0 }
        records.push(row); console.log(JSON.stringify({ ...row, chunks: undefined, chunkCount: chunks.length, lastChunk: chunks.at(-1) }))
    } finally { clearTimeout(timer) }
}
fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(records, null, 2), { mode: 0o600 })
if (records.some(row => !row.exact || !row.jsonValid || row.exitCode !== 0)) process.exitCode = 1
