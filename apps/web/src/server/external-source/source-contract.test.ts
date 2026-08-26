import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

describe("geneops-prod 安全 RPC 契约", () => {
    const sql = fs.readFileSync(
        path.resolve(process.cwd(), "../../docs/geneops-prod/petrichor-connector.sql"),
        "utf8",
    )

    it("固定 tenant、过滤 restricted/removed，并限制结果", () => {
        expect(sql).toContain("'default'")
        expect(sql).toContain("NOT coalesce(document.restricted, false)")
        expect(sql).toContain("NOT coalesce(document.is_removed, false)")
        expect(sql).toContain("least(greatest(match_count, 1), 20)")
        expect(sql).toContain("left(result.content, 4000)")
    })

    it("不向公共角色开放，只授予 knowledge_vault_reader", () => {
        expect(sql).toContain("FROM PUBLIC, anon, authenticated, service_role")
        expect(sql).toContain("TO knowledge_vault_reader")
        expect(sql).not.toContain("GRANT SELECT ON public.")
    })

    it("登录角色强制只读且不绕过 RLS", () => {
        expect(sql).toContain("NOBYPASSRLS")
        expect(sql).toContain("default_transaction_read_only = on")
        expect(sql).toContain("statement_timeout = '8s'")
    })
})
