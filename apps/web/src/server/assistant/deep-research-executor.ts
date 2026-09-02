import { and, eq } from "drizzle-orm"

import { callChatCompletion, type ChatCompletionResult } from "@/server/ai/generation"
import { getDb } from "@/server/db/client"
import { agentRuns, assistantMessages, assistantThreads, deepResearchJobs, users } from "@/server/db/schema"
import { sourceTools } from "./agent-runtime/tools/sources"
import type { AgentState, ToolExecutionContext, ToolNormalizerResult } from "./agent-runtime/types"
import {
    acknowledgeDeepResearchJobCancellation,
    completeDeepResearchJob,
    deepResearchCapabilitySnapshotSchema,
    failDeepResearchJob,
    getDeepResearchJob,
    heartbeatDeepResearchJob,
    type DeepResearchErrorCode,
} from "./deep-research-job-store"
import { createAgentRunRecord, persistEvidence } from "./agent-runtime/store"
import { assistantFocusSchema } from "./thread-logic"
import { buildDeepResearchSourceScopeHash } from "./deep-research-contract"
import { DEEP_RESEARCH_MODEL_OUTPUT_LIMITS } from "./deep-research-limits"
import {
    estimateDeepResearchCost,
    fetchDeepResearchPricingSnapshot,
    type DeepResearchPricingSnapshot,
} from "./deep-research-pricing"
import {
    buildDeepResearchReferenceKey,
    normalizeDeepResearchAnswer,
    normalizeDeepResearchUrl,
    toDeepResearchReferences,
    toMetadataOnlyAgentEvidence,
} from "./deep-research-output"
import {
    DeepResearchExecutionError,
    runDeepResearchPipeline,
    type DeepResearchCandidate,
    type DeepResearchEvidence,
    type SearchMode,
} from "./deep-research-pipeline"

const DEADLINE_MS = 180_000
const MAX_PLANNED_QUERIES = 5

export async function executeDeepResearchJob(jobId: number, workerId: string) {
    const db = getDb()
    const [job] = await db.select().from(deepResearchJobs).where(and(
        eq(deepResearchJobs.id, jobId),
        eq(deepResearchJobs.status, "running"),
        eq(deepResearchJobs.leaseOwner, workerId),
    )).limit(1)
    if (!job) return null
    const [thread, questionRow, user] = await Promise.all([
        db.select().from(assistantThreads).where(and(
            eq(assistantThreads.id, job.threadId),
            eq(assistantThreads.userId, job.userId),
        )).limit(1).then((rows) => rows[0] ?? null),
        db.select().from(assistantMessages).where(and(
            eq(assistantMessages.id, job.questionMessageId),
            eq(assistantMessages.threadId, job.threadId),
            eq(assistantMessages.role, "user"),
        )).limit(1).then((rows) => rows[0] ?? null),
        db.select({ systemRole: users.systemRole }).from(users)
            .where(eq(users.id, job.userId)).limit(1).then((rows) => rows[0] ?? null),
    ])
    if (!thread || !questionRow || !user) {
        return await failDeepResearchJob({ jobId, workerId, errorCode: "validation_failed" })
    }
    const question = extractQuestion(questionRow.contentJson)
    if (!question) return await failDeepResearchJob({ jobId, workerId, errorCode: "validation_failed" })
    const focus = parseFocus(thread.focusJson)
    if (buildDeepResearchSourceScopeHash(focus) !== job.sourceScopeHash) {
        return await failDeepResearchJob({ jobId, workerId, errorCode: "validation_failed" })
    }
    const snapshot = deepResearchCapabilitySnapshotSchema.parse(JSON.parse(job.capabilitySnapshotJson))
    if (snapshot.qualityStale || snapshot.allowedModes.includes("hybrid")) {
        return await failDeepResearchJob({ jobId, workerId, errorCode: "validation_failed" })
    }
    const modes = snapshot.allowedModes.filter((mode): mode is SearchMode => mode === "exact" || mode === "fuzzy")
    const controller = new AbortController()
    let leaseLost = false
    const deadline = setTimeout(() => controller.abort(), DEADLINE_MS)
    const heartbeat = setInterval(() => {
        void heartbeatDeepResearchJob({ jobId, workerId }).then((value) => {
            if (!value) {
                leaseLost = true
                controller.abort()
            }
        }).catch(() => {
            leaseLost = true
            controller.abort()
        })
    }, 20_000)

    const toolContext = createToolContext({
        job,
        question,
        focus,
        systemRole: user.systemRole,
        abortSignal: controller.signal,
    })
    const searchTool = sourceTools.find((item) => item.id === "source.search")!
    const readTool = sourceTools.find((item) => item.id === "source.read")!
    let modelName = "unresolved"
    let inputTokens = 0
    let outputTokens = 0
    let modelCallsStarted = 0
    let plannerUsage: ChatCompletionResult["usage"] | null = null
    let synthesisUsage: ChatCompletionResult["usage"] | null = null
    let pricingSnapshot: DeepResearchPricingSnapshot | null = null
    const startedAt = Date.now()
    try {
        await createAgentRunRecord({
            runKey: job.runKey,
            conversationId: String(job.threadId),
            threadId: job.threadId,
            userId: job.userId,
            model: modelName,
            goal: `[deep-research-message:${job.questionMessageId}]`,
            complexity: "complex",
            retryOfRunKey: job.fastRunKey,
        })
        modelCallsStarted += 1
        const planner = await callModelOrThrow({
            userId: job.userId,
            maxOutputTokens: DEEP_RESEARCH_MODEL_OUTPUT_LIMITS.planner,
            maxRetries: DEEP_RESEARCH_MODEL_OUTPUT_LIMITS.maxRetriesPerCall,
            systemPrompt: [
                "把用户问题拆成最多 5 个互补检索式。",
                "只改写或拆分用户已经表达的意图，不得补入用户未提到的数字、站点、绩效状态或个案条件。",
                "短缩写问题优先覆盖定义、组成与口径差异，不要擅自扩展成故障处置案例。",
                "只输出 JSON 字符串数组，不要解释，不要包含敏感信息。",
            ].join("\n"),
            message: question,
            signal: controller.signal,
        })
        modelName = planner.modelName
        plannerUsage = planner.usage
        inputTokens += planner.usage.inputTokens
        outputTokens += planner.usage.outputTokens
        await db.update(agentRuns).set({ model: modelName }).where(eq(agentRuns.runKey, job.runKey))
        pricingSnapshot = await fetchDeepResearchPricingSnapshot({
            providerKey: planner.resolved.provider.providerKey,
            baseUrl: planner.resolved.provider.baseUrl,
            modelId: planner.modelName,
        })

        const result = await runDeepResearchPipeline({ question, modes, signal: controller.signal }, {
            planQueries: async () => parseQueryPlan(planner.answer),
            search: async (query, mode) => {
                const output = await searchTool.execute(toolContext, {
                    query,
                    limit: 20,
                    geneOpsMode: mode,
                }) as { candidates?: DeepResearchCandidate[] }
                return output.candidates ?? []
            },
            read: async (candidate) => {
                const output = await readTool.execute(toolContext, candidate.read)
                const normalized = readTool.normalize?.(output, candidate.read) as ToolNormalizerResult | undefined
                return (normalized?.evidence ?? []).flatMap((item): DeepResearchEvidence[] => {
                    if (!item.content?.trim()) return []
                    const metadata = item.metadata ?? {}
                    const url = normalizeDeepResearchUrl(item.url ?? candidate.url)
                    const title = item.title ?? candidate.title
                    return [{
                        referenceKey: buildDeepResearchReferenceKey({
                            source: item.source,
                            title,
                            url,
                            fallbackKey: candidate.candidateKey,
                        }),
                        title,
                        content: item.content,
                        source: item.source,
                        url,
                        queriedAt: typeof metadata.queriedAt === "string"
                            ? metadata.queriedAt
                            : new Date().toISOString(),
                        ...(typeof metadata.sourceName === "string"
                            ? { sourceName: metadata.sourceName }
                            : {}),
                    }]
                })
            },
            synthesize: async (goal, evidence, signal) => {
                modelCallsStarted += 1
                const completion = await callModelOrThrow({
                    userId: job.userId,
                    maxOutputTokens: DEEP_RESEARCH_MODEL_OUTPUT_LIMITS.synthesis,
                    maxRetries: DEEP_RESEARCH_MODEL_OUTPUT_LIMITS.maxRetriesPerCall,
                    systemPrompt: [
                        "你负责生成中文深度检索补充，但不要输出标题，系统会统一添加标题。",
                        "只使用下方当前运行证据；冲突时说明差异与时间，不得编造。",
                        "只回答用户实际问题，不得把证据里的个案条件、数字或背景当成用户自身情况。",
                        "问题很短时先给简洁定义；证据案例只能明确标为案例，不得喧宾夺主。",
                        `正文只能用 [1] 到 [${evidence.length}] 引用下方同编号来源，不得引用范围外编号。`,
                    ].join("\n"),
                    message: renderSynthesisInput(goal, evidence),
                    signal,
                })
                modelName = completion.modelName
                synthesisUsage = completion.usage
                inputTokens += completion.usage.inputTokens
                outputTokens += completion.usage.outputTokens
                return normalizeDeepResearchAnswer(completion.answer)
            },
        })
        const answer = normalizeDeepResearchAnswer(result.answer)
        if (!answer) throw new DeepResearchExecutionError("validation_failed", "深度综合没有生成正文")
        const references = toDeepResearchReferences(result.evidence)
        await persistEvidence(job.runKey, toMetadataOnlyAgentEvidence(result.evidence))
        const completed = await completeDeepResearchJob({
            jobId,
            workerId,
            message: {
                parts: [{ type: "text", text: `## 深度检索补充\n\n${answer}` }],
                agentRunId: job.runKey,
                deepResearch: { runKey: job.runKey, fastRunKey: job.fastRunKey, references },
            },
        })
        if (!completed) throw new DeepResearchExecutionError("validation_failed", "任务租约已失效")
        await db.update(agentRuns).set({
            status: "completed",
            answer: answer.slice(0, 100_000),
            metricsJson: JSON.stringify({
                queryCount: result.queries.length,
                candidateCount: result.candidates.length,
                evidenceCount: result.evidence.length,
                rawEvidenceCount: result.rawEvidenceCount,
                modelCalls: {
                    started: modelCallsStarted,
                    completed: countCompletedModelCalls(plannerUsage, synthesisUsage),
                    planner: plannerUsage,
                    synthesis: synthesisUsage,
                },
                pricingSnapshot,
                costEstimate: pricingSnapshot == null ? null : estimateDeepResearchCost({
                    snapshot: pricingSnapshot,
                    inputTokens,
                    outputTokens,
                    modelCalls: modelCallsStarted,
                }),
            }),
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            durationMs: Date.now() - startedAt,
            completedAt: new Date(),
        }).where(eq(agentRuns.runKey, job.runKey))
        return completed.job
    } catch (error) {
        const current = await getDeepResearchJob(job.runKey, job.userId)
        if (current?.status === "cancel_requested") {
            return await acknowledgeDeepResearchJobCancellation({ jobId, workerId })
        }
        const code = classifyExecutionError(error, { leaseLost, aborted: controller.signal.aborted })
        await db.update(agentRuns).set({
            status: "failed",
            stopReason: code,
            metricsJson: JSON.stringify({
                modelCalls: {
                    started: modelCallsStarted,
                    completed: countCompletedModelCalls(plannerUsage, synthesisUsage),
                    planner: plannerUsage,
                    synthesis: synthesisUsage,
                },
                pricingSnapshot,
                costEstimate: pricingSnapshot == null ? null : estimateDeepResearchCost({
                    snapshot: pricingSnapshot,
                    inputTokens,
                    outputTokens,
                    modelCalls: modelCallsStarted,
                }),
            }),
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            durationMs: Date.now() - startedAt,
            completedAt: new Date(),
        }).where(eq(agentRuns.runKey, job.runKey))
        return await failDeepResearchJob({ jobId, workerId, errorCode: code })
    } finally {
        clearTimeout(deadline)
        clearInterval(heartbeat)
    }
}

function countCompletedModelCalls(...usage: Array<ChatCompletionResult["usage"] | null>) {
    return usage.filter((item) => item != null).length
}

function createToolContext(input: {
    job: typeof deepResearchJobs.$inferSelect
    question: string
    focus: unknown
    systemRole: string
    abortSignal: AbortSignal
}): ToolExecutionContext {
    const now = Date.now()
    const state: AgentState = {
        runId: input.job.runKey,
        conversationId: String(input.job.threadId),
        userId: String(input.job.userId),
        goal: input.question,
        complexity: "complex",
        plan: [],
        completedSteps: [],
        pendingSteps: [],
        loadedSkills: [],
        observations: [],
        evidence: [],
        openQuestions: [],
        assumptions: [],
        toolCallCount: 0,
        delegationCount: 0,
        iteration: 1,
        tokenUsage: { input: 0, output: 0, total: 0 },
        startedAt: now,
        updatedAt: now,
        status: "running",
    }
    return {
        runId: input.job.runKey,
        userId: input.job.userId,
        conversationId: String(input.job.threadId),
        threadId: input.job.threadId,
        focus: input.focus,
        systemRole: input.systemRole,
        delegationDepth: 0,
        state,
        abortSignal: input.abortSignal,
    }
}

function extractQuestion(value: string | null) {
    if (!value) return ""
    try {
        const parsed = JSON.parse(value) as { content?: unknown; parts?: unknown }
        if (typeof parsed.content === "string") return parsed.content.trim()
        if (!Array.isArray(parsed.parts)) return ""
        return parsed.parts.flatMap((part) => (
            part && typeof part === "object" && (part as { type?: unknown }).type === "text"
                && typeof (part as { text?: unknown }).text === "string"
                ? [(part as { text: string }).text]
                : []
        )).join("\n").trim()
    } catch {
        return ""
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

function parseQueryPlan(value: string) {
    const start = value.indexOf("[")
    const end = value.lastIndexOf("]")
    if (start < 0 || end <= start) throw new DeepResearchExecutionError("validation_failed", "检索计划格式错误")
    let parsed: unknown
    try {
        parsed = JSON.parse(value.slice(start, end + 1)) as unknown
    } catch {
        throw new DeepResearchExecutionError("validation_failed", "检索计划 JSON 无效")
    }
    if (!Array.isArray(parsed)) throw new DeepResearchExecutionError("validation_failed", "检索计划不是数组")
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim().slice(0, 400))
        .slice(0, MAX_PLANNED_QUERIES)
}

async function callModelOrThrow(input: Parameters<typeof callChatCompletion>[0]) {
    try {
        return await callChatCompletion(input)
    } catch {
        throw new DeepResearchExecutionError("model_failed", "深度检索模型调用失败")
    }
}

function renderSynthesisInput(question: string, evidence: DeepResearchEvidence[]) {
    const blocks = evidence.map((item, index) => [
        `[${index + 1}] ${item.title}`,
        `来源：${item.source}`,
        item.url ? `链接：${item.url}` : "",
        `查询时间：${item.queriedAt}`,
        item.content,
    ].filter(Boolean).join("\n"))
    return `问题：\n${question}\n\n当前运行证据：\n\n${blocks.join("\n\n")}`
}

function classifyExecutionError(error: unknown, input: { leaseLost: boolean; aborted: boolean }): DeepResearchErrorCode {
    if (input.leaseLost) return "lease_expired"
    if (input.aborted) return "timeout"
    if (error instanceof DeepResearchExecutionError) return error.code
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
    if (message.includes("connect") || message.includes("network")) return "connection_failed"
    if (message.includes("model") || message.includes("generation")) return "model_failed"
    return "internal_error"
}
