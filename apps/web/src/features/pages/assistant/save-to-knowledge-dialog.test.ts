import { describe, expect, it } from "vitest"
import type { AgentRunViewModel } from "@/features/agent-runs/types"
import { buildKnowledgeDraft } from "./save-to-knowledge-dialog"

describe("GeneOps knowledge capture draft", () => {
    it("copies the answer and safe citation links without raw snippets", () => {
        const run = {
            id: "run-1",
            status: "completed",
            goal: "Amazon 退货标签",
            plan: [],
            activities: [],
            subagents: [],
            loadedSkills: [],
            answer: "经过核对后的结论。",
            answerSegmentStart: 0,
            evidence: [{
                id: "e1",
                source: "geneops",
                title: "原始帖子",
                snippet: "不应复制的原始正文",
                url: "https://example.com/post/1",
                queriedAt: "2026-08-27T00:00:00.000Z",
                citationIndex: 1,
            }],
            startedAt: 1,
            lastSequence: 1,
        } satisfies AgentRunViewModel

        const markdown = buildKnowledgeDraft(run, run.evidence)
        expect(markdown).toContain("经过核对后的结论")
        expect(markdown).toContain("[原始帖子](<https://example.com/post/1>)")
        expect(markdown).not.toContain("不应复制的原始正文")
    })

    it("does not persist unsafe external link schemes", () => {
        const run = {
            id: "run-2",
            status: "completed",
            goal: "安全引用",
            plan: [],
            activities: [],
            subagents: [],
            loadedSkills: [],
            answer: "结论",
            answerSegmentStart: 0,
            evidence: [{
                id: "e2",
                source: "geneops",
                title: "恶意]标题",
                url: "javascript:alert(1)",
                citationIndex: 1,
            }],
            startedAt: 1,
            lastSequence: 1,
        } satisfies AgentRunViewModel

        const markdown = buildKnowledgeDraft(run, run.evidence)
        expect(markdown).toContain("恶意\\]标题")
        expect(markdown).not.toContain("javascript:")
    })
})
