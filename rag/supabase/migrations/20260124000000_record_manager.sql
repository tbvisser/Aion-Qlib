-- Record Manager: content hash and unique constraint for deduplication

-- Content hash on documents (SHA-256 of full file content)
ALTER TABLE documents ADD COLUMN content_hash TEXT;

-- Index for fast hash lookups
CREATE INDEX idx_documents_content_hash ON documents(user_id, content_hash);

-- Unique constraint: one document per filename per user
-- Re-uploads update the existing record rather than creating duplicates
ALTER TABLE documents ADD CONSTRAINT uq_user_filename UNIQUE (user_id, filename);
