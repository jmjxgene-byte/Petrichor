// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { MarkdownPreview } from "./MarkdownPreview"
afterEach(cleanup)
describe("Markdown源码定位", () => {
    it("重复文本仅标记命中的第二段，保留GFM及代码结构", () => {
        const value = "# 标题\n\n重复正文\n\n重复正文\n\n```ts\nconst a = 1\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |"
        const start = value.lastIndexOf("重复正文")
        const { container } = render(<MarkdownPreview value={value} sourceRange={{ start, end: start + 4 }} />)
        const paragraphs = container.querySelectorAll("p")
        expect(paragraphs[0].hasAttribute("data-citation-hit")).toBe(false)
        expect(paragraphs[1].getAttribute("data-citation-hit")).toBe("true")
        expect(container.querySelectorAll("[data-citation-hit]")).toHaveLength(1)
        expect(container.querySelector("pre")?.textContent).toContain("const a = 1")
        expect(container.querySelector("table")).toBeTruthy()
    })
    it("正文不能伪造高亮属性，无引用不增加高亮", () => {
        const { container } = render(<MarkdownPreview value={'<p data-citation-hit="true">假位置</p>\n\n正文'} />)
        expect(container.querySelector("[data-citation-hit]")).toBeNull()
    })
})
