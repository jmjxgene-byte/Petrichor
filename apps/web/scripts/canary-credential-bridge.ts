import type postgres from "postgres"
import { createHash } from "node:crypto"

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
            await tx`select set_config('statement_timeout','8000',true),set_config('lock_timeout','1000',true)`
            const [gate] = await tx`select current_user as role,current_setting('transaction_read_only') as ro`
            if (gate?.role !== "petrichor_runtime" || gate?.ro !== "on") throw new Error("role_gate")
            const rows = await tx`select b.user_id as binding_user,m.user_id as model_user,p.user_id as provider_user,c.user_id as credential_user,
                m.id as model_ref,m.model_id,m.dimensions,m.enabled as model_enabled,p.enabled as provider_enabled,
                p.id as provider_id,p.provider_key,p.base_url,p.headers_json,c.id as credential_id,c.api_key_enc,
                m.updated_at as model_revision,p.updated_at as provider_revision,c.updated_at as credential_revision
                from petrichor_ai_binding b
                join petrichor_user u on u.id=b.user_id and u.system_role='SUPER_ADMIN'
                join petrichor_ai_model m on m.id=b.model_ref_id and m.user_id=b.user_id
                join petrichor_ai_provider p on p.id=m.provider_id and p.user_id=b.user_id
                join petrichor_ai_credential c on c.id=p.credential_id and c.user_id=b.user_id
                where b.user_id=${input.userId} and b.purpose='EMBEDDING' and m.kind='EMBEDDING' limit 2`
            if (rows.length !== 1) throw new Error("binding_gate")
            const r = rows[0]
            if ([r.binding_user, r.model_user, r.provider_user, r.credential_user].some(id => String(id) !== String(input.userId))
                || r.model_id !== "BAAI/bge-m3" || r.dimensions !== 1024 || !r.model_enabled || !r.provider_enabled || r.provider_key !== "siliconflow"
                || (r.base_url && r.base_url.replace(/\/$/, "") !== "https://api.siliconflow.cn/v1")
                || Object.keys(JSON.parse(r.headers_json || "{}")).length) throw new Error("profile_gate")
            return r
        })
        const profile = { model: row.model_id, dimensions: row.dimensions, modelRef: row.model_ref, provider: row.provider_id,
            endpoint: "https://api.siliconflow.cn/v1", credential: row.credential_id,
            modelRevision: row.model_revision, providerRevision: row.provider_revision, credentialRevision: row.credential_revision }
        const providerProfileHash = createHash("sha256").update(JSON.stringify(profile)).digest("hex")
        if (input.expectedProviderProfileHash && input.expectedProviderProfileHash !== providerProfileHash) throw new Error("profile_changed")
        key = input.decrypt(row.api_key_enc)
        if (!key.trim()) throw new Error("empty_key")
        failure = "canary_execution_failed"
        return await input.use({ apiKey: key, providerProfileHash })
    } catch { throw new Error(failure) }
    finally { key = "" }
}
