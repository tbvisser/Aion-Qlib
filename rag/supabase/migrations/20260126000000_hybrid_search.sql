-- Module 6: Hybrid Search & Reranking
-- Adds full-text search (FTS) support alongside existing vector search

-- 1. Add fts tsvector column to chunks
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS fts tsvector;

-- 2. Backfill existing chunks
UPDATE chunks SET fts = to_tsvector('english', content) WHERE fts IS NULL;

-- 3. GIN index on fts column
CREATE INDEX IF NOT EXISTS idx_chunks_fts ON chunks USING GIN (fts);

-- 4. Trigger to auto-populate fts on INSERT/UPDATE of content
CREATE OR REPLACE FUNCTION chunks_fts_trigger() RETURNS trigger AS $$
BEGIN
  NEW.fts := to_tsvector('english', NEW.content);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chunks_fts_update ON chunks;
CREATE TRIGGER chunks_fts_update
  BEFORE INSERT OR UPDATE OF content ON chunks
  FOR EACH ROW
  EXECUTE FUNCTION chunks_fts_trigger();

-- 5. Keyword search RPC
CREATE OR REPLACE FUNCTION keyword_search_chunks(
  p_query TEXT,
  p_match_count INT DEFAULT 10,
  p_user_id UUID DEFAULT NULL,
  p_metadata_filter JSONB DEFAULT NULL
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
  ORDER BY rank DESC
  LIMIT p_match_count;
END;
$$;

-- 6. Add reranking configuration columns to global_settings
ALTER TABLE global_settings
  ADD COLUMN IF NOT EXISTS rerank_model TEXT DEFAULT 'rerank-v3.5',
  ADD COLUMN IF NOT EXISTS rerank_base_url TEXT DEFAULT 'https://api.cohere.com/v2',
  ADD COLUMN IF NOT EXISTS rerank_api_key TEXT,
  ADD COLUMN IF NOT EXISTS rerank_top_n INTEGER DEFAULT 5;
