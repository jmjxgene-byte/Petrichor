import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"

export function ensureSqliteRuntimeBundled() {
    return { Database, drizzle }
}
