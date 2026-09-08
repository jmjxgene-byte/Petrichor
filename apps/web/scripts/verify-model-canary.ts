import fs from "node:fs"
import type postgres from "postgres"
import { buildQueryTokens, buildTsQuery } from "../src/server/retrieval/tokenize"
import { reciprocalRankFusion, toRecallHits } from "../src/server/retrieval/fusion"
import { hashDocumentText, buildDocumentPassages } from "../src/server/doc-library/passage-builder"
import { planGroundedCanary } from "../src/server/retrieval/grounded-canary-plan"
import { syntheticQaDataset } from "../src/server/retrieval/fixtures/grounded-qa-v1"

type Passage = { id: string; documentId: string; index: number; text: string; searchTokens: string; vector: number[] }
export async function verifyModelCanary(db: ReturnType<typeof postgres>) {
    if (process.env.QA_CANARY !== "true") return null
    const artifact = JSON.parse(fs.readFileSync("/canary/embed.json", "utf8"))
    const plan = planGroundedCanary()
    if (Boolean(artifact.syntheticMock) !== (process.env.QA_CANARY_DRY_RUN === "true")) throw new Error("canary_mock_gate")
    if (!artifact.syntheticMock && artifact.executionId !== "20260909-b") throw new Error("canary_execution_gate")
    if (!artifact.passed || artifact.calls !== 22 || artifact.planHash !== plan.planHash || artifact.documents.length !== 3 || artifact.cases.length !== 8) throw new Error("canary_artifact_gate")
    const passages: Passage[] = []
    const vector = (v: number[]) => {
        if (!Array.isArray(v) || v.length !== 1024 || v.some(n => !Number.isFinite(n)) || !v.some(n => n !== 0)) throw new Error("canary_vector_gate")
        return JSON.stringify(v)
    }
    for (const item of plan.documents) {
        const doc = syntheticQaDataset.documents.find(d => d.id === item.id)!
        const source = artifact.documents.find((d: { id: string }) => d.id === doc.id)
        const expected = buildDocumentPassages(doc.text, doc.title)
        if (!source || source.passages.length !== expected.length || hashDocumentText(source.text) !== item.sourceHash) throw new Error("canary_source_gate")
        expected.forEach((p, i) => {
            const actual = source.passages[i]
            if (p.contentHash !== actual.contentHash || p.text !== actual.text) throw new Error("canary_passage_gate")
            vector(actual.vector)
            passages.push({ id: `${doc.id}:${i}`, documentId: doc.id, index: i, text: p.text, searchTokens: p.searchTokens, vector: actual.vector })
        })
    }
    // 临时表只存在于当前隔离连接；不新增产品表或修改索引current。
    await db`create temporary table qa_canary_passage(id text primary key, document_id text, content text, tokens tsvector, embedding vector(1024))`
    for (const p of passages) await db`insert into qa_canary_passage values(${p.id},${p.documentId},${p.text},to_tsvector('simple',${p.searchTokens}),${vector(p.vector)}::vector)`
    const output = []
    for (const id of plan.caseIds) {
        const c = syntheticQaDataset.cases.find(c => c.id === id)!
        const actual = artifact.cases.find((x: { id: string }) => x.id === id)
        const query = [...c.history.map(h => h.content), c.question].join("\n")
        if (!actual || query !== actual.query) throw new Error("canary_query_gate")
        const tsquery = buildTsQuery(buildQueryTokens(query))
        const lexical = tsquery ? await db`select id from qa_canary_passage where document_id=any(${c.scope}) and tokens @@ to_tsquery('simple',${tsquery}) order by ts_rank_cd(tokens,to_tsquery('simple',${tsquery})) desc,id limit 20` : []
        const semantic = await db`select id from qa_canary_passage where document_id=any(${c.scope}) order by embedding <=> ${vector(actual.vector)}::vector,id limit 20`
        const fused = reciprocalRankFusion([toRecallHits("chunk_bm25", lexical.map(x => ({ nodeKey: x.id }))), toRecallHits("chunk_vector", semantic.map(x => ({ nodeKey: x.id })))], { topK: 20 })
        const candidates = fused.map(row => { const p = passages.find(p => p.id === row.nodeKey)!; return { id: p.id, text: p.text } })
        const expectedIds = c.evidence.map(e => passages.find(p => p.documentId === e.documentId && p.text.includes(e.quote))?.id)
        if (expectedIds.some(x => !x)) throw new Error("canary_gold_mapping_gate")
        output.push({ id, query, expectedResolution: c.expectedResolution, expectedIds, lexicalIds: lexical.map(x => x.id), semanticIds: semantic.map(x => x.id), candidates })
    }
    await db`drop table qa_canary_passage`
    return { planHash: plan.planHash, executionId: artifact.executionId ?? null, syntheticMock: Boolean(artifact.syntheticMock), componentOnly: true, documents: 3, passages: passages.length, cases: output }
}
