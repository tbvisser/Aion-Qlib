-- Module 4: Metadata Extraction
-- Adds metadata column to documents, metadata_schema to global_settings,
-- updates match_chunks to support metadata filtering, and adds GIN index.

-- 1. Add metadata column to documents
ALTER TABLE documents ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- 2. Add metadata_schema to global_settings with defaults
ALTER TABLE global_settings ADD COLUMN IF NOT EXISTS metadata_schema JSONB DEFAULT '[
  {"name": "title", "type": "string", "required": true, "description": "A concise, descriptive title for the document"},
  {"name": "summary", "type": "string", "required": true, "description": "A 1-3 sentence summary of the document content"},
  {"name": "document_type", "type": "enum", "required": true, "description": "The category of this document", "enum_values": ["article", "tutorial", "reference", "notes", "report", "essay", "code", "other"]},
  {"name": "topics", "type": "list", "required": true, "description": "3-7 key topics or themes covered in the document"},
  {"name": "language", "type": "string", "required": false, "description": "ISO 639-1 language code of the document (e.g. en, es, fr)"}
]';

-- 3. Drop old match_chunks (4-param) before creating the new version with optional 5th param
DROP FUNCTION IF EXISTS match_chunks(vector, float, int, uuid);

-- Recreate match_chunks with optional metadata filter
CREATE OR REPLACE FUNCTION match_chunks(
    query_embedding vector,
    match_threshold float,
    match_count int,
    p_user_id uuid,
    p_metadata_filter jsonb DEFAULT NULL
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
    ORDER BY c.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- 4. GIN index for fast JSONB containment queries on chunks
CREATE INDEX IF NOT EXISTS idx_chunks_metadata ON chunks USING gin (metadata jsonb_path_ops);
