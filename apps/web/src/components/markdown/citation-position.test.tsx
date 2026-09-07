// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MarkdownPreview } from "./MarkdownPreview"
const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView")
const scroll = vi.fn()
beforeEach(() => {
    scroll.mockClear()
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll })
})
afterEach(() => {
    cleanup()
    if (originalScroll) Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll)
    else Reflect.deleteProperty(Element.prototype, "scrollIntoView")
})
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
    it("长文末尾命中将滚动目标绑定到末段，切换与移除引用不留旧高亮", () => {
        const value = Array.from({ length: 300 }, (_, index) => `第${index}段 重复内容`).join("\n\n")
        const start = value.lastIndexOf("第299段")
        const { container, rerender } = render(<MarkdownPreview value={value} sourceRange={{ start, end: value.length }} />)
        const target = container.querySelector("[data-citation-hit]")
        expect(target?.textContent).toBe("第299段 重复内容")
        expect(scroll).toHaveBeenCalledOnce()
        expect(scroll.mock.contexts[0]).toBe(target)
        expect(scroll).toHaveBeenCalledWith({ block: "center", behavior: "instant" })
        rerender(<MarkdownPreview value={value} sourceRange={{ start: 0, end: 10 }} />)
        expect(container.querySelectorAll("p")[299].hasAttribute("data-citation-hit")).toBe(false)
        expect(container.querySelectorAll("[data-citation-hit]")).toHaveLength(1)
        expect(container.querySelector("[data-citation-hit]")?.textContent).toContain("第0段")
        rerender(<MarkdownPreview value={value} />)
        expect(container.querySelector("[data-citation-hit]")).toBeNull()
        expect(scroll).toHaveBeenCalledTimes(2)
    })
    it("代码围栏和表格单元格可定位，非法范围不触发滚动", () => {
        const value = "```ts\nconst answer = 42\n```\n\n| A | B |\n|---|---|\n| 特定值 | 2 |"
        const start = value.indexOf("const")
        const { container, rerender } = render(<MarkdownPreview value={value} sourceRange={{ start, end: start + 5 }} />)
        expect(container.querySelector("pre[data-citation-hit]")).toBeTruthy()
        const cellStart = value.indexOf("特定值")
        rerender(<MarkdownPreview value={value} sourceRange={{ start: cellStart, end: cellStart + 3 }} />)
        expect(container.querySelector("td[data-citation-hit]")?.textContent).toBe("特定值")
        expect(container.querySelector("pre[data-citation-hit]")).toBeNull()
        rerender(<MarkdownPreview value={value} sourceRange={{ start: -1, end: 10 }} />)
        expect(container.querySelector("[data-citation-hit]")).toBeNull()
        expect(scroll).toHaveBeenCalledTimes(2)
    })
})
