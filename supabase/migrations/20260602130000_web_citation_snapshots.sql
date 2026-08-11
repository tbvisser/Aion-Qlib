-- Web citation snapshots (see .agent/plans/7.web-search-citation-snapshots.md):
--   * web_snapshots stores the full captured page text for a web source so a
--     web citation can render the source and highlight the cited passage,
--     instead of just showing the bare URL.
--   * Deduped per (user_id, source_id) where source_id is the canonical
--     web_<sha(url)[:12]> id used by answer_citations, so a page cited by
--     multiple [S#] aliases (or across turns) stores a single snapshot.
-- Owned by the user that ran the search; RLS so users only see their own
-- snapshots (mirrors answer_citations).

CREATE TABLE IF NOT EXISTS web_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Canonical web source identity (matches answer_citations.source_id).
    source_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT,

    -- Captured page text + metadata.
    content TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'text/markdown',
    content_hash TEXT,
    byte_size INTEGER,
    fetched_at TIMESTAMPTZ DEFAULT NOW(),

    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (user_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_web_snapshots_user_source
    ON web_snapshots(user_id, source_id);

ALTER TABLE web_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own web snapshots"
    ON web_snapshots FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own web snapshots"
    ON web_snapshots FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own web snapshots"
    ON web_snapshots FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own web snapshots"
    ON web_snapshots FOR DELETE
    USING (auth.uid() = user_id);
