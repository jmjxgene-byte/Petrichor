-- GeneOps 外部只读数据源配置与查询审计。

CREATE TABLE IF NOT EXISTS petrichor_external_source (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_by_user_id bigint NOT NULL REFERENCES petrichor_user(id) ON DELETE RESTRICT,
    source_type text NOT NULL DEFAULT 'GENEOPS_SUPABASE',
    name text NOT NULL,
    enabled boolean NOT NULL DEFAULT false,
    global_shared boolean NOT NULL DEFAULT true,
    connection_enc text NOT NULL,
    capabilities_json text,
    contract_version integer,
    last_checked_at timestamptz,
    last_check_status text,
    last_check_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_petrichor_external_source_name
    ON petrichor_external_source(name);

CREATE INDEX IF NOT EXISTS idx_petrichor_external_source_enabled
    ON petrichor_external_source(enabled, updated_at);

CREATE TABLE IF NOT EXISTS petrichor_external_query_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES petrichor_user(id) ON DELETE CASCADE,
    thread_id bigint,
    run_id bigint,
    source_id bigint NOT NULL REFERENCES petrichor_external_source(id) ON DELETE CASCADE,
    tool_name text NOT NULL,
    query_type text NOT NULL,
    parameter_hash text NOT NULL,
    duration_ms integer NOT NULL DEFAULT 0,
    result_count integer NOT NULL DEFAULT 0,
    status text NOT NULL,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_petrichor_external_query_audit_user
    ON petrichor_external_query_audit(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_petrichor_external_query_audit_source
    ON petrichor_external_query_audit(source_id, created_at);
