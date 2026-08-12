-- Folder-scoped search: add p_folder_ids parameter to match_chunks and keyword_search_chunks
-- When p_folder_ids is provided, results are filtered to chunks belonging to documents in those folders.
-- When NULL (default), no JOIN is performed — zero performance regression for existing callers.

-- Drop existing overloads to avoid ambiguity
DROP FUNCTION IF EXISTS match_chunks(vector, float, int, uuid, jsonb);

-- Recreate match_chunks with folder filtering
CREATE OR REPLACE FUNCTION match_chunks(
    query_embedding vector,
    match_threshold float,
    match_count int,
    p_user_id uuid,
    p_metadata_filter jsonb DEFAULT NULL,
    p_folder_ids uuid[] DEFAULT NULL
) RETURNS TABLE (
    id uuid, document_id uuid, content text,
    chunk_index int, metadata jsonb, similarity float
) LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT c.id, c.document_id, c.content, c.chunk_index, c.metadata,
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

-- Drop existing keyword_search_chunks to avoid ambiguity
DROP FUNCTION IF EXISTS keyword_search_chunks(text, int, uuid, jsonb);

-- Recreate keyword_search_chunks with folder filtering
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
