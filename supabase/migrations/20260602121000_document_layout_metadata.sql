-- Docling PDF layout metadata for citation highlight overlays.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS document_layout JSONB;
