import { Database } from "bun:sqlite"
import assert from "node:assert/strict"
import { softDeleteSqliteThreads, truncateSqliteThread } from "../src/server/assistant/thread-sqlite-mutations"

// 只在内存创建合成表；不读取env、磁盘数据库或网络。
const db = new Database(":memory:")
try {
    db.exec(`pragma foreign_keys=on;
        create table petrichor_assistant_thread(id integer primary key,user_id integer,deleted_at integer,updated_at integer);
        create table petrichor_assistant_message(id integer primary key,thread_id integer,role text,created_at integer);
        create table petrichor_deep_research_job(id integer primary key,user_id integer,thread_id integer,question_message_id integer references petrichor_assistant_message(id) on delete cascade,status text,run_key text,lease_owner text,lease_expires_at integer,heartbeat_at integer,error_code text,cancelled_at integer,completed_at integer,updated_at integer);
        create table petrichor_agent_run(run_key text primary key,user_id integer,status text,stop_reason text,completed_at integer,metrics_json text);
        insert into petrichor_assistant_thread values(11,7,null,0),(12,8,null,0);
        insert into petrichor_assistant_message values(1,11,'user',1),(2,11,'assistant',2),(3,11,'user',3),(4,12,'user',4);
        insert into petrichor_deep_research_job(id,user_id,thread_id,question_message_id,status,run_key) values(1,7,11,3,'running','fixture'),(2,8,12,4,'queued','other');
        insert into petrichor_agent_run values('fixture',7,'running',null,null,'{"reserved":1}');
        create trigger fail_delete before delete on petrichor_assistant_message when old.id=3 begin select raise(abort,'synthetic_failure'); end;`)
    assert.throws(() => truncateSqliteThread(db, { userId: 7, threadId: 11, keepCount: 1 }))
    assert.deepEqual(db.query("select status from petrichor_deep_research_job where id=1").get(), { status: "running" })
    assert.deepEqual(db.query("select count(*) as count from petrichor_assistant_message").get(), { count: 4 })
    assert.deepEqual(db.query("select status from petrichor_agent_run where run_key='fixture'").get(), { status: "running" })
    db.exec("drop trigger fail_delete")
    assert.throws(() => truncateSqliteThread(db, { userId: 8, threadId: 11, keepCount: 0 }))
    assert.deepEqual(truncateSqliteThread(db, { userId: 7, threadId: 11, keepCount: 1 }), { deleted: 2 })
    assert.deepEqual(db.query("select count(*) as count from petrichor_deep_research_job where id=1").get(), { count: 0 })
    assert.deepEqual(db.query("select status,metrics_json from petrichor_agent_run where run_key='fixture'").get(), { status: "cancelled", metrics_json: '{"reserved":1}' })
    assert.deepEqual(softDeleteSqliteThreads(db, 7, [11, 12]), { deleted: 1 })
    assert.deepEqual(db.query("select deleted_at from petrichor_assistant_thread where id=12").get(), { deleted_at: null })
    assert.deepEqual(db.query("select status from petrichor_deep_research_job where id=2").get(), { status: "queued" })
    console.log(JSON.stringify({ passed: true, scope: "in-memory-sqlite-thread-mutations", checks: 11 }))
} finally { db.close() }
