import type postgres from "postgres"

/** 使用真实检索函数；只在上层已验证的合成PG任务中运行，不配置provider。 */
export async function verifyIndexFixture(runtime: ReturnType<typeof postgres>, userId: number, checks: string[]) {
  if (process.platform !== "linux" || !/^postgres:\/\/petrichor_runtime@petrichor-qa-[a-f0-9]{8}:5432\/petrichor_qa_fixture$/.test(process.env.DATABASE_URL ?? "")) throw new Error("index_fixture_target")
  process.env.PETRICHOR_DOC_INDEX_ENABLED = "true"
  process.env.PETRICHOR_DOC_HYBRID_ENABLED = "false"
  const { buildDocumentPassages, hashDocumentText } = await import("../src/server/doc-library/passage-builder")
  const { prepareIndexManifest } = await import("../src/server/doc-library/index-contract")
  const { searchDocumentIndex, readDocumentIndexPassage, createDocumentIndexReadSession } = await import("../src/server/doc-library/index-retrieval")
  function check(value: unknown, label: string): asserts value { if (!value) throw new Error(label); checks.push(label) }
  async function rejects(label: string, expected: string, run: () => Promise<unknown>) {
    let rejected = false
    try { await run() } catch (error) { rejected = error instanceof Error && error.message.includes(expected) }
    check(rejected, label)
  }
  const [library] = await runtime`insert into petrichor_doc_library(user_id,name) values(${userId},'synthetic-index') returning id`
  const libraryId = Number(library.id)
  const source = "# 合成资料\n\n" + "这是无关的背景信息，仅用于测试长文。\n\n".repeat(500) + "## 尾部证据\n\n蓝鲸校验码 QAZX739 的处理条件是先验证材料，再申请复核。\n"
  const sourceHash = hashDocumentText(source)
  const [document] = await runtime`insert into petrichor_doc_document(user_id,library_id,file_name,title,file_type,object_key,status,updated_at)
    values(${userId},${libraryId},'synthetic.md','合成资料','markdown','synthetic-only','ready','2026-01-01T00:00:00Z') returning id`
  const documentId = Number(document.id)
  const profile = { modelRefId: 1, model: "synthetic-not-called", dimensions: 1024, version: 1, key: "synthetic" }
  const prepared = prepareIndexManifest([{ documentId, sourceHash, updatedAt: "2026-01-01T00:00:00.000Z" }], profile)
  async function generation(version: 1 | 2) {
    const snapshot = prepareIndexManifest(prepared.manifest.documents, profile, version)
    const passages = buildDocumentPassages(source, "合成资料", version)
    const [g] = await runtime`insert into petrichor_doc_index_generation(user_id,library_id,manifest_hash,manifest_json,embedding_profile_json,preprocessing_version,expected_documents)
      values(${userId},${libraryId},${snapshot.manifestHash},${JSON.stringify(snapshot.manifest)},${JSON.stringify(profile)},${version},1) returning id`
    for (const p of passages) {
      await runtime`insert into petrichor_doc_passage(generation_id,user_id,library_id,document_id,passage_index,source_hash,content_hash,start_offset,end_offset,parent_start_offset,parent_end_offset,locator,text,search_tokens)
        values(${g.id},${userId},${libraryId},${documentId},${p.passageIndex},${p.sourceHash},${p.contentHash},${p.startOffset},${p.endOffset},${p.parentStartOffset},${p.parentEndOffset},${p.locator},${p.text},${p.searchTokens})`
    }
    await runtime`update petrichor_doc_index_generation set status='ready',completed_documents=1,passage_count=${passages.length},is_current=true where id=${g.id}`
    return Number(g.id)
  }
  const generationId = await generation(1)
  const session = createDocumentIndexReadSession()
  const input = { userId, libraryIds: [libraryId], query: "QAZX739", session }
  const search = await searchDocumentIndex(input)
  const hit = search.hits[0]
  check(hit && hit.text.includes("QAZX739") && hit.passageIndex > 0 && hit.generationId === generationId, "index_native_lexical_tail_hit")
  check(search.degraded.length === 0 && hit.mode === "lexical", "index_lexical_without_provider")
  const readInput = { userId, libraryId, documentId, generationId, passageId: hit.passageId, contentHash: hit.contentHash }
  const read = await readDocumentIndexPassage(readInput)
  check(read.content.slice(read.anchorStart, read.anchorEnd) === hit.text && read.content.length <= 4000, "index_native_anchor_window")
  check(read.href.includes(`passageId=${hit.passageId}`) && read.href.includes(hit.contentHash), "index_native_citation_identity")
  check((await searchDocumentIndex({ ...input, userId: userId + 10000, session: undefined })).hits.length === 0, "index_foreign_user_no_search")
  await rejects("index_foreign_user_no_read", "版本已失效", () => readDocumentIndexPassage({ ...readInput, userId: userId + 10000 }))
  await rejects("index_wrong_hash_rejected", "hash不匹配", () => readDocumentIndexPassage({ ...readInput, contentHash: "0".repeat(64) }))
  await runtime`update petrichor_doc_index_generation set is_current=false,status='retired' where id=${generationId}`
  const nextGeneration = await generation(2)
  check((await searchDocumentIndex(input)).hits[0]?.generationId === generationId, "index_session_pins_retired_generation")
  check((await searchDocumentIndex({ ...input, session: createDocumentIndexReadSession() })).hits[0]?.generationId === nextGeneration, "index_new_session_uses_current")
  await readDocumentIndexPassage(readInput)
  check(true, "index_retired_citation_readable")
  await runtime`update petrichor_doc_document set updated_at='2026-01-02T00:00:00Z' where id=${documentId}`
  await rejects("index_pinned_source_change_rejected", "原文已变化", () => searchDocumentIndex(input))
  await rejects("index_stale_citation_rejected", "原文版本已变化", () => readDocumentIndexPassage(readInput))
  const stale = await searchDocumentIndex({ ...input, session: createDocumentIndexReadSession() })
  check(stale.hits.length === 0 && stale.degraded.includes("index_snapshot_stale"), "index_new_session_stale_degrades")
  const controller = new AbortController(); controller.abort(new Error("synthetic-abort"))
  await rejects("index_cancelled_query_stops", "synthetic-abort", () => searchDocumentIndex({ ...input, session: undefined, abortSignal: controller.signal }))
  await rejects("index_expired_budget_stops", "超时", () => searchDocumentIndex({ ...input, session: undefined, queryDeadlineAt: Date.now() - 1 }))
  const jobs = await import("../src/server/doc-library/index-jobs")
  const [building] = await runtime`insert into petrichor_doc_index_generation(user_id,library_id,manifest_hash,manifest_json,embedding_profile_json,preprocessing_version,expected_documents)
    values(${userId},${libraryId},${prepared.manifestHash},${JSON.stringify(prepared.manifest)},${JSON.stringify(profile)},${prepared.manifest.preprocessingVersion},1) returning id`
  const approval = { approvalId: "synthetic-only", manifestHash: prepared.manifestHash, maxInputTokens: 100, maxCostMicrousd: 100, expiresAt: new Date(Date.now() + 60000).toISOString() }
  const [pending] = await runtime`insert into petrichor_doc_index_job(generation_id,user_id,library_id,document_id,source_hash,idempotency_key,approved_budget_json,available_at)
    values(${building.id},${userId},${libraryId},${documentId},${sourceHash},'synthetic-index-job',${JSON.stringify(approval)},'2020-01-01T00:00:00Z') returning id`
  const claimed = await Promise.all([jobs.claimDocumentIndexJob("index-a"), jobs.claimDocumentIndexJob("index-b")])
  const job = claimed.find((value) => value != null)
  check(job && job.id === Number(pending.id) && claimed.filter(Boolean).length === 1, "index_job_concurrent_single_slot")
  const workerId = job.leaseOwner!
  check(await jobs.heartbeatDocumentIndexJob(job.id, "wrong") === null, "index_job_heartbeat_owner")
  check(await jobs.heartbeatDocumentIndexJob(job.id, workerId), "index_job_heartbeat_success")
  await rejects("index_job_budget_limit", "预算不足", () => jobs.reserveDocumentIndexBudget({ userId, jobId: job.id, workerId, reservation: { inputTokens: 101, costMicrousd: 1 } }))
  const reserve = { userId, jobId: job.id, workerId, reservation: { inputTokens: 10, costMicrousd: 1 } }
  const reserved = await Promise.allSettled([jobs.reserveDocumentIndexBudget(reserve), jobs.reserveDocumentIndexBudget(reserve)])
  check(reserved.filter((result) => result.status === "fulfilled").length === 1 && reserved.some((result) => result.status === "rejected" && result.reason instanceof Error && result.reason.message.includes("禁止重复调用")), "index_job_reservation_once")
  await runtime`update petrichor_doc_index_job set lease_expires_at=now()-interval '1 second' where id=${job.id}`
  check(await jobs.heartbeatDocumentIndexJob(job.id, workerId) === null, "index_job_expired_heartbeat_rejected")
  check(await jobs.claimDocumentIndexJob("index-recovery") === null, "index_reserved_expiry_not_replayed")
  const [terminal] = await runtime`select j.status,j.error_code,g.status as generation_status from petrichor_doc_index_job j
    join petrichor_doc_index_generation g on g.id=j.generation_id where j.id=${job.id}`
  check(terminal.status === "failed" && terminal.error_code === "model_outcome_unknown" && terminal.generation_status === "failed", "index_reserved_expiry_safe_terminal")
  await runtime`delete from petrichor_doc_document where id=${documentId}`
  await rejects("index_deleted_document_no_read", "原文版本已变化", () => readDocumentIndexPassage(readInput))
  process.env.PETRICHOR_DOC_INDEX_ENABLED = "false"
}
