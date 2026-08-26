import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"

const SQLITE_RUNTIME_KEY = "__PETRICHOR_BUNDLED_SQLITE_RUNTIME__"

export function installBundledSqliteRuntime() {
    (globalThis as Record<string, unknown>)[SQLITE_RUNTIME_KEY] = {
        Database,
        drizzleSqlite: drizzle,
    }
}
