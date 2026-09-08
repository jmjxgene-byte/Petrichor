import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ARTIFACT_BLOCK_BYTES, acceptArtifactBlock, describeArtifact, finalizeArtifactSpool, missingArtifactBlocks, openArtifactSpool } from "../../../scripts/canary-artifact-spool"
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true }) })
function fixture(size = 1680201) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "petrichor-spool-")); roots.push(root)
    const directory = path.join(root, "receiver"), payload = Buffer.alloc(size, 65)
    const manifest = describeArtifact(payload, "synthetic-run", "a".repeat(64))
    openArtifactSpool(directory, manifest)
    const block = (index: number) => payload.subarray(index * ARTIFACT_BLOCK_BYTES, (index + 1) * ARTIFACT_BLOCK_BYTES)
    return { root, directory, payload, manifest, block }
}
describe("可恢复产物分块", () => {
    it("中断后只需缺失块，完整SHA与收据通过，重复提交幂等", () => {
        const f = fixture()
        for (let i = 0; i < 2; i++) acceptArtifactBlock(f.directory, f.manifest, i, f.block(i))
        expect(() => finalizeArtifactSpool(f.directory, f.manifest)).toThrow("artifact_incomplete")
        expect(fs.existsSync(path.join(f.directory, "artifact.bin"))).toBe(false)
        openArtifactSpool(f.directory, f.manifest)
        const missing = missingArtifactBlocks(f.directory, f.manifest)
        expect(missing).toHaveLength(50)
        for (const index of missing.reverse()) acceptArtifactBlock(f.directory, f.manifest, index, f.block(index))
        acceptArtifactBlock(f.directory, f.manifest, 0, f.block(0))
        const receipt = finalizeArtifactSpool(f.directory, f.manifest)
        expect(finalizeArtifactSpool(f.directory, f.manifest)).toEqual(receipt)
        expect(fs.readFileSync(path.join(f.directory, "artifact.bin"))).toEqual(f.payload)
        expect(fs.statSync(path.join(f.directory, "artifact.bin")).mode & 0o777).toBe(0o600)
    })
    it("截断和损坏块不落盘", () => {
        const f = fixture()
        expect(() => acceptArtifactBlock(f.directory, f.manifest, 0, f.block(0).subarray(1))).toThrow("block_integrity_failed")
        expect(() => acceptArtifactBlock(f.directory, f.manifest, 0, Buffer.alloc(32768, 66))).toThrow("block_integrity_failed")
        expect(missingArtifactBlocks(f.directory, f.manifest)).toHaveLength(52)
    })
    it("不同执行或计划不能复用收件目录", () => {
        const f = fixture()
        expect(() => openArtifactSpool(f.directory, { ...f.manifest, executionId: "different" })).toThrow("spool_file_conflict")
        expect(() => missingArtifactBlocks(f.directory, { ...f.manifest, planHash: "b".repeat(64) })).toThrow("spool_manifest_mismatch")
    })
    it("拒绝危险ID和不连续块布局", () => {
        expect(() => describeArtifact(Buffer.from("x"), "../../etc", "a".repeat(64))).toThrow()
        const f = fixture()
        expect(() => openArtifactSpool(path.join(f.root, "other"), { ...f.manifest, blocks: [...f.manifest.blocks].reverse() })).toThrow()
        expect(() => acceptArtifactBlock(f.directory, f.manifest, -1, f.block(0))).toThrow("invalid_block_index")
    })
    it("已有块被篡改时失败，不默认为可补传", () => {
        const f = fixture()
        acceptArtifactBlock(f.directory, f.manifest, 0, f.block(0))
        fs.writeFileSync(path.join(f.directory, "block-000"), "tampered")
        expect(() => missingArtifactBlocks(f.directory, f.manifest)).toThrow("stored_block_integrity_failed")
    })
    it("拒绝符号链接和宽权限目录", () => {
        const f = fixture()
        const link = path.join(f.root, "link"); fs.symlinkSync(f.directory, link)
        expect(() => openArtifactSpool(link, f.manifest)).toThrow("unsafe_spool_directory")
        fs.chmodSync(f.directory, 0o755)
        expect(() => missingArtifactBlocks(f.directory, f.manifest)).toThrow("unsafe_spool_directory")
    })
    it("全文件hash不匹配时不发布收据", () => {
        const f = fixture(10), bad = { ...f.manifest, sha256: "b".repeat(64) }, other = path.join(f.root, "bad")
        openArtifactSpool(other, bad); acceptArtifactBlock(other, bad, 0, f.payload)
        expect(() => finalizeArtifactSpool(other, bad)).toThrow("artifact_integrity_failed")
        expect(fs.existsSync(path.join(other, "receipt.json"))).toBe(false)
    })
    it("未发布的临时块不算完成，已有冲突产物不覆盖", () => {
        const f = fixture(10)
        fs.writeFileSync(path.join(f.directory, ".pending-orphan"), f.payload, { mode: 0o600 })
        expect(missingArtifactBlocks(f.directory, f.manifest)).toEqual([0])
        acceptArtifactBlock(f.directory, f.manifest, 0, f.payload)
        fs.writeFileSync(path.join(f.directory, "artifact.bin"), "conflict", { mode: 0o600 })
        expect(() => finalizeArtifactSpool(f.directory, f.manifest)).toThrow("spool_file_conflict")
        expect(fs.readFileSync(path.join(f.directory, "artifact.bin"), "utf8")).toBe("conflict")
        expect(fs.existsSync(path.join(f.directory, "receipt.json"))).toBe(false)
    })
})
