-- 本地文档增强索引：仅增加派生结构，原文件与旧chunk保持不变。
create unique index if not exists ux_doc_library_owner on petrichor_doc_library(id, user_id);
create unique index if not exists ux_doc_document_owner_library on petrichor_doc_document(id, user_id, library_id);

create table if not exists petrichor_doc_index_generation (
    id bigint generated always as identity primary key,
    user_id bigint not null,
    library_id bigint not null,
    manifest_hash text not null,
    manifest_json text not null,
    embedding_profile_json text not null,
    preprocessing_version integer not null,
    status text not null default 'building',
    is_current boolean not null default false,
    expected_documents integer not null,
    completed_documents integer not null default 0,
    passage_count integer not null default 0,
    error_code text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (id, user_id, library_id),
    foreign key (library_id, user_id) references petrichor_doc_library(id, user_id) on delete cascade,
    check (status in ('building', 'ready', 'failed', 'cancelled', 'retired')),
    check (not is_current or (status = 'ready' and completed_documents = expected_documents)),
    check (expected_documents >= 0 and completed_documents >= 0 and completed_documents <= expected_documents),
    check (passage_count >= 0 and preprocessing_version > 0)
);
create unique index if not exists ux_doc_index_current on petrichor_doc_index_generation(library_id) where is_current = true;
create index if not exists idx_doc_index_owner on petrichor_doc_index_generation(user_id, library_id, status);

create table if not exists petrichor_doc_passage (
    id bigint generated always as identity primary key,
    generation_id bigint not null,
    user_id bigint not null,
    library_id bigint not null,
    document_id bigint not null,
    passage_index integer not null,
    source_hash text not null,
    content_hash text not null,
    start_offset integer not null,
    end_offset integer not null,
    parent_start_offset integer not null,
    parent_end_offset integer not null,
    locator text,
    published_at timestamptz,
    text text not null,
    search_tokens text not null,
    embedding_status text not null default 'pending',
    embedding_dimensions integer,
    created_at timestamptz not null default now(),
    unique (generation_id, document_id, passage_index),
    foreign key (generation_id, user_id, library_id) references petrichor_doc_index_generation(id, user_id, library_id) on delete cascade,
    foreign key (document_id, user_id, library_id) references petrichor_doc_document(id, user_id, library_id) on delete cascade,
    check (passage_index >= 0 and start_offset >= 0 and end_offset > start_offset),
    check (parent_start_offset >= 0 and parent_start_offset <= start_offset and parent_end_offset >= end_offset),
    check (embedding_status in ('pending', 'ready', 'failed')),
    check (embedding_dimensions is null or embedding_dimensions > 0),
    check (embedding_status <> 'ready' or (embedding_dimensions is not null and embedding_dimensions > 0))
);
create index if not exists idx_doc_passage_scope on petrichor_doc_passage(user_id, library_id, generation_id, document_id);
alter table petrichor_doc_passage add column if not exists embedding vector;
alter table petrichor_doc_passage add column if not exists search_vector tsvector
    generated always as (to_tsvector('simple', search_tokens)) stored;
create index if not exists idx_doc_passage_lexical on petrichor_doc_passage using gin (search_vector);

create table if not exists petrichor_doc_index_job (
    id bigint generated always as identity primary key,
    generation_id bigint not null,
    user_id bigint not null,
    library_id bigint not null,
    document_id bigint not null,
    source_hash text not null,
    idempotency_key text not null,
    status text not null default 'queued',
    attempt_count integer not null default 0,
    available_at timestamptz not null default now(),
    lease_owner text,
    lease_expires_at timestamptz,
    heartbeat_at timestamptz,
    approved_budget_json text not null,
    consumed_input_tokens bigint not null default 0,
    consumed_cost_microusd bigint not null default 0,
    error_code text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (user_id, idempotency_key),
    unique (generation_id, document_id),
    foreign key (generation_id, user_id, library_id) references petrichor_doc_index_generation(id, user_id, library_id) on delete cascade,
    foreign key (document_id, user_id, library_id) references petrichor_doc_document(id, user_id, library_id) on delete cascade,
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled')),
    check (attempt_count >= 0 and consumed_input_tokens >= 0 and consumed_cost_microusd >= 0)
);
create index if not exists idx_doc_index_job_claim on petrichor_doc_index_job(status, available_at, lease_expires_at);
