import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import postgres from "postgres"
import { readCanaryProviderProfile } from "./canary-credential-bridge"
import { assertPrivateSpoolDirectory, readPrivateSpoolFile, publishSpoolFile } from "./canary-artifact-spool"

async function main() {
    const [action, owner, user, expectedSha] = process.argv.slice(2)
    if (!action || action === "--preflight") {
        console.log(JSON.stringify({ mode: "metadata_only_preflight", databaseCalls: 0, modelCalls: 0, selectsCredentialCiphertext: false, requiresSeparateApproval: true })); return
    }
    if (action !== "--read-profile-approved" || process.platform !== "linux" || process.getuid?.() !== 1000
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(owner)
        || !/^[1-9][0-9]*$/.test(user) || !Number.isSafeInteger(Number(user)) || !/^[a-f0-9]{64}$/.test(expectedSha)) throw new Error("profile_gate")
    const root = `/tmp/petrichor-profile-${owner}`, entry = fileURLToPath(import.meta.url)
    assertPrivateSpoolDirectory(root)
    if (path.dirname(entry) !== root || fs.lstatSync(root).uid !== 1000 || readPrivateSpoolFile(path.join(root, "owner"), 100).toString() !== owner) throw new Error("owner_gate")
    if (createHash("sha256").update(readPrivateSpoolFile(entry, 4 * 1024 * 1024)).digest("hex") !== expectedSha) throw new Error("entry_gate")
    // 独立核验一次性预约；失败不自动重试，连接串仅在当前进程中使用。
    fs.mkdirSync(path.join(root, "started"), { mode: 0o700 })
    publishSpoolFile(path.join(root, "started", "intent.json"), Buffer.from(JSON.stringify({ mode: "metadata_only", entrySha: expectedSha })))
    const url = process.env.DATABASE_URL
    if (!url) throw new Error("database_missing")
    const client = postgres(url, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} })
    try {
        const profile = await readCanaryProviderProfile({ client, userId: Number(user) })
        const result = { mode: "metadata_only", ...profile, modelCalls: 0, selectsCredentialCiphertext: false }
        publishSpoolFile(path.join(root, "result.json"), Buffer.from(JSON.stringify(result)))
        console.log(JSON.stringify(result))
    } finally { await client.end({ timeout: 2 }) }
}
if (import.meta.main) main().catch(() => {
    console.error(JSON.stringify({ failed: true, category: "profile_verification_failed", retryAllowed: false })); process.exitCode = 1
})
