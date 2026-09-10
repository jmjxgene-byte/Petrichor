import { describe, expect, it } from "vitest"
import { reconcileRerankCanary } from "../../../scripts/reconcile-rerank-canary"
describe("重排批次终态对账", () => {
    it("拒绝越出.data的输入，不能读取任意本地路径", () => {
        expect(() => reconcileRerankCanary("/tmp/rerank", ".data/embedding-approved")).toThrow("path_gate")
        expect(() => reconcileRerankCanary(".data/rerank-canary", "/tmp/secret")).toThrow("path_gate")
    })
    it("拒绝伪造的终态字段，需由实际收据对账", () => {
        expect(() => reconcileRerankCanary(".data/rerank-canary", ".data/embedding-approved")).toThrow()
    })
})
