-- 双速深度检索任务只持久化安全元数据；原始查询、chunk、snippet 和 RPC 结果不得落表。

create table if not exists petrichor_deep_research_job (
    id bigint generated always as identity primary key,
    run_key text not null,
    idempotency_key text not null,
    thread_id bigint not null references petrichor_assistant_thread(id) on delete cascade,
    user_id bigint not null references petrichor_user(id) on delete cascade,
    question_message_id bigint not null references petrichor_assistant_message(id) on delete cascade,
    fast_run_key text,
    source_scope_hash text not null,
    capability_snapshot_json text not null,
    status text not null default 'queued',
    attempt_count integer not null default 0,
    max_attempts integer not null default 3,
    available_at timestamptz not null default now(),
    lease_owner text,
    lease_expires_at timestamptz,
    heartbeat_at timestamptz,
    error_code text,
    result_message_id bigint references petrichor_assistant_message(id) on delete set null,
    started_at timestamptz,
    completed_at timestamptz,
    cancelled_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint petrichor_deep_research_job_status_check check (
        status in ('queued', 'running', 'retry_wait', 'cancel_requested', 'cancelled', 'succeeded', 'failed')
    ),
    constraint petrichor_deep_research_job_attempt_check check (
        attempt_count >= 0 and max_attempts > 0 and attempt_count <= max_attempts
    )
);

create unique index if not exists ux_petrichor_deep_research_job_run_key
    on petrichor_deep_research_job(run_key);
create unique index if not exists ux_petrichor_deep_research_job_idempotency
    on petrichor_deep_research_job(idempotency_key);
create index if not exists petrichor_deep_research_job_claim_idx
    on petrichor_deep_research_job(status, available_at, lease_expires_at);
create index if not exists petrichor_deep_research_job_thread_idx
    on petrichor_deep_research_job(thread_id, created_at desc);
