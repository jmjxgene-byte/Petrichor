import { describe, expect, it } from "vitest"
import { documentSearchTerms, documentHitSnippet, literalLikePattern } from "./search-query"

describe("文档中文词项召回", () => {
    it("口语短问提取翻新，不要求原文逐字出现整句", () => {
        expect(documentSearchTerms("翻新怎么翻？")).toEqual(["翻新"])
    })
    it("中文长句生成连续词项，保留英文标识", () => {
        const terms = documentSearchTerms("请问亚马逊链接翻新的 GPSR 要求是什么？")
        expect(terms).toContain("翻新")
        expect(terms).toContain("gpsr")
        expect(terms).not.toContain("是什么")
    })
    it("限制查询与词项规模；空查询不产生全库扫描词项", () => {
        expect(documentSearchTerms("？ ！")).toEqual([])
        expect(documentSearchTerms("你".repeat(500) + "词").length).toBeLessThanOrEqual(24)
    })
    it("用户通配符按字面量转义", () => {
        expect(literalLikePattern("a_b%\\c")).toBe("%a\\_b\\%\\\\c%")
    })
    it("命中分片尾部时摘要包括命中，不是分片开头", () => {
        const text = "无关前文".repeat(300) + "翻新目标" + "后文".repeat(100)
        expect(documentHitSnippet(text, ["翻新"])).toContain("翻新目标")
        expect(documentHitSnippet(text, ["翻新"]).length).toBeLessThanOrEqual(600)
    })
})
