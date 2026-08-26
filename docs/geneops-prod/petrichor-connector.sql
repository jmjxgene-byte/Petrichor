-- GeneOps 生产知识面向 Petrichor 的最小只读 RPC 门面。
-- 此文件属于 geneops-prod，不登记到 Petrichor 自身 migration manifest。

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'petrichor_geneops_reader') THEN
        CREATE ROLE petrichor_geneops_reader
            LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
END
$$;

ALTER ROLE petrichor_geneops_reader
    SET default_transaction_read_only = on;
ALTER ROLE petrichor_geneops_reader
    SET statement_timeout = '8s';
ALTER ROLE petrichor_geneops_reader
    SET lock_timeout = '1s';

GRANT knowledge_vault_reader TO petrichor_geneops_reader;
REVOKE ALL ON SCHEMA public FROM petrichor_geneops_reader;
GRANT USAGE ON SCHEMA knowledge_vault TO knowledge_vault_reader;

CREATE OR REPLACE FUNCTION knowledge_vault.capabilities_v1()
RETURNS TABLE (
    contract_version integer,
    project_ref text,
    tenant_id text,
    allowed_sources text[],
    search_modes text[],
    graph_enabled boolean,
    embedding_model text,
    embedding_dimensions integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, extensions
AS $$
    SELECT
        1,
        'snsvqlqwnpyzcftubeab'::text,
        'default'::text,
        ARRAY['wearesellers', 'wechat_mp']::text[],
        ARRAY['exact', 'fuzzy']::text[],
        true,
        'BAAI/bge-m3'::text,
        1024
$$;

CREATE OR REPLACE FUNCTION knowledge_vault.search_v1(
    query_text text,
    query_source text DEFAULT NULL,
    search_mode text DEFAULT 'exact',
    match_count integer DEFAULT 10
)
RETURNS TABLE (
    result_key text,
    document_id text,
    reply_id text,
    chunk_kind text,
    title text,
    snippet text,
    author text,
    source_url text,
    match_type text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, extensions
AS $$
DECLARE
    safe_count integer := least(greatest(match_count, 1), 20);
BEGIN
    IF search_mode NOT IN ('exact', 'fuzzy') THEN
        RAISE EXCEPTION 'invalid search mode';
    END IF;
    IF query_source IS NOT NULL AND query_source NOT IN ('wearesellers', 'wechat_mp') THEN
        RAISE EXCEPTION 'invalid source';
    END IF;
    IF length(trim(query_text)) < 1 OR length(query_text) > 500 THEN
        RAISE EXCEPTION 'invalid query length';
    END IF;

    RETURN QUERY
    SELECT
        result.result_key,
        result.document_id,
        result.reply_id,
        result.chunk_kind,
        result.title,
        left(result.content, 4000) AS snippet,
        result.author,
        result.source_url,
        result.match_type
    FROM public.search_geneops_v2(
        query_text,
        'default',
        NULL,
        safe_count,
        0,
        search_mode,
        60,
        NULL,
        query_source
    ) AS result
    JOIN public.source_documents AS document
      ON document.tenant_id = 'default'
     AND document.id = result.document_id
    WHERE document.source IN ('wearesellers', 'wechat_mp')
      AND NOT coalesce(document.restricted, false)
      AND NOT coalesce(document.is_removed, false)
    LIMIT safe_count;
END
$$;

CREATE OR REPLACE FUNCTION knowledge_vault.read_chunks_v1(
    query_document_id text,
    after_position integer DEFAULT -1,
    chunk_limit integer DEFAULT 8
)
RETURNS TABLE (
    document_id text,
    chunk_position integer,
    chunk_kind text,
    title text,
    content text,
    author text,
    source_url text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, extensions
AS $$
    SELECT
        chunk.document_id,
        chunk.chunk_position,
        chunk.chunk_kind,
        chunk.title,
        left(chunk.content, 4000) AS content,
        chunk.author,
        chunk.source_url
    FROM public.geneops_search_chunks AS chunk
    JOIN public.source_documents AS document
      ON document.tenant_id = chunk.tenant_id
     AND document.id = chunk.document_id
    WHERE chunk.tenant_id = 'default'
      AND chunk.document_id = query_document_id
      AND chunk.source IN ('wearesellers', 'wechat_mp')
      AND chunk.chunk_position > greatest(after_position, -1)
      AND NOT coalesce(document.restricted, false)
      AND NOT coalesce(document.is_removed, false)
    ORDER BY chunk.chunk_position, chunk.id
    LIMIT least(greatest(chunk_limit, 1), 12)
$$;

CREATE OR REPLACE FUNCTION knowledge_vault.graph_search_v1(
    query_text text,
    query_node_types text[] DEFAULT NULL,
    match_count integer DEFAULT 10
)
RETURNS TABLE (
    node_id text,
    node_type text,
    label text,
    group_key text,
    degree integer,
    evidence_count integer,
    metadata_json jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, extensions
AS $$
    SELECT *
    FROM public.graph_search_nodes_v1(
        'default',
        left(query_text, 300),
        query_node_types,
        least(greatest(match_count, 1), 20)
    )
$$;

CREATE OR REPLACE FUNCTION knowledge_vault.graph_neighborhood_v1(
    center_node_id text,
    max_nodes integer DEFAULT 30,
    max_edges integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, extensions
AS $$
    SELECT public.graph_neighborhood_v1(
        'default',
        center_node_id,
        least(greatest(max_nodes, 1), 40),
        least(greatest(max_edges, 1), 80)
    )
$$;

CREATE OR REPLACE FUNCTION knowledge_vault.backlinks_v1(
    query_page_id text,
    match_count integer DEFAULT 10
)
RETURNS TABLE (
    page_id text,
    title text,
    category text,
    shared_node_count bigint,
    node_degree integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, extensions
AS $$
    SELECT *
    FROM public.knowledge_backlinks_v1(
        'default',
        query_page_id,
        least(greatest(match_count, 1), 20)
    )
$$;

REVOKE ALL ON FUNCTION knowledge_vault.capabilities_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION knowledge_vault.search_v1(text, text, text, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION knowledge_vault.read_chunks_v1(text, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION knowledge_vault.graph_search_v1(text, text[], integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION knowledge_vault.graph_neighborhood_v1(text, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION knowledge_vault.backlinks_v1(text, integer) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION knowledge_vault.capabilities_v1() TO knowledge_vault_reader;
GRANT EXECUTE ON FUNCTION knowledge_vault.search_v1(text, text, text, integer) TO knowledge_vault_reader;
GRANT EXECUTE ON FUNCTION knowledge_vault.read_chunks_v1(text, integer, integer) TO knowledge_vault_reader;
GRANT EXECUTE ON FUNCTION knowledge_vault.graph_search_v1(text, text[], integer) TO knowledge_vault_reader;
GRANT EXECUTE ON FUNCTION knowledge_vault.graph_neighborhood_v1(text, integer, integer) TO knowledge_vault_reader;
GRANT EXECUTE ON FUNCTION knowledge_vault.backlinks_v1(text, integer) TO knowledge_vault_reader;
