-- Scheduled tasks for the Aion qlib half of the platform.
--
-- A lightweight in-process scheduler inside the API process reads this table,
-- wakes every minute, and dispatches due tasks. The row is the source of truth
-- for recurrence, ownership and run history; the scheduler only decides when
-- to fire.

CREATE TABLE IF NOT EXISTS aion.scheduled_tasks (
    id          TEXT PRIMARY KEY,
    org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    visibility  TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'org')),
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('macro_refresh', 'data_refresh', 'run_strategy')),
    enabled     BOOLEAN NOT NULL DEFAULT true,
    -- {frequency: "daily"|"weekdays"|"weekly", time: "HH:MM", day?: "mon".."sun"}
    schedule    JSONB NOT NULL,
    -- kind-specific payload: {what} for macro_refresh, refresh params for
    -- data_refresh, {strategy_id} for run_strategy.
    params      JSONB NOT NULL DEFAULT '{}'::jsonb,
    next_run    TIMESTAMPTZ,
    last_run    TIMESTAMPTZ,
    last_status TEXT CHECK (last_status IN ('ok', 'skipped', 'error')),
    last_error  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aion_scheduled_tasks_org   ON aion.scheduled_tasks(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_aion_scheduled_tasks_owner ON aion.scheduled_tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aion_scheduled_tasks_due   ON aion.scheduled_tasks(enabled, next_run)
    WHERE enabled = true AND next_run IS NOT NULL;

DROP TRIGGER IF EXISTS update_aion_scheduled_tasks_updated_at ON aion.scheduled_tasks;
CREATE TRIGGER update_aion_scheduled_tasks_updated_at
    BEFORE UPDATE ON aion.scheduled_tasks
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE aion.scheduled_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scheduled_tasks_select ON aion.scheduled_tasks;
CREATE POLICY scheduled_tasks_select ON aion.scheduled_tasks FOR SELECT
    USING (
        user_id = (SELECT auth.uid())
        OR (visibility = 'org' AND public.is_org_member(org_id))
    );

DROP POLICY IF EXISTS scheduled_tasks_insert ON aion.scheduled_tasks;
CREATE POLICY scheduled_tasks_insert ON aion.scheduled_tasks FOR INSERT
    WITH CHECK (
        user_id = (SELECT auth.uid())
        AND public.is_org_member(org_id)
    );

DROP POLICY IF EXISTS scheduled_tasks_update ON aion.scheduled_tasks;
CREATE POLICY scheduled_tasks_update ON aion.scheduled_tasks FOR UPDATE
    USING (user_id = (SELECT auth.uid()) OR public.is_org_admin(org_id))
    WITH CHECK (user_id = (SELECT auth.uid()) OR public.is_org_admin(org_id));

DROP POLICY IF EXISTS scheduled_tasks_delete ON aion.scheduled_tasks;
CREATE POLICY scheduled_tasks_delete ON aion.scheduled_tasks FOR DELETE
    USING (user_id = (SELECT auth.uid()) OR public.is_org_admin(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON aion.scheduled_tasks TO authenticated;
GRANT ALL ON aion.scheduled_tasks TO service_role;
