-- Venue scalability tool: upload -> parse -> analyze -> report -> booking.
--
-- A fund uploads trading data; the scalability_agent background worker (data
-- plane) picks jobs off aion.scalability_jobs, runs the ceiling engine, and
-- writes aion.scalability_reports plus a Storage artifact. The webapp API only
-- ever enqueues (control plane). Booking a consultation with a venue is the
-- hard consent gate: only then is report_shared_at set, and only service-role
-- code may set it.
--
-- RLS follows the aion house pattern from 20260813120001/20260817110100:
-- owner rows via auth.uid() + org membership, service_role full access.
-- Unlike the org-scoped record tables there is deliberately no visibility
-- column and no org-wide SELECT here: trading data is strictly per-owner.

-- ---------------------------------------------------------------------------
-- Venue catalog (versioned reference data)
-- ---------------------------------------------------------------------------
-- Profiles are jsonb so a venue's conditions can grow (financing, ticket
-- tiers, ...) without schema churn. version+venue is the natural key: a
-- report records the catalog_version it was computed against so results stay
-- reproducible and auditable when conditions change.

CREATE TABLE IF NOT EXISTS aion.venue_catalog (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version    INTEGER NOT NULL,
    venue      TEXT NOT NULL,
    profile    JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (version, venue)
);

ALTER TABLE aion.venue_catalog ENABLE ROW LEVEL SECURITY;

-- Reference data: every signed-in user may read the catalog; only
-- service_role (migrations, admin tooling) writes it.
DROP POLICY IF EXISTS venue_catalog_select ON aion.venue_catalog;
CREATE POLICY venue_catalog_select ON aion.venue_catalog FOR SELECT
    USING (true);

GRANT SELECT ON aion.venue_catalog TO authenticated;
GRANT ALL ON aion.venue_catalog TO service_role;

-- Seed v1. Numbers are plausible placeholders pending Phase-0 validation of
-- the engine (see venue-scalability-tool/PRD.md worked example). UBS is the
-- deeper, cheaper venue gated behind a $20M AUM minimum; IBKR is the open,
-- shallower default. liquidity_multiplier >= 1 scales available depth in the
-- square-root impact model.
INSERT INTO aion.venue_catalog (version, venue, profile) VALUES
    (1, 'IBKR', '{
        "display_name": "Interactive Brokers",
        "min_aum": 0,
        "fee_bps_per_side": 2.0,
        "spread_bps": 5.0,
        "min_ticket_usd": 0,
        "liquidity_multiplier": 1.0,
        "booking_link": "https://example.com/book/ibkr"
    }'::jsonb),
    (1, 'UBS', '{
        "display_name": "UBS",
        "min_aum": 20000000,
        "fee_bps_per_side": 1.0,
        "spread_bps": 3.0,
        "min_ticket_usd": 250000,
        "liquidity_multiplier": 1.4,
        "booking_link": "https://example.com/book/ubs"
    }'::jsonb)
ON CONFLICT (version, venue) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Uploads
-- ---------------------------------------------------------------------------
-- One row per uploaded statement file. The file itself lives in the private
-- 'scalability-uploads' bucket at storage_path; summary is the parsed "what
-- we understood" preview the parse_upload job writes back.

CREATE TABLE IF NOT EXISTS aion.scalability_uploads (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    org_id       UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    filename     TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'parsed', 'failed')),
    summary      JSONB,
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aion_scalability_uploads_org   ON aion.scalability_uploads(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_aion_scalability_uploads_owner ON aion.scalability_uploads(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Jobs (the work queue)
-- ---------------------------------------------------------------------------
-- The agent claims with SELECT ... FOR UPDATE SKIP LOCKED, so status +
-- lease_expires_at is the hot path and gets the composite index. report_id is
-- a plain uuid with no FK on purpose: scalability_reports.job_id already
-- points back here, and a FK both ways would force deferred constraints for
-- no gain (same reasoning as projects.thread_ids in 20260813120001).

CREATE TABLE IF NOT EXISTS aion.scalability_jobs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    org_id           UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL CHECK (kind IN ('parse_upload', 'analyze')),
    status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    params           JSONB NOT NULL DEFAULT '{}',
    upload_id        UUID REFERENCES aion.scalability_uploads(id) ON DELETE SET NULL,
    report_id        UUID,
    attempts         INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TIMESTAMPTZ,
    heartbeat_at     TIMESTAMPTZ,
    error            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Claim/reap path: queued jobs, plus running jobs whose lease expired.
CREATE INDEX IF NOT EXISTS idx_aion_scalability_jobs_claim
    ON aion.scalability_jobs(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_aion_scalability_jobs_owner
    ON aion.scalability_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aion_scalability_jobs_upload
    ON aion.scalability_jobs(upload_id);

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------
-- One row per finished analyze job. result holds the full engine output
-- (ceilings per venue, decomposition, confidence band); artifact_path points
-- at the rendered HTML in the 'scalability-uploads' bucket.

CREATE TABLE IF NOT EXISTS aion.scalability_reports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    job_id          UUID REFERENCES aion.scalability_jobs(id) ON DELETE SET NULL,
    upload_id       UUID REFERENCES aion.scalability_uploads(id) ON DELETE SET NULL,
    catalog_version INTEGER NOT NULL,
    current_venue   TEXT NOT NULL,
    result          JSONB NOT NULL,
    artifact_path   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aion_scalability_reports_org   ON aion.scalability_reports(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_aion_scalability_reports_owner ON aion.scalability_reports(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Bookings (consent gate)
-- ---------------------------------------------------------------------------
-- report_shared_at is THE consent gate: null means the venue has seen
-- nothing. It is set exactly once, by the booking-completion code path
-- running as service_role -- authenticated gets INSERT and SELECT on this
-- table but no UPDATE grant and no UPDATE policy, so a user can never set or
-- unset it themselves, even accidentally through the API.

CREATE TABLE IF NOT EXISTS aion.scalability_bookings (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    org_id           UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    report_id        UUID NOT NULL REFERENCES aion.scalability_reports(id) ON DELETE CASCADE,
    venue            TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'booked'
                     CHECK (status IN ('booked', 'completed', 'cancelled')),
    report_shared_at TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aion_scalability_bookings_owner  ON aion.scalability_bookings(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aion_scalability_bookings_report ON aion.scalability_bookings(report_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS update_aion_scalability_uploads_updated_at ON aion.scalability_uploads;
CREATE TRIGGER update_aion_scalability_uploads_updated_at
    BEFORE UPDATE ON aion.scalability_uploads
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_aion_scalability_jobs_updated_at ON aion.scalability_jobs;
CREATE TRIGGER update_aion_scalability_jobs_updated_at
    BEFORE UPDATE ON aion.scalability_jobs
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Uploads/jobs: the API inserts as the owner (authenticated) and reads back
-- for status polling; every state transition after that (parsed/failed,
-- queued/running/succeeded) is the agent acting as service_role, so
-- authenticated gets SELECT + INSERT only.
--
-- Reports: written exclusively by the agent; the owner reads.
--
-- Bookings: owner inserts (with report_shared_at forced null at insert) and
-- selects; nothing else. No UPDATE grant or policy -- see the consent-gate
-- comment on the table.

ALTER TABLE aion.scalability_uploads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scalability_uploads_select ON aion.scalability_uploads;
CREATE POLICY scalability_uploads_select ON aion.scalability_uploads FOR SELECT
    USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS scalability_uploads_insert ON aion.scalability_uploads;
CREATE POLICY scalability_uploads_insert ON aion.scalability_uploads FOR INSERT
    WITH CHECK (
        user_id = (SELECT auth.uid())
        AND public.is_org_member(org_id)
    );

GRANT SELECT, INSERT ON aion.scalability_uploads TO authenticated;
GRANT ALL ON aion.scalability_uploads TO service_role;

ALTER TABLE aion.scalability_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scalability_jobs_select ON aion.scalability_jobs;
CREATE POLICY scalability_jobs_select ON aion.scalability_jobs FOR SELECT
    USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS scalability_jobs_insert ON aion.scalability_jobs;
CREATE POLICY scalability_jobs_insert ON aion.scalability_jobs FOR INSERT
    WITH CHECK (
        user_id = (SELECT auth.uid())
        AND public.is_org_member(org_id)
    );

GRANT SELECT, INSERT ON aion.scalability_jobs TO authenticated;
GRANT ALL ON aion.scalability_jobs TO service_role;

ALTER TABLE aion.scalability_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scalability_reports_select ON aion.scalability_reports;
CREATE POLICY scalability_reports_select ON aion.scalability_reports FOR SELECT
    USING (user_id = (SELECT auth.uid()));

GRANT SELECT ON aion.scalability_reports TO authenticated;
GRANT ALL ON aion.scalability_reports TO service_role;

ALTER TABLE aion.scalability_bookings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scalability_bookings_select ON aion.scalability_bookings;
CREATE POLICY scalability_bookings_select ON aion.scalability_bookings FOR SELECT
    USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS scalability_bookings_insert ON aion.scalability_bookings;
CREATE POLICY scalability_bookings_insert ON aion.scalability_bookings FOR INSERT
    WITH CHECK (
        user_id = (SELECT auth.uid())
        AND public.is_org_member(org_id)
        AND report_shared_at IS NULL
    );

GRANT SELECT, INSERT ON aion.scalability_bookings TO authenticated;
GRANT ALL ON aion.scalability_bookings TO service_role;

-- ---------------------------------------------------------------------------
-- Storage bucket (private): uploads + rendered report artifacts
-- ---------------------------------------------------------------------------
-- Same user-folder pattern as documents/skill-files/workspace-files: the API
-- uploads at {user_id}/... and the agent reads/writes with the service key.

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('scalability-uploads', 'scalability-uploads', false, 104857600)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS scalability_uploads_storage_insert ON storage.objects;
CREATE POLICY scalability_uploads_storage_insert ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'scalability-uploads'
        AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    );

DROP POLICY IF EXISTS scalability_uploads_storage_select ON storage.objects;
CREATE POLICY scalability_uploads_storage_select ON storage.objects FOR SELECT
    USING (
        bucket_id = 'scalability-uploads'
        AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    );
