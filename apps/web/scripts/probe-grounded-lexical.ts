import { Database } from "bun:sqlite"
import { sql } from "drizzle-orm"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core"
import { buildDocumentPassages, hashDocumentText } from "../src/server/doc-library/passage-builder"
import { documentLexicalExpressions, documentSearchTerms } from "../src/server/doc-library/search-query"
import { syntheticQaCases, syntheticQaDataset, syntheticQaDocuments } from "../src/server/retrieval/fixtures/grounded-qa-v1"

// 固定虚构语料、内存数据库，不读取env/用户文件、不连接网络、不运行模型。
const datasetSha = hashDocumentText(JSON.stringify(syntheticQaDataset))
if (datasetSha !== "55eee733924fcda56d2ad3f6ff52bb4b546a6564db9e6bf858639f3d42d3ba1e") throw new Error("固定评测数据集身份不匹配")
const db = new Database(":memory:")
const dialect = new SQLiteSyncDialect()
type Hit = { id: number; document_id: string; text: string }
try {
    db.exec("create table passages(id integer primary key, document_id text not null, text text not null)")
    let passageCount = 0
    const insert = db.query("insert into passages values(?,?,?)")
    db.transaction(() => {
        for (const document of syntheticQaDocuments) for (const passage of buildDocumentPassages(document.text, document.title)) {
            insert.run(++passageCount, document.id, passage.text)
        }
    })()
    const rows = syntheticQaCases.map((test) => {
        const expressions = documentLexicalExpressions(sql.identifier("text"), documentSearchTerms(test.question))
        const query = dialect.sqlToQuery(sql`select id, document_id, text from passages where
            document_id in (${sql.join(test.scope.map((id) => sql`${id}`), sql`, `)}) and ${expressions.predicate}
            order by ${expressions.score} desc, id asc limit 20`)
        const start = performance.now()
        const params = query.params.map((value: unknown) => {
            if (typeof value !== "string" && typeof value !== "number") throw new Error("意外的词法SQL参数类型")
            return value
        })
        const hits = db.query<Hit, (string | number)[]>(query.sql).all(...params)
        const elapsedMs = performance.now() - start
        const matched = test.evidence.filter((expected) => hits.some((hit) => hit.document_id === expected.documentId && hit.text.includes(expected.quote))).length
        return { caseId: test.id, group: test.group, semanticQuestion: test.semantic,
            hasHistory: test.history.length > 0, expectedResolution: test.expectedResolution,
            expectedEvidenceCount: test.evidence.length, matchedEvidenceCount: matched,
            recallAt20: test.evidence.length ? matched / test.evidence.length : null,
            retrievedCount: hits.length, candidateIds: hits.map((hit) => hit.id),
            scopeLeakCount: hits.filter((hit) => !test.scope.includes(hit.document_id)).length,
            elapsedMs: Number(elapsedMs.toFixed(3)) }
    })
    const groups = [...new Set(rows.map((row) => row.group))].map((group) => {
        const cases = rows.filter((row) => row.group === group)
        const scorable = cases.filter((row) => row.recallAt20 !== null)
        return { group, caseCount: cases.length, scorableCount: scorable.length,
            macroRecallAt20: scorable.length ? scorable.reduce((sum, row) => sum + row.recallAt20!, 0) / scorable.length : null,
            nonAnswerCasesWithCandidates: cases.filter((row) => row.expectedResolution !== "answer" && row.retrievedCount > 0).length }
    })
    console.log(JSON.stringify({ version: 1, scope: "synthetic-native-sqlite-lexical-component-probe", datasetSha,
        limitations: ["not_postgres", "not_production_e2e", "no_semantic", "no_query_rewrite_or_history", "no_answer_or_citation_precision", "engineering_labels_not_human_gold"],
        documentCount: syntheticQaDocuments.length, passageCount, caseCount: rows.length, groups,
        failures: rows.filter((row) => row.recallAt20 !== null && row.recallAt20 < 1).map((row) => row.caseId), rows }, null, 2))
} finally { db.close() }
