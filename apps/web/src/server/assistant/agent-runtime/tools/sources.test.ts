import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
    getDb: vi.fn(),
    resolveSources: vi.fn(),
    searchGeneOps: vi.fn(),
    readGeneOpsChunks: vi.fn(),
    searchDocuments: vi.fn(),
    readDocument: vi.fn(),
    searchIndex: vi.fn(),
    readIndex: vi.fn(),
}))

vi.mock("@/server/doc-library/index-retrieval", () => ({ searchDocumentIndex: mocks.searchIndex, readDocumentIndexPassage: mocks.readIndex }))

vi.mock("@/server/assistant/tools/doc-library", () => ({
    searchDocuments: mocks.searchDocuments,
    readDocument: mocks.readDocument,
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
import { EvidenceStore } from "../evidence"
import { toPublicEvidence } from "../events"

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
    mocks.searchIndex.mockResolvedValue({ hits: [], indexedLibraryIds: [], degraded: [] })
    mocks.resolveSources.mockResolvedValue({
        scope: { mode: "selected", refs: [source.ref] },
        selected: [source],
        unavailable: [],
    })
    mocks.searchGeneOps.mockResolvedValue([{
        result_key: "r1",
        document_id: "doc-1",
        reply_id: null,
        chunk_kind: "post",
        title: "Amazon 退货标签经验",
        snippet: "候选摘要",
        author: "seller",
        source_url: "https://example.com/post/1",
        match_type: "exact",
    }])
    mocks.readGeneOpsChunks.mockResolvedValue([{
        document_id: "doc-1",
        chunk_position: 0,
        chunk_kind: "post",
        title: "Amazon 退货标签经验",
        content: "正文证据",
        author: "seller",
        source_url: "https://example.com/post/1",
    }])
})

describe("unified source tools", () => {
    it("旧关键词候选携带版本和hash，下一查询版本漂移不合并", async () => {
        const local = { ...source, ref: "doc-library:3", kind: "doc-library", id: "3" }
        mocks.resolveSources.mockResolvedValue({ scope: { mode: "selected", refs: [local.ref] }, selected: [local], unavailable: [] })
        const date = new Date(0).toISOString()
        const row = { documentId: "12", chunkId: "901", libraryId: "3", title: "合成", snippet: "内容", href: "/document/12",
            expectedUpdatedAt: date, anchorContentHash: "a".repeat(64) }
        mocks.searchDocuments.mockResolvedValue([row])
        mocks.readDocument.mockResolvedValue({ documentId: "12", href: "/document/12", title: "合成", fileName: "demo.md",
            updatedAt: date, anchorIndex: 900, chunks: [{ chunkIndex: 900, text: "合成正文", locator: null }] })
        const ctx = context()
        const lookup = sourceTools.find((item) => item.id === "source.lookup")!
        const result = await lookup.execute(ctx, { query: "合成" })
        expect(lookup.normalize!(result, {}).evidence?.[0].metadata?.documentVersion).toBe(date)
        expect(mocks.readDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ expectedUpdatedAt: date, anchorContentHash: row.anchorContentHash }))
        mocks.searchDocuments.mockResolvedValue([{ ...row, expectedUpdatedAt: new Date(1).toISOString() }])
        const search = sourceTools.find((item) => item.id === "source.search")!
        expect(await search.execute(ctx, { query: "下一轮" })).toMatchObject({ candidates: [], degradedSources: [expect.objectContaining({ message: "本轮关键词文档版本已变化，未合并新旧内容" })] })
        expect(mocks.readDocument).toHaveBeenCalledTimes(1)
    })
    it("已固定代际失败不回退旧chunk；同Run共享session，新Run隔离", async () => {
        const local = { ...source, ref: "doc-library:3", kind: "doc-library", id: "3" }
        mocks.resolveSources.mockResolvedValue({ scope: { mode: "selected", refs: [local.ref] }, selected: [local], unavailable: [] })
        const sessions: unknown[] = []
        mocks.searchIndex.mockImplementation(async ({ session }) => {
            sessions.push(session)
            session.pins.set(3, 5)
            throw new Error("fixture failure")
        })
        const tool = sourceTools.find((item) => item.id === "source.search")!
        const ctx = context()
        const result = await tool.execute(ctx, { query: "合成" })
        expect(result).toMatchObject({ candidates: [], degradedSources: [expect.objectContaining({ message: "本轮固定索引检索失败，未切换资料版本" })] })
        await tool.execute({ ...ctx }, { query: "第二轮" })
        await tool.execute(context(), { query: "新Run" })
        expect(sessions[0]).toBe(sessions[1])
        expect(sessions[0]).not.toBe(sessions[2])
        expect(mocks.searchDocuments).not.toHaveBeenCalled()
        const read = sourceTools.find((item) => item.id === "source.read")!
        await expect(read.execute(ctx, { kind: "document", sourceRef: local.ref, documentId: 12,
            generationId: 6, passageId: 9, contentHash: "a".repeat(64) })).rejects.toThrow("固定索引版本不一致")
        await expect(read.execute(ctx, { kind: "document", sourceRef: local.ref, documentId: 12,
            anchorChunkId: 9 })).rejects.toThrow("固定索引版本不一致")
        expect(mocks.readIndex).not.toHaveBeenCalled()
        expect(mocks.readDocument).not.toHaveBeenCalled()
    })
    it("已就绪索引走代际锚点，不重复读取旧chunk，并保留实际检索模式", async () => {
        const local = { ...source, ref: "doc-library:3", kind: "doc-library", id: "3" }
        mocks.resolveSources.mockResolvedValue({ scope: { mode: "selected", refs: [local.ref] }, selected: [local], unavailable: [] })
        mocks.searchIndex.mockResolvedValue({ hits: [{ documentId: 12, libraryId: 3, generationId: 5, passageId: 6,
            contentHash: "a".repeat(64), title: "合成文档", snippet: "合成", href: "/document/12", mode: "hybrid" }], indexedLibraryIds: [3], degraded: [] })
        mocks.readIndex.mockResolvedValue({ title: "合成文档", content: "前".repeat(500) + "合成命中", anchorStart: 500, anchorEnd: 504, href: "/document/12?generationId=5&passageId=6",
            anchor: { sourceHash: "b".repeat(64), startOffset: 10, endOffset: 20 } })
        const tool = sourceTools.find((item) => item.id === "source.lookup")!
        const output = await tool.execute(context(), { query: "合成" })
        const normalized = tool.normalize!(output, {})
        expect(mocks.searchDocuments).not.toHaveBeenCalled()
        expect(mocks.readDocument).not.toHaveBeenCalled()
        expect(mocks.readIndex).toHaveBeenCalledWith(expect.objectContaining({ userId: 1, libraryId: 3, documentId: 12, generationId: 5, passageId: 6 }))
        expect(normalized.evidence?.[0].metadata).toMatchObject({ generationId: "5", passageId: "6", documentId: "12" })
        expect(toPublicEvidence(new EvidenceStore().add(normalized.evidence![0])).snippet).toBe("合成命中")
        expect(normalized.data).toMatchObject({ retrievalModes: ["hybrid"] })
    })

    it("代际锚点不完整或混用旧chunk时拒绝", async () => {
        const tool = sourceTools.find((item) => item.id === "source.read")!
        await expect(tool.execute(context(), { kind: "document", sourceRef: "doc-library:3", documentId: 12, passageId: 6 })).rejects.toThrow()
        await expect(tool.execute(context(), { kind: "document", sourceRef: "doc-library:3", documentId: 12,
            passageId: 6, generationId: 5, contentHash: "a".repeat(64), anchorChunkId: 9 })).rejects.toThrow()
        expect(mocks.readIndex).not.toHaveBeenCalled()
    })

    it("保留同一长文两个命中，深读传入各自锚点并分别保存证据", async () => {
        const local = { ...source, ref: "doc-library:3", kind: "doc-library", id: "3" }
        mocks.resolveSources.mockResolvedValue({ scope: { mode: "selected", refs: [local.ref] }, selected: [local], unavailable: [] })
        mocks.searchDocuments.mockResolvedValue([900, 950].map((id) => ({
            documentId: "12", chunkId: String(id), libraryId: "3", title: "长群聊", snippet: "命中", href: "/document/12",
        })))
        mocks.getDb.mockReturnValue({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 12 }] }) }) }) })
        mocks.readDocument.mockImplementation(async (_ctx, input) => ({
            documentId: "12", href: "/document/12", title: "长群聊", fileName: "demo.md", anchorIndex: input.anchorChunkId,
            chunks: [
                { chunkIndex: input.anchorChunkId - 1, locator: null, text: "前".repeat(4_000) },
                { chunkIndex: input.anchorChunkId, locator: null, text: `尾部证据${input.anchorChunkId}` },
            ],
        }))
        const tool = sourceTools.find((item) => item.id === "source.lookup")!
        const output = await tool.execute(context(), { query: "翻新" })
        const normalized = tool.normalize!(output, {})
        expect(mocks.readDocument).toHaveBeenCalledTimes(2)
        expect(mocks.readDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ anchorChunkId: 900, limit: 3 }))
        expect(mocks.readDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ anchorChunkId: 950, limit: 3 }))
        expect(normalized.evidence?.map((e) => e.sourceId)).toEqual(["12:chunk:900", "12:chunk:950"])
        expect(normalized.evidence?.[0].content).toContain("尾部证据900")
        expect(normalized.evidence?.[1].content).toContain("尾部证据950")
        expect(normalized.evidence?.map((item) => toPublicEvidence(new EvidenceStore().add(item)).snippet)).toEqual(["尾部证据900", "尾部证据950"])
        expect(normalized.evidence?.every((e) => (e.content?.length ?? 0) <= 4_000)).toBe(true)
    })

    it("锚点没有被reader确认时拒绝把开头当命中正文", async () => {
        const local = { ...source, ref: "doc-library:3", kind: "doc-library", id: "3" }
        mocks.resolveSources.mockResolvedValue({ scope: { mode: "selected", refs: [local.ref] }, selected: [local], unavailable: [] })
        mocks.getDb.mockReturnValue({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 12 }] }) }) }) })
        mocks.readDocument.mockResolvedValue({ documentId: "12", anchorIndex: null, chunks: [{ chunkIndex: 0, text: "无关开头" }] })
        const tool = sourceTools.find((item) => item.id === "source.read")!
        await expect(tool.execute(context(), { kind: "document", sourceRef: local.ref, documentId: 12, anchorChunkId: 900 })).rejects.toThrow("已失效")
    })

    it("快速深读优先不同文档，限三个窗口，局部失败可见且不重试", async () => {
        const local = { ...source, ref: "doc-library:3", kind: "doc-library", id: "3" }
        mocks.resolveSources.mockResolvedValue({ scope: { mode: "selected", refs: [local.ref] }, selected: [local], unavailable: [] })
        mocks.searchDocuments.mockResolvedValue([12, 12, 13, 14, 15, 16, 17].map((id, index) => ({
            documentId: String(id), chunkId: String(900 + index), libraryId: "3", title: `文档${id}`, snippet: "命中", href: `/document/${id}`,
        })))
        mocks.getDb.mockReturnValue({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 12 }] }) }) }) })
        mocks.readDocument.mockImplementation(async (_ctx, input) => {
            if (input.documentId === 13) throw new Error("synthetic_read_failed")
            return { documentId: String(input.documentId), href: `/document/${input.documentId}`, title: "合成", fileName: "demo.md", anchorIndex: input.anchorChunkId,
                chunks: [{ chunkIndex: input.anchorChunkId, text: "已读合成证据", locator: null }] }
        })
        const tool = sourceTools.find((item) => item.id === "source.lookup")!
        const output = await tool.execute(context(), { query: "合成", limit: 10 })
        const result = tool.normalize!(output, {})
        expect(mocks.readDocument.mock.calls.map((call) => call[1].documentId)).toEqual([12, 13, 14])
        expect(mocks.readDocument).toHaveBeenCalledTimes(3)
        expect(result.evidence).toHaveLength(2)
        expect(result.data).toMatchObject({ readCount: 2, failedReadCount: 1 })
        expect(result.summary).toContain("1 个候选读取失败")
        expect(JSON.stringify(result.data)).not.toContain("synthetic_read_failed")
    })

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
        expect(normalized.evidence).toHaveLength(1)
        expect(normalized.evidence?.[0]).toMatchObject({
            source: "geneops",
            title: "Amazon 退货标签经验",
            content: "正文证据",
            url: "https://example.com/post/1",
            metadata: {
                sourceRef: "external-source:1",
                sourceName: "GeneOps 生产知识",
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
        mocks.readDocument.mockRejectedValueOnce(new Error("文档不存在或不属于当前文档库"))
        const tool = sourceTools.find((item) => item.id === "source.read")!
        await expect(tool.execute(context(), {
            kind: "document",
            sourceRef: documentSource.ref,
            documentId: "99",
        })).rejects.toThrow("文档不存在或不属于当前文档库")
        expect(mocks.readDocument).toHaveBeenCalledWith(
            expect.objectContaining({ focus: expect.objectContaining({ libraryId: "3" }) }), expect.anything(),
        )
    })
})
