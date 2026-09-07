import { describe, expect, it } from "vitest"
import { toPublicEvidence } from "@/server/assistant/agent-runtime/events"
import { citationIndicesForEvidence } from "@/server/assistant/agent-runtime/evidence"
import type { AgentEvidence } from "@/server/assistant/agent-runtime/types"
import { agentRunReducer, createEmptyRun } from "./reducer"
import { toRunViewModel } from "./hydrate"
import { assignEvidenceCitationIndices, groupEvidenceBySource } from "./evidence-sources"

const evidence: AgentEvidence[] = [1, 2].map((id) => ({
    id: `e${id}`, source: "document", sourceId: `9:passage:${id}`, title: "合成文档", content: "合成片段",
    createdAt: 1, url: `/dashboard/doc-library/4?documentId=9&generationId=7&passageId=${id}`,
    metadata: { documentId: "9", sourceName: "合成资料库", queriedAt: "2026-09-08T00:00:00Z" },
}))

describe("文档证据实时与历史契约", () => {
    it("两个命中位置共享来源编号，但保留独立证据和定位URL", () => {
        const indices = citationIndicesForEvidence(evidence)
        const published = evidence.map((item, index) => toPublicEvidence(item, indices[index]))
        const live = agentRunReducer(createEmptyRun("r"), { runId: "r", sequence: 1, type: "evidence_created", timestamp: 1, payload: { evidence: published } })!
        const restored = toRunViewModel({ id: "r", conversationId: "1", status: "completed", goal: "合成问题", answer: "合成回答",
            plan: [], loadedSkills: [], activities: [], subagents: [], evidence: published,
            metrics: { durationMs: 1, toolCalls: 1, evidenceCount: 2, subAgentCount: 0, iterations: 1 }, startedAt: 1 })
        expect(live.evidence).toEqual(restored.evidence)
        expect(groupEvidenceBySource(live.evidence)).toHaveLength(1)
        expect(live.evidence.map((item) => item.citationIndex)).toEqual([1, 1])
        expect(live.evidence.map((item) => item.url)).toEqual(evidence.map((item) => item.url))
        expect(live.evidence[0]).toMatchObject({ documentId: "9", sourceName: "合成资料库", queriedAt: "2026-09-08T00:00:00Z" })
    })
    it("旧相对URL可恢复文档身份，不跨文档或将外站路径误认成本地", () => {
        const old = evidence.map((item) => ({ id: item.id, source: item.source, title: "合成", url: item.url, citationIndex: 0 }))
        const assigned = assignEvidenceCitationIndices([...old, { ...old[0], id: "other", url: "/dashboard/doc-library/4?documentId=10" }])
        expect(assigned.map((item) => item.citationIndex)).toEqual([1, 1, 2])
        expect(groupEvidenceBySource([old[0], { ...old[1], url: `https://external.invalid${old[1].url}` }])).toHaveLength(2)
        expect(assigned[1].url).toContain("passageId=2")
    })
})
