import type { AppRequest } from "@/server/http/request"
import { authenticateAgentRequest, requireAgentScope } from "@/server/agent/api-key"
import {
    expandGeneOpsGraph,
    getGeneOpsBacklinks,
    readGeneOpsChunks,
    searchGeneOps,
    searchGeneOpsGraph,
} from "@/server/external-source/geneops-query"
import { listAssistantSourceCatalog } from "@/server/assistant/source-catalog"
import { ok, readJson, toErrorResponse } from "@/server/http/response"
import { getDb } from "@/server/db/client"
import { agentCallLogs } from "@/server/db/schema"

async function withExternalRead(
    request: AppRequest,
    handler: (userId: number, input: unknown) => Promise<unknown>,
) {
    const startedAt = Date.now()
    let context: Awaited<ReturnType<typeof authenticateAgentRequest>> | null = null
    let response: Response
    let failure: unknown = null
    try {
        context = await authenticateAgentRequest(request)
        requireAgentScope(context, "external:read")
        const input = await readJson(request)
        response = ok(await handler(context.userId, input))
    } catch (error) {
        failure = error
        response = toErrorResponse(error, request.urlObject.pathname)
    }
    if (context) {
        await getDb().insert(agentCallLogs).values({
            userId: context.userId,
            apiKeyId: context.apiKey.id,
            apiKeyPrefix: context.apiKey.keyPrefix,
            method: request.method,
            path: request.urlObject.pathname,
            ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
            userAgent: request.headers.get("user-agent")?.slice(0, 1_000) ?? null,
            requestJson: JSON.stringify({ redacted: true, reason: "external-source-metadata-only" }),
            responseJson: JSON.stringify({ redacted: true, reason: "external-source-metadata-only" }),
            statusCode: response.status,
            durationMs: Date.now() - startedAt,
            errorMessage: failure instanceof Error ? failure.message.slice(0, 1_000) : null,
        }).catch(() => undefined)
    }
    return response
}

export async function agentListExternalSources(request: AppRequest) {
    return withExternalRead(request, async (userId) => ({
        items: (await listAssistantSourceCatalog(userId))
            .filter((item) => item.kind === "external-source")
            .map((item) => ({
                ref: item.ref,
                id: item.id,
                name: item.name,
                availability: item.availability,
                capabilities: item.capabilities,
                updatedAt: item.updatedAt,
            })),
    }))
}

export async function agentSearchGeneOps(request: AppRequest) {
    return withExternalRead(request, async (userId, input) => await searchGeneOps({ userId }, input))
}

export async function agentReadGeneOps(request: AppRequest) {
    return withExternalRead(request, async (userId, input) => await readGeneOpsChunks({ userId }, input))
}

export async function agentSearchGeneOpsGraph(request: AppRequest) {
    return withExternalRead(request, async (userId, input) => await searchGeneOpsGraph({ userId }, input))
}

export async function agentExpandGeneOpsGraph(request: AppRequest) {
    return withExternalRead(request, async (userId, input) => await expandGeneOpsGraph({ userId }, input))
}

export async function agentGetGeneOpsBacklinks(request: AppRequest) {
    return withExternalRead(request, async (userId, input) => await getGeneOpsBacklinks({ userId }, input))
}
