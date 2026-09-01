import type { DeepResearchErrorCode } from "./deep-research-job-store"

const MAX_QUERIES = 6
const MAX_CANDIDATES = 12
const MAX_EVIDENCE_ITEMS = 96
const MAX_EVIDENCE_ITEM_CHARS = 4_000
const MAX_EVIDENCE_TOTAL_CHARS = 240_000

export type SearchMode = "exact" | "fuzzy"

export type DeepResearchCandidate = {
    candidateKey: string
    title: string
    sourceName: string
    url: string | null
    score: number
    read: unknown
}

export type DeepResearchEvidence = {
    title: string
    content: string
    source: string
    url: string | null
    queriedAt: string
}

export type DeepResearchPipelineDeps = {
    planQueries(question: string, signal: AbortSignal): Promise<string[]>
    search(query: string, mode: SearchMode): Promise<DeepResearchCandidate[]>
    read(candidate: DeepResearchCandidate): Promise<DeepResearchEvidence[]>
    synthesize(question: string, evidence: DeepResearchEvidence[], signal: AbortSignal): Promise<string>
}

export class DeepResearchExecutionError extends Error {
    constructor(readonly code: DeepResearchErrorCode, message: string) {
        super(message)
    }
}

export async function runDeepResearchPipeline(input: {
    question: string
    modes: SearchMode[]
    signal: AbortSignal
}, deps: DeepResearchPipelineDeps) {
    const planned = await deps.planQueries(input.question, input.signal)
    const queries = [...new Set([input.question, ...planned].map((item) => item.trim()).filter(Boolean))]
        .slice(0, MAX_QUERIES)
    const modes = [...new Set(input.modes)]
    if (modes.length === 0) throw new DeepResearchExecutionError("validation_failed", "没有可用检索模式")

    const searched = await Promise.allSettled(
        queries.flatMap((query) => modes.map(async (mode) => await deps.search(query, mode))),
    )
    const byKey = new Map<string, DeepResearchCandidate>()
    for (const result of searched) {
        if (result.status !== "fulfilled") continue
        for (const candidate of result.value) {
            const existing = byKey.get(candidate.candidateKey)
            if (!existing || candidate.score > existing.score) byKey.set(candidate.candidateKey, candidate)
        }
    }
    const candidates = [...byKey.values()].sort((left, right) => right.score - left.score).slice(0, MAX_CANDIDATES)
    if (candidates.length === 0) throw new DeepResearchExecutionError("validation_failed", "检索没有候选")

    const reads = await Promise.allSettled(candidates.map(async (candidate) => await deps.read(candidate)))
    const evidence: DeepResearchEvidence[] = []
    let totalChars = 0
    for (const result of reads) {
        if (result.status !== "fulfilled") continue
        for (const item of result.value) {
            if (!item.content.trim() || evidence.length >= MAX_EVIDENCE_ITEMS) continue
            const remaining = MAX_EVIDENCE_TOTAL_CHARS - totalChars
            if (remaining <= 0) break
            const content = item.content.slice(0, Math.min(MAX_EVIDENCE_ITEM_CHARS, remaining))
            evidence.push({ ...item, content })
            totalChars += content.length
        }
    }
    if (evidence.length === 0) throw new DeepResearchExecutionError("validation_failed", "候选没有可读证据")
    const answer = (await deps.synthesize(input.question, evidence, input.signal)).trim()
    if (!answer) throw new DeepResearchExecutionError("validation_failed", "深度综合没有生成答案")
    return { queries, candidates, evidence, answer }
}
