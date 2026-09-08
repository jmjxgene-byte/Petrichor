import { describe, expect, it } from "vitest"
import { geneOpsTools } from "./tools/geneops"
import { EvidenceStore, scoreSourceQuality } from "./evidence"
import { renderEvidence } from "./context-manager"
import { evidenceForPersistence } from "./store"
import { toPublicEvidence } from "./events"
describe("GeneOps v1证据限制", () => {
    it("不把连接类型当成高质量，也不声称验证了搜索锚点", () => {
        const tool = geneOpsTools.find((item) => item.id === "geneops.read_chunks")!
        const normalized = tool.normalize!([{ document_id: "fixture", chunk_position: 0, chunk_kind: "post", title: "合成", content: "仅内存正文", author: null, source_url: "https://example.invalid/post" }], {})
        const evidence = new EvidenceStore().add(normalized.evidence![0])
        expect(evidence.confidence).toBeUndefined()
        expect(scoreSourceQuality(evidence)).toBe(0.5)
        expect(renderEvidence(evidence, 1)).toContain("未校验搜索命中位置")
        const stored = evidenceForPersistence(evidence)!
        expect(stored.content).toBe("")
        expect(toPublicEvidence(stored).anchorVerified).toBe(false)
        expect(JSON.stringify(stored)).not.toContain("仅内存正文")
    })
})
