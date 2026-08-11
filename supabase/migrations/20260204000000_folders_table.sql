-- Folders table with adjacency list pattern for hierarchical structure
-- Global folders (user_id IS NULL) are visible to all authenticated users
-- Per-user folders are private to their owner

-- Folders table
CREATE TABLE IF NOT EXISTS folders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,  -- NULL = global folder
    parent_id UUID REFERENCES folders(id) ON DELETE CASCADE,   -- NULL = root folder
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Unique constraint handling NULL values properly
-- COALESCE ensures duplicate names at same level for same owner are prevented
-- even when user_id or parent_id are NULL
CREATE UNIQUE INDEX idx_folders_unique_name ON folders(
    COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    name
);

-- Performance indexes
CREATE INDEX idx_folders_user_id ON folders(user_id);
CREATE INDEX idx_folders_parent_id ON folders(parent_id);

-- Enable Row Level Security
ALTER TABLE folders ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Note: Using (SELECT auth.uid()) instead of auth.uid() for ~95% performance improvement

-- SELECT: Users see global folders (user_id IS NULL) and their own folders
CREATE POLICY "folders_select_policy" ON folders
FOR SELECT TO authenticated
USING (user_id IS NULL OR user_id = (SELECT auth.uid()));

-- INSERT: Users can only create folders they own (not global folders)
CREATE POLICY "folders_insert_policy" ON folders
FOR INSERT TO authenticated
WITH CHECK (user_id = (SELECT auth.uid()));

-- UPDATE: Users can only update their own folders (not global folders)
CREATE POLICY "folders_update_policy" ON folders
FOR UPDATE TO authenticated
USING (user_id = (SELECT auth.uid()))
WITH CHECK (user_id = (SELECT auth.uid()));

-- DELETE: Users can only delete their own folders (not global folders)
CREATE POLICY "folders_delete_policy" ON folders
FOR DELETE TO authenticated
USING (user_id = (SELECT auth.uid()));

-- Trigger for updated_at
-- Uses existing update_updated_at_column() function from initial_schema migration
CREATE TRIGGER update_folders_updated_at
    BEFORE UPDATE ON folders
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
