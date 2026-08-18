"""Who you are, who you work with, and the state that follows you around.

Three things that all key off the signed-in account and had nowhere to live
before:

* **Organisations** -- the list you belong to, the one you are acting in, and
  the membership and invite management behind the switcher.
* **Preferences** -- theme, sidebar, model choice. Previously browser
  localStorage, which meant your setup was a property of the machine you
  happened to be sitting at rather than of your account.
* **Agenda seen-marks and shadow accounts** -- same story, same fix.

Org writes go through the SECURITY DEFINER functions in ``public`` rather than
straight INSERTs. Creating an organisation needs both the row and its owner
membership, and the membership policy would reject the second half because the
creator is not a member yet; accepting an invite has the same shape from the
other side. Doing them in the database keeps both halves in one transaction and
keeps the identity check on ``auth.uid()`` where it cannot be spoofed.
"""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Body, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from psycopg import errors as pg_errors

from ..auth import Principal, get_principal
from ..db import user_tx

logger = logging.getLogger(__name__)

router = APIRouter()


# --------------------------------------------------------------------------
# Identity
# --------------------------------------------------------------------------
@router.get("/me")
def me(principal: Principal = Depends(get_principal)) -> dict:
    """The signed-in account, and every organisation it can act in.

    The UI needs all of it on first paint: the switcher renders the list, and
    whether an admin-only control appears depends on the role in the *current*
    org, not on some global flag.
    """
    with user_tx(principal.user_id) as cur:
        cur.execute(
            "SELECT o.id, o.name, o.slug, m.role "
            "FROM public.org_members m "
            "JOIN public.organizations o ON o.id = m.org_id "
            "WHERE m.user_id = %s ORDER BY o.name",
            (principal.user_id,),
        )
        orgs = [
            {"id": str(r["id"]), "name": r["name"], "slug": r["slug"], "role": r["role"]}
            for r in cur.fetchall()
        ]
    return {
        "user_id": principal.user_id,
        "email": principal.email,
        "org_id": principal.org_id,
        "org_role": principal.org_role,
        "is_org_admin": principal.is_org_admin,
        "organizations": orgs,
    }


class OrgCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    slug: str | None = Field(None, max_length=80)


@router.post("/orgs")
def create_org(req: OrgCreate, principal: Principal = Depends(get_principal)) -> dict:
    with user_tx(principal.user_id) as cur:
        cur.execute("SELECT public.create_org(%s, %s) AS id", (req.name, req.slug))
        org_id = str(cur.fetchone()["id"])
        cur.execute(
            "SELECT id, name, slug FROM public.organizations WHERE id = %s", (org_id,)
        )
        row = cur.fetchone()
    return {"id": str(row["id"]), "name": row["name"], "slug": row["slug"], "role": "owner"}


@router.put("/me/default-org")
def set_default_org(
    org_id: str = Body(..., embed=True),
    principal: Principal = Depends(get_principal),
) -> dict:
    """Remember which organisation to open in next time.

    The switcher also sends X-Aion-Org per request, so this is the durable half:
    without it, a new browser would land back in the personal org every time.
    """
    with user_tx(principal.user_id) as cur:
        try:
            cur.execute("SELECT public.set_default_org(%s)", (org_id,))
        except pg_errors.InsufficientPrivilege as exc:
            raise HTTPException(403, "You are not a member of that organisation.") from exc
    return {"ok": True, "org_id": org_id}


# --------------------------------------------------------------------------
# Members and invites
# --------------------------------------------------------------------------
@router.get("/orgs/{org_id}/members")
def list_members(org_id: str, principal: Principal = Depends(get_principal)) -> dict:
    with user_tx(principal.user_id) as cur:
        cur.execute(
            "SELECT m.user_id, m.role, m.created_at, (m.user_id = %s) AS is_you "
            "FROM public.org_members m WHERE m.org_id = %s ORDER BY m.created_at",
            (principal.user_id, org_id),
        )
        rows = cur.fetchall()
    # Not a member -> RLS returned nothing, and there is no such org as far as
    # this caller is concerned.
    if not rows:
        raise HTTPException(404, "Unknown organisation")
    return {
        "members": [
            {"user_id": str(r["user_id"]), "role": r["role"],
             "joined_at": r["created_at"].isoformat(), "is_you": r["is_you"]}
            for r in rows
        ]
    }


class InviteCreate(BaseModel):
    email: str = Field(..., min_length=3, max_length=200)
    role: str = Field("member", pattern="^(owner|admin|member)$")


@router.post("/orgs/{org_id}/invites")
def create_invite(
    org_id: str, req: InviteCreate, principal: Principal = Depends(get_principal)
) -> dict:
    """Invite a colleague by email. Admins only -- enforced by RLS.

    Returns the token. There is no mail sender in this deployment, so the admin
    passes the link on themselves; saying so plainly beats pretending an email
    went out.
    """
    with user_tx(principal.user_id) as cur:
        try:
            cur.execute(
                "INSERT INTO public.org_invites (org_id, email, role, invited_by) "
                "VALUES (%s, %s, %s, %s) RETURNING id, email, role, token, expires_at",
                (org_id, req.email.strip().lower(), req.role, principal.user_id),
            )
        except pg_errors.UniqueViolation as exc:
            raise HTTPException(
                409, f"{req.email} already has an open invite to this organisation."
            ) from exc
        except pg_errors.InsufficientPrivilege as exc:
            raise HTTPException(403, "Only organisation admins can invite people.") from exc
        row = cur.fetchone()
        if row is None:
            raise HTTPException(403, "Only organisation admins can invite people.")
    return {
        "id": str(row["id"]), "email": row["email"], "role": row["role"],
        "token": row["token"], "expires_at": row["expires_at"].isoformat(),
    }


@router.get("/orgs/{org_id}/invites")
def list_invites(org_id: str, principal: Principal = Depends(get_principal)) -> dict:
    with user_tx(principal.user_id) as cur:
        cur.execute(
            "SELECT id, email, role, token, expires_at, accepted_at "
            "FROM public.org_invites WHERE org_id = %s ORDER BY created_at DESC",
            (org_id,),
        )
        return {
            "invites": [
                {"id": str(r["id"]), "email": r["email"], "role": r["role"],
                 "token": r["token"], "expires_at": r["expires_at"].isoformat(),
                 "accepted_at": r["accepted_at"].isoformat() if r["accepted_at"] else None}
                for r in cur.fetchall()
            ]
        }


@router.post("/invites/accept")
def accept_invite(
    token: str = Body(..., embed=True), principal: Principal = Depends(get_principal)
) -> dict:
    with user_tx(principal.user_id) as cur:
        try:
            cur.execute("SELECT public.accept_org_invite(%s) AS org_id", (token,))
        except (pg_errors.RaiseException, pg_errors.InsufficientPrivilege,
                pg_errors.InvalidParameterValue) as exc:
            # The function distinguishes expired, already-used and wrong-address;
            # its message is the useful one, so pass it through rather than
            # flattening all three into "invalid invite".
            raise HTTPException(400, str(exc).splitlines()[0]) from exc
        return {"org_id": str(cur.fetchone()["org_id"])}


@router.delete("/orgs/{org_id}/members/{user_id}", status_code=204)
def remove_member(
    org_id: str, user_id: str, principal: Principal = Depends(get_principal)
) -> Response:
    """Remove someone, or leave yourself. RLS allows exactly those two."""
    with user_tx(principal.user_id) as cur:
        cur.execute(
            "DELETE FROM public.org_members WHERE org_id = %s AND user_id = %s",
            (org_id, user_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(
                403, "Only an organisation admin can remove other members."
            )
    return Response(status_code=204)


# --------------------------------------------------------------------------
# Preferences and per-user state
# --------------------------------------------------------------------------
@router.get("/prefs")
def get_prefs(principal: Principal = Depends(get_principal)) -> dict:
    with user_tx(principal.user_id) as cur:
        cur.execute("SELECT prefs FROM aion.user_prefs WHERE user_id = %s",
                    (principal.user_id,))
        row = cur.fetchone()
    return {"prefs": (row["prefs"] if row else {})}


@router.put("/prefs")
def put_prefs(
    prefs: dict = Body(..., embed=True), principal: Principal = Depends(get_principal)
) -> dict:
    """Merge, never replace.

    Two tabs saving different settings should not undo each other, and the theme
    toggle has no business knowing what the sidebar stored.
    """
    with user_tx(principal.user_id) as cur:
        cur.execute(
            "INSERT INTO aion.user_prefs (user_id, prefs) VALUES (%s, %s::jsonb) "
            "ON CONFLICT (user_id) DO UPDATE "
            "  SET prefs = aion.user_prefs.prefs || EXCLUDED.prefs, updated_at = NOW() "
            "RETURNING prefs",
            (principal.user_id, json.dumps(prefs)),
        )
        return {"prefs": cur.fetchone()["prefs"]}


@router.get("/agenda/seen")
def get_seen(principal: Principal = Depends(get_principal)) -> dict:
    with user_tx(principal.user_id) as cur:
        cur.execute("SELECT key, seen_at FROM aion.agenda_seen WHERE user_id = %s",
                    (principal.user_id,))
        return {"seen": {r["key"]: r["seen_at"].isoformat() for r in cur.fetchall()}}


@router.put("/agenda/seen")
def put_seen(
    key: str = Body(..., embed=True, max_length=200),
    principal: Principal = Depends(get_principal),
) -> dict:
    with user_tx(principal.user_id) as cur:
        cur.execute(
            "INSERT INTO aion.agenda_seen (user_id, key) VALUES (%s, %s) "
            "ON CONFLICT (user_id, key) DO UPDATE SET seen_at = NOW() "
            "RETURNING seen_at",
            (principal.user_id, key),
        )
        return {"key": key, "seen_at": cur.fetchone()["seen_at"].isoformat()}


class ShadowAccount(BaseModel):
    id: str | None = Field(None, max_length=64)
    label: str = Field(..., min_length=1, max_length=120)
    journal_path: str | None = Field(None, max_length=500)
    shadow_id: str | None = Field(None, max_length=200)


@router.get("/shadow-accounts")
def list_shadow_accounts(principal: Principal = Depends(get_principal)) -> dict:
    with user_tx(principal.user_id) as cur:
        cur.execute(
            "SELECT id, label, journal_path, shadow_id, created_at "
            "FROM aion.shadow_accounts ORDER BY created_at DESC"
        )
        return {
            "accounts": [
                {"id": r["id"], "label": r["label"], "journal_path": r["journal_path"],
                 "shadow_id": r["shadow_id"], "created_at": r["created_at"].isoformat()}
                for r in cur.fetchall()
            ]
        }


@router.post("/shadow-accounts")
def save_shadow_account(
    req: ShadowAccount, principal: Principal = Depends(get_principal)
) -> dict:
    import uuid

    account_id = req.id or uuid.uuid4().hex[:12]
    with user_tx(principal.user_id) as cur:
        cur.execute(
            "INSERT INTO aion.shadow_accounts "
            "  (id, org_id, user_id, label, journal_path, shadow_id) "
            "VALUES (%s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, "
            "  journal_path = EXCLUDED.journal_path, shadow_id = EXCLUDED.shadow_id, "
            "  updated_at = NOW() "
            "RETURNING id, label, journal_path, shadow_id, created_at",
            (account_id, principal.org_id, principal.user_id, req.label,
             req.journal_path, req.shadow_id),
        )
        r = cur.fetchone()
    return {"id": r["id"], "label": r["label"], "journal_path": r["journal_path"],
            "shadow_id": r["shadow_id"], "created_at": r["created_at"].isoformat()}


@router.delete("/shadow-accounts/{account_id}", status_code=204)
def delete_shadow_account(
    account_id: str, principal: Principal = Depends(get_principal)
) -> Response:
    with user_tx(principal.user_id) as cur:
        cur.execute("DELETE FROM aion.shadow_accounts WHERE id = %s", (account_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, "No such shadow account")
    return Response(status_code=204)
