import fs from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"

export const ARTIFACT_BLOCK_BYTES = 32 * 1024
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const schema = z.object({
    version: z.literal(1), executionId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), planHash: digest,
    bytes: z.number().int().min(1).max(4 * 1024 * 1024), sha256: digest,
    blockBytes: z.literal(ARTIFACT_BLOCK_BYTES),
    blocks: z.array(z.object({ index: z.number().int().nonnegative(), bytes: z.number().int().min(1).max(ARTIFACT_BLOCK_BYTES), sha256: digest }).strict()).min(1).max(128),
}).strict().superRefine((m, ctx) => {
    if (m.blocks.length !== Math.ceil(m.bytes / ARTIFACT_BLOCK_BYTES)
        || m.blocks.some((b, i) => b.index !== i || b.bytes !== Math.min(ARTIFACT_BLOCK_BYTES, m.bytes - i * ARTIFACT_BLOCK_BYTES))) ctx.addIssue({ code: "custom", message: "invalid_block_layout" })
})
export type ArtifactManifest = z.infer<typeof schema>

export function describeArtifact(payload: Uint8Array, executionId: string, planHash: string): ArtifactManifest {
    return schema.parse({ version: 1, executionId, planHash, bytes: payload.byteLength, sha256: hash(payload), blockBytes: ARTIFACT_BLOCK_BYTES,
        blocks: Array.from({ length: Math.ceil(payload.byteLength / ARTIFACT_BLOCK_BYTES) }, (_, index) => {
            const part = payload.subarray(index * ARTIFACT_BLOCK_BYTES, (index + 1) * ARTIFACT_BLOCK_BYTES)
            return { index, bytes: part.byteLength, sha256: hash(part) }
        }),
    })
}

function checkDirectory(directory: string) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("unsafe_spool_directory")
}
function readPrivate(file: string, maxBytes: number) {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) throw new Error("unsafe_spool_file")
    return fs.readFileSync(file)
}
/** 同目录先fsync再硬链接发布；EEXIST仅接受相同内容，不覆盖已有文件。 */
function publish(file: string, bytes: Uint8Array) {
    const temp = path.join(path.dirname(file), `.pending-${randomUUID()}`)
    let fd: number | undefined
    try {
        fd = fs.openSync(temp, "wx", 0o600)
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined
        try { fs.linkSync(temp, file) }
        catch (error) {
            if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error
            if (fs.lstatSync(file).size !== bytes.byteLength) throw new Error("spool_file_conflict")
            if (!readPrivate(file, bytes.byteLength).equals(Buffer.from(bytes))) throw new Error("spool_file_conflict")
        }
        const parent = fs.openSync(path.dirname(file), "r")
        try { fs.fsyncSync(parent) } finally { fs.closeSync(parent) }
    } finally {
        if (fd !== undefined) fs.closeSync(fd)
        if (fs.existsSync(temp)) fs.unlinkSync(temp)
    }
}
function boundManifest(directory: string, raw: unknown) {
    checkDirectory(directory)
    const manifest = schema.parse(raw)
    const stored = schema.parse(JSON.parse(readPrivate(path.join(directory, "manifest.json"), 64 * 1024).toString()))
    if (JSON.stringify(manifest) !== JSON.stringify(stored)) throw new Error("spool_manifest_mismatch")
    return manifest
}
const blockFile = (directory: string, index: number) => path.join(directory, `block-${String(index).padStart(3, "0")}`)

export function openArtifactSpool(directory: string, raw: unknown) {
    const manifest = schema.parse(raw)
    try { fs.mkdirSync(directory, { mode: 0o700 }) }
    catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error }
    checkDirectory(directory)
    publish(path.join(directory, "manifest.json"), Buffer.from(JSON.stringify(manifest)))
    return manifest
}
export function acceptArtifactBlock(directory: string, raw: unknown, index: number, bytes: Uint8Array) {
    const manifest = boundManifest(directory, raw)
    if (!Number.isInteger(index) || index < 0 || index >= manifest.blocks.length) throw new Error("invalid_block_index")
    const expected = manifest.blocks[index]
    if (bytes.byteLength !== expected.bytes || hash(bytes) !== expected.sha256) throw new Error("block_integrity_failed")
    publish(blockFile(directory, index), bytes)
}
export function missingArtifactBlocks(directory: string, raw: unknown) {
    const manifest = boundManifest(directory, raw)
    return manifest.blocks.flatMap(block => {
        const file = blockFile(directory, block.index)
        try {
            const bytes = readPrivate(file, block.bytes)
            if (bytes.length !== block.bytes || hash(bytes) !== block.sha256) throw new Error("stored_block_integrity_failed")
            return []
        } catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [block.index]
            throw error
        }
    })
}
export function finalizeArtifactSpool(directory: string, raw: unknown) {
    const manifest = boundManifest(directory, raw)
    if (missingArtifactBlocks(directory, manifest).length) throw new Error("artifact_incomplete")
    const payload = Buffer.concat(manifest.blocks.map(b => readPrivate(blockFile(directory, b.index), b.bytes)))
    if (payload.length !== manifest.bytes || hash(payload) !== manifest.sha256) throw new Error("artifact_integrity_failed")
    publish(path.join(directory, "artifact.bin"), payload)
    const receipt = { version: 1, executionId: manifest.executionId, manifestHash: hash(JSON.stringify(manifest)), bytes: payload.length, sha256: manifest.sha256, verified: true }
    publish(path.join(directory, "receipt.json"), Buffer.from(JSON.stringify(receipt)))
    return receipt
}

// 仅供canary受限执行日志复用同一文件权限与无覆盖发布实现。
export { checkDirectory as assertPrivateSpoolDirectory, readPrivate as readPrivateSpoolFile, publish as publishSpoolFile }
