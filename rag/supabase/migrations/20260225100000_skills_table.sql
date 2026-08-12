-- Skills table
CREATE TABLE IF NOT EXISTS skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,  -- NULL = global
    name TEXT NOT NULL,
    description TEXT NOT NULL,      -- ~1-2 sentences for LLM discovery (min 20, max 1024 chars)
    instructions TEXT NOT NULL,     -- Full instructions loaded on-demand
    enabled BOOLEAN NOT NULL DEFAULT true,  -- Only enabled skills appear in LLM catalog
    shared_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_skills_unique_name ON skills(
    COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid), name
);
CREATE INDEX idx_skills_user_id ON skills(user_id);

ALTER TABLE skills ENABLE ROW LEVEL SECURITY;

-- RLS: see own + global
CREATE POLICY "skills_select" ON skills FOR SELECT TO authenticated
    USING (user_id IS NULL OR user_id = (SELECT auth.uid()));
CREATE POLICY "skills_insert" ON skills FOR INSERT TO authenticated
    WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "skills_update" ON skills FOR UPDATE TO authenticated
    USING (user_id = (SELECT auth.uid()));
CREATE POLICY "skills_delete" ON skills FOR DELETE TO authenticated
    USING (user_id = (SELECT auth.uid()));

-- Reuse existing trigger function for updated_at
CREATE TRIGGER update_skills_updated_at
    BEFORE UPDATE ON skills FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Junction table: skill <-> folder (many-to-many)
CREATE TABLE IF NOT EXISTS skill_folders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(skill_id, folder_id)
);
CREATE INDEX idx_skill_folders_skill_id ON skill_folders(skill_id);
CREATE INDEX idx_skill_folders_folder_id ON skill_folders(folder_id);

ALTER TABLE skill_folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "skill_folders_select" ON skill_folders FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM skills s WHERE s.id = skill_folders.skill_id
        AND (s.user_id IS NULL OR s.user_id = (SELECT auth.uid()))));
CREATE POLICY "skill_folders_insert" ON skill_folders FOR INSERT TO authenticated
    WITH CHECK (EXISTS (SELECT 1 FROM skills s WHERE s.id = skill_folders.skill_id
        AND s.user_id = (SELECT auth.uid())));
CREATE POLICY "skill_folders_delete" ON skill_folders FOR DELETE TO authenticated
    USING (EXISTS (SELECT 1 FROM skills s WHERE s.id = skill_folders.skill_id
        AND s.user_id = (SELECT auth.uid())));
