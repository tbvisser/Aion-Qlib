-- Keycard workflow builder storage.
--
-- A keycard is a persisted DAG of quant-aware nodes that replaces the flat
-- StrategySpec in the new workflow builder. Templates are keycards with
-- is_template = true.

CREATE TABLE IF NOT EXISTS aion.keycards (
    id             TEXT PRIMARY KEY,
    org_id         UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    visibility     TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'org')),
    name           TEXT NOT NULL,
    spec           JSONB NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aion_keycards_org   ON aion.keycards(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_aion_keycards_owner ON aion.keycards(user_id, created_at DESC);

-- updated_at trigger
DROP TRIGGER IF EXISTS update_aion_keycards_updated_at ON aion.keycards;
CREATE TRIGGER update_aion_keycards_updated_at
    BEFORE UPDATE ON aion.keycards
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Row level security: same policy set as strategies/portfolios/projects.
ALTER TABLE aion.keycards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS keycards_select ON aion.keycards;
CREATE POLICY keycards_select ON aion.keycards FOR SELECT
USING (
    user_id = (SELECT auth.uid())
    OR (visibility = 'org' AND public.is_org_member(org_id))
);

DROP POLICY IF EXISTS keycards_insert ON aion.keycards;
CREATE POLICY keycards_insert ON aion.keycards FOR INSERT
WITH CHECK (
    user_id = (SELECT auth.uid())
    AND public.is_org_member(org_id)
);

DROP POLICY IF EXISTS keycards_update ON aion.keycards;
CREATE POLICY keycards_update ON aion.keycards FOR UPDATE
USING (user_id = (SELECT auth.uid()) OR public.is_org_admin(org_id))
WITH CHECK (user_id = (SELECT auth.uid()) OR public.is_org_admin(org_id));

DROP POLICY IF EXISTS keycards_delete ON aion.keycards;
CREATE POLICY keycards_delete ON aion.keycards FOR DELETE
USING (user_id = (SELECT auth.uid()) OR public.is_org_admin(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON aion.keycards TO authenticated;
GRANT ALL ON aion.keycards TO service_role;
