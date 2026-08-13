-- Resolve the caller's email from auth.users rather than from a JWT claim.
--
-- 20260813120000 compared invite addresses against `auth.jwt() ->> 'email'`.
-- That works for PostgREST, which forwards the whole verified token, but not
-- for webapp/api, which opens its own connection and publishes only the claims
-- it needs -- `sub` and `role`. The email came back empty there, so accepting a
-- legitimate invite was refused as "issued to a different address".
--
-- Reading auth.users is the better fix regardless of the caller: the address is
-- then whatever the identity provider actually holds, not whatever the
-- application chose to put in a GUC. Nothing outside the database can influence
-- it, and every client behaves the same way.

CREATE OR REPLACE FUNCTION public.current_email()
RETURNS TEXT LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, auth AS $$
    SELECT lower(email) FROM auth.users WHERE id = auth.uid();
$$;

REVOKE EXECUTE ON FUNCTION public.current_email() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_email() TO authenticated, service_role;

-- An invitee needs to see their own pending invite in order to accept it.
DROP POLICY IF EXISTS org_invites_select ON public.org_invites;
CREATE POLICY org_invites_select ON public.org_invites FOR SELECT
    USING (
        public.is_org_admin(org_id)
        OR lower(email) = public.current_email()
    );

CREATE OR REPLACE FUNCTION public.accept_org_invite(p_token TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_uid    UUID := auth.uid();
    v_email  TEXT := public.current_email();
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
    -- Still checked, and still the point: a leaked token is only usable by the
    -- address it was issued to.
    IF v_email IS NULL OR lower(v_invite.email) <> v_email THEN
        RAISE EXCEPTION 'invite was issued to a different address' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.org_members (org_id, user_id, role)
    VALUES (v_invite.org_id, v_uid, v_invite.role)
    ON CONFLICT (org_id, user_id) DO NOTHING;

    UPDATE public.org_invites SET accepted_at = NOW(), accepted_by = v_uid
    WHERE id = v_invite.id;
    UPDATE public.user_profiles SET default_org_id = COALESCE(default_org_id, v_invite.org_id)
    WHERE user_id = v_uid;

    RETURN v_invite.org_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.accept_org_invite(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_org_invite(TEXT) TO authenticated, service_role;
