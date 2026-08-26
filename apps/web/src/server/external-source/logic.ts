import { createHash } from "node:crypto"
import { and, desc, eq } from "drizzle-orm"
import postgres from "postgres"
import { z } from "zod"

import { getServerConfig } from "@/config/server"
import { isSuperAdmin } from "@/server/admin/logic"
import { encryptText, decryptText } from "@/server/crypto/spring-text-encryptor"
import { getDb } from "@/server/db/client"
import { externalQueryAudits, externalSources } from "@/server/db/schema"
import { badRequest, forbidden, notFound } from "@/server/http/response"

export const GENEOPS_PROJECT_REF = "snsvqlqwnpyzcftubeab"
export const GENEOPS_POOLER_HOST = "aws-0-ap-southeast-1.pooler.supabase.com"
export const GENEOPS_POOLER_PORT = 6543
export const GENEOPS_DATABASE = "postgres"
export const GENEOPS_READER_USERNAME = `petrichor_geneops_reader.${GENEOPS_PROJECT_REF}`
export const GENEOPS_CONTRACT_VERSION = 1

const connectionSchema = z.object({
    host: z.literal(GENEOPS_POOLER_HOST),
    port: z.literal(GENEOPS_POOLER_PORT),
    database: z.literal(GENEOPS_DATABASE),
    username: z.literal(GENEOPS_READER_USERNAME),
    password: z.string().min(20).max(256),
    ssl: z.literal(true),
})

export const sourceCreateSchema = z.object({
    name: z.string().trim().min(1).max(80),
    password: z.string().min(20).max(256),
})

export const sourceUpdateSchema = z.object({
    id: z.union([z.string(), z.number()]).transform((value) => Number(value)),
    name: z.string().trim().min(1).max(80).optional(),
    password: z.string().min(20).max(256).optional(),
    enabled: z.boolean().optional(),
})

export type GeneOpsConnection = z.infer<typeof connectionSchema>
export type ExternalSourceRecord = typeof externalSources.$inferSelect

export function assertSuperAdmin(user: { id: number; systemRole?: string | null }) {
    if (!isSuperAdmin(user.systemRole, user.id)) throw forbidden("仅超级管理员可以管理外部数据源")
}

export function encodeConnection(password: string) {
    const { key, salt } = getServerConfig().apiEncryption
    const value: GeneOpsConnection = {
        host: GENEOPS_POOLER_HOST,
        port: GENEOPS_POOLER_PORT,
        database: GENEOPS_DATABASE,
        username: GENEOPS_READER_USERNAME,
        password,
        ssl: true,
    }
    return encryptText(key, salt, JSON.stringify(value))
}

export function decodeConnection(value: string): GeneOpsConnection {
    const { key, salt } = getServerConfig().apiEncryption
    return connectionSchema.parse(JSON.parse(decryptText(key, salt, value)))
}

export function toSourceResponse(source: ExternalSourceRecord, options?: { isAdmin?: boolean }) {
    return {
        id: String(source.id),
        name: source.name,
        sourceType: source.sourceType,
        enabled: source.enabled,
        globalShared: source.globalShared,
        projectRef: GENEOPS_PROJECT_REF,
        region: "ap-southeast-1",
        host: options?.isAdmin ? GENEOPS_POOLER_HOST : null,
        port: options?.isAdmin ? GENEOPS_POOLER_PORT : null,
        username: options?.isAdmin ? GENEOPS_READER_USERNAME : null,
        configured: Boolean(source.connectionEnc),
        capabilities: parseJsonRecord(source.capabilitiesJson),
        contractVersion: source.contractVersion,
        lastCheckedAt: source.lastCheckedAt?.toISOString() ?? null,
        lastCheckStatus: source.lastCheckStatus,
        lastCheckMessage: source.lastCheckMessage,
        createdAt: source.createdAt.toISOString(),
        updatedAt: source.updatedAt.toISOString(),
    }
}

export async function listExternalSources() {
    return await getDb().select().from(externalSources).orderBy(desc(externalSources.updatedAt))
}

export async function getExternalSource(id: number) {
    const [source] = await getDb().select().from(externalSources).where(eq(externalSources.id, id)).limit(1)
    if (!source) throw notFound("外部数据源不存在")
    return source
}

export async function getActiveGeneOpsSource() {
    if (!getServerConfig().geneOpsConnector.enabled) throw new Error("GeneOps Connector 尚未启用")
    const [source] = await getDb()
        .select()
        .from(externalSources)
        .where(and(eq(externalSources.sourceType, "GENEOPS_SUPABASE"), eq(externalSources.enabled, true)))
        .orderBy(desc(externalSources.updatedAt))
        .limit(1)
    if (!source) throw new Error("GeneOps 数据源尚未配置或未启用")
    return source
}

export async function testSourceConnection(source: ExternalSourceRecord) {
    const connection = decodeConnection(source.connectionEnc)
    const client = createSourceClient(connection)
    try {
        const [identity] = await client<Array<{
            currentUser: string
            transactionReadOnly: string
            canSelectPublicDocuments: boolean
            canInsertPublicDocuments: boolean
        }>>`
            select
                current_user as "currentUser",
                current_setting('default_transaction_read_only') as "transactionReadOnly",
                has_table_privilege(current_user, 'public.source_documents', 'SELECT') as "canSelectPublicDocuments",
                has_table_privilege(current_user, 'public.source_documents', 'INSERT') as "canInsertPublicDocuments"
        `
        if (identity?.currentUser !== GENEOPS_READER_USERNAME) throw new Error("连接角色不正确")
        if (identity.transactionReadOnly !== "on") throw new Error("连接角色未强制只读事务")
        if (identity.canSelectPublicDocuments || identity.canInsertPublicDocuments) {
            throw new Error("连接角色拥有不允许的 public 表权限")
        }
        const [capability] = await client<Array<Record<string, unknown>>>`
            select * from knowledge_vault.capabilities_v1()
        `
        const contractVersion = Number(capability?.contract_version ?? capability?.contractVersion ?? 0)
        if (contractVersion !== GENEOPS_CONTRACT_VERSION) {
            throw new Error(`GeneOps RPC contract 不兼容：${contractVersion || "unknown"}`)
        }
        return { identity, capability, contractVersion }
    } finally {
        await client.end({ timeout: 5 })
    }
}

export async function updateSourceCheck(
    id: number,
    result: { status: "OK" | "ERROR"; message: string; capabilities?: Record<string, unknown>; contractVersion?: number },
) {
    await getDb().update(externalSources).set({
        capabilitiesJson: result.capabilities ? JSON.stringify(result.capabilities) : null,
        contractVersion: result.contractVersion ?? null,
        lastCheckedAt: new Date(),
        lastCheckStatus: result.status,
        lastCheckMessage: result.message.slice(0, 500),
        updatedAt: new Date(),
    }).where(eq(externalSources.id, id))
}

export async function executeGeneOpsRpc<T>(
    input: {
        userId: number
        threadId?: number
        runId?: number
        toolName: string
        queryType: string
        parameters: unknown
    },
    query: (client: ReturnType<typeof postgres>) => Promise<T>,
): Promise<T> {
    const source = await getActiveGeneOpsSource()
    const startedAt = Date.now()
    let status = "OK"
    let errorCode: string | null = null
    let resultCount = 0
    try {
        const client = createSourceClient(decodeConnection(source.connectionEnc))
        try {
            const result = await query(client)
            resultCount = Array.isArray(result) ? result.length : result == null ? 0 : 1
            return result
        } finally {
            await client.end({ timeout: 5 })
        }
    } catch (error) {
        status = "ERROR"
        errorCode = normalizeExternalErrorCode(error)
        throw new Error(externalUserMessage(errorCode))
    } finally {
        await getDb().insert(externalQueryAudits).values({
            userId: input.userId,
            threadId: input.threadId ?? null,
            runId: input.runId ?? null,
            sourceId: source.id,
            toolName: input.toolName,
            queryType: input.queryType,
            parameterHash: hashParameters(input.parameters),
            durationMs: Date.now() - startedAt,
            resultCount,
            status,
            errorCode,
        }).catch(() => undefined)
    }
}

function createSourceClient(connection: GeneOpsConnection) {
    return postgres({
        host: connection.host,
        port: connection.port,
        database: connection.database,
        username: connection.username,
        password: connection.password,
        ssl: "require",
        max: 1,
        prepare: false,
        connect_timeout: 5,
        idle_timeout: 5,
    })
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
    if (!value) return null
    try {
        const parsed = JSON.parse(value)
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null
    } catch {
        return null
    }
}

function hashParameters(value: unknown) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function normalizeExternalErrorCode(error: unknown) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
    if (message.includes("timeout")) return "TIMEOUT"
    if (message.includes("permission") || message.includes("denied")) return "PERMISSION_DENIED"
    if (message.includes("connect") || message.includes("network")) return "CONNECTION_FAILED"
    return "QUERY_FAILED"
}

function externalUserMessage(code: string) {
    if (code === "TIMEOUT") return "GeneOps 实时查询超时，请缩小问题范围后重试"
    if (code === "PERMISSION_DENIED") return "GeneOps 数据源拒绝了该查询"
    if (code === "CONNECTION_FAILED") return "GeneOps 数据源暂时不可用"
    return "GeneOps 实时查询失败"
}

export function parseSourceId(value: unknown) {
    const id = Number(value)
    if (!Number.isInteger(id) || id <= 0) throw badRequest("数据源 ID 无效")
    return id
}
