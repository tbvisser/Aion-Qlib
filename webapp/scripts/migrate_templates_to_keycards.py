"""Migrate shipped strategy templates into the keycards table.

Each curated template becomes a keycard marked ``is_template=true`` with a stable
id derived from its filename, so re-running the script updates rather than
duplicates.

Usage, from the repo root::

    docker compose exec api python -m webapp.scripts.migrate_templates_to_keycards --user-id <uuid>
    docker compose exec api python -m webapp.scripts.migrate_templates_to_keycards --user-id <uuid> --apply

Without ``--apply`` it reports what it would do and writes nothing.
"""
from __future__ import annotations

import argparse
import sys

from webapp.api.auth import Principal
from webapp.api.db import service_tx
from webapp.api.keycards.adapter import strategy_to_keycard
from webapp.api.keycards.models import KeycardSpec
from webapp.api.keycards.repo import KeycardRepo
from webapp.api.strategy_gen.draft import lower_draft
from webapp.api.strategy_gen.templates import load_templates


def resolve_principal(user_id: str) -> Principal:
    """Build a principal for the migration owner.

    The org_id is read as service_role so the script can run without a JWT.
    Writes then go through ``KeycardRepo`` / ``user_tx`` as the target user,
    exercising the same RLS path a request would.
    """
    with service_tx() as cur:
        cur.execute(
            "SELECT default_org_id FROM public.user_profiles WHERE user_id = %s",
            (user_id,),
        )
        row = cur.fetchone()
    if row is None or row.get("default_org_id") is None:
        raise SystemExit(
            f"No user profile found for {user_id!r}. Sign in once through the UI "
            "so the signup trigger creates the profile and organisation, then re-run."
        )
    return Principal(
        user_id=user_id,
        email="templates@example.invalid",
        org_id=str(row["default_org_id"]),
        org_role="owner",
    )


def _description(template) -> str:
    """Rationale plus good_for/bad_for, so nothing from the template is lost."""
    parts = [template.rationale.strip()]
    if template.good_for:
        parts.append("Good for:\n- " + "\n- ".join(template.good_for))
    if template.bad_for:
        parts.append("Bad for:\n- " + "\n- ".join(template.bad_for))
    return "\n\n".join(parts)


def template_to_keycard(template) -> KeycardSpec:
    """Template -> a keycard spec ready for storage."""
    lowered = lower_draft(template.draft)
    keycard = strategy_to_keycard(lowered.spec)
    spec = KeycardSpec(**keycard.model_dump(exclude={"id", "created_at", "updated_at", "user_id", "visibility"}))
    spec.name = template.title
    spec.description = _description(template)
    spec.tags = list(template.tags)
    spec.is_template = True
    spec.template_family = template.family
    return spec


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m webapp.scripts.migrate_templates_to_keycards",
        description=__doc__,
    )
    parser.add_argument(
        "--user-id", required=True,
        help="UUID of the owner every migrated template is filed under.")
    parser.add_argument(
        "--apply", action="store_true",
        help="Actually write. Without it, nothing is changed.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    principal = resolve_principal(args.user_id)
    repo = KeycardRepo(principal)

    templates = load_templates()
    specs: dict[str, KeycardSpec] = {}
    errors: list[str] = []
    for template in templates:
        try:
            specs[f"template-{template.id}"] = template_to_keycard(template)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{template.id}: {type(exc).__name__}: {exc}")

    print(f"Owner: user_id={principal.user_id}  org_id={principal.org_id}")
    print(f"Mode : {'APPLY (writing)' if args.apply else 'DRY RUN (no writes)'}")
    print(f"Templates parsed: {len(specs)} / {len(templates)}")

    if errors:
        print(f"\nSkipped {len(errors)} template(s):")
        for line in errors:
            print(f"  - {line}")

    created = updated = 0
    if args.apply:
        for record_id, spec in specs.items():
            existing = repo.get(record_id)
            repo.upsert(record_id, spec)
            if existing is None:
                created += 1
            else:
                updated += 1
    else:
        # In dry-run we still validate ids and report the set that would be written.
        for record_id in specs:
            try:
                repo._check_id(record_id)
            except ValueError as exc:
                errors.append(f"{record_id}: invalid id: {exc}")

    print(f"Would write: {len(specs)} keycard(s)")
    if args.apply:
        print(f"  created: {created}")
        print(f"  updated: {updated}")
    else:
        print("Nothing was written. Re-run with --apply.")

    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
