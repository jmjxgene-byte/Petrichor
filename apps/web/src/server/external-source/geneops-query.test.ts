import { describe, expect, it, vi } from "vitest"

vi.mock("./logic", () => ({
    executeGeneOpsRpc: vi.fn(async (input: unknown) => input),
}))

import {
    expandGeneOpsGraph,
    getGeneOpsBacklinks,
    readGeneOpsChunks,
    searchGeneOps,
    searchGeneOpsGraph,
} from "./geneops-query"

type AuditInput = {
    toolName: string
    requiredCapability?: "wiki" | "graph"
}

function auditInput(value: unknown) {
    return value as AuditInput
}

describe("GeneOps 查询质量能力绑定", () => {
    const actor = { userId: 7, sourceId: 3, threadId: 5, runId: 9 }

    it("Exact/Fuzzy 与 anchored read 不依赖未就绪的 Wiki/Graph", async () => {
        const search = auditInput(await searchGeneOps(actor, { query: "FBA", mode: "exact" }))
        const read = auditInput(await readGeneOpsChunks(actor, { documentId: "doc-1" }))

        expect(search).toMatchObject({ toolName: "geneops.search" })
        expect(read).toMatchObject({ toolName: "geneops.read_chunks" })
        expect(search.requiredCapability).toBeUndefined()
        expect(read.requiredCapability).toBeUndefined()
    })

    it("Graph 搜索与展开必须绑定 graph 质量能力", async () => {
        const search = auditInput(await searchGeneOpsGraph(actor, { query: "FBA" }))
        const expand = auditInput(await expandGeneOpsGraph(actor, { nodeId: "node-1" }))

        expect(search).toMatchObject({ toolName: "geneops.graph_search", requiredCapability: "graph" })
        expect(expand).toMatchObject({ toolName: "geneops.graph_expand", requiredCapability: "graph" })
    })

    it("Backlinks 必须绑定 wiki 质量能力", async () => {
        const backlinks = auditInput(await getGeneOpsBacklinks(actor, { pageId: "page-1" }))

        expect(backlinks).toMatchObject({ toolName: "geneops.backlinks", requiredCapability: "wiki" })
    })
})
