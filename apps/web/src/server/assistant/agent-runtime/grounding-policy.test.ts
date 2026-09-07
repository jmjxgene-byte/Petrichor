import { describe, expect, it } from "vitest"
import { groundingPolicy, groundingQueries } from "./grounding-policy"

describe("资料问答执行策略", () => {
    it.each(["翻新怎么翻？", "这个呢？", "GPSR 是什么", "你好，翻新怎么操作？", "如何删除文档？", "删除这个文档的注意事项", "把这句话翻译成英文，并告诉我最新业务规则"])("内容问题不得豁免：%s", (goal) => {
        expect(groundingPolicy(goal)).toBe("required")
    })
    it.each(["你好！", "谢谢", "请把这句话翻译成英文", "翻译：hello", "把上面的回答改成列表"])("明确豁免：%s", (goal) => {
        expect(groundingPolicy(goal)).toBe("exempt")
    })
    it("操作请求保留既有确认链，不误认为知识问答", () => {
        expect(groundingPolicy("删除这个文档")).toBe("action")
    })
    it("只生成一次关键词补检，不丢失原问题", () => {
        expect(groundingQueries("翻新怎么翻？")).toEqual(["翻新怎么翻？", "翻新"])
        expect(groundingQueries("GPSR")).toEqual(["GPSR"])
    })
})
