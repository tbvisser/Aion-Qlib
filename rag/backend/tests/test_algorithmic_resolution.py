"""Tests for the algorithmic entity resolution mode."""

import pytest
from unittest.mock import MagicMock, patch

from app.services.redaction_service import (
    ParsedPerson,
    ThreadRedactionService,
    UnionFind,
    get_entity_resolution_mode,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_supabase():
    client = MagicMock()
    table_mock = MagicMock()
    select_mock = MagicMock()
    eq_mock = MagicMock()
    eq_mock.execute.return_value = MagicMock(data=[])
    select_mock.eq.return_value = eq_mock
    table_mock.select.return_value = select_mock
    upsert_mock = MagicMock()
    upsert_mock.execute.return_value = MagicMock(data=[])
    table_mock.upsert.return_value = upsert_mock
    client.table.return_value = table_mock
    return client


@pytest.fixture
def service(mock_supabase):
    return ThreadRedactionService("test-thread", mock_supabase)


# ---------------------------------------------------------------------------
# UnionFind
# ---------------------------------------------------------------------------

class TestUnionFind:
    def test_initial_state(self):
        uf = UnionFind(5)
        for i in range(5):
            assert uf.find(i) == i

    def test_union_and_find(self):
        uf = UnionFind(5)
        uf.union(0, 1)
        uf.union(2, 3)
        assert uf.find(0) == uf.find(1)
        assert uf.find(2) == uf.find(3)
        assert uf.find(0) != uf.find(2)

    def test_transitive_union(self):
        uf = UnionFind(3)
        uf.union(0, 1)
        uf.union(1, 2)
        assert uf.find(0) == uf.find(2)


# ---------------------------------------------------------------------------
# _parse_person_entity
# ---------------------------------------------------------------------------

class TestParsePersonEntity:
    def test_full_name(self, service):
        pp = service._parse_person_entity("Daniel Walsh")
        assert pp.canonical_first is not None
        assert pp.last == "walsh"
        assert pp.title is None

    def test_nickname_resolution(self, service):
        pp = service._parse_person_entity("Danny Walsh")
        # "danny" should resolve to canonical "daniel"
        assert pp.canonical_first is not None
        assert pp.last == "walsh"

    def test_title_last(self, service):
        pp = service._parse_person_entity("Mr. Walsh")
        assert pp.title == "Mr."
        assert pp.canonical_first is None
        assert pp.last == "walsh"

    def test_first_only(self, service):
        pp = service._parse_person_entity("Danny")
        assert pp.canonical_first is not None
        assert pp.last is None

    def test_single_word(self, service):
        pp = service._parse_person_entity("Walsh")
        # nameparser treats a single word as a first name
        assert pp.canonical_first is not None
        assert pp.last is None


# ---------------------------------------------------------------------------
# _normalize_non_person_entity
# ---------------------------------------------------------------------------

class TestNormalizeNonPerson:
    def test_email(self, service):
        assert service._normalize_non_person_entity("EMAIL_ADDRESS", "John@Example.COM") == "john@example.com"

    def test_phone_strips_non_digits(self, service):
        assert service._normalize_non_person_entity("PHONE_NUMBER", "(555) 123-4567") == "5551234567"

    def test_phone_strips_leading_1(self, service):
        assert service._normalize_non_person_entity("PHONE_NUMBER", "1-555-123-4567") == "5551234567"

    def test_url_strips_www(self, service):
        assert service._normalize_non_person_entity("URL", "www.example.com/") == "example.com"

    def test_iban(self, service):
        assert service._normalize_non_person_entity("IBAN_CODE", "GB29 NWBK 6016") == "GB29NWBK6016"

    def test_credit_card(self, service):
        assert service._normalize_non_person_entity("CREDIT_CARD", "4111-1111-1111-1111") == "4111111111111111"

    def test_ssn(self, service):
        assert service._normalize_non_person_entity("US_SSN", "123-45-6789") == "123456789"


# ---------------------------------------------------------------------------
# _derive_sub_surrogate
# ---------------------------------------------------------------------------

class TestDeriveSubSurrogate:
    def test_title_last(self, service):
        member = ParsedPerson(0, "Mr. Walsh", "Mr.", None, "walsh")
        result = service._derive_sub_surrogate("Marcus Smith", member)
        assert result == "Mr. Smith"

    def test_first_only(self, service):
        member = ParsedPerson(0, "Danny", None, "daniel", None)
        result = service._derive_sub_surrogate("Marcus Smith", member)
        assert result == "Marcus"

    def test_last_only(self, service):
        member = ParsedPerson(0, "Walsh", None, None, "walsh")
        result = service._derive_sub_surrogate("Marcus Smith", member)
        assert result == "Smith"

    def test_full_name(self, service):
        member = ParsedPerson(0, "Daniel Walsh", None, "daniel", "walsh")
        result = service._derive_sub_surrogate("Marcus Smith", member)
        assert result == "Marcus Smith"

    def test_title_full_name(self, service):
        member = ParsedPerson(0, "Dr. Daniel Walsh", "Dr.", "daniel", "walsh")
        result = service._derive_sub_surrogate("Marcus Smith", member)
        assert result == "Dr. Marcus Smith"


# ---------------------------------------------------------------------------
# _resolve_entities_algorithmic (clustering)
# ---------------------------------------------------------------------------

class TestAlgorithmicResolution:
    @pytest.mark.asyncio
    async def test_full_name_clustering(self, service):
        """Daniel Walsh + Danny Walsh cluster together."""
        entities = [
            {"original_value": "Daniel Walsh", "entity_type": "PERSON", "start": 0, "end": 12},
            {"original_value": "Danny Walsh", "entity_type": "PERSON", "start": 20, "end": 31},
        ]
        candidates = {
            "Daniel Walsh": "Marcus Smith",
            "Danny Walsh": "Arnold Jones",
        }
        result = await service._resolve_entities_algorithmic("...", entities, candidates)

        person_results = [r for r in result if r["entity_type"] == "PERSON"]
        surrogates = {r["original_value"]: r["surrogate_value"] for r in person_results}

        # Both should share a surrogate family
        assert surrogates["Daniel Walsh"] == surrogates["Danny Walsh"]

    @pytest.mark.asyncio
    async def test_title_joins_cluster(self, service):
        """Mr. Walsh joins the Daniel Walsh cluster."""
        entities = [
            {"original_value": "Daniel Walsh", "entity_type": "PERSON", "start": 0, "end": 12},
            {"original_value": "Mr. Walsh", "entity_type": "PERSON", "start": 20, "end": 29},
        ]
        candidates = {
            "Daniel Walsh": "Marcus Smith",
            "Mr. Walsh": "Arnold Jones",
        }
        result = await service._resolve_entities_algorithmic("...", entities, candidates)

        surrogates = {r["original_value"]: r["surrogate_value"] for r in result}
        assert surrogates["Daniel Walsh"] == "Marcus Smith"
        assert surrogates["Mr. Walsh"] == "Mr. Smith"

    @pytest.mark.asyncio
    async def test_first_name_only_joins_cluster(self, service):
        """Danny joins the Daniel Walsh cluster."""
        entities = [
            {"original_value": "Daniel Walsh", "entity_type": "PERSON", "start": 0, "end": 12},
            {"original_value": "Danny", "entity_type": "PERSON", "start": 20, "end": 25},
        ]
        candidates = {
            "Daniel Walsh": "Marcus Smith",
            "Danny": "Arnold",
        }
        result = await service._resolve_entities_algorithmic("...", entities, candidates)

        surrogates = {r["original_value"]: r["surrogate_value"] for r in result}
        assert surrogates["Daniel Walsh"] == "Marcus Smith"
        assert surrogates["Danny"] == "Marcus"

    @pytest.mark.asyncio
    async def test_ambiguous_last_no_merge(self, service):
        """Mr. Walsh doesn't merge when two Walshes exist."""
        entities = [
            {"original_value": "Daniel Walsh", "entity_type": "PERSON", "start": 0, "end": 12},
            {"original_value": "Sarah Walsh", "entity_type": "PERSON", "start": 20, "end": 31},
            {"original_value": "Mr. Walsh", "entity_type": "PERSON", "start": 40, "end": 49},
        ]
        candidates = {
            "Daniel Walsh": "Marcus Smith",
            "Sarah Walsh": "Jessica Park",
            "Mr. Walsh": "Mr. Anderson",
        }
        result = await service._resolve_entities_algorithmic("...", entities, candidates)

        surrogates = {r["original_value"]: r["surrogate_value"] for r in result}
        # Mr. Walsh should NOT join either cluster (ambiguous)
        assert surrogates["Mr. Walsh"] != "Mr. Smith"
        assert surrogates["Mr. Walsh"] != "Mr. Park"

    @pytest.mark.asyncio
    async def test_non_person_passthrough(self, service):
        """Non-PERSON entities get their candidate surrogates."""
        entities = [
            {"original_value": "john@example.com", "entity_type": "EMAIL_ADDRESS", "start": 0, "end": 16},
        ]
        candidates = {"john@example.com": "fake@email.com"}
        result = await service._resolve_entities_algorithmic("...", entities, candidates)

        assert len(result) == 1
        assert result[0]["surrogate_value"] == "fake@email.com"

    @pytest.mark.asyncio
    async def test_non_person_same_normalized_group(self, service):
        """Phone variants with same normalized form get same surrogate."""
        entities = [
            {"original_value": "(555) 123-4567", "entity_type": "PHONE_NUMBER", "start": 0, "end": 14},
            {"original_value": "555-123-4567", "entity_type": "PHONE_NUMBER", "start": 20, "end": 32},
        ]
        candidates = {
            "(555) 123-4567": "555-987-6543",
            "555-123-4567": "555-111-2222",
        }
        result = await service._resolve_entities_algorithmic("...", entities, candidates)

        surrogates = [r["surrogate_value"] for r in result]
        assert surrogates[0] == surrogates[1]

    @pytest.mark.asyncio
    async def test_existing_registry_match(self, service):
        """New entity matching existing registry gets the existing surrogate."""
        # Pre-populate registry
        service._anon_map["PERSON"]["daniel walsh"] = "Marcus Smith"
        service._deanon_map["Marcus Smith"] = "Daniel Walsh"
        service._all_surrogates.add("Marcus Smith")

        entities = [
            {"original_value": "Danny Walsh", "entity_type": "PERSON", "start": 0, "end": 11},
        ]
        candidates = {"Danny Walsh": "Arnold Jones"}
        result = await service._resolve_entities_algorithmic("...", entities, candidates)

        assert len(result) == 1
        assert result[0]["surrogate_value"] == "Marcus Smith"


# ---------------------------------------------------------------------------
# _deanonymize_algorithmic
# ---------------------------------------------------------------------------

class TestAlgorithmicDeanonymization:
    def test_title_last_replacement(self, service):
        """Mr. Smith -> Mr. Walsh when Marcus Smith -> Daniel Walsh."""
        service._anon_map["PERSON"]["daniel walsh"] = "Marcus Smith"
        service._deanon_map["Marcus Smith"] = "Daniel Walsh"

        text = "Mr. Smith said hello."
        result = service._deanonymize_algorithmic(text)
        assert "Mr. Walsh" in result

    def test_first_name_unambiguous(self, service):
        """Marcus -> Daniel when only one surrogate has first name Marcus."""
        service._anon_map["PERSON"]["daniel walsh"] = "Marcus Smith"
        service._deanon_map["Marcus Smith"] = "Daniel Walsh"

        text = "Marcus said hello."
        result = service._deanonymize_algorithmic(text)
        assert "Daniel" in result

    def test_last_name_ambiguous_no_replace(self, service):
        """Smith not replaced when two surrogates share last name Smith."""
        service._anon_map["PERSON"]["daniel walsh"] = "Marcus Smith"
        service._anon_map["PERSON"]["sarah chen"] = "Jessica Smith"
        service._deanon_map["Marcus Smith"] = "Daniel Walsh"
        service._deanon_map["Jessica Smith"] = "Sarah Chen"

        text = "Smith said hello."
        result = service._deanonymize_algorithmic(text)
        assert "Smith" in result  # Should NOT be replaced (ambiguous)

    def test_no_replacement_when_surrogate_present(self, service):
        """Skip fuzzy logic if full surrogate is still in text."""
        service._anon_map["PERSON"]["daniel walsh"] = "Marcus Smith"
        service._deanon_map["Marcus Smith"] = "Daniel Walsh"

        text = "Marcus Smith said hello."
        result = service._deanonymize_algorithmic(text)
        # Full surrogate present -> skip, don't try partials
        assert "Marcus Smith" in result


# ---------------------------------------------------------------------------
# get_entity_resolution_mode
# ---------------------------------------------------------------------------

class TestGetEntityResolutionMode:
    def test_default_is_llm(self):
        with patch("app.services.redaction_service.get_settings") as mock:
            mock.return_value.entity_resolution_mode = "llm"
            assert get_entity_resolution_mode() == "llm"

    def test_algorithmic(self):
        with patch("app.services.redaction_service.get_settings") as mock:
            mock.return_value.entity_resolution_mode = "algorithmic"
            assert get_entity_resolution_mode() == "algorithmic"

    def test_none(self):
        with patch("app.services.redaction_service.get_settings") as mock:
            mock.return_value.entity_resolution_mode = "none"
            assert get_entity_resolution_mode() == "none"

    def test_invalid_falls_back_to_llm(self):
        with patch("app.services.redaction_service.get_settings") as mock:
            mock.return_value.entity_resolution_mode = "invalid"
            assert get_entity_resolution_mode() == "llm"

    def test_exception_falls_back_to_llm(self):
        with patch("app.services.redaction_service.get_settings") as mock:
            mock.side_effect = Exception("config error")
            assert get_entity_resolution_mode() == "llm"
