-- Thread Context Compaction: link evicted messages to the compaction row that summarized them.
-- ON DELETE SET NULL — deleting a compaction never deletes the original messages (they are the ground truth).

ALTER TABLE messages ADD COLUMN IF NOT EXISTS compaction_id UUID DEFAULT NULL
    REFERENCES thread_compactions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_compaction_id
    ON messages(compaction_id) WHERE compaction_id IS NOT NULL;
