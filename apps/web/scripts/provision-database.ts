import postgres from "postgres"

function requireEnv(name: string) {
    const value = process.env[name]?.trim()
    if (!value) throw new Error(`${name} 未设置`)
    return value
}

const adminDatabaseUrl = requireEnv("SUPABASE_ADMIN_DATABASE_URL")
const migratorPassword = requireEnv("PETRICHOR_MIGRATOR_PASSWORD")
const runtimePassword = requireEnv("PETRICHOR_RUNTIME_PASSWORD")

if (adminDatabaseUrl.startsWith("file:")) {
    throw new Error("数据库角色初始化仅支持 PostgreSQL")
}
for (const [name, value] of [
    ["PETRICHOR_MIGRATOR_PASSWORD", migratorPassword],
    ["PETRICHOR_RUNTIME_PASSWORD", runtimePassword],
] as const) {
    if (value.length < 32) throw new Error(`${name} 至少需要 32 个字符`)
}
if (migratorPassword === runtimePassword) {
    throw new Error("迁移角色和运行角色必须使用不同密码")
}

const client = postgres(adminDatabaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 20,
    idle_timeout: 5,
})

try {
    const existingRoles = await client<{ rolname: string }[]>`
        select rolname from pg_roles
        where rolname in ('petrichor_migrator', 'petrichor_runtime')
        order by rolname
    `
    if (existingRoles.length > 0) {
        throw new Error(`数据库角色已存在，拒绝隐式轮换密码：${existingRoles.map((row) => row.rolname).join(", ")}`)
    }

    const publicTables = await client<{ tablename: string }[]>`
        select tablename from pg_tables where schemaname = 'public' order by tablename
    `
    if (publicTables.length > 0) {
        throw new Error(`角色初始化只允许全新 public schema；已发现 ${publicTables.length} 张表`)
    }

    const [quoted] = await client<{ migrator: string; runtime: string }[]>`
        select quote_literal(${migratorPassword}) as migrator,
               quote_literal(${runtimePassword}) as runtime
    `
    if (!quoted) throw new Error("数据库密码转义失败")

    await client.begin(async (transaction) => {
        await transaction.unsafe("create extension if not exists pg_trgm")
        await transaction.unsafe("create extension if not exists vector")
        await transaction.unsafe(`
            create role petrichor_migrator with login password ${quoted.migrator}
            nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls
        `)
        await transaction.unsafe(`
            create role petrichor_runtime with login password ${quoted.runtime}
            nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls
        `)
        await transaction.unsafe("grant connect on database postgres to petrichor_migrator, petrichor_runtime")
        await transaction.unsafe("grant usage, create on schema public to petrichor_migrator")
        await transaction.unsafe("grant usage on schema public to petrichor_runtime")
        await transaction.unsafe("grant usage on schema extensions to petrichor_migrator, petrichor_runtime")
        await transaction.unsafe("revoke create on schema public from petrichor_runtime")
        await transaction.unsafe("alter role petrichor_migrator set search_path to public, extensions")
        await transaction.unsafe("alter role petrichor_runtime set search_path to public, extensions")
        await transaction.unsafe("alter role petrichor_migrator set statement_timeout to '5min'")
        await transaction.unsafe("alter role petrichor_runtime set statement_timeout to '30s'")
        await transaction.unsafe("alter role petrichor_runtime set idle_in_transaction_session_timeout to '10s'")
    })

    console.log("数据库扩展和专用角色已创建；下一步请配置 MIGRATION_DATABASE_URL 后运行 bun db:bootstrap")
} finally {
    await client.end()
}
