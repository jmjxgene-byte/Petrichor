import path from "node:path"
import fs from "node:fs"
import postgres from "postgres"
const name = process.env.QA_PG_HOST ?? ""
const cwd = path.resolve(import.meta.dir, "..")
const checks: string[] = []
const clients: ReturnType<typeof postgres>[] = []
let stage = "client_preflight"
let failure: string | null = null
let canaryResult: unknown = null
function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label)
  checks.push(label)
}
async function rejected(label: string, sqlstate: string, run: () => Promise<unknown>) {
  let code: unknown
  try { await run() } catch (error) { code = error && typeof error === "object" && "code" in error ? error.code : null }
  assert(code === sqlstate, label)
}
async function migrate(url: string, bootstrap: boolean, workingDirectory = cwd) {
  const child = Bun.spawn([process.execPath, "run", "scripts/migrate-database.ts", ...(bootstrap ? ["--bootstrap"] : [])], {
    cwd: workingDirectory, env: { ...process.env, MIGRATION_DATABASE_URL: url, DATABASE_URL: url }, stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 60_000)
  try {
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { code, output, error }
  } finally { clearTimeout(timer) }
}
try {
  assert(process.platform === "linux" && /^petrichor-qa-[a-f0-9]{8}$/.test(name), "isolated_client_target")
  const dbUrl = (role: string) => `postgres://${role}@${name}:5432/petrichor_qa_fixture`
  const admin = postgres(dbUrl("postgres"), { max: 1, prepare: false, connect_timeout: 5, onnotice: () => {} })
  clients.push(admin)
  stage = "roles"
  const [server] = await admin`select current_setting('cluster_name') as marker, current_setting('server_version_num')::int as version`
  assert(server.marker === name && server.version >= 170000 && server.version < 180000, "isolated_pg17_identity")
  await admin.unsafe(`create schema extensions;
    create extension vector; create extension pg_trgm;
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create role petrichor_migrator login noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
    create role petrichor_runtime login noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
    grant usage,create on schema public to petrichor_migrator;
    grant usage on schema public,extensions to petrichor_runtime;
    grant usage on schema extensions to petrichor_migrator;
    alter role petrichor_migrator set search_path=public,extensions;
    alter role petrichor_runtime set search_path=public,extensions;`)
  stage = "bootstrap"
  const first = await migrate(dbUrl("petrichor_migrator"), true, "/baseline/apps/web")
  if (first.code !== 0) {
    // 全为固定DDL/合成库，无生产数据；只返回错误类别与简短首行。
    console.log(JSON.stringify({ stage, migrationError: first.error.split("\n").filter((line) => /error:|code:|message:/.test(line)).slice(0, 4) }))
  }
  assert(first.code === 0, "bootstrap_success")
  const [baseline] = await admin`select count(*)::int as n from petrichor_schema_migration`
  assert(baseline.n === 8, "baseline_eight_migrations")
  const [absent] = await admin`select to_regclass('public.petrichor_doc_index_generation') is null as absent`
  assert(absent.absent, "baseline_has_no_new_index")
  await admin`update petrichor_site_appearance set public_qa_enabled=false where id=1`
  const [retained] = await admin`insert into petrichor_user(email,password_hash) values('upgrade@example.invalid','synthetic-old-hash') returning id`
  const beforeLedger = await admin`select filename,checksum,applied_at,execution_ms from petrichor_schema_migration order by filename`
  stage = "upgrade_failure_rollback"
  // 在容器tmpfs中物化失败清单；工作区和历史迁移挂载仍只读。
  const faultRoot = fs.mkdtempSync("/tmp/petrichor-qa-fault-")
  try {
    for (const file of ["scripts/migrate-database.ts", "src/server/db/full-migration.ts", "src/server/db/doc-index-schema.ts", "src/server/db/migration-utils.ts"]) {
      const target = path.join(faultRoot, "apps/web", file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(path.join(cwd, file), target)
    }
    fs.mkdirSync(path.join(faultRoot, "apps/web/node_modules"), { recursive: true })
    fs.symlinkSync(path.join(cwd, "node_modules/postgres"), path.join(faultRoot, "apps/web/node_modules/postgres"))
    fs.cpSync("/workspace/docs/migrations", path.join(faultRoot, "docs/migrations"), { recursive: true })
    const manifestPath = path.join(faultRoot, "docs/migrations/manifest.json")
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    manifest.migrations.push({ file: "2099-01-01-fixture-write.sql" }, { file: "2099-01-02-fixture-failure.sql" })
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    fs.writeFileSync(path.join(faultRoot, "docs/migrations/2099-01-01-fixture-write.sql"), "create table petrichor_qa_rollback_marker(id int);\nupdate petrichor_user set password_hash='synthetic-changed' where email='upgrade@example.invalid';")
    fs.writeFileSync(path.join(faultRoot, "docs/migrations/2099-01-02-fixture-failure.sql"), "select 1/0;")
    const failed = await migrate(dbUrl("petrichor_migrator"), false, path.join(faultRoot, "apps/web"))
    assert(failed.code !== 0 && failed.error.includes("22012") && failed.output.includes("完成 2099-01-01-fixture-write.sql"), "upgrade_injected_failure_after_ddl_and_dml")
    const [rolledBack] = await admin`select to_regclass('public.petrichor_doc_index_generation') is null as index_absent,
      to_regclass('public.petrichor_qa_rollback_marker') is null as marker_absent`
    assert(rolledBack.index_absent && rolledBack.marker_absent, "upgrade_all_pending_ddl_rolled_back")
    const [brandingRollback] = await admin`select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='petrichor_site_appearance' and column_name='branding_json'`
    assert(brandingRollback.n === 0, "branding_column_rolled_back")
    const [oldUser] = await admin`select password_hash from petrichor_user where id=${retained.id}`
    assert(oldUser.password_hash === "synthetic-old-hash", "upgrade_existing_data_rolled_back")
    const afterLedger = await admin`select filename,checksum,applied_at,execution_ms from petrichor_schema_migration order by filename`
    assert(JSON.stringify(beforeLedger) === JSON.stringify(afterLedger), "upgrade_ledger_rolled_back")
  } finally { fs.rmSync(faultRoot, { recursive: true }); assert(!fs.existsSync(faultRoot), "fault_fixture_cleaned") }
  stage = "baseline_upgrade"
  const upgraded = await migrate(dbUrl("petrichor_migrator"), false)
  assert(upgraded.code === 0 && upgraded.output.includes("新执行 2 个迁移"), "baseline_upgrade_exactly_two_migrations")
  const [ledger] = await admin`select count(*)::int as n from petrichor_schema_migration`
  assert(ledger.n === 10, "ten_migrations_recorded")
  const [preserved] = await admin`select password_hash from petrichor_user where id=${retained.id}`
  assert(preserved.password_hash === "synthetic-old-hash", "upgrade_preserves_existing_user")
  const second = await migrate(dbUrl("petrichor_migrator"), true)
  assert(second.code !== 0 && second.error.includes("bootstrap 只允许空库"), "bootstrap_repeat_rejected")
  const repeat = await migrate(dbUrl("petrichor_migrator"), false)
  assert(repeat.code === 0 && repeat.output.includes("新执行 0 个迁移"), "migrate_no_pending")
  stage = "acl_and_constraints"
  const runtime = postgres(dbUrl("petrichor_runtime"), { max: 1, prepare: false, onnotice: () => {} }); clients.push(runtime)
  const [branding] = await runtime`select public_qa_enabled,branding_json from petrichor_site_appearance where id=1`
  assert(branding.public_qa_enabled === false && branding.branding_json === "{}", "branding_default_preserves_qa_disabled")
  await runtime`update petrichor_site_appearance set branding_json=${JSON.stringify({ title: "Synthetic branding", showContact: false })} where id=1`
  const [savedBranding] = await runtime`select branding_json from petrichor_site_appearance where id=1`
  assert(JSON.parse(savedBranding.branding_json).title === "Synthetic branding", "runtime_branding_roundtrip")
  for (const role of ["anon", "authenticated", "service_role"]) {
    const [permission] = await admin`select has_column_privilege(${role},'public.petrichor_site_appearance','branding_json','SELECT') as allowed`
    assert(permission.allowed === false, `${role}_cannot_read_branding_column`)
  }
  const [tables] = await admin`select count(*)::int as total, count(*) filter(where relrowsecurity)::int as rls
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and (c.relname like 'petrichor_%' or c.relname like 'better_auth_%')`
  assert(tables.total > 0 && tables.total === tables.rls, "all_application_tables_rls")
  for (const role of ["anon", "authenticated", "service_role"]) {
    const [acl] = await admin`select count(*)::int as readable from pg_tables where schemaname='public'
      and (tablename like 'petrichor_%' or tablename like 'better_auth_%') and has_table_privilege(${role},format('%I.%I',schemaname,tablename),'SELECT')`
    assert(acl.readable === 0, `${role}_no_table_read`)
  }
  await rejected("runtime_cannot_create_table", "42501", () => runtime.unsafe("create table forbidden_fixture(id int)"))
  await rejected("runtime_cannot_read_ledger", "42501", () => runtime.unsafe("select * from petrichor_schema_migration"))
  const [user] = await runtime`insert into petrichor_user(email,password_hash) values('fixture@example.invalid','unused-fixture') returning id`
  const [library] = await runtime`insert into petrichor_doc_library(user_id,name) values(${user.id},'fixture') returning id`
  const [document] = await runtime`insert into petrichor_doc_document(user_id,library_id,file_name,title,file_type,object_key) values(${user.id},${library.id},'fixture.md','fixture','markdown','fixture-only') returning id`
  const [generation] = await runtime`insert into petrichor_doc_index_generation(user_id,library_id,manifest_hash,manifest_json,embedding_profile_json,preprocessing_version,expected_documents)
    values(${user.id},${library.id},'fixture','{}','{}',1,1) returning id`
  await rejected("incomplete_generation_not_current", "23514", () => runtime`update petrichor_doc_index_generation set is_current=true where id=${generation.id}`)
  await runtime`update petrichor_doc_index_generation set status='ready',completed_documents=1,is_current=true where id=${generation.id}`
  const vector = `[1,${Array(1023).fill(0).join(",")}]`
  await runtime`insert into petrichor_doc_passage(generation_id,user_id,library_id,document_id,passage_index,source_hash,content_hash,start_offset,end_offset,parent_start_offset,parent_end_offset,text,search_tokens,embedding,embedding_status,embedding_dimensions)
    values(${generation.id},${user.id},${library.id},${document.id},0,'fixture','fixture',0,2,0,2,'合成','fixture',${vector}::vector,'ready',1024)`
  const [vectorRow] = await runtime`select vector_dims(embedding) as dimensions, embedding <=> ${vector}::vector as distance from petrichor_doc_passage where document_id=${document.id}`
  assert(vectorRow.dimensions === 1024 && Number(vectorRow.distance) === 0, "native_vector_1024_distance")
  const [lexical] = await runtime`select count(*)::int as matches from petrichor_doc_passage where search_vector @@ to_tsquery('simple','fixture')`
  assert(lexical.matches === 1, "generated_tsvector_search")
  await runtime`delete from petrichor_doc_document where id=${document.id}`
  const [removed] = await runtime`select count(*)::int as total from petrichor_doc_passage where document_id=${document.id}`
  assert(removed.total === 0, "document_passage_cascade")
  stage = "deep_application_store"
  const { verifyDeepFixture } = await import("./verify-deep-postgres-fixture")
  await verifyDeepFixture(runtime, Number(user.id), dbUrl("petrichor_runtime"), checks)
  if (process.env.QA_CANARY === "true") {
    const { verifyModelCanary } = await import("./verify-model-canary")
    canaryResult = await verifyModelCanary(runtime)
    assert(canaryResult, "native_model_canary_candidates")
  }
  stage = "done"
} catch (error) {
  failure = error instanceof Error ? error.message.slice(0, 160) : "unknown_failure"
  const cause = error instanceof Error && error.cause ? error.cause : error
  if (cause && typeof cause === "object" && "code" in cause) {
    const detail = cause as { code?: unknown; column_name?: unknown; constraint_name?: unknown }
    failure = JSON.stringify({ sqlstate: detail.code, column: detail.column_name, constraint: detail.constraint_name })
  }
} finally {
  await Promise.allSettled(clients.map((client) => client.end({ timeout: 2 })))
  console.log(JSON.stringify({ scope: "local-synthetic-postgres-client", stage, passed: !failure, checks, failure, canaryResult }, null, 2))
  if (failure) process.exitCode = 1
}
