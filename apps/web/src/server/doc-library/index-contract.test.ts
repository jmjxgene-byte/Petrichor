import { describe, expect, it } from "vitest"
import { parseStoredIndexManifest, prepareIndexManifest, requireIndexApproval } from "./index-contract"
const profile = { modelRefId: 1, model: "synthetic", dimensions: 1024, version: 1, key: "synthetic:v1" }
const doc = { documentId: 1, sourceHash: "a".repeat(64), updatedAt: "2026-09-08T00:00:00.000Z" }

describe("索引manifest与审批绑定", () => {
    it("旧v1 manifest按原版本核验，新构建v2不复用旧hash或审批", () => {
        const old = prepareIndexManifest([doc], profile, 1)
        const current = prepareIndexManifest([doc], profile)
        expect(current.manifest.preprocessingVersion).toBe(2)
        expect(parseStoredIndexManifest(JSON.stringify(old.manifest), old.manifestHash)).toEqual(old.manifest)
        expect(current.manifestHash).not.toBe(old.manifestHash)
        expect(() => parseStoredIndexManifest(JSON.stringify(current.manifest), old.manifestHash)).toThrow("校验失败")
        expect(() => parseStoredIndexManifest(JSON.stringify({ ...old.manifest, preprocessingVersion: 3 }), old.manifestHash)).toThrow()
    })
    it("顺序无关，模型/源内容变化必须产生不同manifest", () => {
        const other = { ...doc, documentId: 2 }
        expect(prepareIndexManifest([doc, other], profile)).toEqual(prepareIndexManifest([other, doc], profile))
        const base = prepareIndexManifest([doc], profile).manifestHash
        expect(prepareIndexManifest([{ ...doc, sourceHash: "b".repeat(64) }], profile).manifestHash).not.toBe(base)
        expect(prepareIndexManifest([doc], { ...profile, dimensions: 512 }).manifestHash).not.toBe(base)
    })
    it("拒绝重复文档、未知维度及额外配置字段", () => {
        expect(() => prepareIndexManifest([doc, doc], profile)).toThrow("重复")
        expect(() => prepareIndexManifest([doc], { ...profile, dimensions: null })).toThrow()
        expect(() => prepareIndexManifest([doc], { ...profile, apiKey: "forbidden" })).toThrow()
    })
    it("拒绝过期、错配与零费用预算；不凭manifest当批准", () => {
        const manifestHash = prepareIndexManifest([doc], profile).manifestHash
        const approval = { approvalId: "synthetic", manifestHash, maxInputTokens: 1000, maxCostMicrousd: 1000, expiresAt: "2026-09-09T00:00:00.000Z" }
        expect(requireIndexApproval(approval, manifestHash, 0)).toEqual(approval)
        expect(() => requireIndexApproval(approval, "b".repeat(64), 0)).toThrow("不匹配")
        expect(() => requireIndexApproval(approval, manifestHash, Date.parse(approval.expiresAt))).toThrow("过期")
        expect(() => requireIndexApproval({ ...approval, maxCostMicrousd: 0 }, manifestHash, 0)).toThrow()
    })
})
