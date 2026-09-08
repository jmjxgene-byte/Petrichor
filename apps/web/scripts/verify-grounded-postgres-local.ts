import fs from "node:fs"
import path from "node:path"

// 只允许本机OrbStack；双容器内部网络，无端口发布、业务挂载或持久卷。
const pgImage = "pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f"
const bunImage = "oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4"
const root = path.resolve(import.meta.dir, "../../..")
const owner = crypto.randomUUID()
const name = `petrichor-qa-${owner.slice(0, 8)}`
const clientName = `${name}-client`
const network = `${name}-net`
const checks: string[] = []
let stage = "preflight"
let failure: string | null = null
let cleanupOk = true
function command(args: string[], allowFailure = false) {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" })
  const output = result.stdout.toString().trim()
  if (result.exitCode !== 0 && !allowFailure) throw new Error(`command_failed:${args[1]}:${result.stderr.toString().trim().slice(0, 180)}`)
  return { output, code: result.exitCode }
}
function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label)
  checks.push(label)
}
function mount(source: string, target: string) {
  const resolved = fs.realpathSync(path.join(root, source))
  assert(resolved.startsWith(root + path.sep) && !resolved.includes(","), "mount_within_worktree")
  return ["--mount", `type=bind,src=${resolved},dst=${target},readonly`]
}
try {
  assert(process.platform === "darwin", "local_macos_only")
  assert(JSON.parse(command(["docker", "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"]).output)
    .endsWith("/.orbstack/run/docker.sock"), "local_orbstack_endpoint")
  for (const image of [pgImage, bunImage]) {
    const item = JSON.parse(command(["docker", "image", "inspect", image, "--format", "{{json .}}"]).output)
    assert(item.RepoDigests.includes(image) && item.Architecture === process.arch, "fixed_native_image")
  }
  for (const [kind, resource] of [["container", name], ["container", clientName], ["network", network]]) {
    assert(command(["docker", kind, "inspect", resource], true).code !== 0, "resource_name_unused")
  }
  const mounts = [
    ...[
      "tsconfig.json", "scripts/verify-deep-postgres-fixture.ts",
      "src/server/assistant/deep-research-job-store.ts", "src/server/db/client.ts",
      "src/server/db/schema.ts", "src/server/db/sqlite-migration.ts", "src/config/server.ts",
      "src/lib/deep-evidence-url.ts", "src/lib/assistant-source-contract.ts",
      "node_modules/drizzle-orm", "node_modules/zod",
    ].flatMap((file) => mount(`apps/web/${file}`, `/workspace/apps/web/${file}`)),
    ...mount("apps/web/scripts/verify-grounded-postgres-client.ts", "/workspace/apps/web/scripts/verify-grounded-postgres-client.ts"),
    ...mount("apps/web/scripts/migrate-database.ts", "/workspace/apps/web/scripts/migrate-database.ts"),
    ...mount("apps/web/src/server/db/full-migration.ts", "/workspace/apps/web/src/server/db/full-migration.ts"),
    ...mount("apps/web/src/server/db/doc-index-schema.ts", "/workspace/apps/web/src/server/db/doc-index-schema.ts"),
    ...mount("apps/web/src/server/db/migration-utils.ts", "/workspace/apps/web/src/server/db/migration-utils.ts"),
    ...mount("docs/migrations", "/workspace/docs/migrations"),
    ...mount("apps/web/node_modules/postgres", "/workspace/apps/web/node_modules/postgres"),
  ]
  stage = "resources"
  command(["docker", "network", "create", "--internal", "--label", `petrichor.qa.owner=${owner}`, network])
  command(["docker", "run", "--pull=never", "-d", "--name", name, "--label", `petrichor.qa.owner=${owner}`,
    "--network", network, "--cpus=1", "--memory=512m", "--memory-swap=512m", "--pids-limit=128", "--read-only",
    "--tmpfs", "/var/lib/postgresql/data:rw,size=268435456", "--tmpfs", "/var/run/postgresql:rw,size=16777216", "--tmpfs", "/tmp:rw,size=16777216",
    "-e", "POSTGRES_DB=petrichor_qa_fixture", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
    pgImage, "postgres", "-c", `cluster_name=${name}`, "-c", "shared_buffers=32MB", "-c", "max_connections=15"])
  let ready = false
  for (let attempt = 0; attempt < 20; attempt++) {
    if (command(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "petrichor_qa_fixture"], true).code === 0) { ready = true; break }
    await Bun.sleep(500)
  }
  assert(ready, "postgres_tcp_ready")
  assert(command(["docker", "network", "inspect", network, "--format", "{{.Internal}}"]).output === "true", "internal_network")
  const ports = JSON.parse(command(["docker", "inspect", name, "--format", "{{json .HostConfig.PortBindings}}"]).output)
  assert(!ports || Object.keys(ports).length === 0, "no_published_ports")
  stage = "client_validation"
  const child = Bun.spawn(["docker", "run", "--pull=never", "--name", clientName, "--label", `petrichor.qa.owner=${owner}`,
    "--network", network, "--cpus=1", "--memory=512m", "--memory-swap=512m", "--pids-limit=128", "--read-only",
    "--user", "1000:1000", "--tmpfs", "/tmp:rw,size=67108864", "--workdir", "/workspace/apps/web",
    "-e", `QA_PG_HOST=${name}`, ...mounts, bunImage, "bun", "run", "scripts/verify-grounded-postgres-client.ts"],
    { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 180_000)
  try {
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    console.log(output.trim())
    if (code !== 0) console.log(JSON.stringify({ clientError: error.slice(0, 800) }))
    assert(code === 0 && JSON.parse(output).passed === true, "client_checks_passed")
  } finally { clearTimeout(timer) }
  stage = "done"
} catch (error) {
  failure = error instanceof Error ? error.message.slice(0, 200) : "unknown_failure"
} finally {
  for (const [kind, resource] of [["container", clientName], ["container", name], ["network", network]]) {
    const inspected = command(["docker", kind, "inspect", resource, "--format", kind === "container" ? '{{index .Config.Labels "petrichor.qa.owner"}}' : '{{index .Labels "petrichor.qa.owner"}}'], true)
    if (inspected.code !== 0) continue
    if (inspected.output !== owner) { cleanupOk = false; continue }
    if (command(kind === "container" ? ["docker", "rm", "-f", "-v", resource] : ["docker", "network", "rm", resource], true).code !== 0) cleanupOk = false
    if (command(["docker", kind, "inspect", resource], true).code === 0) cleanupOk = false
  }
  console.log(JSON.stringify({ scope: "local-synthetic-postgres-host", pgImage, bunImage, stage, passed: !failure && cleanupOk, checks, failure, cleanupOk }, null, 2))
  if (failure || !cleanupOk) process.exitCode = 1
}
