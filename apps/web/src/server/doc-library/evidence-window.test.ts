import { describe, expect, it } from "vitest"
import { buildEvidenceWindow } from "./evidence-window"

describe("命中优先证据窗口", () => {
    it("长文尾部命中保留，前文先裁剪而非裁掉命中", () => {
        const result = buildEvidenceWindow([
            { chunkIndex: 999, text: "前".repeat(4_000) },
            { chunkIndex: 1000, text: "真正命中的尾部回答" },
            { chunkIndex: 1001, text: "后".repeat(4_000) },
        ], 1000)
        expect(result.content).toContain("真正命中的尾部回答")
        expect(result.content.length).toBeLessThanOrEqual(4_000)
        expect(result.indices).toContain(1000)
        expect(result.content.slice(result.anchorStart, result.anchorEnd)).toBe("真正命中的尾部回答")
    })
    it("无论读取顺序如何，输出保持来源顺序", () => {
        expect(buildEvidenceWindow([
            { chunkIndex: 11, text: "后" }, { chunkIndex: 10, text: "命中" }, { chunkIndex: 9, text: "前" },
        ], 10).content).toBe("前\n\n命中\n\n后")
    })
    it("核心用完预算时不追加邻近片段", () => {
        const result = buildEvidenceWindow([{ chunkIndex: 0, text: "前" }, { chunkIndex: 1, text: "中".repeat(4_000) }], 1)
        expect(result.indices).toEqual([1])
    })
    it("失效及超预算核心明确失败，不回退到文档开头", () => {
        expect(() => buildEvidenceWindow([{ chunkIndex: 0, text: "无关开头" }], 100)).toThrow("已失效")
        expect(() => buildEvidenceWindow([{ chunkIndex: 1, text: "中".repeat(4_001) }], 1)).toThrow("预算")
    })
})
