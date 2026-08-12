-- Add folder reference to documents table
ALTER TABLE documents
ADD COLUMN folder_id UUID REFERENCES folders(id) ON DELETE SET NULL;

-- Index for folder-based queries (list documents in folder)
CREATE INDEX idx_documents_folder_id ON documents(folder_id);

-- Note: ON DELETE SET NULL preserves documents when folder is deleted
-- They become "unfiled" (folder_id = NULL) rather than being deleted
