// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
const read = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api", () => ({ docLibraryApi: { readCitation: read } }))
import { DocumentCitationPanel } from "./DocumentCitationPanel"
import { parseDocumentCitation } from "@/lib/document-citation"
const search = `?generationId=4&passageId=5&contentHash=${"a".repeat(64)}`
afterEach(() => { cleanup(); vi.clearAllMocks() })
describe("引用定位窗口", () => {
    it("缺参数或重复参数明确无效，普通文档不请求", () => {
        expect(parseDocumentCitation("?documentId=3")).toBeNull()
        expect(parseDocumentCitation("?generationId=4&passageId=5")).toBe("invalid")
        expect(parseDocumentCitation(`${search}&passageId=6`)).toBe("invalid")
        render(<DocumentCitationPanel libraryId="2" documentId="3" search="?generationId=4" />)
        expect(screen.getByText(/仅可查看原文/)).toBeTruthy()
        expect(read).not.toHaveBeenCalled()
    })
    it("按服务端偏移高亮，不按首次文字匹配猜位置", async () => {
        read.mockResolvedValue({ data: { title: "合成", content: "命中\n\n命中", anchorStart: 4, anchorEnd: 6 } })
        const { container } = render(<DocumentCitationPanel libraryId="2" documentId="3" search={search} />)
        await screen.findByText(/索引版本 #4/)
        expect(container.querySelector("mark")?.textContent).toBe("命中")
        expect(container.querySelector("mark")?.previousSibling?.textContent).toBe("命中\n\n")
    })
    it("失败显示不可定位，卸载中止读取", async () => {
        read.mockRejectedValue(new Error("gone"))
        const { unmount } = render(<DocumentCitationPanel libraryId="2" documentId="3" search={search} />)
        await screen.findByRole("alert")
        expect(screen.queryByText(/索引版本/)).toBeNull()
        const signal = read.mock.calls[0][3] as AbortSignal
        unmount()
        await waitFor(() => expect(signal.aborted).toBe(true))
    })
})
