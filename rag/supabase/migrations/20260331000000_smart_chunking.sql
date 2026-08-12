-- Smart Markdown Chunking: Add hierarchical_index column and get_chunks_by_ranges function

-- 1. Add hierarchical_index column to documents table
ALTER TABLE documents ADD COLUMN IF NOT EXISTS hierarchical_index TEXT;

-- 2. Create get_chunks_by_ranges function for range-based chunk retrieval
-- Adapted from n8n version: uses proper typed columns (document_id UUID, chunk_index INTEGER)
-- instead of JSONB metadata lookups. Enforces RLS via p_user_id parameter.
CREATE OR REPLACE FUNCTION get_chunks_by_ranges(p_input_data jsonb, p_user_id uuid)
RETURNS TABLE(
  document_id uuid,
  chunk_index integer,
  content text,
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
  -- Loop through each document in the input array
  FOR doc_item IN SELECT * FROM jsonb_array_elements(p_input_data)
  LOOP
    current_doc_id := (doc_item->>'document_id')::UUID;

    -- Loop through each chunk range for this document
    FOR range_item IN SELECT * FROM jsonb_array_elements(doc_item->'chunk_ranges')
    LOOP
      range_start := (range_item->0)::INTEGER;
      range_end := (range_item->1)::INTEGER;

      -- Return all chunks within this range for this document, filtered by user_id
      RETURN QUERY
      SELECT
        c.document_id,
        c.chunk_index,
        c.content,
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
