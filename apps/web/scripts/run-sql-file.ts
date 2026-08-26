import fs from "node:fs"
import path from "node:path"
import postgres from "postgres"
import { splitSqlStatements } from "../src/server/db/migration-utils"

const file = process.argv[2]
if (!file) {
    throw new Error("用法：bun scripts/run-sql-file.ts <path-to-sql>")
}
const url = process.env.MIGRATION_DATABASE_URL
if (!url) {
    throw new Error("MIGRATION_DATABASE_URL 未设置")
}

const raw = fs.readFileSync(path.resolve(file), "utf8")
const statements = splitSqlStatements(raw)

const sql = postgres(url, { max: 1, prepare: false })

try {
    console.log(`共 ${statements.length} 条语句\n`)
    for (const [index, statement] of statements.entries()) {
        const preview = statement.replace(/\s+/g, " ").slice(0, 100)
        process.stdout.write(`[${index + 1}/${statements.length}] ${preview}\n`)
        await sql.unsafe(statement)
        console.log("    ✓ ok")
    }
    console.log("\n迁移执行完毕")
} finally {
    await sql.end()
}
