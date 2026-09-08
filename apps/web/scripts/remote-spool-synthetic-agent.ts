import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { ARTIFACT_BLOCK_BYTES, acceptArtifactBlock, describeArtifact, finalizeArtifactSpool, openArtifactSpool } from "./canary-artifact-spool"

const [action, owner, rawIndex] = process.argv.slice(2)
if (process.getuid?.() !== 0 || !/^[a-f0-9-]{36}$/.test(owner)) throw new Error("root_owner_gate")
const root = `/tmp/petrichor-spool-${owner}`, directory = path.join(root, "source")
const stat = fs.lstatSync(root)
if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) !== 0 || fs.readFileSync(path.join(root, "owner"), "utf8") !== owner) throw new Error("directory_gate")
if (action === "init") {
    if (fs.existsSync(directory)) throw new Error("already_generated")
    const payload = Buffer.from(JSON.stringify({ data: "x".repeat(1680190) }))
    const manifest = describeArtifact(payload, owner, "a".repeat(64))
    openArtifactSpool(directory, manifest)
    for (const b of manifest.blocks) acceptArtifactBlock(directory, manifest, b.index, payload.subarray(b.index * ARTIFACT_BLOCK_BYTES, (b.index + 1) * ARTIFACT_BLOCK_BYTES))
    console.log(JSON.stringify({ generated: true, ...finalizeArtifactSpool(directory, manifest) }))
} else if (action === "manifest") {
    console.log(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"))
} else if (action === "block" || action === "partial-block") {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"))
    const index = Number(rawIndex)
    if (!Number.isInteger(index) || index < 0 || index >= manifest.blocks.length) throw new Error("index_gate")
    const file = path.join(directory, `block-${String(index).padStart(3, "0")}`), stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) !== 0 || stat.size !== manifest.blocks[index].bytes) throw new Error("block_gate")
    const bytes = fs.readFileSync(file)
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.blocks[index].sha256) throw new Error("hash_gate")
    console.log(JSON.stringify({ index, data: (action === "partial-block" ? bytes.subarray(0, 100) : bytes).toString("base64") }))
} else throw new Error("action_gate")
