"""Per-user storage for keycard workflows.

Mirrors the ``RecordRepo`` pattern used for strategies, portfolios and projects,
but adds filters that matter to the keycard gallery: templates, family and tags.
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import Depends

from ..auth import Principal, get_principal
from ..db import user_tx
from ..repositories import RecordRepo
from .models import Keycard, KeycardSpec


class KeycardRepo(RecordRepo[KeycardSpec, Keycard]):
    """One user's view of the ``aion.keycards`` table."""

    table = "keycards"
    spec_model = KeycardSpec
    stored_model = Keycard

    def list_filtered(
        self,
        is_template: bool | None = None,
        family: str | None = None,
        tag: str | None = None,
    ) -> list[Keycard]:
        """Everything this caller may see, filtered by template metadata."""
        conditions: list[str] = []
        params: list[Any] = []
        if is_template is not None:
            conditions.append("(spec->>'is_template')::boolean = %s")
            params.append(is_template)
        if family is not None:
            conditions.append("spec->>'template_family' = %s")
            params.append(family)
        if tag is not None:
            conditions.append("spec @> %s::jsonb")
            params.append(json.dumps({"tags": [tag]}))
        where = "WHERE " + " AND ".join(conditions) if conditions else ""
        with user_tx(self.principal.user_id) as cur:
            return self._hydrate(self._select(cur, where, tuple(params)))

    def list_templates(self) -> list[Keycard]:
        """Caller-visible keycards marked as templates."""
        return self.list_filtered(is_template=True)

    def list_by_family(self, family: str) -> list[Keycard]:
        """Caller-visible keycards in a given template family."""
        return self.list_filtered(family=family)


def get_keycard_repo(principal: Principal = Depends(get_principal)) -> KeycardRepo:
    return KeycardRepo(principal)
