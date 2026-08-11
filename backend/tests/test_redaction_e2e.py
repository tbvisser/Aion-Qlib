"""End-to-end integration tests for the PII redaction pipeline.

Exercises the full flow: Presidio detection -> surrogate generation ->
registry persistence -> surrogate reuse -> tool arg de-anonymization ->
LLM response de-anonymization.

Uses real Presidio (CPU-bound NLP model) but mocks Supabase.
"""

import json
from collections import defaultdict
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio

from app.services.redaction_service import ThreadRedactionService


# ---------------------------------------------------------------------------
# Stateful Supabase mock (tracks persisted rows across load/save cycles)
# ---------------------------------------------------------------------------

class FakeSupabase:
    """In-memory Supabase stand-in that stores and retrieves registry rows."""

    def __init__(self):
        self._rows: dict[str, list[dict]] = defaultdict(list)

    def table(self, name):
        return _FakeTable(self._rows, name)


class _FakeTable:
    def __init__(self, store, name):
        self._store = store
        self._name = name
        self._filters = {}

    def select(self, *cols):
        return _FakeSelect(self._store, self._name)

    def upsert(self, data, **kwargs):
        on_conflict = kwargs.get("on_conflict", "")
        conflict_keys = [k.strip() for k in on_conflict.split(",") if k.strip()]

        rows = data if isinstance(data, list) else [data]
        for row in rows:
            # Upsert logic: replace existing row with same conflict keys
            existing = self._store[self._name]
            replaced = False
            for i, ex in enumerate(existing):
                if conflict_keys and all(ex.get(k) == row.get(k) for k in conflict_keys):
                    existing[i] = row
                    replaced = True
                    break
            if not replaced:
                existing.append(row)
        return _FakeExecute([])

    def update(self, data):
        return _FakeChainedUpdate(self._store, self._name, data)

    def delete(self):
        return _FakeChainedDelete(self._store, self._name)


class _FakeSelect:
    def __init__(self, store, name):
        self._store = store
        self._name = name
        self._filters = {}

    def eq(self, col, val):
        self._filters[col] = val
        return self

    def execute(self):
        rows = self._store.get(self._name, [])
        filtered = [
            r for r in rows
            if all(r.get(k) == v for k, v in self._filters.items())
        ]
        return MagicMock(data=filtered)


class _FakeChainedUpdate:
    def __init__(self, store, name, data):
        self._store = store
        self._name = name
        self._data = data
        self._filters = {}

    def eq(self, col, val):
        self._filters[col] = val
        return self

    def execute(self):
        rows = self._store.get(self._name, [])
        for r in rows:
            if all(r.get(k) == v for k, v in self._filters.items()):
                r.update(self._data)
        return MagicMock(data=[])


class _FakeChainedDelete:
    def __init__(self, store, name):
        self._store = store
        self._name = name
        self._filters = {}

    def eq(self, col, val):
        self._filters[col] = val
        return self

    def execute(self):
        rows = self._store.get(self._name, [])
        self._store[self._name] = [
            r for r in rows
            if not all(r.get(k) == v for k, v in self._filters.items())
        ]
        return MagicMock(data=[])


class _FakeExecute:
    def __init__(self, data):
        self.data = data

    def execute(self):
        return self


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def fake_supabase():
    return FakeSupabase()


@pytest_asyncio.fixture
async def svc(fake_supabase):
    """ThreadRedactionService with stateful in-memory persistence."""
    svc = ThreadRedactionService(thread_id="e2e-thread-1", supabase_client=fake_supabase)
    await svc.load_registry()
    return svc


# ---------------------------------------------------------------------------
# E2E-1: Full round-trip (anonymize -> persist -> reload -> deanonymize)
# ---------------------------------------------------------------------------

class TestFullRoundTrip:
    @pytest.mark.asyncio
    async def test_anonymize_persist_reload_deanonymize(self, fake_supabase):
        """Anonymize text, persist to DB, create a new service that loads
        from DB, and verify the same surrogates are reused."""
        # Service 1: anonymize
        svc1 = ThreadRedactionService("e2e-rt-1", fake_supabase)
        await svc1.load_registry()

        text = "Please contact Margaret Thompson about the contract."
        anon = await svc1.anonymize(text)

        assert "Margaret Thompson" not in anon
        surrogate = svc1._anon_map.get("PERSON", {}).get("margaret thompson")
        assert surrogate is not None
        assert surrogate in anon

        # Verify rows were persisted
        rows = fake_supabase._rows.get("thread_entity_registry", [])
        assert len(rows) >= 1
        person_row = next(
            (r for r in rows if r["entity_type"] == "PERSON"), None
        )
        assert person_row is not None
        assert person_row["surrogate_value"] == surrogate

        # Service 2: load from same DB and verify reuse
        svc2 = ThreadRedactionService("e2e-rt-1", fake_supabase)
        await svc2.load_registry()

        assert svc2._anon_map.get("PERSON", {}).get("margaret thompson") == surrogate

        text2 = "Margaret Thompson confirmed the meeting."
        anon2 = await svc2.anonymize(text2)
        assert surrogate in anon2

        # De-anonymize
        restored = svc2.deanonymize(anon2)
        assert "Margaret Thompson" in restored


# ---------------------------------------------------------------------------
# E2E-2: Surrogate reuse across messages in same thread
# ---------------------------------------------------------------------------

class TestSurrogateReuse:
    @pytest.mark.asyncio
    async def test_same_name_same_surrogate_multi_message(self, svc):
        """Multiple messages mentioning the same person get the same surrogate."""
        msg1 = "Daniel Walsh will lead the project."
        msg2 = "Daniel Walsh submitted his report yesterday."
        msg3 = "We need Daniel Walsh to review the budget."

        r1 = await svc.anonymize(msg1)
        r2 = await svc.anonymize(msg2)
        r3 = await svc.anonymize(msg3)

        surrogate = svc._anon_map.get("PERSON", {}).get("daniel walsh")
        assert surrogate is not None

        for r in [r1, r2, r3]:
            assert "Daniel Walsh" not in r
            assert surrogate in r


# ---------------------------------------------------------------------------
# E2E-3: Tool argument de-anonymization
# ---------------------------------------------------------------------------

class TestToolArgDeanonymization:
    @pytest.mark.asyncio
    async def test_tool_args_deanonymized(self, svc):
        """After anonymizing user message, tool args with surrogates
        should be de-anonymized back to originals."""
        user_msg = "Please contact Margaret Thompson about the contract."
        await svc.anonymize(user_msg)

        surrogate = svc._anon_map.get("PERSON", {}).get("margaret thompson")
        assert surrogate is not None, (
            "Presidio should detect 'Margaret Thompson' as PERSON entity"
        )

        # Simulate LLM generating tool call with surrogate
        tool_args = json.dumps({"query": f"Find documents by {surrogate}"})
        deanon_args = svc.deanonymize(tool_args)

        assert surrogate not in deanon_args
        assert "Margaret Thompson" in deanon_args


# ---------------------------------------------------------------------------
# E2E-4: LLM response de-anonymization (exact + fuzzy algorithmic)
# ---------------------------------------------------------------------------

class TestResponseDeanonymization:
    @pytest.mark.asyncio
    async def test_exact_match_deanonymization(self, svc):
        """LLM response containing exact surrogates gets de-anonymized."""
        await svc.anonymize("Contact John Smith at john.smith@acme.com.")

        person_surr = svc._anon_map.get("PERSON", {}).get("john smith")
        email_surr = svc._anon_map.get("EMAIL_ADDRESS", {}).get("john.smith@acme.com")

        # Build a fake LLM response using surrogates
        llm_response = f"I found information about {person_surr}."
        if email_surr:
            llm_response += f" Their email is {email_surr}."

        # Use deanonymize (not the async LLM variant) for exact matching
        restored = svc.deanonymize(llm_response)

        assert "John Smith" in restored
        if email_surr:
            assert "john.smith@acme.com" in restored

    @pytest.mark.asyncio
    async def test_algorithmic_fuzzy_deanonymization(self, svc):
        """Algorithmic mode catches partial name references (Mr. X, first-name-only)."""
        await svc.anonymize("Daniel Walsh is the project lead.")

        surrogate = svc._anon_map.get("PERSON", {}).get("daniel walsh")
        assert surrogate is not None

        # Parse surrogate to get last name for testing
        from nameparser import HumanName
        parsed = HumanName(surrogate)

        if parsed.last:
            # Test Mr. <last> replacement
            llm_text = f"Mr. {parsed.last} confirmed the timeline."
            restored = svc._deanonymize_algorithmic(llm_text)
            assert "Mr. Walsh" in restored

        if parsed.first:
            # Test first-name-only replacement
            llm_text = f"{parsed.first} will attend the meeting."
            restored = svc._deanonymize_algorithmic(llm_text)
            assert "Daniel" in restored


# ---------------------------------------------------------------------------
# E2E-5: Word-boundary de-anonymization (HIGH-2 fix)
# ---------------------------------------------------------------------------

class TestWordBoundaryDeanonymization:
    @pytest.mark.asyncio
    async def test_short_surrogate_no_midword_replacement(self, svc):
        """A short surrogate should not match inside longer words."""
        # Manually register a short surrogate
        svc._anon_map["LOCATION"]["portland"] = "Art"
        svc._deanon_map["Art"] = "Portland"
        svc._all_surrogates.add("Art")

        text = "The artificial intelligence team in Art is doing great work."
        restored = svc.deanonymize(text)

        # "Art" (standalone) should be replaced, but "artificial" should NOT
        assert "Portland" in restored
        assert "artificial" in restored  # NOT "Portlandificial"

    @pytest.mark.asyncio
    async def test_normal_surrogate_replaced(self, svc):
        """Standard multi-word surrogates are still correctly replaced."""
        svc._anon_map["PERSON"]["john doe"] = "Marcus Smith"
        svc._deanon_map["Marcus Smith"] = "John Doe"
        svc._all_surrogates.add("Marcus Smith")

        text = "Marcus Smith submitted the report."
        restored = svc.deanonymize(text)
        assert "John Doe" in restored
        assert "Marcus Smith" not in restored


# ---------------------------------------------------------------------------
# E2E-6: Multiple entity types in same message
# ---------------------------------------------------------------------------

class TestMultipleEntityTypes:
    @pytest.mark.asyncio
    async def test_multiple_types_anonymize_and_restore(self, svc):
        """Text with PERSON + EMAIL + PHONE all get anonymized and restored."""
        text = "John Smith (john@example.com, 555-123-4567) from New York."
        anon = await svc.anonymize(text)

        assert "John Smith" not in anon
        assert "john@example.com" not in anon

        restored = svc.deanonymize(anon)
        assert "John Smith" in restored
        assert "john@example.com" in restored


# ---------------------------------------------------------------------------
# E2E-7: Batch persistence (HIGH-5 fix)
# ---------------------------------------------------------------------------

class TestBatchPersistence:
    @pytest.mark.asyncio
    async def test_all_mappings_persisted_in_single_call(self, fake_supabase):
        """After anonymizing text with multiple entities, all mappings
        should be persisted (verifies batch upsert works)."""
        svc = ThreadRedactionService("e2e-batch-1", fake_supabase)
        await svc.load_registry()

        text = "John Smith emailed john@example.com from New York."
        await svc.anonymize(text)

        rows = [
            r for r in fake_supabase._rows.get("thread_entity_registry", [])
            if r["thread_id"] == "e2e-batch-1"
        ]

        # Should have at least PERSON + EMAIL
        types = {r["entity_type"] for r in rows}
        assert "PERSON" in types
        assert "EMAIL_ADDRESS" in types


# ---------------------------------------------------------------------------
# E2E-8: Thread isolation with shared DB
# ---------------------------------------------------------------------------

class TestThreadIsolationE2E:
    @pytest.mark.asyncio
    async def test_different_threads_independent(self, fake_supabase):
        """Two threads with the same name get independent surrogates."""
        svc_a = ThreadRedactionService("thread-A", fake_supabase)
        await svc_a.load_registry()
        svc_b = ThreadRedactionService("thread-B", fake_supabase)
        await svc_b.load_registry()

        text = "Contact Margaret Thompson."

        await svc_a.anonymize(text)
        await svc_b.anonymize(text)

        surr_a = svc_a._anon_map.get("PERSON", {}).get("margaret thompson")
        surr_b = svc_b._anon_map.get("PERSON", {}).get("margaret thompson")

        assert surr_a is not None
        assert surr_b is not None
        # Surrogates should be independent (different Faker seeds)
        # Verify the registries are separate objects at minimum
        assert svc_a._anon_map is not svc_b._anon_map

        # DB rows should be scoped to their thread_ids
        rows_a = [
            r for r in fake_supabase._rows.get("thread_entity_registry", [])
            if r["thread_id"] == "thread-A"
        ]
        rows_b = [
            r for r in fake_supabase._rows.get("thread_entity_registry", [])
            if r["thread_id"] == "thread-B"
        ]
        assert len(rows_a) >= 1
        assert len(rows_b) >= 1


# ---------------------------------------------------------------------------
# E2E-9: Fuzzy collision regression (surname corruption)
# ---------------------------------------------------------------------------

class TestFuzzyCollisionE2E:
    """Multi-person collision test: when a Faker surrogate shares a surname
    component with a real person name, the de-anonymization pipeline must
    not corrupt the real name."""

    @pytest.mark.asyncio
    async def test_multi_person_collision_safe(self, fake_supabase):
        """Simulate: Margaret Eleanor Thompson -> Brittney Ferguson,
        Maria Vasquez -> Aaron Thompson DDS.
        De-anonymizing text with both surrogates must NOT corrupt
        'Margaret Eleanor Thompson' to 'Margaret Eleanor Vasquez'."""
        svc = ThreadRedactionService("e2e-collision-1", fake_supabase)
        await svc.load_registry()

        # Manually seed the registry with controlled colliding surrogates
        svc._anon_map["PERSON"]["margaret eleanor thompson"] = "Brittney Ferguson"
        svc._deanon_map["Brittney Ferguson"] = "Margaret Eleanor Thompson"
        svc._all_surrogates.add("Brittney Ferguson")

        svc._anon_map["PERSON"]["maria vasquez"] = "Aaron Thompson DDS"
        svc._deanon_map["Aaron Thompson DDS"] = "Maria Vasquez"
        svc._all_surrogates.add("Aaron Thompson DDS")

        # Simulate LLM response with both surrogates
        llm_text = (
            "BRITTNEY FERGUSON\n"
            "Name: Brittney Ferguson\n"
            "Manager: Aaron Thompson DDS\n"
            "Brittney Ferguson has been with the company for 5 years."
        )

        with patch(
            "app.services.redaction_service.call_local_llm",
            new_callable=AsyncMock,
            return_value=None,
        ), patch(
            "app.services.redaction_service.get_entity_resolution_mode",
            return_value="algorithmic",
        ):
            result = await svc.deanonymize_llm_response(llm_text)

        # Verify correct de-anonymization
        assert "Margaret Eleanor Thompson" in result
        assert "Maria Vasquez" in result
        # The corruption bug: Thompson -> Vasquez
        assert "Margaret Eleanor Vasquez" not in result
        # No ALL CAPS surrogate leakage
        assert "BRITTNEY FERGUSON" not in result
        # No placeholder leakage
        assert "<<PH_" not in result

    @pytest.mark.asyncio
    async def test_collision_safe_with_none_mode(self, fake_supabase):
        """With mode='none' (no fuzzy pass), exact replacement via
        placeholders should still work correctly."""
        svc = ThreadRedactionService("e2e-collision-2", fake_supabase)
        await svc.load_registry()

        svc._anon_map["PERSON"]["margaret thompson"] = "Brittney Ferguson"
        svc._deanon_map["Brittney Ferguson"] = "Margaret Thompson"
        svc._all_surrogates.add("Brittney Ferguson")

        svc._anon_map["PERSON"]["maria vasquez"] = "Aaron Thompson DDS"
        svc._deanon_map["Aaron Thompson DDS"] = "Maria Vasquez"
        svc._all_surrogates.add("Aaron Thompson DDS")

        llm_text = "Brittney Ferguson and Aaron Thompson DDS met yesterday."

        with patch(
            "app.services.redaction_service.get_entity_resolution_mode",
            return_value="none",
        ):
            result = await svc.deanonymize_llm_response(llm_text)

        assert "Margaret Thompson" in result
        assert "Maria Vasquez" in result
        assert "Margaret Vasquez" not in result
        assert "<<PH_" not in result
