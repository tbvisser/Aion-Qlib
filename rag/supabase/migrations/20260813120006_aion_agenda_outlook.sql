-- Per-user AI-generated agenda outlooks, cached so the page stays fast and
-- the LLM bill stays small. Day/week/month scopes share one table; the PK is
-- (user_id, scope, date) because an outlook is personal and scoped to one day.

CREATE TABLE IF NOT EXISTS aion.agenda_outlook (
    user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    scope        TEXT NOT NULL CHECK (scope IN ('day','week','month')),
    date         DATE NOT NULL,
    summary      TEXT NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, scope, date)
);

CREATE INDEX IF NOT EXISTS idx_aion_agenda_outlook_expires
    ON aion.agenda_outlook(user_id, scope, date, expires_at);

ALTER TABLE aion.agenda_outlook ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agenda_outlook_own ON aion.agenda_outlook;
CREATE POLICY agenda_outlook_own ON aion.agenda_outlook FOR ALL
    USING (user_id = (SELECT auth.uid()))
    WITH CHECK (user_id = (SELECT auth.uid()));

GRANT SELECT, INSERT, UPDATE, DELETE ON aion.agenda_outlook TO authenticated;
GRANT ALL ON aion.agenda_outlook TO service_role;
