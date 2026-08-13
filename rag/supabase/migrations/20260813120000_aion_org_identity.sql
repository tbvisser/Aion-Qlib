-- Aion multi-tenancy, part 1 of 2: the organisation layer.
--
-- These tables live in `public` beside user_profiles on purpose. They are the
-- identity model for the whole platform, not just the qlib half. The RAG tables
-- (documents, threads, skills) stay strictly per-user for now, but when they grow
-- org sharing they adopt these same helpers rather than a second identity model.
--
-- Part 2 (20260813120001_aion_schema.sql) creates the `aion` schema whose tables
-- all carry a NOT NULL org_id pointing here.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.organizations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL UNIQUE,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.org_members (
    org_id     UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON public.org_members(user_id);

CREATE TABLE IF NOT EXISTS public.org_invites (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    invited_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    token       TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '14 days',
    accepted_at TIMESTAMPTZ,
    accepted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_invites_email ON public.org_invites(lower(email));
-- One live invite per address per org; re-inviting means reusing or revoking the
-- open one rather than accumulating duplicates the admin screen has to dedupe.
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_invites_pending
    ON public.org_invites(org_id, lower(email)) WHERE accepted_at IS NULL;

ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS default_org_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL;

DROP TRIGGER IF EXISTS update_organizations_updated_at ON public.organizations;
CREATE TRIGGER update_organizations_updated_at
    BEFORE UPDATE ON public.organizations
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Membership helpers
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER is load-bearing, not convenience. A subquery inside an RLS
-- policy is itself subject to the target table's RLS, so an org_members policy
-- that reads org_members recurses until the stack blows. Reading through a
-- definer function runs as the owner with RLS off and breaks the cycle.
--
-- Granting EXECUTE to `authenticated` is safe here and is required, because RLS
-- policies execute as the calling role. Note the contrast with
-- 20260611000000_secure_definer_functions.sql, which revoked EXECUTE from
-- authenticated on the RAG search functions: those take a caller-supplied
-- user_id and would have let a browser client read another user's rows. These
-- take no user id at all -- identity comes from auth.uid() inside the function,
-- which a caller cannot forge.

CREATE OR REPLACE FUNCTION public.is_org_member(p_org UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.org_members
        WHERE org_id = p_org AND user_id = auth.uid()
    );
$$;

CREATE OR REPLACE FUNCTION public.is_org_admin(p_org UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.org_members
        WHERE org_id = p_org AND user_id = auth.uid() AND role IN ('owner', 'admin')
    );
$$;

CREATE OR REPLACE FUNCTION public.is_org_owner(p_org UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.org_members
        WHERE org_id = p_org AND user_id = auth.uid() AND role = 'owner'
    );
$$;

REVOKE EXECUTE ON FUNCTION public.is_org_member(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_org_admin(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_org_owner(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_org_member(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_org_admin(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_org_owner(UUID) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_invites   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orgs_select ON public.organizations;
CREATE POLICY orgs_select ON public.organizations FOR SELECT
    USING (public.is_org_member(id));

DROP POLICY IF EXISTS orgs_update ON public.organizations;
CREATE POLICY orgs_update ON public.organizations FOR UPDATE
    USING (public.is_org_admin(id)) WITH CHECK (public.is_org_admin(id));

DROP POLICY IF EXISTS orgs_delete ON public.organizations;
CREATE POLICY orgs_delete ON public.organizations FOR DELETE
    USING (public.is_org_owner(id));

-- No INSERT policy: creating an org also needs the owner membership row, which
-- the org_members INSERT policy would reject (the creator is not a member yet).
-- public.create_org() below does both atomically.

DROP POLICY IF EXISTS org_members_select ON public.org_members;
CREATE POLICY org_members_select ON public.org_members FOR SELECT
    USING (public.is_org_member(org_id));

DROP POLICY IF EXISTS org_members_insert ON public.org_members;
CREATE POLICY org_members_insert ON public.org_members FOR INSERT
    WITH CHECK (public.is_org_admin(org_id));

DROP POLICY IF EXISTS org_members_update ON public.org_members;
CREATE POLICY org_members_update ON public.org_members FOR UPDATE
    USING (public.is_org_admin(org_id)) WITH CHECK (public.is_org_admin(org_id));

-- An admin can remove anyone; anyone can remove themselves (leave the org).
DROP POLICY IF EXISTS org_members_delete ON public.org_members;
CREATE POLICY org_members_delete ON public.org_members FOR DELETE
    USING (public.is_org_admin(org_id) OR user_id = auth.uid());

DROP POLICY IF EXISTS org_invites_select ON public.org_invites;
CREATE POLICY org_invites_select ON public.org_invites FOR SELECT
    USING (
        public.is_org_admin(org_id)
        OR lower(email) = lower(COALESCE(auth.jwt() ->> 'email', ''))
    );

DROP POLICY IF EXISTS org_invites_write ON public.org_invites;
CREATE POLICY org_invites_write ON public.org_invites FOR ALL
    USING (public.is_org_admin(org_id)) WITH CHECK (public.is_org_admin(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_members   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_invites   TO authenticated;
GRANT ALL ON public.organizations TO service_role;
GRANT ALL ON public.org_members   TO service_role;
GRANT ALL ON public.org_invites   TO service_role;

-- ---------------------------------------------------------------------------
-- Org lifecycle functions
-- ---------------------------------------------------------------------------

-- Creates an org and its owner membership in one transaction. Identity comes
-- from auth.uid(), never from an argument.
CREATE OR REPLACE FUNCTION public.create_org(p_name TEXT, p_slug TEXT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_uid  UUID := auth.uid();
    v_base TEXT;
    v_slug TEXT;
    v_n    INT := 0;
    v_org  UUID;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
    END IF;
    IF COALESCE(trim(p_name), '') = '' THEN
        RAISE EXCEPTION 'organisation name is required' USING ERRCODE = '22023';
    END IF;

    v_base := public._slugify(COALESCE(p_slug, p_name));
    v_slug := v_base;
    WHILE EXISTS (SELECT 1 FROM public.organizations WHERE slug = v_slug) LOOP
        v_n := v_n + 1;
        v_slug := v_base || '-' || v_n::TEXT;
    END LOOP;

    INSERT INTO public.organizations (name, slug, created_by)
    VALUES (trim(p_name), v_slug, v_uid)
    RETURNING id INTO v_org;

    INSERT INTO public.org_members (org_id, user_id, role) VALUES (v_org, v_uid, 'owner');
    UPDATE public.user_profiles SET default_org_id = COALESCE(default_org_id, v_org)
    WHERE user_id = v_uid;

    RETURN v_org;
END;
$$;

-- Accepting an invite has to bypass the org_members INSERT policy (the invitee
-- is not an admin), so it is a definer function keyed on the secret token and
-- cross-checked against the caller's own verified email claim.
CREATE OR REPLACE FUNCTION public.accept_org_invite(p_token TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_uid    UUID := auth.uid();
    v_email  TEXT := lower(COALESCE(auth.jwt() ->> 'email', ''));
    v_invite public.org_invites;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_invite FROM public.org_invites
    WHERE token = p_token AND accepted_at IS NULL AND expires_at > NOW();

    IF NOT FOUND THEN
        RAISE EXCEPTION 'invite not found, already used, or expired' USING ERRCODE = '22023';
    END IF;
    IF lower(v_invite.email) <> v_email THEN
        RAISE EXCEPTION 'invite was issued to a different address' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.org_members (org_id, user_id, role)
    VALUES (v_invite.org_id, v_uid, v_invite.role)
    ON CONFLICT (org_id, user_id) DO NOTHING;

    UPDATE public.org_invites SET accepted_at = NOW(), accepted_by = v_uid WHERE id = v_invite.id;
    UPDATE public.user_profiles SET default_org_id = COALESCE(default_org_id, v_invite.org_id)
    WHERE user_id = v_uid;

    RETURN v_invite.org_id;
END;
$$;

-- user_profiles gets no UPDATE policy on purpose: one would also expose the
-- is_admin column, and RLS cannot restrict columns. This narrow function is the
-- only write path a user has to their own profile.
CREATE OR REPLACE FUNCTION public.set_default_org(p_org UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT public.is_org_member(p_org) THEN
        RAISE EXCEPTION 'not a member of that organisation' USING ERRCODE = '42501';
    END IF;
    UPDATE public.user_profiles SET default_org_id = p_org WHERE user_id = auth.uid();
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_org(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.accept_org_invite(TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_default_org(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_org(TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accept_org_invite(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_default_org(UUID) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Every account owns an organisation
-- ---------------------------------------------------------------------------
-- The qlib tables in part 2 declare org_id NOT NULL, so an org-less account
-- would be unable to save anything. Giving every user a personal org at signup
-- makes that impossible. Joining a company org later is additive -- the personal
-- one stays, and the UI switches between them.

CREATE OR REPLACE FUNCTION public._slugify(p_text TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
    SELECT COALESCE(
        NULLIF(trim(BOTH '-' FROM regexp_replace(lower(COALESCE(p_text, '')), '[^a-z0-9]+', '-', 'g')), ''),
        'org'
    );
$$;

CREATE OR REPLACE FUNCTION public.ensure_personal_org(p_user UUID, p_email TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_existing UUID;
    v_base     TEXT;
    v_slug     TEXT;
    v_n        INT := 0;
    v_org      UUID;
BEGIN
    SELECT org_id INTO v_existing FROM public.org_members
    WHERE user_id = p_user ORDER BY created_at LIMIT 1;
    IF FOUND THEN
        RETURN v_existing;
    END IF;

    v_base := public._slugify(split_part(COALESCE(p_email, 'user'), '@', 1));
    v_slug := v_base;
    WHILE EXISTS (SELECT 1 FROM public.organizations WHERE slug = v_slug) LOOP
        v_n := v_n + 1;
        v_slug := v_base || '-' || v_n::TEXT;
    END LOOP;

    INSERT INTO public.organizations (name, slug, created_by)
    VALUES (v_base, v_slug, p_user)
    RETURNING id INTO v_org;

    INSERT INTO public.org_members (org_id, user_id, role)
    VALUES (v_org, p_user, 'owner')
    ON CONFLICT (org_id, user_id) DO NOTHING;

    UPDATE public.user_profiles SET default_org_id = COALESCE(default_org_id, v_org)
    WHERE user_id = p_user;

    RETURN v_org;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.ensure_personal_org(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_personal_org(UUID, TEXT) TO service_role;

-- Extend the existing on_auth_user_created trigger rather than adding a second
-- one, so profile and org creation stay in a single statement's transaction.
CREATE OR REPLACE FUNCTION public.create_user_profile()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    INSERT INTO public.user_profiles (user_id, is_admin)
    VALUES (NEW.id, false)
    ON CONFLICT (user_id) DO NOTHING;

    PERFORM public.ensure_personal_org(NEW.id, NEW.email);
    RETURN NEW;
END;
$$;

-- Backfill the accounts that predate this migration.
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT id, email FROM auth.users LOOP
        PERFORM public.ensure_personal_org(r.id, r.email);
    END LOOP;
END $$;
