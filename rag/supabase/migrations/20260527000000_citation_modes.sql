-- Citation modes (see citation_mode_spec.md):
--   * answer_citations stores verifier-/model-authored citation metadata for a
--     persisted assistant message. Canonical source_id/span_id stay stable
--     across turns; display_ref/display_number are answer-local.
--   * claim_states stores per-claim verification status for Deep Mode.
-- Both tables are owned by the same user that owns the message and use RLS so
-- users only see citations attached to their own messages.

CREATE TABLE IF NOT EXISTS answer_citations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    thread_id UUID REFERENCES threads(id) ON DELETE CASCADE,

    -- Answer-local display info.
    display_ref TEXT NOT NULL,        -- e.g. "[S3]"
    display_number INTEGER NOT NULL,  -- e.g. 3

    -- Canonical source identity (stable across turns).
    source_id TEXT NOT NULL,
    span_id TEXT,
    source_type TEXT NOT NULL CHECK (source_type IN ('document', 'workspace_file', 'web')),
    source_title TEXT NOT NULL,
    source_uri TEXT,
    document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
    workspace_file_path TEXT,
    content_type TEXT,
    content_hash TEXT,

    -- Span target.
    target JSONB NOT NULL DEFAULT '{}'::jsonb,
    quote TEXT,

    -- Verification.
    status TEXT NOT NULL CHECK (status IN (
        'verified', 'partially_supported', 'not_verified', 'contradicted', 'verification_failed'
    )),
    support_score NUMERIC,
    claim_id TEXT,
    problem TEXT,
    verification_mode TEXT NOT NULL CHECK (verification_mode IN ('unverified', 'semantic-text')),

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_answer_citations_message_id
    ON answer_citations(message_id, display_number);
CREATE INDEX IF NOT EXISTS idx_answer_citations_user_id
    ON answer_citations(user_id, created_at DESC);

ALTER TABLE answer_citations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own citations"
    ON answer_citations FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own citations"
    ON answer_citations FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own citations"
    ON answer_citations FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own citations"
    ON answer_citations FOR DELETE
    USING (auth.uid() = user_id);


CREATE TABLE IF NOT EXISTS claim_states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    claim_id TEXT NOT NULL,
    answer_span JSONB,
    status TEXT NOT NULL CHECK (status IN (
        'verified', 'partially_supported', 'not_verified', 'contradicted', 'verification_failed'
    )),
    problem TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (message_id, claim_id)
);

CREATE INDEX IF NOT EXISTS idx_claim_states_message_id
    ON claim_states(message_id);

ALTER TABLE claim_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own claim states"
    ON claim_states FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own claim states"
    ON claim_states FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own claim states"
    ON claim_states FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own claim states"
    ON claim_states FOR DELETE
    USING (auth.uid() = user_id);


-- Optional verification_mode column on messages so old answers can be re-rendered
-- with the right UI mode even if we change defaults later.
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS verification_mode TEXT
    CHECK (verification_mode IS NULL OR verification_mode IN ('unverified', 'semantic-text'));
