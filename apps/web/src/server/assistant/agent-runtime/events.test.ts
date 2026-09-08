import { describe, expect, it } from "vitest"
import { EvidenceStore } from "./evidence"
import { toPublicEvidence } from "./events"
import { evidenceForPersistence } from "./store"

describe("公开证据的窗口锚点摘要", () => {
    const content = "前".repeat(1000) + "真正命中" + "后".repeat(1000)
    function evidence(metadata: Record<string, unknown> = {}, source: "document" | "geneops" = "document") {
        return new EvidenceStore().add({ source, content, metadata })
    }
    it("实时和本地历史摘要保留核心命中，不重复持久化正文副本", () => {
        const item = evidence({ windowAnchorStart: 1000, windowAnchorEnd: 1004, startOffset: 90000 })
        expect(toPublicEvidence(item).snippet).toBe("真正命中")
        const stored = evidenceForPersistence(item)!
        expect(toPublicEvidence(stored).snippet).toBe("真正命中")
        expect(stored.metadata).not.toHaveProperty("snippet")
    })
    it("长核心最多展示280字符", () => {
        expect(toPublicEvidence(evidence({ windowAnchorStart: 1000, windowAnchorEnd: 1500 })).snippet).toBe(content.slice(1000, 1280))
    })
    it.each([
        {}, { startOffset: 1000, endOffset: 1004 },
        { windowAnchorStart: -1, windowAnchorEnd: 4 },
        { windowAnchorStart: 1.5, windowAnchorEnd: 4 },
        { windowAnchorStart: "1000", windowAnchorEnd: 1004 },
        { windowAnchorStart: 1000, windowAnchorEnd: 1000 },
        { windowAnchorStart: 1000, windowAnchorEnd: 10000 },
        { windowAnchorStart: 1000, windowAnchorEnd: 1004, anchorVerified: false },
    ])("无效或未验证锚点不冒用原文坐标 %j", (metadata) => {
        expect(toPublicEvidence(evidence(metadata)).snippet).toBe(content.slice(0, 280))
    })
    it("外部来源不消费本地窗口坐标", () => {
        expect(toPublicEvidence(evidence({ windowAnchorStart: 1000, windowAnchorEnd: 1004 }, "geneops")).snippet).toBe(content.slice(0, 280))
    })
})
