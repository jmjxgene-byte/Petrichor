import { describe, expect, it } from "vitest"

import type { AgentRunViewModel, EvidenceViewModel } from "@/features/agent-runs/types"
import { selectCitationRun } from "./citation-run"

function evidence(citationIndex: number): EvidenceViewModel {
    return {
        id: `evidence-${citationIndex}`,
        source: "geneops",
        title: `来源 ${citationIndex}`,
        url: `https://example.com/${citationIndex}`,
        citationIndex,
    }
}

function run(items: EvidenceViewModel[]): AgentRunViewModel {
    return {
        id: "deep-run",
        status: "completed",
        goal: "ODR",
        plan: [],
        activities: [],
        subagents: [],
        evidence: items,
        loadedSkills: [],
        answer: "结论 [13] [21]",
        answerSegmentStart: 0,
        startedAt: 1,
        completedAt: 2,
        lastSequence: 1,
    }
}

describe("selectCitationRun", () => {
    it("消息引用覆盖更多已引用编号时替换不完整的历史 Run Evidence", () => {
        const current = run([evidence(13)])
        const persisted = [evidence(13), evidence(21)]

        const selected = selectCitationRun(current, persisted)

        expect(selected).not.toBe(current)
        expect(selected?.evidence).toEqual(persisted)
    })

    it("覆盖数量没有提升时保留原 Run 的较丰富 Evidence", () => {
        const current = run([{ ...evidence(13), snippet: "保留的详情" }])

        expect(selectCitationRun(current, [evidence(13)])).toBe(current)
        expect(selectCitationRun(current, [])).toBe(current)
    })
})
