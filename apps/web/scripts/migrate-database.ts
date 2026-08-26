import fs from "node:fs"
import path from "node:path"
import postgres from "postgres"
import { buildInitialMigrationSql } from "../src/server/db/full-migration"
import {
    migrationChecksum,
    parseMigrationManifest,
    splitSqlStatements,
} from "../src/server/db/migration-utils"

const bootstrap = process.argv.includes("--bootstrap")
const databaseUrl = process.env.MIGRATION_DATABASE_URL?.trim()
if (!databaseUrl) {
    throw new Error("MIGRATION_DATABASE_URL 未设置；迁移禁止回退到运行时 DATABASE_URL")
}
if (databaseUrl.startsWith("file:")) {
    throw new Error("数据库 bootstrap / migrate 仅支持 PostgreSQL")
}

const repositoryRoot = path.resolve(import.meta.dirname, "../../..")
const migrationsDirectory = path.join(repositoryRoot, "docs/migrations")
const manifestPath = path.join(migrationsDirectory, "manifest.json")
const manifest = parseMigrationManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")))
const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 20,
    idle_timeout: 5,
})

type AppliedMigration = {
    filename: string
    checksum: string
}

type DatabaseIdentity = {
    currentRole: string
    currentSchema: string
}

type TableNameRow = {
    tableName: string
}

function quoteIdentifier(value: string) {
    return `"${value.replaceAll('"', '""')}"`
}

try {
    await client.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(hashtext('petrichor-schema-migrations'))`

        const [identity] = await transaction<DatabaseIdentity[]>`
            select current_user as "currentRole", current_schema() as "currentSchema"
        `
        if (identity?.currentRole !== "petrichor_migrator") {
            throw new Error(`迁移必须使用 petrichor_migrator，当前角色为 ${identity?.currentRole ?? "unknown"}`)
        }
        if (identity.currentSchema !== "public") {
            throw new Error(`迁移目标 schema 必须是 public，当前为 ${identity.currentSchema}`)
        }

        await transaction.unsafe("alter default privileges in schema public revoke all on tables from public")
        await transaction.unsafe(`
            alter default privileges in schema public
            grant select, insert, update, delete on tables to petrichor_runtime
        `)
        await transaction.unsafe("alter default privileges in schema public revoke all on sequences from public")
        await transaction.unsafe(`
            alter default privileges in schema public
            grant usage, select, update on sequences to petrichor_runtime
        `)
        await transaction.unsafe("alter default privileges in schema public revoke all on functions from public")

        const extensionRows = await transaction<{ extname: string }[]>`
            select extname from pg_extension where extname in ('pg_trgm', 'vector') order by extname
        `
        const extensions = new Set(extensionRows.map((row) => row.extname))
        for (const extension of ["pg_trgm", "vector"]) {
            if (!extensions.has(extension)) {
                throw new Error(`缺少 PostgreSQL 扩展：${extension}；请先运行 bun db:provision`)
            }
        }

        const existingTables = await transaction<TableNameRow[]>`
            select tablename as "tableName"
            from pg_tables
            where schemaname = current_schema()
              and tablename ~ '^(petrichor_|better_auth_)'
            order by tablename
        `

        if (bootstrap) {
            if (existingTables.length > 0) {
                throw new Error(`bootstrap 只允许空库；已发现 ${existingTables.length} 张 Petrichor 表`)
            }
            const initialStatements = splitSqlStatements(buildInitialMigrationSql())
            console.log(`[db:bootstrap] 初始化基础结构（${initialStatements.length} 条语句）`)
            for (const statement of initialStatements) {
                await transaction.unsafe(statement)
            }
        } else if (!existingTables.some((row) => row.tableName === "petrichor_schema_migration")) {
            throw new Error("未发现 petrichor_schema_migration；新库必须先运行 bun db:bootstrap")
        }

        await transaction.unsafe(`
            create table if not exists petrichor_schema_migration (
                filename text primary key,
                checksum text not null,
                applied_at timestamptz not null default now(),
                execution_ms integer not null
            )
        `)

        const appliedRows = await transaction<AppliedMigration[]>`
            select filename, checksum
            from petrichor_schema_migration
            order by filename asc
        `
        const applied = new Map(appliedRows.map((row) => [row.filename, row.checksum]))
        let appliedCount = 0

        for (const entry of manifest.migrations) {
            const migrationPath = path.join(migrationsDirectory, entry.file)
            if (!fs.existsSync(migrationPath)) {
                throw new Error(`迁移文件不存在：${entry.file}`)
            }

            const rawSql = fs.readFileSync(migrationPath, "utf8")
            const checksum = migrationChecksum(rawSql)
            const recordedChecksum = applied.get(entry.file)
            if (recordedChecksum) {
                if (recordedChecksum !== checksum) {
                    throw new Error(`已执行的迁移被修改：${entry.file}`)
                }
                console.log(`[db:migrate] 已执行 ${entry.file}`)
                continue
            }

            const statements = splitSqlStatements(rawSql)
            if (statements.length === 0) {
                throw new Error(`迁移文件不包含可执行 SQL：${entry.file}`)
            }

            console.log(`[db:migrate] 执行 ${entry.file}（${statements.length} 条语句）`)
            const startedAt = Date.now()
            for (const statement of statements) {
                await transaction.unsafe(statement)
            }
            const executionMs = Date.now() - startedAt

            await transaction`
                insert into petrichor_schema_migration (filename, checksum, execution_ms)
                values (${entry.file}, ${checksum}, ${executionMs})
            `
            appliedCount += 1
            console.log(`[db:migrate] 完成 ${entry.file}（${executionMs}ms）`)
        }

        const tables = await transaction<TableNameRow[]>`
            select tablename as "tableName"
            from pg_tables
            where schemaname = current_schema()
              and tablename ~ '^(petrichor_|better_auth_)'
            order by tablename
        `
        for (const row of tables) {
            const table = quoteIdentifier(row.tableName)
            await transaction.unsafe(`alter table ${table} enable row level security`)
            await transaction.unsafe(`revoke all on table ${table} from public, anon, authenticated, service_role`)

            if (row.tableName === "petrichor_schema_migration") {
                await transaction.unsafe(`revoke all on table ${table} from petrichor_runtime`)
                continue
            }

            await transaction.unsafe(`grant select, insert, update, delete on table ${table} to petrichor_runtime`)
            const [policy] = await transaction<{ exists: boolean }[]>`
                select exists (
                    select 1 from pg_policies
                    where schemaname = current_schema()
                      and tablename = ${row.tableName}
                      and policyname = 'petrichor_runtime_access'
                ) as exists
            `
            if (!policy?.exists) {
                await transaction.unsafe(`
                    create policy petrichor_runtime_access on ${table}
                    for all to petrichor_runtime
                    using (true) with check (true)
                `)
            }
        }

        const sequences = await transaction<TableNameRow[]>`
            select sequence_name as "tableName"
            from information_schema.sequences
            where sequence_schema = current_schema()
              and sequence_name ~ '^petrichor_'
            order by sequence_name
        `
        for (const row of sequences) {
            const sequence = quoteIdentifier(row.tableName)
            await transaction.unsafe(`revoke all on sequence ${sequence} from public, anon, authenticated, service_role`)
            await transaction.unsafe(`grant usage, select, update on sequence ${sequence} to petrichor_runtime`)
        }

        console.log(`[db:${bootstrap ? "bootstrap" : "migrate"}] 完成，新执行 ${appliedCount} 个迁移`)
    })
} finally {
    await client.end()
}
