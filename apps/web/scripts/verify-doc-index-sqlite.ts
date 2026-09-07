import { Database } from "bun:sqlite"
import { buildSqliteMigrationSql } from "../src/server/db/sqlite-migration"

// 只使用内存数据库与合成标识，不读取任何env、文件正文或网络凭据。
const db = new Database(":memory:")
let checks = 0
function rejected(run: () => unknown) {
    let failed = false
    try { run() } catch { failed = true }
    if (!failed) throw new Error("预期的数据库约束未拒绝输入")
    checks++
}
try {
    db.exec(buildSqliteMigrationSql())
    db.query("insert into petrichor_user(id,email,password_hash) values(7,'fixture7@example.invalid','not-a-credential'),(8,'fixture8@example.invalid','not-a-credential')").run()
    db.query("insert into petrichor_doc_library(id,user_id,name) values(1,7,'synthetic'),(2,8,'other')").run()
    db.query("insert into petrichor_doc_document(id,user_id,library_id,file_name,title,file_type,object_key) values(1,7,1,'synthetic.md','synthetic','markdown','synthetic')").run()
    const generation = db.query("insert into petrichor_doc_index_generation(id,user_id,library_id,manifest_hash,manifest_json,embedding_profile_json,preprocessing_version,expected_documents) values(?,?,?,'synthetic','{}','{}',1,1)")
    generation.run(1,7,1)
    rejected(() => generation.run(2,8,1))
    rejected(() => db.query("update petrichor_doc_index_generation set is_current=1 where id=1").run())
    rejected(() => db.query("update petrichor_doc_index_generation set status='ready',is_current=1 where id=1").run())
    db.query("update petrichor_doc_index_generation set status='ready',completed_documents=1,is_current=1 where id=1").run()
    generation.run(2,7,1)
    rejected(() => db.query("update petrichor_doc_index_generation set status='ready',completed_documents=1,is_current=1 where id=2").run())
    const passage = db.query("insert into petrichor_doc_passage(generation_id,user_id,library_id,document_id,passage_index,source_hash,content_hash,start_offset,end_offset,parent_start_offset,parent_end_offset,text,search_tokens) values(1,?,1,1,?,'synthetic','synthetic',0,1,0,1,'x','x')")
    passage.run(7,0)
    rejected(() => passage.run(8,1))
    rejected(() => passage.run(7,0))
    rejected(() => db.query("update petrichor_doc_passage set embedding_status='ready'").run())
    rejected(() => db.query("update petrichor_doc_passage set end_offset=0").run())
    const job = db.query("insert into petrichor_doc_index_job(generation_id,user_id,library_id,document_id,source_hash,idempotency_key,approved_budget_json) values(1,7,1,1,'synthetic','synthetic','{}')")
    job.run()
    rejected(() => job.run())
    rejected(() => db.query("update petrichor_doc_index_job set consumed_cost_microusd=-1").run())
    // 模拟用户明确删除资料：级联只清该资料的派生片段/任务，不阻塞原有删除入口。
    db.query("delete from petrichor_doc_document where id=1").run()
    for (const table of ["petrichor_doc_passage", "petrichor_doc_index_job"]) {
        const row = db.query(`select count(*) as count from ${table}`).get() as { count: number }
        if (row.count !== 0) throw new Error("合成删除未清理对应派生行")
        checks++
    }
    console.log(`PASS SQLite memory index contracts: ${checks}; PostgreSQL/RLS/vector NOT verified`)
} finally { db.close() }
