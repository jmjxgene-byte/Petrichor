import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ reader: null as unknown, source: vi.fn(), policy: vi.fn() }))
vi.mock("@/server/db/read-budget", () => ({ withReadBudget: async (run: (reader: unknown, checkpoint: () => Promise<void>) => Promise<unknown>) => run(mocks.reader, async () => {}) }))
vi.mock("./index-source", () => ({ loadDocumentIndexSource: mocks.source }))
vi.mock("./index-provider", async (original) => ({ ...await original<typeof import("./index-provider")>(), resolveDocumentIndexQuotePolicy: mocks.policy }))
import { prepareDocumentIndexQuote, verifyIndexQuote } from "./index-quote"
const secret = "synthetic-only-signing-key-32-characters"
const profile = { modelRefId: 1, model: "synthetic", dimensions: 2, version: 1, key: "fixture" }
function fixture(rows: unknown[][]) {
    let i = 0
    mocks.reader = { select: () => {
        const result = rows[i++] ?? []
        const chain = { from: () => chain, where: () => chain, orderBy: () => chain, limit: () => chain,
            then: <T>(resolve: (rows: unknown[]) => T) => Promise.resolve(result).then(resolve) }
        return chain
    } }
}
beforeEach(() => vi.clearAllMocks())
describe("报价准备（无模型调用）", () => {
    it("读取合成源生成绑定报价，但令牌不包含正文", async () => {
        fixture([[{ id: 2 }], [{ id: 1 }]])
        mocks.source.mockResolvedValue({ source: "合成正文", title: "合成", sourceFormat: "raw_markdown", updatedAt: "2026-09-08T00:00:00Z" })
        mocks.policy.mockResolvedValue({ profile, policy: { profileKey: "fixture", credentialFingerprint: "a".repeat(64), maxInputTokens: 1000, tokenOverheadPerInput: 2,
            priceMicrousdPerMillionTokens: 1000, maxRequestFeeMicrousd: 0, pricingEvidence: "fixture", expiresAt: "2099-01-01T00:00:00Z", batchSize: 2 } })
        const quote = await prepareDocumentIndexQuote(7, 2, secret)
        expect(quote.documentCount).toBe(1); expect(quote.passageCount).toBe(1)
        expect(quote.maxInputTokens).toBeGreaterThan(0)
        const decoded = verifyIndexQuote(quote.token, secret, 7, 2)
        expect(decoded.documents[0].sourceFormat).toBe("raw_markdown")
        expect(JSON.stringify(decoded)).not.toContain("合成正文")
        expect(mocks.source).toHaveBeenCalledWith(7, 2, 1, expect.any(AbortSignal))
    })
    it("无文档时不加载模型配置或读取源", async () => {
        fixture([[{ id: 2 }], []])
        await expect(prepareDocumentIndexQuote(7, 2, secret)).rejects.toThrow("为空")
        expect(mocks.policy).not.toHaveBeenCalled(); expect(mocks.source).not.toHaveBeenCalled()
    })
    it("缺少核验策略时在读取源前停止", async () => {
        fixture([[{ id: 2 }], [{ id: 1 }]])
        mocks.policy.mockRejectedValueOnce(new Error("unverified"))
        await expect(prepareDocumentIndexQuote(7, 2, secret)).rejects.toThrow("unverified")
        expect(mocks.source).not.toHaveBeenCalled()
    })
})
