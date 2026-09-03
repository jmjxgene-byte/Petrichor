import { describe, expect, it } from "vitest"
import {
    assertGeneOpsQualityCapabilityReady,
    decodeConnection,
    encodeConnection,
    GENEOPS_DATABASE,
    GENEOPS_PREFERRED_CONTRACT_VERSION,
    GENEOPS_POOLER_HOST,
    GENEOPS_POOLER_PORT,
    GENEOPS_READER_ROLE,
    GENEOPS_READER_USERNAME,
    geneOpsQualityCapabilityReady,
    geneOpsRetrievalV2Ready,
    isSupportedGeneOpsContractVersion,
    sourceCreateSchema,
    toSourceResponse,
} from "./logic"

describe("GeneOps 外部连接配置", () => {
    it("区分 Supavisor 登录用户名和数据库当前角色", () => {
        expect(GENEOPS_READER_ROLE).toBe("petrichor_geneops_reader")
        expect(GENEOPS_READER_USERNAME).toBe(`${GENEOPS_READER_ROLE}.snsvqlqwnpyzcftubeab`)
    })

    it("兼容 v1/v2，但质量能力只接受非过期 v2 状态", () => {
        expect(isSupportedGeneOpsContractVersion(1)).toBe(true)
        expect(isSupportedGeneOpsContractVersion(GENEOPS_PREFERRED_CONTRACT_VERSION)).toBe(true)
        expect(isSupportedGeneOpsContractVersion(3)).toBe(false)

        const ready = JSON.stringify({
            graph_enabled: true,
            quality_status: {
                stale: false,
                wiki_ready: true,
                graph_ready: true,
            },
        })
        expect(geneOpsQualityCapabilityReady(1, ready, "graph")).toBe(false)
        expect(geneOpsQualityCapabilityReady(2, ready, "graph")).toBe(true)
        expect(geneOpsQualityCapabilityReady(2, ready, "wiki")).toBe(true)

        const stale = JSON.stringify({
            quality_status: {
                stale: true,
                wiki_ready: true,
                graph_ready: true,
            },
        })
        expect(geneOpsQualityCapabilityReady(2, stale, "graph")).toBe(false)
        expect(geneOpsQualityCapabilityReady(2, null, "wiki")).toBe(false)
    })

    it("服务端执行层对 v1、缺失、过期和未就绪能力保持 fail-closed", () => {
        const ready = JSON.stringify({
            quality_status: { stale: false, wiki_ready: true, graph_ready: true },
        })
        const stale = JSON.stringify({
            quality_status: { stale: true, wiki_ready: true, graph_ready: true },
        })
        const graphDisabled = JSON.stringify({
            quality_status: { stale: false, wiki_ready: true, graph_ready: false },
        })

        expect(() => assertGeneOpsQualityCapabilityReady({ contractVersion: 1, capabilitiesJson: ready }, "graph"))
            .toThrow("QUALITY_NOT_READY:graph")
        expect(() => assertGeneOpsQualityCapabilityReady({ contractVersion: 2, capabilitiesJson: null }, "wiki"))
            .toThrow("QUALITY_NOT_READY:wiki")
        expect(() => assertGeneOpsQualityCapabilityReady({ contractVersion: 2, capabilitiesJson: stale }, "graph"))
            .toThrow("QUALITY_NOT_READY:graph")
        expect(() => assertGeneOpsQualityCapabilityReady({ contractVersion: 2, capabilitiesJson: graphDisabled }, "graph"))
            .toThrow("QUALITY_NOT_READY:graph")
        expect(() => assertGeneOpsQualityCapabilityReady({ contractVersion: 2, capabilitiesJson: ready }, "wiki"))
            .not.toThrow()
    })

    it("只有带 generation 的 v2 质量快照才启用 shared retrieval v2", () => {
        const ready = JSON.stringify({
            quality_status: {
                contract_version: 2,
                generation_id: "reply-sequence-v2-20",
            },
        })
        expect(geneOpsRetrievalV2Ready({ contractVersion: 2, capabilitiesJson: ready }))
            .toBe(true)
        expect(geneOpsRetrievalV2Ready({ contractVersion: 2, capabilitiesJson: JSON.stringify({
            quality_status: { contract_version: 1 },
        }) })).toBe(false)
        expect(geneOpsRetrievalV2Ready({ contractVersion: 1, capabilitiesJson: ready }))
            .toBe(false)
    })

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
