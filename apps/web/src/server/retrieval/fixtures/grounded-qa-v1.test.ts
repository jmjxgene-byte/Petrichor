import { describe, expect, it } from "vitest"
import { buildDocumentPassages, hashDocumentText } from "@/server/doc-library/passage-builder"
import { syntheticQaCases, syntheticQaDocuments, syntheticQaDataset } from "./grounded-qa-v1"
import { QA_GROUP_COUNTS } from "../grounded-evaluation"
describe("固定60题合成语料契约", () => {
    it("v1长文片段集合保持旧版本身份，v2只改变派生片段不改原文", () => {
        const doc = syntheticQaDocuments[0]
        const old = buildDocumentPassages(doc.text, doc.title, 1)
        expect(old).toHaveLength(1005)
        expect(hashDocumentText(JSON.stringify(old.map(p => ({ index: p.passageIndex, hash: p.contentHash, start: p.startOffset, end: p.endOffset }))))).toBe("6cee0c38879030c595783e6b6967266ae1aa8cef36dfd000960a97261eeb44cf")
        const current = buildDocumentPassages(doc.text, doc.title)
        expect(current).toHaveLength(46)
        expect(current.map(p => p.text).join("")).toBe(doc.text)
    })
    it("固定版本SHA，变更题目或语料须创建新版本", () => {
        expect(hashDocumentText(JSON.stringify(syntheticQaDataset))).toBe("55eee733924fcda56d2ad3f6ff52bb4b546a6564db9e6bf858639f3d42d3ba1e")
    })
    it("严格覆盖各组，题目和文档身份唯一", () => {
        expect(syntheticQaCases).toHaveLength(60)
        expect(new Set(syntheticQaCases.map((row) => row.id)).size).toBe(60)
        expect(new Set(syntheticQaDocuments.map((row) => row.id)).size).toBe(syntheticQaDocuments.length)
        for (const [group, count] of Object.entries(QA_GROUP_COUNTS)) expect(syntheticQaCases.filter((row) => row.group === group)).toHaveLength(count)
    })
    it("每个期望证据在选定文档和实际切片里可定位，文末证据在后半段", () => {
        const passages = new Map(syntheticQaDocuments.map((doc) => [doc.id, buildDocumentPassages(doc.text, doc.title)]))
        for (const test of syntheticQaCases) {
            for (const evidence of test.evidence) {
                expect(test.scope).toContain(evidence.documentId)
                const doc = syntheticQaDocuments.find((row) => row.id === evidence.documentId)!
                expect(doc.text).toContain(evidence.quote)
                expect(passages.get(doc.id)!.some((passage) => passage.text.includes(evidence.quote))).toBe(true)
                if (test.group === "late_passage") {
                    expect(doc.text.indexOf(evidence.quote)).toBeGreaterThan(doc.text.length / 2)
                    expect(passages.get(doc.id)!.find((passage) => passage.text.includes(evidence.quote))!.passageIndex).toBeGreaterThan(20)
                }
            }
        }
    })
})
