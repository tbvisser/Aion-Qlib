-- Sandbox files table and storage bucket for code execution outputs

CREATE TABLE IF NOT EXISTS sandbox_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    execution_id UUID NOT NULL REFERENCES code_executions(id),
    user_id UUID NOT NULL REFERENCES auth.users(id),
    filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    file_size INTEGER,
    content_type TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- RLS
ALTER TABLE sandbox_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to sandbox_files"
    ON sandbox_files FOR ALL
    USING (role() = 'service_role');

CREATE POLICY "Users can view own sandbox files"
    ON sandbox_files FOR SELECT
    USING (uid() = user_id);

CREATE POLICY "Users can insert own sandbox files"
    ON sandbox_files FOR INSERT
    WITH CHECK (uid() = user_id);

-- Storage bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('sandbox-outputs', 'sandbox-outputs', false, 104857600)
ON CONFLICT (id) DO NOTHING;

-- Storage policies
CREATE POLICY "Users can upload sandbox outputs"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'sandbox-outputs'
        AND (storage.foldername(name))[1] = (uid())::text
    );

CREATE POLICY "Users can view own sandbox outputs"
    ON storage.objects FOR SELECT
    USING (
        bucket_id = 'sandbox-outputs'
        AND (storage.foldername(name))[1] = (uid())::text
    );

CREATE POLICY "Service role full access to sandbox storage"
    ON storage.objects FOR ALL
    USING (
        bucket_id = 'sandbox-outputs'
        AND role() = 'service_role'
    );
