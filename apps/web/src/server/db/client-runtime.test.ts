import { describe, expect, it } from "vitest"

import { loadSqliteDeps } from "./client"

const SQLITE_RUNTIME_KEY = "__PETRICHOR_BUNDLED_SQLITE_RUNTIME__"

describe("Vercel bundled SQLite runtime", () => {
    it("prefers the Bun entrypoint runtime over package-name require", () => {
        const globals = globalThis as Record<string, unknown>
        const previous = globals[SQLITE_RUNTIME_KEY]
        const bundled = {
            Database: class PreviewDatabase {},
            drizzleSqlite: () => "preview-db",
        }
        globals[SQLITE_RUNTIME_KEY] = bundled
        try {
            expect(loadSqliteDeps()).toBe(bundled)
        } finally {
            if (previous === undefined) delete globals[SQLITE_RUNTIME_KEY]
            else globals[SQLITE_RUNTIME_KEY] = previous
        }
    })
})
