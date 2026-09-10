import { createHash } from "node:crypto"
import { z } from "zod"

const rankRow = z.object({ index: z.number().int().nonnegative(), relevance_score: z.number().finite() }).strict()
const responseSchema = z.object({
    results: z.array(rankRow),
    usage: z.object({ total_tokens: z.number().int().nonnegative().nullable() }).strict(),
}).strict()
const id = z.string().min(1).max(200)

export type RerankResultRow = { index: number; relevance_score: number }
export type SafeRerankCase = {
    caseId: string
    candidateCount: number
    rankedIds: string[]
    scores: number[]
    goldIds: string[]
    recallAt20: number | null
    usageTokens: number | null
}

/** provider适配器和离线消费共用的严格结果契约；不接受document/text回显。 */
export function parseRerankResponse(raw: unknown, expectedCount: number) {
    if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 20) throw new Error("rerank_candidate_count")
    const parsed = responseSchema.parse(raw)
    if (parsed.results.length !== expectedCount || parsed.results.some((row, index) => row.index !== index
        || !Number.isFinite(row.relevance_score) || (index > 0 && parsed.results[index - 1].relevance_score < row.relevance_score))) {
        throw new Error("rerank_result_contract")
    }
    return parsed
}

export function consumeRerankResult(input: { caseId: string; candidateIds: string[]; goldIds?: string[]; raw: unknown }) {
    const candidates = input.candidateIds.map(value => id.parse(value))
    if (!candidates.length || candidates.length > 20 || new Set(candidates).size !== candidates.length) throw new Error("rerank_candidate_ids")
    const parsed = parseRerankResponse(input.raw, candidates.length)
    const goldIds = [...new Set((input.goldIds ?? []).map(value => id.parse(value)))]
    if (goldIds.some(value => !candidates.includes(value))) throw new Error("rerank_gold_outside_candidates")
    const rankedIds = parsed.results.map(row => candidates[row.index]), scores = parsed.results.map(row => row.relevance_score)
    const top = new Set(rankedIds.slice(0, 20))
    return { caseId: id.parse(input.caseId), candidateCount: candidates.length, rankedIds, scores, goldIds,
        recallAt20: goldIds.length ? goldIds.filter(value => top.has(value)).length / goldIds.length : null,
        usageTokens: parsed.usage.total_tokens,
    } satisfies SafeRerankCase
}

export function buildSafeRerankReport(input: { executionId: string; planHash: string; requestSetHash: string; cases: Array<{ caseId: string; candidateIds: string[]; goldIds?: string[]; raw: unknown }> }) {
    const cases = input.cases.map(consumeRerankResult)
    return { scope: "offline_rerank_result_preview", executionId: id.parse(input.executionId), planHash: z.string().regex(/^[a-f0-9]{64}$/).parse(input.planHash),
        requestSetHash: z.string().regex(/^[a-f0-9]{64}$/).parse(input.requestSetHash), caseCount: cases.length, cases,
        resultHash: createHash("sha256").update(JSON.stringify(cases)).digest("hex"), rawTextPersisted: false, rawVectorsPersisted: false,
        modelCalls: 0, databaseCalls: 0, productionIndexWrites: 0,
    }
}
