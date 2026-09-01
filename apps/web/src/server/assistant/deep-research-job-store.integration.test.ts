import { createRequire } from "node:module"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import type { DeepResearchCapabilitySnapshot } from "./deep-research-job-store"

const require = createRequire(import.meta.url)
const hasSqlite = (() => {
    try {
        require("bun:sqlite")
        return true
    } catch {
        return false
    }
})()

let dbModule: typeof import("@/server/db/client")
let schema: typeof import("@/server/db/schema")
let store: typeof import("./deep-research-job-store")

describe.runIf(hasSqlite)("deep research job store", () => {
    beforeAll(async () => {
        process.env.PETRICHOR_DB_DIALECT = "sqlite"
        process.env.DATABASE_URL = `file:/tmp/petrichor-deep-job-${process.pid}-${Date.now()}.sqlite`
        process.env.SESSION_SECRET = "01234567890123456789012345678901"
        process.env.PETRICHOR_ENCRYPT_KEY = "k".repeat(32)
        process.env.PETRICHOR_ENCRYPT_SALT = "0123456789abcdef"

        dbModule = await import("@/server/db/client")
        schema = await import("@/server/db/schema")
        store = await import("./deep-research-job-store")
    })

    async function createQuestion() {
        const db = dbModule.getDb()
        const [user] = await db.insert(schema.users).values({
            email: `deep-${Date.now()}@example.com`,
            passwordHash: "not-used",
        }).returning()
        const [thread] = await db.insert(schema.assistantThreads).values({
            userId: user.id,
            title: "深度检索测试",
        }).returning()
        const [message] = await db.insert(schema.assistantMessages).values({
            threadId: thread.id,
            role: "user",
            contentJson: JSON.stringify({ parts: [{ type: "text", text: "仅存在于消息表" }] }),
        }).returning()
        return { user, thread, message }
    }

    const capabilitySnapshot: DeepResearchCapabilitySnapshot = {
        contractVersion: 2,
        sourceCutoffs: { wearesellers: "2026-08-27T00:00:00.000Z" },
        allowedModes: ["exact", "fuzzy"],
        wikiReady: false,
        graphReady: false,
        qualityStale: false,
        capturedAt: "2026-09-01T00:00:00.000Z",
    }

    it("相同幂等键只创建一个 metadata-only job", async () => {
        const { user, thread, message } = await createQuestion()
        const input = {
            runKey: "deep_run_1",
            idempotencyKey: "idem_1",
            threadId: thread.id,
            userId: user.id,
            questionMessageId: message.id,
            fastRunKey: "fast_run_1",
            sourceScopeHash: "scope_hash_1",
            capabilitySnapshot,
        }
        const first = await store.createDeepResearchJob(input)
        const second = await store.createDeepResearchJob({ ...input, runKey: "ignored_duplicate_run" })

        expect(second.id).toBe(first.id)
        const rows = await dbModule.getDb().select().from(schema.deepResearchJobs)
        expect(rows).toHaveLength(1)
        expect(Object.keys(rows[0])).not.toEqual(expect.arrayContaining(["query", "chunk", "snippet", "resultJson"]))
        expect(rows[0].capabilitySnapshotJson).not.toContain("仅存在于消息表")
    })

    it("queued 任务直接取消，running 任务只请求取消", async () => {
        const queuedQuestion = await createQuestion()
        await store.createDeepResearchJob({
            runKey: "deep_run_cancel_queued",
            idempotencyKey: "idem_cancel_queued",
            threadId: queuedQuestion.thread.id,
            userId: queuedQuestion.user.id,
            questionMessageId: queuedQuestion.message.id,
            sourceScopeHash: "scope_hash_cancel_queued",
            capabilitySnapshot,
        })
        const queued = await store.requestDeepResearchJobCancellation(
            "deep_run_cancel_queued",
            queuedQuestion.user.id,
        )
        expect(queued?.status).toBe("cancelled")

        const { user, thread, message } = await createQuestion()
        const running = await store.createDeepResearchJob({
            runKey: "deep_run_2",
            idempotencyKey: "idem_2",
            threadId: thread.id,
            userId: user.id,
            questionMessageId: message.id,
            sourceScopeHash: "scope_hash_2",
            capabilitySnapshot,
        })
        await dbModule.getDb().update(schema.deepResearchJobs)
            .set({ status: "running", leaseOwner: "worker-1", leaseExpiresAt: new Date(Date.now() + 60_000) })
            .where(eq(schema.deepResearchJobs.id, running.id))

        const requested = await store.requestDeepResearchJobCancellation("deep_run_2", user.id)
        expect(requested?.status).toBe("cancel_requested")
        expect(requested?.cancelledAt).toBeInstanceOf(Date)
    })

    it("capability snapshot 严格拒绝未知字段", () => {
        expect(() => store.deepResearchCapabilitySnapshotSchema.parse({
            ...capabilitySnapshot,
            rawChunks: ["forbidden"],
        })).toThrow()
    })
})
