#!/usr/bin/env python3
"""Provision / delete / GC per-worktree test accounts in the shared Supabase.

Every git worktree shares the one local Supabase DB, so the regression suites must
run against per-worktree accounts or parallel worktrees corrupt each other's data
(both suites wipe all threads+folders for the logged-in user at session start).

Emails (tag = worktree leaf, recorded as `.worktree-ports.json.tag`):
    user1 (admin):     test-wt-<tag>@test.com
    user2 (non-admin): test2-wt-<tag>@test.com

Usage (venv python; run from backend/ or with backend/ on sys.path):
    python scripts/provision_test_users.py --tag <tag>
        Create or password-rotate both accounts; print ONE JSON line of creds to
        stdout: {"user1":{"email","password"},"user2":{"email","password"}}.
    python scripts/provision_test_users.py --delete --tag <tag>
        Delete both accounts (their data cascades; no-cascade tables cleared first).
    python scripts/provision_test_users.py --gc --keep-tags a,b,c
        Delete any test-wt-*/test2-wt-* accounts whose tag is not in the keep set.

All human-readable logging goes to STDERR; only the creds JSON goes to STDOUT, so a
PowerShell caller can `ConvertFrom-Json` stdout without log noise.
"""
import argparse
import json
import re
import secrets
import sys
from pathlib import Path

# Bootstrap: make `app` importable and load backend/.env (matches sync_skills.py).
backend_dir = Path(__file__).resolve().parent.parent
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(backend_dir / ".env")

from supabase import create_client, Client  # noqa: E402
from app.config import get_settings  # noqa: E402

EMAIL_DOMAIN = "test.com"
USER1_PREFIX = "test-wt-"
USER2_PREFIX = "test2-wt-"
# A worktree leaf: letters, digits, dot, dash, underscore (e.g. recursing-agnesi-b44d47).
_TAG_RE = re.compile(r"^[A-Za-z0-9._-]+$")
# Tables that FK auth.users WITHOUT `on delete cascade` -> clear before delete_user
# or the hard user delete FK-errors. (sandbox is off by default; be robust anyway.)
_NO_CASCADE_TABLES = ("code_executions", "sandbox_files")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _client() -> Client:
    settings = get_settings()
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


def _emails(tag: str) -> tuple[str, str]:
    return f"{USER1_PREFIX}{tag}@{EMAIL_DOMAIN}", f"{USER2_PREFIX}{tag}@{EMAIL_DOMAIN}"


def _all_users(sb: Client) -> list:
    """All auth users, paginated (list_users returns at most per_page per call)."""
    users: list = []
    page = 1
    while True:
        batch = list(sb.auth.admin.list_users(page=page, per_page=200) or [])
        users.extend(batch)
        if len(batch) < 200:
            break
        page += 1
    return users


def _find_by_email(sb: Client, email: str):
    target = email.lower()
    for u in _all_users(sb):
        if (getattr(u, "email", "") or "").lower() == target:
            return u
    return None


def _ensure_user(sb: Client, email: str, password: str):
    """Create the user (email pre-confirmed) or rotate its password if it exists."""
    try:
        resp = sb.auth.admin.create_user(
            {"email": email, "password": password, "email_confirm": True}
        )
        log(f"  created {email}")
        return resp.user
    except Exception as exc:  # already registered (or transient) -> look up + rotate
        log(f"  create {email} failed ({exc}); trying existing user")
        user = _find_by_email(sb, email)
        if not user:
            raise
        sb.auth.admin.update_user_by_id(
            user.id, {"password": password, "email_confirm": True}
        )
        log(f"  rotated password for existing {email}")
        return user


def _set_admin(sb: Client, user_id: str, is_admin: bool) -> None:
    # The signup trigger inserts the profile row (is_admin=false) synchronously on
    # create; upsert flips it (service role bypasses RLS).
    sb.table("user_profiles").upsert(
        {"user_id": user_id, "is_admin": is_admin}, on_conflict="user_id"
    ).execute()


def _delete_user(sb: Client, user) -> None:
    uid = user.id
    for tbl in _NO_CASCADE_TABLES:
        try:
            sb.table(tbl).delete().eq("user_id", uid).execute()
        except Exception as exc:
            log(f"  warn: clearing {tbl} for {uid} failed: {exc}")
    sb.auth.admin.delete_user(uid)
    log(f"  deleted {getattr(user, 'email', uid)}")


def cmd_create(tag: str) -> None:
    sb = _client()
    e1, e2 = _emails(tag)
    p1, p2 = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    u1 = _ensure_user(sb, e1, p1)
    u2 = _ensure_user(sb, e2, p2)
    _set_admin(sb, u1.id, True)
    _set_admin(sb, u2.id, False)
    json.dump(
        {
            "user1": {"email": e1, "password": p1},
            "user2": {"email": e2, "password": p2},
        },
        sys.stdout,
    )
    sys.stdout.write("\n")
    sys.stdout.flush()
    log(f"create: provisioned accounts for tag '{tag}' (user1 admin, user2 non-admin)")


def cmd_delete(tag: str) -> None:
    sb = _client()
    deleted = 0
    for email in _emails(tag):
        user = _find_by_email(sb, email)
        if user:
            _delete_user(sb, user)
            deleted += 1
        else:
            log(f"  absent: {email}")
    log(f"delete: removed {deleted} account(s) for tag '{tag}'")


def _tag_of(email: str):
    for prefix in (USER1_PREFIX, USER2_PREFIX):
        if email.startswith(prefix) and email.endswith("@" + EMAIL_DOMAIN):
            return email[len(prefix) : -(len(EMAIL_DOMAIN) + 1)]
    return None


def cmd_gc(keep_tags: set) -> None:
    sb = _client()
    removed = kept = 0
    for u in _all_users(sb):
        tag = _tag_of(getattr(u, "email", "") or "")
        if tag is None:
            continue  # not a worktree test account (e.g. test@/test2@) -> never touch
        if tag in keep_tags:
            kept += 1
            continue
        _delete_user(sb, u)
        removed += 1
    log(f"gc: removed {removed} orphan account(s), kept {kept} live, "
        f"keep-tags={sorted(keep_tags)}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Per-worktree test account provisioning.")
    ap.add_argument("--tag", help="worktree leaf (provision/delete target)")
    ap.add_argument("--delete", action="store_true", help="delete the tag's accounts")
    ap.add_argument("--gc", action="store_true", help="reap orphan worktree accounts")
    ap.add_argument("--keep-tags", default="", help="comma-separated live tags (gc)")
    args = ap.parse_args()

    if args.gc:
        cmd_gc({t.strip() for t in args.keep_tags.split(",") if t.strip()})
        return 0

    if not args.tag or not _TAG_RE.match(args.tag):
        log("error: --tag <worktree-leaf> required (letters/digits/.-_ only)")
        return 2

    if args.delete:
        cmd_delete(args.tag)
    else:
        cmd_create(args.tag)
    return 0


if __name__ == "__main__":
    sys.exit(main())
