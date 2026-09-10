import { describe, expect, it } from "vitest"
import { materializeCanaryPostgresFixture } from "../../../scripts/materialize-canary-pg-fixture"
describe("临时PG嵌入输入物化边界", () => {
    it("禁止读取或写入.data之外的路径", () => {
        expect(() => materializeCanaryPostgresFixture("/tmp/petrichor-outside")) .toThrow("fixture_directory_gate")
        const previous = process.env.CANARY_EMBEDDING_DIRECTORY
        process.env.CANARY_EMBEDDING_DIRECTORY = "/tmp/private-input"
        try { expect(() => materializeCanaryPostgresFixture(".data/canary-test-output")).toThrow("embedding_directory_gate") }
        finally { if (previous === undefined) delete process.env.CANARY_EMBEDDING_DIRECTORY; else process.env.CANARY_EMBEDDING_DIRECTORY = previous }
    })
})
