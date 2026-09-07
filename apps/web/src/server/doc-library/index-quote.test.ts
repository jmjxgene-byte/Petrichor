import { describe, expect, it } from "vitest"
import { signIndexQuote, verifyIndexQuote, type IndexQuotePayload } from "./index-quote"
import { prepareIndexManifest } from "./index-contract"
const secret = "synthetic-only-signing-key-32-characters"
const prepared = prepareIndexManifest([{ documentId: 1, sourceHash: "a".repeat(64), updatedAt: "2026-09-08T00:00:00Z" }], { modelRefId: 1, model: "synthetic", dimensions: 2, version: 1, key: "synthetic" })
const payload: IndexQuotePayload = { version: 1, userId: 7, libraryId: 2, documents: prepared.manifest.documents, profile: prepared.manifest.profile,
    quoteExpiresAt: "2099-01-01T00:00:00Z", policyHash: "b".repeat(64), passageCount: 1,
    approval: { approvalId: "fixture", manifestHash: prepared.manifestHash, maxInputTokens: 10, maxCostMicrousd: 10, expiresAt: "2099-01-02T00:00:00Z" } }
describe("索引报价签名", () => {
    it("绑定用户、文档库、模型、快照与预算", () => {
        expect(verifyIndexQuote(signIndexQuote(payload, secret), secret, 7, 2)).toEqual(payload)
    })
    it("篡改费用或原文范围不能沿用签名", () => {
        const token = signIndexQuote(payload, secret), mac = token.split(".")[1]
        const changed = { ...payload, approval: { ...payload.approval, maxCostMicrousd: 999 } }
        const forged = `${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${mac}`
        expect(() => verifyIndexQuote(forged, secret, 7, 2)).toThrow("签名")
    })
    it("跨用户、跨库、错密钥与过期报价拒绝", () => {
        const token = signIndexQuote(payload, secret)
        expect(() => verifyIndexQuote(token, secret, 8, 2)).toThrow("不属于")
        expect(() => verifyIndexQuote(token, secret, 7, 3)).toThrow("不属于")
        expect(() => verifyIndexQuote(token, "different-synthetic-key-32-characters", 7, 2)).toThrow("签名")
        expect(() => verifyIndexQuote(token, secret, 7, 2, Date.parse(payload.quoteExpiresAt))).toThrow("过期")
    })
    it("签名正确但manifest内在不一致也拒绝", () => {
        const token = signIndexQuote({ ...payload, documents: [{ ...payload.documents[0], sourceHash: "c".repeat(64) }] }, secret)
        expect(() => verifyIndexQuote(token, secret, 7, 2)).toThrow("manifest")
    })
    it("拒绝错误格式和超大令牌", () => {
        expect(() => verifyIndexQuote("not-a-token", secret, 7, 2)).toThrow("无效")
        expect(() => verifyIndexQuote("x".repeat(4*1024*1024), secret, 7, 2)).toThrow("无效")
    })
})
