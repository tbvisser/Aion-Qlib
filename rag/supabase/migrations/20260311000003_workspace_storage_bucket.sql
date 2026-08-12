-- Story 2.1: workspace-files storage bucket for binary workspace artifacts

-- Create workspace-files storage bucket (private)
INSERT INTO storage.buckets (id, name, public) VALUES ('workspace-files', 'workspace-files', false);

-- Policy: users can upload files to their own folder (user_id prefix pattern)
-- Storage path convention: {user_id}/{thread_id}/{file_path}
CREATE POLICY "users_upload_own_workspace_files" ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'workspace-files' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Policy: users can read their own workspace files
CREATE POLICY "users_read_own_workspace_files" ON storage.objects FOR SELECT
    USING (bucket_id = 'workspace-files' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Policy: users can delete their own workspace files
CREATE POLICY "users_delete_own_workspace_files" ON storage.objects FOR DELETE
    USING (bucket_id = 'workspace-files' AND (storage.foldername(name))[1] = auth.uid()::text);
