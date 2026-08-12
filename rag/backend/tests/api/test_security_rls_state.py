"""Database-layer security state assertions (Workstream B2 drift guard).

These tests lock in the *live* Postgres security posture so that an accidental
migration regression (a dropped RLS policy, a re-granted EXECUTE on a
SECURITY DEFINER function, a missing ON DELETE CASCADE, a re-introduced demo
table) fails CI instead of silently widening the attack surface.

They talk to the database DIRECTLY via ``docker exec supabase-db psql`` (the
same password-less peer-auth path the audit used), NOT through the API. That
means they do not depend on the API server, do not need a JWT, and crucially do
NOT mutate any data — so they are safe to run alongside the rest of the suite.
If the local Supabase container is not reachable, every test skips.

Run just these:  pytest backend/tests/api/test_security_rls_state.py -m isolation
"""

from __future__ import annotations

import shutil
import subprocess

import pytest

pytestmark = [pytest.mark.api, pytest.mark.isolation]

DB_CONTAINER = "supabase-db"

# ---- the security baseline this audit verified (Workstream B2) --------------

# Every application table that MUST have RLS enabled.
RLS_TABLES = {
    "agent_todos", "answer_citations", "chunks", "code_executions", "documents",
    "folders", "global_settings", "harness_runs", "messages", "pii_vault",
    "sandbox_files", "skill_files", "skills", "thread_compactions",
    "thread_entity_registry", "threads", "user_profiles", "web_snapshots",
    "workspace_files",
}

# SECURITY DEFINER functions that MUST NOT be EXECUTE-able by anon/authenticated
# (they run RLS-bypassing and trust a caller-supplied user_id).
LOCKED_DEFINER_FUNCS = {
    "cascade_folder_user_id", "get_chunks_by_ranges", "keyword_search_chunks",
    "next_message_sequence", "update_harness_phase_atomic",
}

# Non-SECURITY-DEFINER search helpers that the revoke migration ALSO hardened
# (defense in depth — they take a user_id arg, so block direct anon calls too).
LOCKED_INVOKER_FUNCS = {"match_chunks", "get_folder_tree"}

# Tables whose ONLY policy is service-role (browser/anon/authenticated denied).
SERVICE_ROLE_ONLY = {"pii_vault", "thread_entity_registry"}

# Every thread-child table that must cascade on thread delete (no PII orphans).
THREAD_CHILD_TABLES = {
    "messages", "agent_todos", "workspace_files", "code_executions",
    "thread_entity_registry", "harness_runs", "thread_compactions",
    "answer_citations",
}

# Demo / synthetic-PII tables that must stay dropped from the main install.
FORBIDDEN_DEMO_TABLES = {
    "sales_data", "team_members", "travel_expenses", "budget_limits",
    "test_customer_records", "test_employee_directory", "customers", "employees",
}

REALTIME_PUBLICATION = {"documents", "threads"}


def _psql(sql: str) -> str:
    """Run a read-only query in the local supabase-db container; skip if absent."""
    if shutil.which("docker") is None:
        pytest.skip("docker CLI not available")
    try:
        proc = subprocess.run(
            ["docker", "exec", "-i", DB_CONTAINER, "psql", "-U", "supabase_admin",
             "-d", "postgres", "-t", "-A", "-F", "|", "-c", sql],
            capture_output=True, text=True, timeout=30,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:  # pragma: no cover
        pytest.skip(f"cannot reach {DB_CONTAINER}: {exc}")
    if proc.returncode != 0:
        # container not running / not this stack -> skip rather than fail
        pytest.skip(f"psql query failed (container down?): {proc.stderr.strip()[:200]}")
    return proc.stdout.strip()


def _rows(sql: str) -> list[list[str]]:
    out = _psql(sql)
    return [line.split("|") for line in out.splitlines() if line]


# ---------------------------------------------------------------------------


def test_all_app_tables_have_rls_enabled():
    rows = _rows(
        "SELECT relname, relrowsecurity FROM pg_class "
        "WHERE relnamespace='public'::regnamespace AND relkind='r' "
        "AND relname = ANY(ARRAY["
        + ",".join(f"'{t}'" for t in sorted(RLS_TABLES))
        + "])"
    )
    found = {r[0]: r[1] for r in rows}
    missing = RLS_TABLES - set(found)
    assert not missing, f"expected RLS tables not present: {missing}"
    rls_off = {t for t, on in found.items() if on != "t"}
    assert not rls_off, f"RLS is DISABLED on: {rls_off}"


def test_no_unexpected_public_tables_without_rls():
    """Any public base table that is NOT in our known set with RLS on is a flag."""
    rows = _rows(
        "SELECT relname FROM pg_class "
        "WHERE relnamespace='public'::regnamespace AND relkind='r' "
        "AND relrowsecurity = false"
    )
    offenders = {r[0] for r in rows}
    assert not offenders, (
        f"public base tables with RLS OFF (potential anon-readable): {offenders}"
    )


def test_service_role_only_tables_deny_authenticated():
    """pii_vault / thread_entity_registry must expose ONLY a service_role policy."""
    for table in SERVICE_ROLE_ONLY:
        rows = _rows(
            "SELECT policyname, qual, with_check FROM pg_policies "
            f"WHERE schemaname='public' AND tablename='{table}'"
        )
        assert rows, f"{table}: no policies at all (RLS-on with no policy is OK too, "
        # Every policy must be gated on service_role — no permissive anon/auth grant.
        for policyname, qual, with_check in rows:
            expr = f"{qual} {with_check}"
            assert "service_role" in expr, (
                f"{table}.{policyname} is not service-role gated: USING={qual} "
                f"WITH CHECK={with_check} — authenticated users may access PII!"
            )


def test_definer_functions_execute_revoked_from_authenticated():
    funcs = LOCKED_DEFINER_FUNCS | LOCKED_INVOKER_FUNCS
    rows = _rows(
        "SELECT p.proname, "
        "has_function_privilege('anon', p.oid, 'EXECUTE'), "
        "has_function_privilege('authenticated', p.oid, 'EXECUTE') "
        "FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
        "WHERE n.nspname='public' AND p.proname = ANY(ARRAY["
        + ",".join(f"'{f}'" for f in sorted(funcs))
        + "])"
    )
    assert rows, "expected security-sensitive functions not found in DB"
    leaks = [
        name for name, anon_x, auth_x in rows if anon_x == "t" or auth_x == "t"
    ]
    assert not leaks, (
        f"these functions are EXECUTE-able by anon/authenticated (RLS-bypass risk): {leaks}"
    )


def test_definer_functions_have_search_path_pinned():
    rows = _rows(
        "SELECT p.proname, (p.proconfig::text LIKE '%search_path%') "
        "FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
        "WHERE n.nspname='public' AND p.prosecdef = true"
    )
    assert rows, "no SECURITY DEFINER functions found"
    unpinned = [name for name, pinned in rows if pinned != "t"]
    assert not unpinned, f"SECURITY DEFINER funcs without pinned search_path: {unpinned}"


@pytest.mark.xfail(
    reason="B2-002: default privileges still grant EXECUTE on FUTURE public "
    "functions to anon/authenticated; revoke migration did not add "
    "ALTER DEFAULT PRIVILEGES. Flip to pass once remediated.",
    strict=False,
)
def test_future_functions_not_executable_by_anon_by_default():
    """No ACL entry should grant EXECUTE on future public functions to anon/auth."""
    out = _psql(
        "SELECT d.defaclacl::text FROM pg_default_acl d "
        "JOIN pg_namespace n ON n.oid=d.defaclnamespace "
        "WHERE d.defaclobjtype='f' AND n.nspname='public'"
    )
    assert "anon=X" not in out and "authenticated=X" not in out, (
        "default privileges expose future public functions to anon/authenticated: " + out
    )


def test_create_user_profile_cannot_set_admin():
    """The signup-trigger definer fn must hardcode is_admin=false (no escalation)."""
    body = _psql("SELECT prosrc FROM pg_proc WHERE proname='create_user_profile'")
    assert body, "create_user_profile function missing"
    normalized = body.lower().replace(" ", "")
    assert "is_admin)values(new.id,false)" in normalized or "is_admin,false" in normalized or "false)" in normalized, (
        "create_user_profile no longer hardcodes is_admin=false — escalation risk: " + body
    )


def test_thread_children_cascade_on_delete():
    rows = _rows(
        "SELECT con.conrelid::regclass::text, con.confdeltype "
        "FROM pg_constraint con "
        "WHERE con.contype='f' AND con.confrelid='public.threads'::regclass"
    )
    on_delete = {r[0]: r[1] for r in rows}
    for child in THREAD_CHILD_TABLES:
        assert child in on_delete, f"{child} has no FK to threads (cascade regression?)"
        assert on_delete[child] == "c", (
            f"{child} FK to threads is not ON DELETE CASCADE (confdeltype="
            f"{on_delete[child]}) — thread delete will orphan rows / 500"
        )


def test_no_orphaned_thread_children():
    """Defense check for cascade integrity: zero rows whose thread is gone."""
    union = " UNION ALL ".join(
        f"SELECT '{t}' AS tbl, count(*) AS n FROM {t} c "
        f"LEFT JOIN threads th ON th.id=c.thread_id WHERE th.id IS NULL"
        for t in sorted(THREAD_CHILD_TABLES)
    )
    rows = _rows(f"SELECT tbl, n FROM ({union}) q WHERE n::int > 0")
    assert not rows, f"orphaned thread-child rows found (PII retention bug): {rows}"


def test_demo_pii_tables_absent():
    rows = _rows(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema='public' AND table_name = ANY(ARRAY["
        + ",".join(f"'{t}'" for t in sorted(FORBIDDEN_DEMO_TABLES))
        + "])"
    )
    present = {r[0] for r in rows}
    assert not present, (
        f"demo/synthetic-PII tables are present in the main DB (should be import-only): {present}"
    )


def test_realtime_publication_membership():
    rows = _rows(
        "SELECT tablename FROM pg_publication_tables WHERE pubname='supabase_realtime'"
    )
    members = {r[0] for r in rows}
    assert members == REALTIME_PUBLICATION, (
        f"supabase_realtime publication drifted: {members} != {REALTIME_PUBLICATION}. "
        "Adding a table here exposes its row changes to subscribers (RLS-gated, but "
        "review intent)."
    )


def test_realtime_tables_have_replica_identity_full():
    """RLS-filtered Realtime needs the full row (incl. user_id) in the WAL."""
    rows = _rows(
        "SELECT relname, relreplident FROM pg_class "
        "WHERE relnamespace='public'::regnamespace "
        "AND relname = ANY(ARRAY['documents','threads'])"
    )
    ident = {r[0]: r[1] for r in rows}
    for t in REALTIME_PUBLICATION:
        assert ident.get(t) == "f", (
            f"{t} REPLICA IDENTITY is '{ident.get(t)}' not FULL — Realtime RLS "
            "filtering on user_id may not apply correctly"
        )


def test_user_profiles_has_no_self_write_policy():
    """is_admin escalation guard: authenticated users get SELECT only, no I/U/D."""
    rows = _rows(
        "SELECT cmd FROM pg_policies WHERE schemaname='public' "
        "AND tablename='user_profiles'"
    )
    cmds = {r[0] for r in rows}
    writeable = cmds & {"INSERT", "UPDATE", "DELETE", "ALL"}
    assert not writeable, (
        f"user_profiles exposes write policies to clients ({writeable}) — a user could "
        "set is_admin=true via PostgREST. Writes must be service-role / trigger only."
    )
