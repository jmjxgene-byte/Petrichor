import { describe, expect, it } from "vitest"
import { evaluateGroundedQa, QA_GROUP_COUNTS } from "./grounded-evaluation"
function fixture() {
    return { datasetSha: "a".repeat(64), baselineDatasetSha: "a".repeat(64), cases: Object.entries(QA_GROUP_COUNTS).flatMap(([group, size]) =>
        Array.from({ length: size }, (_, index) => ({ id: `${group}-${index}`, group, semantic: group === "synthesis",
            expectedEvidenceIds: group === "no_answer" ? [] : ["synthetic-passage"],
            expectedResolution: group === "no_answer" ? "insufficient" : "answer", resolution: group === "no_answer" ? "insufficient" : "answer",
            retrievedIds: ["synthetic-passage"], readIds: ["synthetic-passage"], baselineRetrievedIds: group === "synthesis" ? [] : ["synthetic-passage"],
            retrievalRecorded: true, fastMs: 200, localExpected: true, localMs: 100,
            reviewer: "human", claims: group === "no_answer" ? 0 : 1, reviewedClaims: group === "no_answer" ? 0 : 1, supportedClaims: group === "no_answer" ? 0 : 1,
            unsafeResults: 0, unknownTimeAssertions: 0,
        }))) }
}
describe("离线QA报告验收器（合成记录，非实际指标）", () => {
    it("完整合成记录可计算指标，不输出逐题身份或正文", () => {
        const report = evaluateGroundedQa(fixture())
        expect(report).toMatchObject({ passed: true, caseCount: 60, recall20: 1, humanSupportPrecision: 1, localP95Ms: 100 })
        expect(JSON.stringify(report)).not.toContain("synthetic-passage")
        expect(JSON.stringify(report)).not.toContain("terms-0")
    })
    it("缺题、重复题、基线漂移不能通过", () => {
        const input = fixture(); input.cases.pop(); input.cases[1].id = input.cases[0].id; input.baselineDatasetSha = "b".repeat(64)
        expect(evaluateGroundedQa(input).reasons).toEqual(expect.arrayContaining(["incomplete_cohort", "duplicate_case", "baseline_missing_or_mismatched"]))
    })
    it("模型自评或不完整人工审查不给支持precision", () => {
        const input = fixture(); input.cases[0].reviewer = "model"
        expect(evaluateGroundedQa(input)).toMatchObject({ passed: false, humanSupportPrecision: null })
        input.cases[0].reviewer = "human"; input.cases[0].reviewedClaims = 0; input.cases[0].supportedClaims = 0
        expect(evaluateGroundedQa(input).reasons).toContain("human_review_incomplete")
    })
    it("只算前20排名，重复候选不虚增召回，长文必须实际深读", () => {
        const input = fixture()
        input.cases[0].retrievedIds = [...Array.from({ length: 20 }, () => "duplicate"), "synthetic-passage"]
        input.cases.find((row) => row.group === "late_passage")!.readIds = []
        const report = evaluateGroundedQa(input)
        expect(report.recall20).toBeLessThan(1)
        expect(report.reasons).toEqual(expect.arrayContaining(["term_regression", "late_passage_not_read"]))
    })
    it("泄漏、未知时间断言、超时与缺测均阻断", () => {
        const input = fixture(); Object.assign(input.cases[0], { unsafeResults: 1, unknownTimeAssertions: 1, fastMs: 8001, localMs: null })
        expect(evaluateGroundedQa(input).reasons).toEqual(expect.arrayContaining(["unsafe_result", "unsupported_time_assertion", "fast_deadline_exceeded", "local_latency_missing"]))
    })
    it("不接受夹带查询正文或不可能的审查计数", () => {
        expect(() => evaluateGroundedQa({ ...fixture(), query: "不得进入报告的正文" })).toThrow()
        const input = fixture(); input.cases[0].supportedClaims = 2
        expect(() => evaluateGroundedQa(input)).toThrow()
    })
    it("非本地样本不能稀释本地P95", () => {
        const input = fixture()
        for (const row of input.cases) { row.localExpected = false; row.localMs = 0 }
        input.cases[0].localExpected = true; input.cases[0].localMs = 4000
        expect(evaluateGroundedQa(input)).toMatchObject({ passed: false, localP95Ms: 4000 })
    })
})
