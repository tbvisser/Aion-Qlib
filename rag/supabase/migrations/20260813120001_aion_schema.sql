-- Aion multi-tenancy, part 2 of 2: the qlib records.
--
-- Replaces the flat-file stores webapp/api used to own -- strategies as YAML in
-- webapp/data/strategies/, portfolios and projects as JSON, runs as directories --
-- with tables scoped by the organisation layer from 20260813120000.
--
-- Its own schema rather than `public` so the RAG tables stay uncluttered and the
-- two halves of the platform are legible apart. webapp/api reaches these as the
-- `authenticator` role with SET LOCAL ROLE authenticated, so RLS is the real
-- boundary rather than an app-level WHERE clause anyone could forget.
--
-- What deliberately did NOT move here: the qlib binary stores, catalog.json,
-- catalog.db, store_manifest.json, the macro and market parquet, and the MLflow
-- store under examples/mlruns. Those are shared reference data -- duplicating
-- them per user would be both wrong and enormous. Run logs also stay on disk at
-- webapp/data/runs/<run_id>/; the row here is what gates access to them.

CREATE SCHEMA IF NOT EXISTS aion;
GRANT USAGE ON SCHEMA aion TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Org-scoped records
-- ---------------------------------------------------------------------------
-- ids stay TEXT, not UUID. They are already 12-hex strings (uuid4().hex[:12])
-- and demo slugs, they appear in /runs/:runId URLs, and a run id is also its
-- MLflow experiment name (aion-<run_id>). Switching to uuid would orphan every
-- existing experiment for no gain.

CREATE TABLE IF NOT EXISTS aion.strategies (
    id         TEXT PRIMARY KEY,
    org_id     UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'org')),
    name       TEXT NOT NULL,
    spec       JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS aion.portfolios (
    id         TEXT PRIMARY KEY,
    org_id     UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'org')),
    name       TEXT NOT NULL,
    spec       JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS aion.projects (
    id            TEXT PRIMARY KEY,
    org_id        UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    visibility    TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'org')),
    name          TEXT NOT NULL,
    description   TEXT,
    strategy_ids  TEXT[] NOT NULL DEFAULT '{}',
    portfolio_ids TEXT[] NOT NULL DEFAULT '{}',
    -- Supabase thread/document uuids. Kept as plain arrays with no foreign key
    -- on purpose: those tables are per-user in `public`, and a project must not
    -- become a way to discover that a row exists in someone else's corpus.
    thread_ids    UUID[] NOT NULL DEFAULT '{}',
    document_ids  UUID[] NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS aion.runs (
    id              TEXT PRIMARY KEY,
    org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    visibility      TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'org')),
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'backtest',
    -- A strategy can be deleted while its runs stay as history.
    strategy_id     TEXT REFERENCES aion.strategies(id) ON DELETE SET NULL,
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    phase           TEXT,
    exit_code       INTEGER,
    error           TEXT,
    experiment_name TEXT,
    -- The knobs the runs list renders as columns (model, handler, universe,
    -- benchmark, data_store, topk, n_drop, costs) and the completion metrics
    -- snapshot, so a list survives the mlruns store being cleared.
    params          JSONB NOT NULL DEFAULT '{}',
    metrics         JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS aion.shadow_accounts (
    id           TEXT PRIMARY KEY,
    org_id       UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    visibility   TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'org')),
    label        TEXT NOT NULL,
    journal_path TEXT,
    shadow_id    TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aion_strategies_org      ON aion.strategies(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_aion_strategies_owner    ON aion.strategies(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aion_portfolios_org      ON aion.portfolios(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_aion_portfolios_owner    ON aion.portfolios(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aion_projects_org        ON aion.projects(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_aion_projects_owner      ON aion.projects(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aion_runs_org            ON aion.runs(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_aion_runs_owner          ON aion.runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aion_runs_strategy       ON aion.runs(strategy_id);
CREATE INDEX IF NOT EXISTS idx_aion_runs_status         ON aion.runs(status) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_aion_shadow_owner        ON aion.shadow_accounts(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Per-user state that was previously browser localStorage
-- ---------------------------------------------------------------------------
-- No org_id and no visibility: an agenda seen-mark or a theme is personal by
-- definition and there is nothing to share.

CREATE TABLE IF NOT EXISTS aion.agenda_seen (
    user_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    key      TEXT NOT NULL,
    seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS aion.user_prefs (
    user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    prefs      JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['strategies', 'portfolios', 'projects', 'runs', 'shadow_accounts', 'user_prefs'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS update_aion_%1$s_updated_at ON aion.%1$s', t);
        EXECUTE format(
            'CREATE TRIGGER update_aion_%1$s_updated_at BEFORE UPDATE ON aion.%1$s '
            'FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', t);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- The five org-scoped tables get an identical policy set, applied in a loop so
-- they cannot drift apart. Drift is the failure mode that matters here: a table
-- that quietly ends up with a laxer SELECT than its siblings is exactly the bug
-- this whole migration exists to prevent.
--
--   SELECT  own rows, plus rows explicitly shared to an org you belong to
--   INSERT  only as yourself, only into an org you belong to
--   UPDATE  owner, or an org admin acting on a row inside their org
--   DELETE  same as UPDATE

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['strategies', 'portfolios', 'projects', 'runs', 'shadow_accounts'] LOOP
        EXECUTE format('ALTER TABLE aion.%I ENABLE ROW LEVEL SECURITY', t);

        EXECUTE format('DROP POLICY IF EXISTS %1$s_select ON aion.%1$s', t);
        EXECUTE format($p$
            CREATE POLICY %1$s_select ON aion.%1$s FOR SELECT
            USING (
                user_id = (SELECT auth.uid())
                OR (visibility = 'org' AND public.is_org_member(org_id))
            )$p$, t);

        EXECUTE format('DROP POLICY IF EXISTS %1$s_insert ON aion.%1$s', t);
        EXECUTE format($p$
            CREATE POLICY %1$s_insert ON aion.%1$s FOR INSERT
            WITH CHECK (
                user_id = (SELECT auth.uid())
                AND public.is_org_member(org_id)
            )$p$, t);

        EXECUTE format('DROP POLICY IF EXISTS %1$s_update ON aion.%1$s', t);
        EXECUTE format($p$
            CREATE POLICY %1$s_update ON aion.%1$s FOR UPDATE
            USING (user_id = (SELECT auth.uid()) OR public.is_org_admin(org_id))
            WITH CHECK (user_id = (SELECT auth.uid()) OR public.is_org_admin(org_id))
            $p$, t);

        EXECUTE format('DROP POLICY IF EXISTS %1$s_delete ON aion.%1$s', t);
        EXECUTE format($p$
            CREATE POLICY %1$s_delete ON aion.%1$s FOR DELETE
            USING (user_id = (SELECT auth.uid()) OR public.is_org_admin(org_id))
            $p$, t);

        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON aion.%I TO authenticated', t);
        EXECUTE format('GRANT ALL ON aion.%I TO service_role', t);
    END LOOP;
END $$;

-- Strictly personal tables: one policy covering all four commands.
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['agenda_seen', 'user_prefs'] LOOP
        EXECUTE format('ALTER TABLE aion.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %1$s_own ON aion.%1$s', t);
        EXECUTE format($p$
            CREATE POLICY %1$s_own ON aion.%1$s FOR ALL
            USING (user_id = (SELECT auth.uid()))
            WITH CHECK (user_id = (SELECT auth.uid()))
            $p$, t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON aion.%I TO authenticated', t);
        EXECUTE format('GRANT ALL ON aion.%I TO service_role', t);
    END LOOP;
END $$;
