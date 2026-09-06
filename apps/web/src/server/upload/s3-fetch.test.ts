import { describe, expect, it } from "vitest"
import { readBoundedObjectBody } from "./s3-fetch"

describe("有上限的对象读取", () => {
    it("读取合法内容", async () => {
        const bytes = await readBoundedObjectBody(new Response("abcd"), 4)
        expect(bytes.toString()).toBe("abcd")
    })
    it("Content-Length 超限时拒绝", async () => {
        await expect(readBoundedObjectBody(new Response("abc", { headers: { "content-length": "1000" } }), 4)).rejects.toThrow("大小")
    })
    it("缺失或伪造 Content-Length 时按实际流字节拒绝", async () => {
        await expect(readBoundedObjectBody(new Response("abcdef"), 4)).rejects.toThrow("大小")
        await expect(readBoundedObjectBody(new Response("abcdef", { headers: { "content-length": "1" } }), 4)).rejects.toThrow("大小")
    })
})
