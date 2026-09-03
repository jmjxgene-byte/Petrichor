import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
    contractVersion: 2,
    sql: [] as string[],
    values: [] as unknown[][],
}))

vi.mock("./logic", () => ({
    geneOpsRetrievalV2Ready: (source: { contractVersion: number }) => source.contractVersion === 2,
    executeGeneOpsRpc: async (
        _input: unknown,
        query: (client: unknown, source: unknown) => Promise<unknown>,
    ) => {
        const client = (strings: TemplateStringsArray, ...values: unknown[]) => {
            mocks.sql.push(strings.join("?"))
            mocks.values.push(values)
            return Promise.resolve([])
        }
        return await query(client, {
            contractVersion: mocks.contractVersion,
            capabilitiesJson: null,
        })
    },
}))

import { readGeneOpsChunks, searchGeneOps } from "./geneops-query"

describe("GeneOps v1/v2 SQL contract selection", () => {
    beforeEach(() => {
        mocks.contractVersion = 2
        mocks.sql = []
        mocks.values = []
    })

    it("v2 search and anchored read use the versioned RPCs", async () => {
        await searchGeneOps({ userId: 1 }, { query: "ODR", mode: "exact" })
        await readGeneOpsChunks({ userId: 1 }, {
            documentId: "doc-1",
            anchorReplyId: "reply-9",
            anchorPosition: 7,
        })

        expect(mocks.sql[0]).toContain("knowledge_vault.search_v2")
        expect(mocks.sql[1]).toContain("knowledge_vault.read_chunks_v2")
        expect(mocks.values[1]).toEqual(["doc-1", "reply-9", 7, 2, 5])
    })

    it("v1 source keeps the existing RPCs", async () => {
        mocks.contractVersion = 1
        await searchGeneOps({ userId: 1 }, { query: "ODR", mode: "exact" })
        await readGeneOpsChunks({ userId: 1 }, { documentId: "doc-1" })

        expect(mocks.sql[0]).toContain("knowledge_vault.search_v1")
        expect(mocks.sql[1]).toContain("knowledge_vault.read_chunks_v1")
    })
})
