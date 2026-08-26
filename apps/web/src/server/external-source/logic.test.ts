import { describe, expect, it } from "vitest"
import {
    decodeConnection,
    encodeConnection,
    GENEOPS_DATABASE,
    GENEOPS_POOLER_HOST,
    GENEOPS_POOLER_PORT,
    GENEOPS_READER_USERNAME,
    sourceCreateSchema,
    toSourceResponse,
} from "./logic"

describe("GeneOps 外部连接配置", () => {
    it("连接密码加密后可回读，且响应不泄露密码", () => {
        const encoded = encodeConnection("a-strong-reader-password-123")
        const decoded = decodeConnection(encoded)

        expect(encoded).not.toContain("a-strong-reader-password-123")
        expect(decoded).toEqual({
            host: GENEOPS_POOLER_HOST,
            port: GENEOPS_POOLER_PORT,
            database: GENEOPS_DATABASE,
            username: GENEOPS_READER_USERNAME,
            password: "a-strong-reader-password-123",
            ssl: true,
        })
    })

    it("创建配置要求长密码", () => {
        expect(() => sourceCreateSchema.parse({ name: "GeneOps", password: "short" })).toThrow()
    })

    it("普通用户响应隐藏连接端点与用户名", () => {
        const now = new Date()
        const response = toSourceResponse({
            id: 1,
            createdByUserId: 1,
            sourceType: "GENEOPS_SUPABASE",
            name: "GeneOps",
            enabled: false,
            globalShared: true,
            connectionEnc: "encrypted",
            capabilitiesJson: null,
            contractVersion: null,
            lastCheckedAt: null,
            lastCheckStatus: null,
            lastCheckMessage: null,
            createdAt: now,
            updatedAt: now,
        })

        expect(response.host).toBeNull()
        expect(response.username).toBeNull()
        expect(JSON.stringify(response)).not.toContain("encrypted")
    })
})
