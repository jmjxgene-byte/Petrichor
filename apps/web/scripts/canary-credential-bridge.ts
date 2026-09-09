import type postgres from "postgres"
import { createHash } from "node:crypto"

async function profileInTransaction(tx: postgres.TransactionSql, userId: number) {
    await tx`select set_config('statement_timeout','8000',true),set_config('lock_timeout','1000',true)`
    const [gate] = await tx`select current_user as role,current_setting('transaction_read_only') as ro,current_setting('transaction_isolation') as isolation`
    if (gate?.role !== "petrichor_runtime" || gate?.ro !== "on" || gate?.isolation !== "repeatable read") throw new Error("role_gate")
    // 只读取身份/版本/能力；URL与headers在SQL内归约为布尔值，不返回其内容。
    const rows = await tx`select b.user_id as binding_user,m.user_id as model_user,p.user_id as provider_user,c.user_id as credential_user,
        m.id as model_ref,m.model_id,m.dimensions,m.enabled as model_enabled,p.enabled as provider_enabled,
        p.id as provider_id,p.provider_key,c.id as credential_id,
        coalesce(nullif(p.base_url,''),'https://api.siliconflow.cn/v1') in ('https://api.siliconflow.cn/v1','https://api.siliconflow.cn/v1/') as endpoint_allowed,
        coalesce(nullif(p.headers_json,''),'{}')::jsonb='{}'::jsonb as headers_empty,
        m.updated_at as model_revision,p.updated_at as provider_revision,c.updated_at as credential_revision
        from petrichor_ai_binding b
        join petrichor_user u on u.id=b.user_id and u.system_role='SUPER_ADMIN'
        join petrichor_ai_model m on m.id=b.model_ref_id and m.user_id=b.user_id
        join petrichor_ai_provider p on p.id=m.provider_id and p.user_id=b.user_id
        join petrichor_ai_credential c on c.id=p.credential_id and c.user_id=b.user_id
        where b.user_id=${userId} and b.purpose='EMBEDDING' and m.kind='EMBEDDING' limit 2`
    if (rows.length !== 1) throw new Error("binding_gate")
    const r = rows[0]
    if ([r.binding_user, r.model_user, r.provider_user, r.credential_user].some(id => String(id) !== String(userId))
        || r.model_id !== "BAAI/bge-m3" || r.dimensions !== 1024 || r.model_enabled !== true || r.provider_enabled !== true
        || r.provider_key !== "siliconflow" || r.endpoint_allowed !== true || r.headers_empty !== true) throw new Error("profile_gate")
    const profile = { model: r.model_id, dimensions: r.dimensions, modelRef: r.model_ref, provider: r.provider_id,
        endpoint: "https://api.siliconflow.cn/v1", credential: r.credential_id,
        modelRevision: r.model_revision, providerRevision: r.provider_revision, credentialRevision: r.credential_revision }
    return { credentialId: r.credential_id, providerProfileHash: createHash("sha256").update(JSON.stringify(profile)).digest("hex") }
}

/** 纯配置核验：SQL不选择密文列，没有decrypt/use回调，也不访问provider。 */
export async function readCanaryProviderProfile(input: { client: postgres.Sql; userId: number }) {
    if (!Number.isSafeInteger(input.userId) || input.userId <= 0) throw new Error("credential_user_invalid")
    try {
        const profile = await input.client.begin("read only isolation level repeatable read", tx => profileInTransaction(tx, input.userId))
        return { providerProfileHash: profile.providerProfileHash, model: "BAAI/bge-m3", dimensions: 1024,
            providerKey: "siliconflow", endpoint: "https://api.siliconflow.cn/v1", configurationValid: true }
    } catch { throw new Error("provider_profile_failed") }
}

/** client由受控运行环境提供；不读取env、不建立新管理连接、不返回凭证对象。 */
export async function withCanaryCredential<T>(input: {
    client: postgres.Sql; userId: number; expectedProviderProfileHash?: string; decrypt: (ciphertext: string) => string
    use: (credential: { apiKey: string; providerProfileHash: string }) => Promise<T>
}) {
    if (!Number.isSafeInteger(input.userId) || input.userId <= 0) throw new Error("credential_user_invalid")
    if (input.expectedProviderProfileHash && !/^[a-f0-9]{64}$/.test(input.expectedProviderProfileHash)) throw new Error("credential_profile_invalid")
    let key = ""
    let failure = "credential_bridge_failed"
    try {
        const row = await input.client.begin("read only isolation level repeatable read", async tx => {
            const profile = await profileInTransaction(tx, input.userId)
            if (input.expectedProviderProfileHash && input.expectedProviderProfileHash !== profile.providerProfileHash) throw new Error("profile_changed")
            const rows = await tx`select api_key_enc from petrichor_ai_credential where id=${profile.credentialId} and user_id=${input.userId} limit 2`
            if (rows.length !== 1 || typeof rows[0].api_key_enc !== "string") throw new Error("credential_gate")
            return { ...profile, ciphertext: rows[0].api_key_enc }
        })
        const providerProfileHash = row.providerProfileHash
        key = input.decrypt(row.ciphertext)
        if (!key.trim()) throw new Error("empty_key")
        failure = "canary_execution_failed"
        return await input.use({ apiKey: key, providerProfileHash })
    } catch { throw new Error(failure) }
    finally { key = "" }
}
