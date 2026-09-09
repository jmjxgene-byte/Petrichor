// 仅测试用的Docker命令协议替身：无网络、凭证、数据库或生产入口。
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import process from "node:process"
import { Buffer } from "node:buffer"
const [root, ...args] = process.argv.slice(2)
const stat = fs.lstatSync(root)
if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 63)) throw new Error("test_root_invalid")
const config = JSON.parse(fs.readFileSync(path.join(root, "fixture.json"), "utf8"))
if (config.syntheticOnly !== true) throw new Error("synthetic_only")
const sha = value => createHash("sha256").update(value).digest("hex")
const report = value => process.stdout.write(JSON.stringify(value))
const saved = path.join(root, "result.json")
const [action, owner, raw] = args.slice(6)
if (args[0] === "inspect") {
    if (args[3] !== config.container.id) throw new Error("container_invalid")
    report(config.container)
} else {
    if (args[0] !== "exec" || args[1] !== "--user" || args[2] !== "1000" || args[3] !== config.container.id || args[4] !== "bun"
        || args[5] !== `/tmp/petrichor-runtime-${config.identity.executionId}/entry.js` || owner !== config.identity.executionId) throw new Error("command_invalid")
    if (action === "status") {
        const states = Array(22).fill("not_started")
        if (fs.existsSync(saved)) states[0] = "persisted"
        report({ ...config.identity, states, modelCalls: 0, databaseCalls: 0 })
    } else if (action === "execute-one") {
        if (raw !== "0") throw new Error("test_single_item_only")
        fs.writeFileSync(path.join(root, "invocation"), "synthetic", { flag: "wx", mode: 384 })
        const bytes = Buffer.from("synthetic-process-result".repeat(6000))
        const manifest = { version: 1, executionId: `${owner}-0`, planHash: config.identity.planHash, bytes: bytes.length,
            sha256: sha(bytes), blockBytes: 32768, blocks: [] }
        for (let index = 0; index * 32768 < bytes.length; index++) {
            const part = bytes.subarray(index * 32768, (index + 1) * 32768)
            manifest.blocks.push({ index, bytes: part.length, sha256: sha(part) })
        }
        const receipt = { version: 1, executionId: manifest.executionId, manifestHash: sha(JSON.stringify(manifest)), bytes: bytes.length, sha256: manifest.sha256, verified: true }
        fs.writeFileSync(saved, JSON.stringify({ manifest, receipt, data: bytes.toString("base64") }), { flag: "wx", mode: 384 })
        report({ ordinal: 0, receipt, waitingForHostAck: true })
    } else if (action === "manifest") {
        if (raw !== "0") throw new Error("ordinal_invalid")
        report(JSON.parse(fs.readFileSync(saved, "utf8")).manifest)
    } else if (action === "block") {
        if (!/^0:[0-7]$/.test(raw)) throw new Error("block_invalid")
        const index = Number(raw.split(":")[1]), result = JSON.parse(fs.readFileSync(saved, "utf8"))
        const bytes = Buffer.from(result.data, "base64").subarray(index * 32768, (index + 1) * 32768)
        report({ index, data: bytes.toString("base64") })
    } else if (action === "ack") {
        const ack = JSON.parse(Buffer.from(raw, "base64").toString()), result = JSON.parse(fs.readFileSync(saved, "utf8"))
        if (ack.ordinal !== 0 || JSON.stringify(ack.receipt) !== JSON.stringify(result.receipt)) throw new Error("ack_invalid")
        // 每个新进程都能看到已确认状态；首次故意丢失ACK返回。
        const ackFile = path.join(root, "ack")
        if (!fs.existsSync(ackFile)) {
            fs.writeFileSync(ackFile, "synthetic", { mode: 384, flag: "wx" })
            process.exitCode = 7
        } else report({ acknowledged: 0, modelCalls: 0, databaseCalls: 0 })
    } else throw new Error("action_invalid")
}
