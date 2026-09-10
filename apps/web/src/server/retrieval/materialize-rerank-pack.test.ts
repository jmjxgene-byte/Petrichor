import { describe, expect, it } from "vitest"
import { materializeRerankPack } from "../../../scripts/materialize-rerank-pack"
describe("重排请求包物化边界", () => {
    it("不允许输入或输出目录越出.data", () => {
        expect(() => materializeRerankPack("/tmp/secret", ".data/out")).toThrow("path_gate")
        expect(() => materializeRerankPack(".data/embedding-approved", "/tmp/out")).toThrow("path_gate")
    })
})
