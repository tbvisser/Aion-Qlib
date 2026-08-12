-- Story 2.1: workspace_files table for per-thread workspace file storage

-- Create workspace_files table
CREATE TABLE IF NOT EXISTS workspace_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    content TEXT,
    storage_path TEXT,
    content_type TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('agent', 'sandbox', 'upload')),
    execution_id UUID,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- UNIQUE constraint on (thread_id, file_path) — upsert key for write_file operations
ALTER TABLE workspace_files ADD CONSTRAINT uq_workspace_files_thread_file_path UNIQUE (thread_id, file_path);

-- Index on thread_id for list queries
CREATE INDEX IF NOT EXISTS idx_workspace_files_thread_id ON workspace_files(thread_id);

-- Enable Row Level Security
ALTER TABLE workspace_files ENABLE ROW LEVEL SECURITY;

-- RLS Policies: thread-ownership join pattern (same as agent_todos)
CREATE POLICY "Users can view workspace files in their own threads"
    ON workspace_files FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM threads
            WHERE threads.id = workspace_files.thread_id
            AND threads.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can create workspace files in their own threads"
    ON workspace_files FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM threads
            WHERE threads.id = workspace_files.thread_id
            AND threads.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can update workspace files in their own threads"
    ON workspace_files FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM threads
            WHERE threads.id = workspace_files.thread_id
            AND threads.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can delete workspace files in their own threads"
    ON workspace_files FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM threads
            WHERE threads.id = workspace_files.thread_id
            AND threads.user_id = auth.uid()
        )
    );

-- Trigger for updated_at (reuses existing function from initial_schema)
DROP TRIGGER IF EXISTS update_workspace_files_updated_at ON workspace_files;
CREATE TRIGGER update_workspace_files_updated_at
    BEFORE UPDATE ON workspace_files
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
