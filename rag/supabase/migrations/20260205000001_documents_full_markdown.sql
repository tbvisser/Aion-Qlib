-- Add full markdown content column for grep/read tools (Phase 5-6)
-- TEXT type with default EXTENDED storage (TOAST with compression)
-- handles large documents efficiently (up to ~1GB)
ALTER TABLE documents ADD COLUMN full_markdown TEXT;

-- Note: No index needed - this column is for read/grep, not filtering
-- Existing documents will have NULL until re-ingested
