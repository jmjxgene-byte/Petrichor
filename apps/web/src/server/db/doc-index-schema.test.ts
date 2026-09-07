import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { DOC_INDEX_SCHEMA_SQL } from "./doc-index-schema"
import { buildInitialMigrationSql } from "./full-migration"
import { splitSqlStatements } from "./migration-utils"
import { buildSqliteMigrationSql } from "./sqlite-migration"
import { getTableColumns } from "drizzle-orm"
import { docIndexGenerations, docPassages, docIndexJobs } from "./schema"

describe("派生索引迁移契约", () => {
    it("初始化、增量迁移使用相同DDL，无DROP或原文覆盖", () => {
        const migration = readFileSync(resolve(process.cwd(), "../../docs/migrations/2026-09-08-document-retrieval-index.sql"), "utf8")
        expect(migration.trim()).toBe(DOC_INDEX_SCHEMA_SQL.trim())
        expect(buildInitialMigrationSql()).toContain(DOC_INDEX_SCHEMA_SQL.trim())
        expect(migration).not.toMatch(/\b(drop|truncate|update|delete from)\b/i)
        expect(splitSqlStatements(migration).length).toBeGreaterThan(8)
    })
    it("ORM所声明列均存在于DDL，向量列仅属于PG", () => {
        for (const table of [docIndexGenerations, docPassages, docIndexJobs]) {
            for (const column of Object.values(getTableColumns(table))) expect(DOC_INDEX_SCHEMA_SQL).toContain(column.name)
        }
        expect(DOC_INDEX_SCHEMA_SQL).toContain("add column if not exists embedding vector")
        const sqlite = buildSqliteMigrationSql()
        expect(sqlite).toContain("create table if not exists petrichor_doc_passage")
        expect(sqlite).not.toContain("add column if not exists embedding vector")
    })
    it("复合外键、current唯一、状态与预算约束不可省略", () => {
        expect(DOC_INDEX_SCHEMA_SQL).toContain("foreign key (generation_id, user_id, library_id)")
        expect(DOC_INDEX_SCHEMA_SQL).toContain("foreign key (document_id, user_id, library_id)")
        expect(DOC_INDEX_SCHEMA_SQL).toContain("where is_current = true")
        expect(DOC_INDEX_SCHEMA_SQL).toContain("check (not is_current or (status = 'ready' and completed_documents = expected_documents))")
        expect(DOC_INDEX_SCHEMA_SQL).toContain("consumed_cost_microusd >= 0")
        expect(DOC_INDEX_SCHEMA_SQL).toContain("unique (user_id, idempotency_key)")
    })
    it("迁移runner继续对新表启用RLS并撤销公开角色，不授予runtime DDL", () => {
        const runner = readFileSync(resolve(process.cwd(), "scripts/migrate-database.ts"), "utf8")
        expect(runner).toContain("enable row level security")
        expect(runner).toContain("from public, anon, authenticated, service_role")
        expect(runner).toContain("grant select, insert, update, delete on table")
        expect(runner).toContain("petrichor_migrator")
    })
})
