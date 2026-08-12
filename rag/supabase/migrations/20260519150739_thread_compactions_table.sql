-- Thread Context Compaction: persisted summaries of evicted message ranges.
-- Originals in `messages` are never deleted; a compaction row records the summary
-- of an evicted slice and (recursively) which prior compaction it folds in.

CREATE TABLE IF NOT EXISTS thread_compactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    summary_text TEXT NOT NULL,
    covers_from_sequence INTEGER NOT NULL,
    covers_to_sequence INTEGER NOT NULL,
    evicted_message_count INTEGER NOT NULL,
    summary_tokens INTEGER NOT NULL,
    model_used TEXT NOT NULL,
    previous_compaction_id UUID REFERENCES thread_compactions(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_thread_compactions_thread_id
    ON thread_compactions(thread_id, created_at DESC);

ALTER TABLE thread_compactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own compactions"
    ON thread_compactions FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own compactions"
    ON thread_compactions FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own compactions"
    ON thread_compactions FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own compactions"
    ON thread_compactions FOR DELETE
    USING (auth.uid() = user_id);
