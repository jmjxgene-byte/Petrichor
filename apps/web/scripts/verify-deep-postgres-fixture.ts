import type postgres from "postgres"
import type { CreateDeepResearchJobInput } from "../src/server/assistant/deep-research-job-store"

/** 由已验证身份的隔离PG客户端调用；不导入Worker、模型或真实环境文件。 */
export async function verifyDeepFixture(runtime: ReturnType<typeof postgres>, userId: number, url: string, checks: string[]) {
  if (process.platform !== "linux" || !/^postgres:\/\/petrichor_runtime@petrichor-qa-[a-f0-9]{8}:5432\/petrichor_qa_fixture$/.test(url)) throw new Error("deep_fixture_target")
  process.env.DATABASE_URL = url
  process.env.PETRICHOR_DB_DIALECT = "postgres"
  process.env.PETRICHOR_DB_MAX_CONNECTIONS = "3"
  process.env.SESSION_SECRET = crypto.randomUUID()
  process.env.PETRICHOR_ENCRYPT_KEY = crypto.randomUUID()
  process.env.PETRICHOR_ENCRYPT_SALT = "0123456789abcdef"
  const store = await import("../src/server/assistant/deep-research-job-store")
  const { getDb } = await import("../src/server/db/client")
  function check(value: unknown, label: string): asserts value {
    if (!value) throw new Error(label)
    checks.push(label)
  }
  try {
    const [thread] = await runtime`insert into petrichor_assistant_thread(user_id,title) values(${userId},'synthetic deep') returning id`
    const [question] = await runtime`insert into petrichor_assistant_message(thread_id,role,content_json) values(${thread.id},'user','{"parts":[]}') returning id`
    const make = async (key: string, overrides: Partial<CreateDeepResearchJobInput> = {}) => {
      const created = await store.createDeepResearchJob({
      runKey: key, idempotencyKey: key, threadId: Number(thread.id), userId,
      questionMessageId: Number(question.id), sourceScopeHash: "synthetic",
      capabilitySnapshot: { reservationVersion: 1, contractVersion: 2, sourceCutoffs: {}, allowedModes: ["exact"], wikiReady: false, graphReady: false, qualityStale: false, capturedAt: new Date().toISOString() },
      ...overrides,
      })
      // PostgreSQL now()含微秒，JS Date仅毫秒；显式构造已到期队列，避免即时领取的时钟竞态。
      await runtime`update petrichor_deep_research_job set available_at='2020-01-01T00:00:00Z' where id=${created.id}`
      return created
    }
    const [one, duplicate] = await Promise.all([make("fixture_deep_one"), make("fixture_deep_one")])
    check(one.id === duplicate.id, "deep_concurrent_create_idempotent")
    for (let index = 0; index < 200; index++) {
      const key = `fixture_deep_race_${index}`
      const batch = await Promise.allSettled([make(key), make(key), make(key)])
      const failed = batch.find((result) => result.status === "rejected")
      if (failed?.status === "rejected") throw failed.reason
      const ids = batch.map((result) => result.status === "fulfilled" ? result.value.id : null)
      if (new Set(ids).size !== 1) throw new Error("deep_repeated_create_id_mismatch")
      await store.requestDeepResearchJobCancellation(key, userId)
    }
    check(true, "deep_200_concurrent_create_batches")
    for (const [label, overrides] of [
      ["deep_run_key_collision_rejected", { idempotencyKey: "different-idempotency-key" }],
      ["deep_scope_collision_rejected", { sourceScopeHash: "different-scope" }],
      ["deep_fast_run_collision_rejected", { fastRunKey: "different-fast-run" }],
    ] as const) {
      let rejected = false
      try { await make(one.runKey, overrides) }
      catch (error) { rejected = error instanceof Error && error.message === "深度检索幂等键冲突" }
      check(rejected, label)
    }
    check(await store.getDeepResearchJob(one.runKey, userId + 10000) === null, "deep_foreign_user_denied")
    const claimed = await Promise.all([store.claimDeepResearchJob({ workerId: "a" }), store.claimDeepResearchJob({ workerId: "b" })])
    const job = claimed.find((row) => row != null)
    check(job && claimed.filter(Boolean).length === 1 && job.attemptCount === 1, "deep_concurrent_claim_unique")
    const workerId = job.leaseOwner!
    check(await store.heartbeatDeepResearchJob({ jobId: job.id, workerId: "wrong" }) === null, "deep_heartbeat_owner_enforced")
    check(await store.heartbeatDeepResearchJob({ jobId: job.id, workerId }), "deep_heartbeat_success")
    const reservations = await Promise.all([store.reserveDeepResearchExecution(job.id, workerId), store.reserveDeepResearchExecution(job.id, workerId)])
    check(reservations.filter(Boolean).length === 1, "deep_execution_reserved_once")
    const message = { parts: [{ type: "text" as const, text: "合成验收结果" }], agentRunId: job.runKey, deepResearch: { runKey: job.runKey, fastRunKey: null, references: [] } }
    const completion = { jobId: job.id, workerId, message, runCompletion: { answer: "合成验收结果", metricsJson: "{}", inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 1 } }
    const results = await Promise.allSettled([store.completeDeepResearchJob(completion), store.completeDeepResearchJob(completion)])
    check(results.some((result) => result.status === "fulfilled" && result.value?.job.status === "succeeded"), "deep_concurrent_completion_success")
    const again = await store.completeDeepResearchJob(completion)
    const [count] = await runtime`select count(*)::int as n from petrichor_assistant_message where thread_id=${thread.id} and role='assistant'`
    check(again && count.n === 1, "deep_final_message_exactly_once")
    const [run] = await runtime`select status from petrichor_agent_run where run_key=${job.runKey}`
    check(run.status === "completed", "deep_run_completed_atomically")
    const queued = await make("fixture_deep_cancel")
    check((await store.requestDeepResearchJobCancellation(queued.runKey, userId))?.status === "cancelled", "deep_queued_cancel")
    await make("fixture_deep_recovery")
    const recovery = await store.claimDeepResearchJob({ workerId: "recover" })
    check(recovery, "deep_recovery_claim")
    await runtime`update petrichor_deep_research_job set lease_expires_at=now()-interval '1 second' where id=${recovery.id}`
    check((await store.recoverExpiredDeepResearchJobs()).retried === 1, "deep_unreserved_lease_recoverable")
    const resumed = await store.claimDeepResearchJob({ workerId: "recover2" })
    check(resumed?.id === recovery.id && resumed.attemptCount === 2, "deep_recovery_same_job")
    check(await store.reserveDeepResearchExecution(resumed.id, "recover2"), "deep_recovered_execution_reserved")
    await runtime`update petrichor_deep_research_job set lease_expires_at=now()-interval '1 second' where id=${resumed.id}`
    check((await store.recoverExpiredDeepResearchJobs()).failed === 1, "deep_reserved_lease_no_replay")
    await make("fixture_deep_running_cancel")
    const cancelling = await store.claimDeepResearchJob({ workerId: "cancel" })
    check(cancelling, "deep_cancel_claim")
    check((await store.requestDeepResearchJobCancellation(cancelling.runKey, userId))?.status === "cancel_requested", "deep_running_cancel_requested")
    check(await store.acknowledgeDeepResearchJobCancellation({ jobId: cancelling.id, workerId: "wrong" }) === null, "deep_cancel_owner_enforced")
    check((await store.acknowledgeDeepResearchJobCancellation({ jobId: cancelling.id, workerId: "cancel" }))?.status === "cancelled", "deep_running_cancel_acknowledged")
    const locked = await make("fixture_deep_locked")
    await runtime.begin(async (tx) => {
      await tx`select id from petrichor_deep_research_job where id=${locked.id} for update`
      check(await store.claimDeepResearchJob({ workerId: "locked" }) === null, "deep_claim_skips_locked_row")
    })
    const rollback = await store.claimDeepResearchJob({ workerId: "rollback" })
    check(rollback?.id === locked.id, "deep_claim_after_lock_release")
    let rejected = false
    try {
      await store.completeDeepResearchJob({ ...completion, jobId: rollback.id, workerId: "rollback", message: { ...message, agentRunId: rollback.runKey, deepResearch: { ...message.deepResearch, runKey: rollback.runKey } } })
    } catch (error) {
      rejected = error instanceof Error && error.message === "深度检索Run完成状态竞争"
    }
    check(rejected, "deep_missing_run_completion_rejected")
    const [afterRollback] = await runtime`select count(*)::int as n from petrichor_assistant_message where thread_id=${thread.id} and role='assistant'`
    check(afterRollback.n === 1 && (await store.getDeepResearchJob(rollback.runKey, userId))?.status === "running", "deep_failed_completion_transaction_rollback")
    const { verifyIndexFixture } = await import("./verify-index-postgres-fixture")
    await verifyIndexFixture(runtime, userId, checks)
  } finally {
    // Drizzle公开的底层客户端；仅结束此测试模块建立的应用连接池。
    await (getDb() as ReturnType<typeof getDb> & { $client: ReturnType<typeof postgres> }).$client.end({ timeout: 2 })
  }
}
