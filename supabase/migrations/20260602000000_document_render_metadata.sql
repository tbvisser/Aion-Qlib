-- Document sidecar render metadata for page-aware preview/text navigation.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS document_structure JSONB;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS document_pages JSONB;
