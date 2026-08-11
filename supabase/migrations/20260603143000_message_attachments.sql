-- Persist files attached to user messages so the chat transcript can
-- rehydrate inline attachment previews after reload.
ALTER TABLE messages
ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT NULL;

COMMENT ON COLUMN messages.attachments IS
  'Array of files attached to this message, e.g. [{file_path, content_type, size_bytes, source}].';
