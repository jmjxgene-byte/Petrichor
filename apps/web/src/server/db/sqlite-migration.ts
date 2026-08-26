import { buildInitialMigrationSql } from "@/server/db/full-migration"
import type { Database as BunSqliteDatabase } from "bun:sqlite"

function toSingleQuotedSql(value: string) {
    return `'${value.replace(/'/g, "''")}'`
}

function replaceDollarQuotedStrings(sql: string) {
    return sql.replace(/\$([a-zA-Z0-9_]+)\$([\s\S]*?)\$\1\$/g, (_match, _tag, body: string) =>
        toSingleQuotedSql(body))
}

function splitStatements(sql: string) {
    return sql
        .split(/;\s*\n/g)
        .map((statement) => statement.trim())
        .filter(Boolean)
}

function shouldSkipStatement(statement: string) {
    const normalized = statement.trimStart().toLowerCase()
    return (
        normalized.includes("create extension") ||
        normalized.includes("alter table") ||
        normalized.startsWith("update ") ||
        normalized.startsWith("insert into better_auth_user") ||
        normalized.startsWith("insert into better_auth_account") ||
        normalized.includes(" using gin ") ||
        normalized.includes(" using hnsw ") ||
        normalized.includes(" using ivfflat ") ||
        normalized.includes(" vector(") ||
        normalized.includes("embedding vector") ||
        normalized.includes("petrichor_assistant_message_embedding")
    )
}

function convertStatement(statement: string) {
    return replaceDollarQuotedStrings(statement)
        .replace(
            /(\s+original_author_name text,\n)(\s+revoked_at timestamptz,)/i,
            "$1    internal_url text,\n    pin_order integer,\n$2",
        )
        .replace(/\bbigint generated always as identity primary key\b/gi, "integer primary key autoincrement")
        .replace(/\bbigint\b/gi, "integer")
        .replace(/\btimestamptz\b/gi, "integer")
        .replace(/\bboolean\b/gi, "integer")
        .replace(/\bdefault now\(\)/gi, "default (unixepoch() * 1000)")
        .replace(/\bdefault true\b/gi, "default 1")
        .replace(/\bdefault false\b/gi, "default 0")
        .replace(/\bvalues \(1, true\)/gi, "values (1, 1)")
        .replace(/\bwhere is_default = true\b/gi, "where is_default = 1")
}

export function buildSqliteMigrationSql() {
    const statements = splitStatements(buildInitialMigrationSql())
        .filter((statement) => !shouldSkipStatement(statement))
        .map(convertStatement)

    return [
        "pragma foreign_keys = on",
        ...statements,
    ].join(";\n\n")
}

function ensureSqliteColumn(
    client: Pick<BunSqliteDatabase, "exec" | "query">,
    table: string,
    column: string,
    definition: string,
) {
    const columns = client.query(`pragma table_info(${table})`).all() as Array<{ name: string }>
    if (!columns.some((item) => item.name === column)) {
        client.exec(`alter table ${table} add column ${column} ${definition}`)
    }
}

export function runSqliteMigration(client: Pick<BunSqliteDatabase, "exec" | "query">) {
    client.exec(buildSqliteMigrationSql())
    // 兼容在 internal_url / pin_order 引入前已经创建的本地 SQLite 文件。
    ensureSqliteColumn(client, "petrichor_kb_article_share", "internal_url", "text")
    ensureSqliteColumn(client, "petrichor_kb_article_share", "pin_order", "integer")
}
