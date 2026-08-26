import { eq } from "drizzle-orm"
import type { AppRequest } from "@/server/http/request"
import { getServerConfig } from "@/config/server"
import { requireCurrentUser } from "@/server/auth/current-user"
import { getDb } from "@/server/db/client"
import { externalSources } from "@/server/db/schema"
import { badRequest, ok, readJson, toErrorResponse, unauthorized } from "@/server/http/response"
import {
    assertSuperAdmin,
    encodeConnection,
    getExternalSource,
    listExternalSources,
    parseSourceId,
    sourceCreateSchema,
    sourceUpdateSchema,
    testSourceConnection,
    toSourceResponse,
    updateSourceCheck,
} from "./logic"

type User = Awaited<ReturnType<typeof requireCurrentUser>>

async function withUser(request: AppRequest, handler: (user: User) => Promise<Response>) {
    try {
        return await handler(await requireCurrentUser(request))
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}

export async function listSources(request: AppRequest) {
    return withUser(request, async (user) => {
        const isAdmin = user.systemRole === "SUPER_ADMIN" || user.id === 1
        const sources = await listExternalSources()
        return ok({
            featureEnabled: getServerConfig().geneOpsConnector.enabled,
            items: sources.map((source) => toSourceResponse(source, { isAdmin })),
        })
    })
}

export async function createSource(request: AppRequest) {
    return withUser(request, async (user) => {
        assertSuperAdmin(user)
        const input = sourceCreateSchema.parse(await readJson(request))
        const [created] = await getDb().insert(externalSources).values({
            createdByUserId: user.id,
            name: input.name,
            sourceType: "GENEOPS_SUPABASE",
            enabled: false,
            globalShared: true,
            connectionEnc: encodeConnection(input.password),
        }).returning()
        return ok(toSourceResponse(created!, { isAdmin: true }))
    })
}

export async function updateSource(request: AppRequest) {
    return withUser(request, async (user) => {
        assertSuperAdmin(user)
        const input = sourceUpdateSchema.parse(await readJson(request))
        const existing = await getExternalSource(input.id)
        if (input.enabled === true) {
            if (!getServerConfig().geneOpsConnector.enabled) {
                throw badRequest("生产功能开关尚未开启")
            }
            if (existing.lastCheckStatus !== "OK" || existing.contractVersion !== 1) {
                throw badRequest("请先通过连接测试再启用")
            }
        }
        const [updated] = await getDb().update(externalSources).set({
            ...(input.name ? { name: input.name } : {}),
            ...(input.password ? {
                connectionEnc: encodeConnection(input.password),
                lastCheckStatus: null,
                lastCheckMessage: null,
                contractVersion: null,
                capabilitiesJson: null,
                enabled: false,
            } : {}),
            ...(input.enabled != null ? { enabled: input.enabled } : {}),
            updatedAt: new Date(),
        }).where(eq(externalSources.id, input.id)).returning()
        return ok(toSourceResponse(updated!, { isAdmin: true }))
    })
}

export async function testSource(request: AppRequest) {
    return withUser(request, async (user) => {
        assertSuperAdmin(user)
        const input = await readJson<Record<string, unknown>>(request)
        const source = await getExternalSource(parseSourceId(input.id))
        try {
            const result = await testSourceConnection(source)
            const capabilities = result.capability as Record<string, unknown>
            await updateSourceCheck(source.id, {
                status: "OK",
                message: "连接、只读权限与 RPC contract 验证通过",
                capabilities,
                contractVersion: result.contractVersion,
            })
            return ok({ status: "OK", message: "连接验证通过", capabilities })
        } catch (error) {
            const message = error instanceof Error ? error.message : "连接验证失败"
            await updateSourceCheck(source.id, { status: "ERROR", message })
            throw badRequest(message)
        }
    })
}

export async function deleteSource(request: AppRequest) {
    return withUser(request, async (user) => {
        assertSuperAdmin(user)
        const input = await readJson<Record<string, unknown>>(request)
        const id = parseSourceId(input.id)
        const source = await getExternalSource(id)
        if (source.enabled) throw badRequest("请先停用数据源再删除")
        await getDb().delete(externalSources).where(eq(externalSources.id, id))
        return new Response(null, { status: 200 })
    })
}

export async function cronRefreshSources(request: AppRequest) {
    try {
        const secret = getServerConfig().geneOpsConnector.cronSecret
        if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) throw unauthorized()
        const sources = await listExternalSources()
        let okCount = 0
        let errorCount = 0
        for (const source of sources) {
            try {
                const result = await testSourceConnection(source)
                await updateSourceCheck(source.id, {
                    status: "OK",
                    message: "每日连接与 RPC contract 检查通过",
                    capabilities: result.capability as Record<string, unknown>,
                    contractVersion: result.contractVersion,
                })
                okCount += 1
            } catch (error) {
                await updateSourceCheck(source.id, {
                    status: "ERROR",
                    message: error instanceof Error ? error.message : "每日检查失败",
                })
                errorCount += 1
            }
        }
        return ok({ checked: sources.length, ok: okCount, errors: errorCount })
    } catch (error) {
        return toErrorResponse(error, request.urlObject.pathname)
    }
}
