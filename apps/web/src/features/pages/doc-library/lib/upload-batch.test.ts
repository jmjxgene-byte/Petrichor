import { expect, it, vi } from "vitest"
import { runDocumentUploadQueue } from "./upload-batch"

it("超过十个文件仍全部顺序处理，失败不计成功", async () => {
    const files = Array.from({ length: 19 }, (_, i) => new File(["test"], `${i}.md`))
    const seen: string[] = []
    let active = 0
    const failed = vi.fn()
    const result = await runDocumentUploadQueue(files, async (file) => {
        active += 1
        expect(active).toBe(1)
        seen.push(file.name)
        await Promise.resolve()
        active -= 1
        if (file.name === "2.md" || file.name === "17.md") throw new Error("fixture failure")
    }, failed)
    expect(result).toEqual({ success: 17, failed: 2 })
    expect(seen).toEqual(files.map((file) => file.name))
    expect(failed).toHaveBeenCalledTimes(2)
})
