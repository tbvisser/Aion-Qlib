"""Tests for the template-to-keycards migration path."""
from __future__ import annotations

import pytest

from unittest.mock import MagicMock, patch

from webapp.api.auth import Principal
from webapp.api.keycards.repo import KeycardRepo
from webapp.api.strategy_gen.templates import load_templates
from webapp.scripts.migrate_templates_to_keycards import main, template_to_keycard

pytestmark = pytest.mark.usefixtures("fake_stores")


def test_every_template_converts_to_keycard_spec():
    """Every shipped template lowers into a valid, template-marked keycard."""
    for template in load_templates():
        spec = template_to_keycard(template)
        assert spec.name == template.title
        assert spec.is_template is True
        assert spec.template_family == template.family
        assert template.tags == spec.tags
        assert template.rationale in spec.description
        assert "Good for" in spec.description or not template.good_for
        assert "Bad for" in spec.description or not template.bad_for


def test_keycard_repo_accepts_template_ids():
    """Stable ids like ``template-baseline-lgbm-alpha158`` pass the repo guard."""
    repo = KeycardRepo.__new__(KeycardRepo)
    for template in load_templates():
        assert repo._check_id(f"template-{template.id}") == f"template-{template.id}"


def test_dry_run_does_not_write():
    """``main`` with ``--dry-run`` parses templates and skips the repo upserts."""
    principal = Principal(
        user_id="test-user", email="test@example.invalid",
        org_id="test-org", org_role="owner")
    mock_repo = MagicMock(spec=KeycardRepo)
    mock_repo.principal = principal

    with patch("webapp.scripts.migrate_templates_to_keycards.resolve_principal",
               return_value=principal), \
         patch("webapp.scripts.migrate_templates_to_keycards.KeycardRepo",
               return_value=mock_repo):
        rc = main(["--user-id", "test-user"])

    assert rc == 0
    assert mock_repo.upsert.called is False
    assert mock_repo.get.called is False
    # One checked id per shipped template.
    assert mock_repo._check_id.call_count == len(load_templates())
