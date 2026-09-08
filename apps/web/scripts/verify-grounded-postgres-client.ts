import path from "node:path"
import postgres from "postgres"
const name = process.env.QA_PG_HOST ?? ""
const cwd = path.resolve(import.meta.dir, "..")
const checks: string[] = []
const clients: ReturnType<typeof postgres>[] = []
let stage = "client_preflight"
let failure: string | null = null
function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label)
  checks.push(label)
}
async function rejected(label: string, sqlstate: string, run: () => Promise<unknown>) {
  let code: unknown
  try { await run() } catch (error) { code = error && typeof error === "object" && "code" in error ? error.code : null }
  assert(code === sqlstate, label)
}
async function migrate(url: string, bootstrap: boolean) {
  const child = Bun.spawn([process.execPath, "run", "scripts/migrate-database.ts", ...(bootstrap ? ["--bootstrap"] : [])], {
    cwd, env: { ...process.env, MIGRATION_DATABASE_URL: url, DATABASE_URL: url }, stdout: "pipe", stderr: "pipe",
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
  const first = await migrate(dbUrl("petrichor_migrator"), true)
  if (first.code !== 0) {
    // 全为固定DDL/合成库，无生产数据；只返回错误类别与简短首行。
    console.log(JSON.stringify({ stage, migrationError: first.error.split("\n").filter((line) => /error:|code:|message:/.test(line)).slice(0, 4) }))
  }
  assert(first.code === 0, "bootstrap_success")
  const second = await migrate(dbUrl("petrichor_migrator"), true)
  assert(second.code !== 0 && second.error.includes("bootstrap 只允许空库"), "bootstrap_repeat_rejected")
  const repeat = await migrate(dbUrl("petrichor_migrator"), false)
  assert(repeat.code === 0 && repeat.output.includes("新执行 0 个迁移"), "migrate_no_pending")
  stage = "acl_and_constraints"
  const runtime = postgres(dbUrl("petrichor_runtime"), { max: 1, prepare: false, onnotice: () => {} }); clients.push(runtime)
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
  stage = "done"
} catch (error) {
  failure = error instanceof Error ? error.message.slice(0, 160) : "unknown_failure"
} finally {
  await Promise.allSettled(clients.map((client) => client.end({ timeout: 2 })))
  console.log(JSON.stringify({ scope: "local-synthetic-postgres-client", stage, passed: !failure, checks, failure }, null, 2))
  if (failure) process.exitCode = 1
}
