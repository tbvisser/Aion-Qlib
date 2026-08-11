-- Skill files metadata table
CREATE TABLE IF NOT EXISTS skill_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    mime_type TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_skill_files_unique_name ON skill_files(skill_id, filename);
CREATE INDEX idx_skill_files_skill_id ON skill_files(skill_id);

ALTER TABLE skill_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "skill_files_select" ON skill_files FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid()));
CREATE POLICY "skill_files_insert" ON skill_files FOR INSERT TO authenticated
    WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "skill_files_delete" ON skill_files FOR DELETE TO authenticated
    USING (user_id = (SELECT auth.uid()));
