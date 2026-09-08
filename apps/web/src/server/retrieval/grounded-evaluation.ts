import { z } from "zod"

export const QA_GROUP_COUNTS = { terms: 15, late_passage: 15, synthesis: 10, followup: 10, no_answer: 5, temporal: 5 } as const
const identity = z.string().min(1).max(200)
const ids = z.array(identity).max(60)
const count = z.number().int().nonnegative()
const duration = z.number().finite().nonnegative()
const resolution = z.enum(["answer", "clarify", "insufficient"])
export const groundedEvaluationSchema = z.object({
    datasetSha: z.string().regex(/^[a-f0-9]{64}$/),
    baselineDatasetSha: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    cases: z.array(z.object({
        id: identity, group: z.enum(["terms", "late_passage", "synthesis", "followup", "no_answer", "temporal"]), semantic: z.boolean(),
        expectedEvidenceIds: ids, expectedResolution: resolution, resolution: resolution,
        retrievedIds: ids, readIds: ids, baselineRetrievedIds: ids.nullable(),
        retrievalRecorded: z.boolean(), fastMs: duration, localExpected: z.boolean(), localMs: duration.nullable(),
        reviewer: z.enum(["human", "model", "pending"]), claims: count, reviewedClaims: count, supportedClaims: count,
        unsafeResults: count, unknownTimeAssertions: count,
    }).strict().refine((row) => row.supportedClaims <= row.reviewedClaims && row.reviewedClaims <= row.claims, "invalid_review_counts")).max(60),
}).strict()

/** 仅评估输入报告；不运行检索/模型，不验证人工标注身份，更不代表整个MVP已验收。 */
export function evaluateGroundedQa(raw: unknown) {
    const input = groundedEvaluationSchema.parse(raw)
    const problems = new Set<string>()
    if (new Set(input.cases.map((row) => row.id)).size !== input.cases.length) problems.add("duplicate_case")
    for (const [group, required] of Object.entries(QA_GROUP_COUNTS)) if (input.cases.filter((row) => row.group === group).length !== required) problems.add("incomplete_cohort")
    if (input.baselineDatasetSha !== input.datasetSha || input.cases.some((row) => row.baselineRetrievedIds == null)) problems.add("baseline_missing_or_mismatched")
    for (const row of input.cases) {
        if (new Set(row.expectedEvidenceIds).size !== row.expectedEvidenceIds.length) problems.add("duplicate_gold_evidence")
        if (row.expectedResolution === "answer" && !row.expectedEvidenceIds.length) problems.add("missing_gold_evidence")
        if (row.reviewer !== "human" || row.reviewedClaims !== row.claims) problems.add("human_review_incomplete")
        if (row.resolution !== row.expectedResolution) problems.add("resolution_mismatch")
        if (row.resolution === "answer" && row.claims === 0) problems.add("answer_without_reviewable_claims")
        if (!row.retrievalRecorded) problems.add("retrieval_not_recorded")
        if (row.unsafeResults > 0) problems.add("unsafe_result")
        if (row.unknownTimeAssertions > 0) problems.add("unsupported_time_assertion")
        if (row.fastMs > 8_000) problems.add("fast_deadline_exceeded")
        if (row.localExpected && row.localMs == null) problems.add("local_latency_missing")
        if (row.group === "late_passage" && !row.expectedEvidenceIds.some((id) => row.readIds.includes(id))) problems.add("late_passage_not_read")
    }
    const answerable = input.cases.filter((row) => row.expectedResolution === "answer" && row.expectedEvidenceIds.length > 0)
    const recall = (gold: string[], ranked: string[]) => {
        const top = new Set(ranked.slice(0, 20))
        return gold.filter((id) => top.has(id)).length / gold.length
    }
    const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
    const recall20 = mean(answerable.map((row) => recall(row.expectedEvidenceIds, row.retrievedIds)))
    const semantic = answerable.filter((row) => row.semantic)
    const semanticRecall = mean(semantic.map((row) => recall(row.expectedEvidenceIds, row.retrievedIds)))
    const baselineSemantic = semantic.every((row) => row.baselineRetrievedIds != null) ? mean(semantic.map((row) => recall(row.expectedEvidenceIds, row.baselineRetrievedIds!))) : null
    if (recall20 == null || recall20 < 0.85) problems.add("recall_below_target")
    if (semanticRecall == null || baselineSemantic == null || semanticRecall <= baselineSemantic) problems.add("semantic_improvement_unproven")
    if (answerable.filter((row) => row.group === "terms").some((row) => row.baselineRetrievedIds && recall(row.expectedEvidenceIds, row.retrievedIds) < recall(row.expectedEvidenceIds, row.baselineRetrievedIds))) problems.add("term_regression")
    const claims = input.cases.reduce((sum, row) => sum + row.claims, 0)
    const supported = input.cases.reduce((sum, row) => sum + row.supportedClaims, 0)
    const precision = claims && !problems.has("human_review_incomplete") ? supported / claims : null
    if (precision == null || precision < 0.95) problems.add("support_precision_unproven")
    const localTimes = input.cases.flatMap((row) => !row.localExpected || row.localMs == null ? [] : [row.localMs]).sort((a, b) => a - b)
    const localP95 = localTimes.length ? localTimes[Math.ceil(localTimes.length * 0.95) - 1] : null
    if (localP95 == null || localP95 > 3_000) problems.add("local_latency_unproven")
    return { datasetSha: input.datasetSha, scope: "offline_retrieval_report_only", passed: problems.size === 0, caseCount: input.cases.length,
        recall20, semanticRecall, baselineSemanticRecall: baselineSemantic, humanSupportPrecision: precision, localP95Ms: localP95,
        reasons: [...problems].sort() }
}
