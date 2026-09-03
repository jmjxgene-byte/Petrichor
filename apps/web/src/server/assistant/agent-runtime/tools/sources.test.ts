import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
    getDb: vi.fn(),
    resolveSources: vi.fn(),
    searchGeneOps: vi.fn(),
    readGeneOpsChunks: vi.fn(),
}))

vi.mock("@/server/assistant/source-catalog", () => ({
    resolveAssistantSources: mocks.resolveSources,
}))

vi.mock("@/server/db/client", () => ({
    getDb: mocks.getDb,
    isSqliteDatabase: () => false,
}))

vi.mock("@/server/external-source/geneops-query", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/server/external-source/geneops-query")>()
    return {
        ...actual,
        searchGeneOps: mocks.searchGeneOps,
        readGeneOpsChunks: mocks.readGeneOpsChunks,
    }
})

import type { ToolExecutionContext } from "../types"
import { sourceTools } from "./sources"

const source = {
    ref: "external-source:1" as const,
    kind: "external-source" as const,
    id: "1",
    name: "GeneOps 生产知识",
    description: "实时",
    availability: "ready" as const,
    selectable: true,
    unavailableReason: null,
    updatedAt: "2026-08-27T00:00:00.000Z",
    capabilities: null,
}

function context(): ToolExecutionContext {
    return {
        runId: "run-1",
        userId: 1,
        conversationId: "thread-1",
        focus: { sourceScope: { mode: "selected", refs: [source.ref] } },
        delegationDepth: 0,
        state: {
            runId: "run-1",
            conversationId: "thread-1",
            userId: "1",
            goal: "Amazon 退货",
            complexity: "simple",
            plan: [],
            completedSteps: [],
            pendingSteps: [],
            loadedSkills: [],
            observations: [],
            evidence: [],
            openQuestions: [],
            assumptions: [],
            toolCallCount: 0,
            delegationCount: 0,
            iteration: 1,
            tokenUsage: { input: 0, output: 0, total: 0 },
            startedAt: 1,
            updatedAt: 1,
            status: "running",
        },
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveSources.mockResolvedValue({
        scope: { mode: "selected", refs: [source.ref] },
        selected: [source],
        unavailable: [],
    })
    mocks.searchGeneOps.mockResolvedValue([{
        result_key: "r1",
        document_id: "doc-1",
        reply_id: "reply-9",
        anchor_position: 7,
        chunk_kind: "post",
        title: "Amazon 退货标签经验",
        snippet: "候选摘要",
        author: "seller",
        source_url: "https://example.com/post/1",
        match_type: "exact",
        combined_score: 0.031,
    }])
    mocks.readGeneOpsChunks.mockResolvedValue([{
        document_id: "doc-1",
        chunk_position: 0,
        chunk_kind: "post",
        title: "Amazon 退货标签经验",
        content: "正文证据",
        author: "seller",
        source_url: "https://example.com/post/1",
        generation_id: "reply-sequence-v2-20",
        snapshot_id: "snapshot-1",
        anchor_reply_id: "reply-9",
        anchor_position: 7,
        published_at: "2025-01-02T03:04:05.000Z",
        publication_status: "known",
        source_position_status: "known",
        timeline_confidence: 1,
    }])
})

describe("unified source tools", () => {
    it("external-only lookup follows search to read and emits GeneOps evidence", async () => {
        const tool = sourceTools.find((item) => item.id === "source.lookup")!
        const output = await tool.execute(context(), { query: "Amazon 退货", limit: 10 })
        const normalized = tool.normalize!(output, { query: "Amazon 退货", limit: 10 })

        expect(mocks.searchGeneOps).toHaveBeenCalledOnce()
        expect(mocks.searchGeneOps).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 1, sourceId: 1 }),
            expect.objectContaining({ query: "Amazon 退货" }),
        )
        expect(mocks.readGeneOpsChunks).toHaveBeenCalledOnce()
        expect(mocks.readGeneOpsChunks).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 1, sourceId: 1 }),
            expect.objectContaining({
                documentId: "doc-1",
                anchorReplyId: "reply-9",
                anchorPosition: 7,
            }),
        )
        expect(normalized.evidence).toHaveLength(1)
        expect(normalized.evidence?.[0]).toMatchObject({
            source: "geneops",
            title: "Amazon 退货标签经验",
            content: "正文证据",
            url: "https://example.com/post/1",
            metadata: {
                sourceRef: "external-source:1",
                sourceName: "GeneOps 生产知识",
                publishedAt: "2025-01-02T03:04:05.000Z",
                timelineConfidence: 1,
                generationId: "reply-sequence-v2-20",
            },
        })
    })

    it("external-only failure is explicit instead of falling back", async () => {
        mocks.searchGeneOps.mockRejectedValueOnce(new Error("GeneOps unavailable"))
        const tool = sourceTools.find((item) => item.id === "source.search")!
        await expect(tool.execute(context(), { query: "Amazon" })).rejects.toThrow("GeneOps unavailable")
    })

    it("rejects a candidate whose read kind does not match its source", async () => {
        const tool = sourceTools.find((item) => item.id === "source.read")!
        await expect(tool.execute(context(), {
            kind: "document",
            sourceRef: "external-source:1",
            documentId: "9",
        })).rejects.toThrow("候选类型与资料源不匹配")
    })

    it("rejects a knowledge candidate that points outside the selected knowledge base", async () => {
        const knowledgeSource = {
            ...source,
            ref: "knowledge-base:7" as const,
            kind: "knowledge-base" as const,
            id: "7",
            name: "选定知识库",
        }
        mocks.resolveSources.mockResolvedValueOnce({
            scope: { mode: "selected", refs: [knowledgeSource.ref] },
            selected: [knowledgeSource],
            unavailable: [],
        })
        const tool = sourceTools.find((item) => item.id === "source.read")!
        await expect(tool.execute(context(), {
            kind: "knowledge",
            sourceRef: knowledgeSource.ref,
            knowledgeBaseId: "8",
            articleId: "12",
        })).rejects.toThrow("知识候选不属于当前选定的知识库")
    })

    it("rejects a document candidate that belongs to another library", async () => {
        const documentSource = {
            ...source,
            ref: "doc-library:3" as const,
            kind: "doc-library" as const,
            id: "3",
            name: "选定文档库",
        }
        mocks.resolveSources.mockResolvedValueOnce({
            scope: { mode: "selected", refs: [documentSource.ref] },
            selected: [documentSource],
            unavailable: [],
        })
        mocks.getDb.mockReturnValueOnce({
            select: () => ({
                from: () => ({
                    where: () => ({
                        limit: async () => [],
                    }),
                }),
            }),
        })
        const tool = sourceTools.find((item) => item.id === "source.read")!
        await expect(tool.execute(context(), {
            kind: "document",
            sourceRef: documentSource.ref,
            documentId: "99",
        })).rejects.toThrow("文档候选不属于当前选定的文档库")
    })
})
