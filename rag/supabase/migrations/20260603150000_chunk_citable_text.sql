-- Plan 15 (Phase 1): Verbatim citable text — decouple citations from context-enrichment.
--
-- The smart chunker bakes retrieval scaffolding into chunks.content (synthetic
-- "(Part N)" headings + a "This chunk is from ..." headline). Citation quotes are
-- taken from that enriched text and then fail to highlight against the verbatim
-- source. This adds a parallel `citable_text` column holding the pre-enrichment
-- verbatim slice, and exposes it through the search/range RPCs so the citation
-- layer can quote verbatim text. Embeddings + the FTS tsvector still derive from
-- `content`, so retrieval quality is unchanged.

-- 1. Verbatim citable text column.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS citable_text text;

-- 2. Safe default so existing rows keep working before re-ingest (Plan 15 Task 6).
--    A re-ingest replaces this with the true verbatim slice; until then the
--    citation layer falls back to this (= enriched content) value.
UPDATE chunks SET citable_text = content WHERE citable_text IS NULL;

-- 3. Re-create the three RPCs to also return citable_text. Changing the
--    RETURNS TABLE shape requires DROP first. Input signatures are unchanged;
--    bodies are copied verbatim from the current definitions
--    (20260225100001_folder_scoped_search.sql, 20260331000000_smart_chunking.sql)
--    with one column added.

-- 3a. Vector search.
DROP FUNCTION IF EXISTS match_chunks(vector, float, int, uuid, jsonb, uuid[]);
CREATE OR REPLACE FUNCTION match_chunks(
    query_embedding vector,
    match_threshold float,
    match_count int,
    p_user_id uuid,
    p_metadata_filter jsonb DEFAULT NULL,
    p_folder_ids uuid[] DEFAULT NULL
) RETURNS TABLE (
    id uuid, document_id uuid, content text, citable_text text,
    chunk_index int, metadata jsonb, similarity float
) LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT c.id, c.document_id, c.content, c.citable_text, c.chunk_index, c.metadata,
           1 - (c.embedding <=> query_embedding) AS similarity
    FROM chunks c
    WHERE c.user_id = p_user_id
      AND 1 - (c.embedding <=> query_embedding) > match_threshold
      AND (p_metadata_filter IS NULL OR c.metadata @> p_metadata_filter)
      AND (p_folder_ids IS NULL OR EXISTS (
          SELECT 1 FROM documents d
          WHERE d.id = c.document_id AND d.folder_id = ANY(p_folder_ids)
      ))
    ORDER BY c.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- 3b. Keyword (FTS) search.
DROP FUNCTION IF EXISTS keyword_search_chunks(text, int, uuid, jsonb, uuid[]);
CREATE OR REPLACE FUNCTION keyword_search_chunks(
    p_query TEXT,
    p_match_count INT DEFAULT 10,
    p_user_id UUID DEFAULT NULL,
    p_metadata_filter JSONB DEFAULT NULL,
    p_folder_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    document_id UUID,
    content TEXT,
    citable_text TEXT,
    metadata JSONB,
    rank REAL
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.document_id,
    c.content,
    c.citable_text,
    c.metadata,
    ts_rank_cd(c.fts, plainto_tsquery('english', p_query))::REAL AS rank
  FROM chunks c
  WHERE c.fts @@ plainto_tsquery('english', p_query)
    AND (p_user_id IS NULL OR c.user_id = p_user_id)
    AND (p_metadata_filter IS NULL OR c.metadata @> p_metadata_filter)
    AND (p_folder_ids IS NULL OR EXISTS (
        SELECT 1 FROM documents d
        WHERE d.id = c.document_id AND d.folder_id = ANY(p_folder_ids)
    ))
  ORDER BY rank DESC
  LIMIT p_match_count;
END;
$$;

-- 3c. Range-based retrieval (get_document_sections / context expansion).
DROP FUNCTION IF EXISTS get_chunks_by_ranges(jsonb, uuid);
CREATE OR REPLACE FUNCTION get_chunks_by_ranges(p_input_data jsonb, p_user_id uuid)
RETURNS TABLE(
  document_id uuid,
  chunk_index integer,
  content text,
  citable_text text,
  metadata jsonb,
  id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  doc_item JSONB;
  range_item JSONB;
  range_start INTEGER;
  range_end INTEGER;
  current_doc_id UUID;
BEGIN
  FOR doc_item IN SELECT * FROM jsonb_array_elements(p_input_data)
  LOOP
    current_doc_id := (doc_item->>'document_id')::UUID;

    FOR range_item IN SELECT * FROM jsonb_array_elements(doc_item->'chunk_ranges')
    LOOP
      range_start := (range_item->0)::INTEGER;
      range_end := (range_item->1)::INTEGER;

      RETURN QUERY
      SELECT
        c.document_id,
        c.chunk_index,
        c.content,
        c.citable_text,
        c.metadata,
        c.id
      FROM public.chunks c
      WHERE c.document_id = current_doc_id
        AND c.user_id = p_user_id
        AND c.chunk_index >= range_start
        AND c.chunk_index <= range_end
      ORDER BY c.chunk_index;
    END LOOP;
  END LOOP;

  RETURN;
END;
$$;
