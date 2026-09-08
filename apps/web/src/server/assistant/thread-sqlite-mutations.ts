import type { Database } from "bun:sqlite"
import { notFound } from "@/server/http/response"

const placeholders = (ids: number[]) => ids.map(() => "?").join(",")
function cancelJobs(db: Database, userId: number, threadIds: number[], questionIds?: number[]) {
    if (!threadIds.length || questionIds?.length === 0) return
    const filter = `user_id=? and thread_id in (${placeholders(threadIds)})${questionIds ? ` and question_message_id in (${placeholders(questionIds)})` : ""}`
    const values = [userId, ...threadIds, ...(questionIds ?? [])]
    const now = Date.now()
    db.query(`update petrichor_deep_research_job set status='cancelled',cancelled_at=?,completed_at=?,updated_at=?,lease_owner=null,lease_expires_at=null,heartbeat_at=null,error_code='cancelled' where ${filter} and status in ('queued','retry_wait')`).run(now, now, now, ...values)
    db.query(`update petrichor_deep_research_job set status='cancel_requested',cancelled_at=?,updated_at=? where ${filter} and status='running'`).run(now, now, ...values)
    db.query(`update petrichor_agent_run set status='cancelled',stop_reason='cancelled',completed_at=? where user_id=? and status='running' and run_key in (select run_key from petrichor_deep_research_job where ${filter} and status in ('cancel_requested','cancelled'))`).run(now, userId, ...values)
}

/** bun:sqlite事务必须同步；回调中不包含await、网络或模型调用。 */
export function truncateSqliteThread(db: Database, input: { userId: number; threadId: number; keepCount: number }) {
    return db.transaction(() => {
        const thread = db.query("select id from petrichor_assistant_thread where id=? and user_id=? and deleted_at is null").get(input.threadId, input.userId)
        if (!thread) throw notFound("Assistant 会话不存在")
        const rows = db.query<{ id: number }, [number]>("select id from petrichor_assistant_message where thread_id=? order by created_at,id").all(input.threadId)
        const ids = rows.slice(Math.max(0, Math.floor(input.keepCount))).map((row) => row.id)
        if (!ids.length) return { deleted: 0 }
        cancelJobs(db, input.userId, [input.threadId], ids)
        db.query(`delete from petrichor_assistant_message where id in (${placeholders(ids)})`).run(...ids)
        return { deleted: ids.length }
    })()
}

export function softDeleteSqliteThreads(db: Database, userId: number, threadIds: number[]) {
    if (!threadIds.length) return { deleted: 0 }
    return db.transaction(() => {
        const ids = [...new Set(threadIds)]
        const owned = db.query<{ id: number }, number[]>(`select id from petrichor_assistant_thread where user_id=? and id in (${placeholders(ids)}) and deleted_at is null`).all(userId, ...ids).map((row) => row.id)
        if (!owned.length) return { deleted: 0 }
        const now = Date.now()
        db.query(`update petrichor_assistant_thread set deleted_at=?,updated_at=? where id in (${placeholders(owned)})`).run(now, now, ...owned)
        cancelJobs(db, userId, owned)
        return { deleted: owned.length }
    })()
}
