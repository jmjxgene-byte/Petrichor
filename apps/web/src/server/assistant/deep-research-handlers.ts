import { createHash } from "node:crypto"
import { and, eq, isNull } from "drizzle-orm"
import { z } from "zod"

import { getServerConfig } from "@/config/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb } from "@/server/db/client"
import { assistantMessages, assistantThreads } from "@/server/db/schema"
import { forbidden, notFound, ok, readJson, toErrorResponse } from "@/server/http/response"
import type { AppRequest } from "@/server/http/request"
import { assistantFocusSchema, assistantIdSchema } from "./thread-logic"
import { resolveAssistantSources } from "./source-catalog"
import { buildDeepResearchCapabilitySnapshot, buildDeepResearchSourceScopeHash } from "./deep-research-contract"
import {
    createDeepResearchJob,
    getDeepResearchJob,
    requestDeepResearchJobCancellation,
    toDeepResearchJobResponse,
} from "./deep-research-job-store"

const startSchema = z.object({
    threadId: assistantIdSchema,
    questionMessageId: assistantIdSchema,
    fastRunKey: z.string().trim().min(1).max(64).optional().nullable(),
})

const runSchema = z.object({
    runKey: z.string().trim().min(1).max(64),
})

export async function startDeepResearch(request: AppRequest) {
    try {
        const config = getServerConfig()
        if (!config.deepResearch.enabled || !config.deepResearch.workerEnabled) {
            throw forbidden("深度检索 Worker 尚未启用")
        }
        const user = await requireCurrentUser(request)
        const input = startSchema.parse(await readJson(request))
        const db = getDb()
        const [thread] = await db.select().from(assistantThreads).where(and(
            eq(assistantThreads.id, input.threadId),
            eq(assistantThreads.userId, user.id),
            isNull(assistantThreads.deletedAt),
        )).limit(1)
        if (!thread) throw notFound("Assistant 会话不存在")
        const [question] = await db.select().from(assistantMessages).where(and(
            eq(assistantMessages.id, input.questionMessageId),
            eq(assistantMessages.threadId, thread.id),
            eq(assistantMessages.role, "user"),
        )).limit(1)
        if (!question) throw notFound("用户问题消息不存在")

        const focus = parseFocus(thread.focusJson)
        const sources = await resolveAssistantSources(user.id, focus)
        if (sources.selected.length === 0) throw forbidden("所选资料源当前不可用")
        const sourceScopeHash = buildDeepResearchSourceScopeHash(focus)
        const capabilitySnapshot = buildDeepResearchCapabilitySnapshot(
            sources.selected,
            config.deepResearch,
        )
        const contractForKey = { ...capabilitySnapshot, capturedAt: undefined }
        const idempotencyKey = sha256(JSON.stringify({
            threadId: thread.id,
            questionMessageId: question.id,
            fastRunKey: input.fastRunKey ?? null,
            sourceScopeHash,
            capabilitySnapshot: contractForKey,
        }))
        const job = await createDeepResearchJob({
            runKey: `deep_${idempotencyKey.slice(0, 32)}`,
            idempotencyKey,
            threadId: thread.id,
            userId: user.id,
            questionMessageId: question.id,
            fastRunKey: input.fastRunKey ?? null,
            sourceScopeHash,
            capabilitySnapshot,
        })
        return ok(toDeepResearchJobResponse(job))
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

export async function deepResearchStatus(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = runSchema.parse(await readJson(request))
        const job = await getDeepResearchJob(input.runKey, user.id)
        if (!job) throw notFound("深度检索任务不存在")
        return ok(toDeepResearchJobResponse(job))
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

export async function cancelDeepResearch(request: AppRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = runSchema.parse(await readJson(request))
        const job = await requestDeepResearchJobCancellation(input.runKey, user.id)
        if (!job) throw notFound("深度检索任务不存在")
        return ok(toDeepResearchJobResponse(job))
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

function parseFocus(value: string | null) {
    if (!value) return null
    try {
        const parsed = assistantFocusSchema.safeParse(JSON.parse(value))
        return parsed.success ? parsed.data : null
    } catch {
        return null
    }
}

function sha256(value: string) {
    return createHash("sha256").update(value).digest("hex")
}
