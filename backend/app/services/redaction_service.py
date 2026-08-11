"""
Thread-scoped PII Redaction Service.

Provides per-thread anonymization (real -> surrogate) and de-anonymization
(surrogate -> real) using Presidio for detection, Faker for surrogate
generation, and an optional local LLM for entity resolution / fuzzy
de-anonymization.
"""

from __future__ import annotations

import json
import logging
import re
from collections import defaultdict
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from faker import Faker
    from nameparser import HumanName
    from nicknames import NickNamer
    from presidio_analyzer import AnalyzerEngine

from app.config import get_settings
from app.db.supabase import get_supabase_client
from app.services.langsmith import get_traced_async_openai_client, traceable

logger = logging.getLogger(__name__)

# Default entity type sets (overridden by env vars)
_DEFAULT_SURROGATE_ENTITIES = {
    "PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "LOCATION",
    "DATE_TIME", "URL", "IP_ADDRESS",
}
_DEFAULT_REDACT_ENTITIES = {
    "CREDIT_CARD", "US_SSN", "US_ITIN", "US_BANK_NUMBER", "IBAN_CODE",
    "CRYPTO", "US_PASSPORT", "US_DRIVER_LICENSE", "MEDICAL_LICENSE",
}

_UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)

# Cached entity sets (populated lazily)
_surrogate_set: set[str] | None = None
_redact_set: set[str] | None = None


def get_pii_entity_sets() -> tuple[set[str], set[str]]:
    """Read PII_SURROGATE_ENTITIES and PII_REDACT_ENTITIES from settings.

    Returns (surrogate_set, redact_set).
    """
    global _surrogate_set, _redact_set
    if _surrogate_set is not None and _redact_set is not None:
        return _surrogate_set, _redact_set

    try:
        settings = get_settings()
        _surrogate_set = {
            e.strip().upper()
            for e in settings.pii_surrogate_entities.split(",")
            if e.strip()
        }
        _redact_set = {
            e.strip().upper()
            for e in settings.pii_redact_entities.split(",")
            if e.strip()
        }
    except Exception:
        _surrogate_set = _DEFAULT_SURROGATE_ENTITIES.copy()
        _redact_set = _DEFAULT_REDACT_ENTITIES.copy()

    return _surrogate_set, _redact_set


def get_supported_entities() -> list[str]:
    """Derive SUPPORTED_ENTITIES from the union of surrogate + redact sets."""
    surrogate_set, redact_set = get_pii_entity_sets()
    return list(surrogate_set | redact_set)

# Faker generators per entity type
FAKER_GENERATORS = {
    "PERSON": lambda fake: fake.name(),
    "EMAIL_ADDRESS": lambda fake: fake.email(),
    "PHONE_NUMBER": lambda fake: fake.phone_number(),
    "IBAN_CODE": lambda fake: fake.iban(),
    "CREDIT_CARD": lambda fake: fake.credit_card_number(),
    "US_SSN": lambda fake: fake.ssn(),
    "US_BANK_NUMBER": lambda fake: f"{fake.random_number(digits=10, fix_len=True)}",
    "US_DRIVER_LICENSE": lambda fake: f"DL-{fake.random_number(digits=8, fix_len=True)}",
    "US_PASSPORT": lambda fake: f"{fake.random_uppercase_letter()}{fake.random_number(digits=8, fix_len=True)}",
    "IP_ADDRESS": lambda fake: fake.ipv4_public(),
    "DATE_TIME": lambda fake: fake.date(),
    "MEDICAL_LICENSE": lambda fake: f"ML-{fake.random_number(digits=8, fix_len=True)}",
    "URL": lambda fake: fake.url(),
    "LOCATION": lambda fake: fake.city(),
    "CRYPTO": lambda fake: fake.sha256()[:42],
    "US_ITIN": lambda fake: f"9{fake.random_number(digits=2, fix_len=True)}-{fake.random_number(digits=2, fix_len=True)}-{fake.random_number(digits=4, fix_len=True)}",
    "NRP": lambda fake: fake.word(),
    "ORG": lambda fake: fake.company(),
}

# ---------------------------------------------------------------------------
# Shared Presidio singleton (expensive to initialise)
# ---------------------------------------------------------------------------
_analyzer_engine: AnalyzerEngine | None = None


def get_analyzer_engine() -> AnalyzerEngine:
    global _analyzer_engine
    if _analyzer_engine is None:
        from presidio_analyzer import AnalyzerEngine
        logger.info("Initializing shared Presidio AnalyzerEngine...")
        _analyzer_engine = AnalyzerEngine()
    return _analyzer_engine


_nicknamer: NickNamer | None = None


def get_nicknamer() -> NickNamer:
    """Lazy singleton for the nicknames resolver."""
    global _nicknamer
    if _nicknamer is None:
        from nicknames import NickNamer
        _nicknamer = NickNamer()
    return _nicknamer


_gender_detector = None


def get_gender_detector():
    """Lazy singleton for the gender-guesser detector."""
    global _gender_detector
    if _gender_detector is None:
        import gender_guesser.detector as gender_mod
        _gender_detector = gender_mod.Detector(case_sensitive=False)
    return _gender_detector


def _generate_gendered_name(fake: Faker, original_name: str) -> str:
    """Generate a Faker name matching the detected gender of the original name."""
    from nameparser import HumanName
    parsed = HumanName(original_name)
    first = parsed.first.strip() if parsed.first else None
    if not first:
        return fake.name()

    detector = get_gender_detector()
    gender = detector.get_gender(first)

    if gender in ("male", "mostly_male"):
        return fake.name_male()
    elif gender in ("female", "mostly_female"):
        return fake.name_female()
    return fake.name()


# Default JSON response format for local LLM calls that expect structured output
_JSON_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "response",
        "schema": {"type": "object"},
    },
}


def get_entity_resolution_mode() -> str:
    """Read ENTITY_RESOLUTION_MODE from settings."""
    try:
        mode = get_settings().entity_resolution_mode.lower().strip()
    except Exception:
        mode = "llm"
    if mode not in ("llm", "algorithmic", "none"):
        logger.warning(f"Unknown ENTITY_RESOLUTION_MODE '{mode}', defaulting to 'llm'")
        mode = "llm"
    return mode


# ---------------------------------------------------------------------------
# Data structures for algorithmic resolution
# ---------------------------------------------------------------------------

@dataclass
class ParsedPerson:
    """A PERSON entity parsed into name components."""
    index: int
    original_value: str
    title: str | None
    canonical_first: str | None
    last: str | None


class UnionFind:
    """Disjoint-set with path compression and union by rank."""

    def __init__(self, n: int):
        self._parent = list(range(n))
        self._rank = [0] * n

    def find(self, x: int) -> int:
        while self._parent[x] != x:
            self._parent[x] = self._parent[self._parent[x]]
            x = self._parent[x]
        return x

    def union(self, a: int, b: int):
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self._rank[ra] < self._rank[rb]:
            ra, rb = rb, ra
        self._parent[rb] = ra
        if self._rank[ra] == self._rank[rb]:
            self._rank[ra] += 1


# ---------------------------------------------------------------------------
# Local LLM helpers
# ---------------------------------------------------------------------------

def get_local_llm_settings() -> dict | None:
    """Read local LLM settings from environment config.

    Returns dict with 'model' and 'base_url' keys, or None if not configured.
    """
    settings = get_settings()

    model = settings.local_llm_model
    base_url = settings.local_llm_base_url
    if not model or not base_url:
        return None

    return {"model": model, "base_url": base_url}


@traceable(name="call_local_llm", run_type="llm", tags=["pii-redaction", "local-llm"])
async def call_local_llm(
    prompt: str,
    response_format: dict | None = None,
    max_tokens: int = 2048,
) -> str | None:
    """Call local LLM via OpenAI-compatible API. Returns content or None on failure.

    Args:
        prompt: The prompt to send to the LLM.
        response_format: Optional response format dict (e.g. _JSON_RESPONSE_FORMAT).
            When None, the LLM returns plain text (useful for title generation).
        max_tokens: Maximum tokens to generate. Prevents runaway repetition
            from small models. Defaults to 2048.
    """
    settings = get_local_llm_settings()
    if not settings:
        return None

    try:
        client = get_traced_async_openai_client(
            base_url=settings["base_url"], api_key="not-needed"
        )
        msgs = [{"role": "user", "content": prompt}]

        kwargs: dict = {
            "model": settings["model"],
            "messages": msgs,
            "temperature": 0.0,
            "max_tokens": max_tokens,
        }
        if response_format is not None:
            kwargs["response_format"] = response_format

        response = await client.chat.completions.create(**kwargs)

        return response.choices[0].message.content
    except Exception as e:
        logger.warning(f"Local LLM call failed: {e}")
        return None


# ---------------------------------------------------------------------------
# ThreadRedactionService
# ---------------------------------------------------------------------------

class ThreadRedactionService:
    """Thread-scoped PII redaction service.

    Each instance is bound to a single chat thread and maintains its own
    entity registry loaded from / persisted to the ``thread_entity_registry``
    table.
    """

    # NOTE: Presidio is hardcoded to English ("en"). Non-English PII
    # (names in other scripts, international phone formats) will NOT be
    # detected.  To add multilingual support, make the language
    # configurable via an env var and load appropriate Presidio NLP models.

    def __init__(self, thread_id: str, supabase_client):
        from faker import Faker
        self._thread_id = thread_id
        self._supabase = supabase_client
        self._faker = Faker()
        self._analyzer = get_analyzer_engine()
        # (entity_type, normalized_original) -> surrogate
        self._anon_map: dict[str, dict[str, str]] = defaultdict(dict)
        # surrogate -> original
        self._deanon_map: dict[str, str] = {}
        # all surrogate values for collision detection
        self._all_surrogates: set[str] = set()
        # Original PERSON name components (lowercased) for Faker collision prevention
        self._original_person_components: set[str] = set()

    # ------------------------------------------------------------------
    # Registry loading
    # ------------------------------------------------------------------

    async def load_registry(self):
        """Load this thread's entity registry from the database."""
        result = self._supabase.table("thread_entity_registry").select(
            "entity_type, original_value, surrogate_value, normalized_key"
        ).eq("thread_id", self._thread_id).execute()

        count = 0
        for row in result.data:
            entity_type = row["entity_type"]
            original = row["original_value"]
            surrogate = row["surrogate_value"]
            normalized = row["normalized_key"]

            self._anon_map[entity_type][normalized] = surrogate
            # Prefer the longest original for de-anonymization
            # (e.g. "Margaret Thompson" over "M. Thompson")
            if surrogate not in self._deanon_map or len(original) > len(self._deanon_map[surrogate]):
                self._deanon_map[surrogate] = original
            self._all_surrogates.add(surrogate)
            count += 1

            # Track original PERSON name components for Faker collision prevention
            if entity_type == "PERSON":
                from nameparser import HumanName
                parsed = HumanName(original)
                if parsed.first:
                    self._original_person_components.add(parsed.first.lower().strip())
                if parsed.last:
                    self._original_person_components.add(parsed.last.lower().strip())

        logger.info(
            f"ThreadRedactionService loaded {count} registry entries "
            f"for thread {self._thread_id}"
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _normalize_key(value: str) -> str:
        """Lowercase + strip for consistent lookup."""
        return value.lower().strip()

    def _generate_candidate_surrogates(self, entities: list) -> dict:
        """Generate Faker surrogates for entities not already in the registry.

        Args:
            entities: list of dicts with 'original_value' and 'entity_type'.

        Returns:
            dict mapping original_value -> candidate surrogate.
        """
        candidates = {}
        for ent in entities:
            original = ent["original_value"]
            entity_type = ent["entity_type"]
            normalized = self._normalize_key(original)

            # Already registered — skip
            if normalized in self._anon_map.get(entity_type, {}):
                continue
            # Already generated a candidate in this batch — skip
            if original in candidates:
                continue

            generator = FAKER_GENERATORS.get(entity_type)
            if not generator:
                import uuid
                candidates[original] = f"{entity_type}_{str(uuid.uuid4())[:8]}"
                continue

            # Try up to 10 times to avoid collisions
            for _ in range(10):
                if entity_type == "PERSON":
                    candidate = _generate_gendered_name(self._faker, original)
                else:
                    candidate = generator(self._faker)
                if candidate in self._all_surrogates:
                    continue
                # For PERSON entities, reject candidates whose name components
                # overlap with original person names (prevents fuzzy collisions)
                if entity_type == "PERSON" and self._original_person_components:
                    from nameparser import HumanName
                    parsed_candidate = HumanName(candidate)
                    candidate_first = parsed_candidate.first.lower().strip() if parsed_candidate.first else None
                    candidate_last = parsed_candidate.last.lower().strip() if parsed_candidate.last else None
                    if (candidate_first and candidate_first in self._original_person_components) or \
                       (candidate_last and candidate_last in self._original_person_components):
                        continue
                candidates[original] = candidate
                break
            else:
                import uuid
                candidates[original] = f"{entity_type}_{str(uuid.uuid4())[:8]}"

        return candidates

    # ------------------------------------------------------------------
    # Surrogate validation
    # ------------------------------------------------------------------

    @staticmethod
    def _is_surrogate_valid_for_type(entity_type: str, surrogate: str) -> bool:
        """Check if a surrogate value is format-appropriate for its entity type.

        The local LLM sometimes assigns a PERSON surrogate (e.g. "Wayne King")
        to an EMAIL_ADDRESS or PHONE_NUMBER.  This guard rejects those so the
        caller can fall back to the Faker-generated candidate.
        """
        if entity_type == "EMAIL_ADDRESS":
            return "@" in surrogate
        if entity_type == "PHONE_NUMBER":
            return any(c.isdigit() for c in surrogate) and len(surrogate) >= 7
        if entity_type == "IP_ADDRESS":
            return surrogate.count(".") >= 3 and any(c.isdigit() for c in surrogate)
        if entity_type == "URL":
            return "." in surrogate  # minimal: contains a dot
        if entity_type == "IBAN_CODE":
            return len(surrogate) >= 10 and any(c.isdigit() for c in surrogate)
        if entity_type == "CREDIT_CARD":
            return any(c.isdigit() for c in surrogate) and len(surrogate) >= 12
        if entity_type == "US_SSN":
            return any(c.isdigit() for c in surrogate)
        if entity_type == "US_BANK_NUMBER":
            return any(c.isdigit() for c in surrogate)
        # PERSON, LOCATION, ORG, DATE_TIME, etc. — any string is acceptable
        return True

    # ------------------------------------------------------------------
    # Name parsing helpers (algorithmic mode)
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_person_entity(value: str) -> ParsedPerson:
        """Parse a PERSON entity into components with nickname resolution."""
        from nameparser import HumanName
        name = HumanName(value)
        nn = get_nicknamer()

        title = name.title if name.title else None
        first = name.first.lower().strip() if name.first else None
        last = name.last.lower().strip() if name.last else None

        canonical_first = None
        if first:
            canonicals = nn.canonicals_of(first)
            # Include the name itself so related names converge to same canonical
            # e.g. "danny" -> min({"danny","daniel","sheridan"}) = "daniel"
            #      "daniel" -> min({"daniel","danny"}) = "daniel"
            all_names = {first} | canonicals
            canonical_first = min(all_names)

        return ParsedPerson(
            index=0,
            original_value=value,
            title=title,
            canonical_first=canonical_first,
            last=last,
        )

    @staticmethod
    def _normalize_non_person_entity(entity_type: str, value: str) -> str:
        """Type-specific normalization for non-PERSON entities."""
        if entity_type == "EMAIL_ADDRESS":
            return value.lower().strip()
        if entity_type == "PHONE_NUMBER":
            digits = re.sub(r"\D", "", value)
            if len(digits) >= 11 and digits.startswith("1"):
                digits = digits[1:]
            return digits
        if entity_type == "IP_ADDRESS":
            return value.strip()
        if entity_type == "URL":
            v = value.lower().strip().rstrip("/")
            if v.startswith("www."):
                v = v[4:]
            return v
        if entity_type == "IBAN_CODE":
            return value.replace(" ", "").upper()
        if entity_type == "CREDIT_CARD":
            return re.sub(r"[\s-]", "", value)
        if entity_type == "US_SSN":
            return value.replace("-", "")
        return value.lower().strip()

    @staticmethod
    def _derive_sub_surrogate(reference_surrogate: str, member: ParsedPerson) -> str:
        """Derive a sub-surrogate matching the member's name form.

        E.g. reference "Marcus Smith" + member form "Mr. Walsh" -> "Mr. Smith"
        """
        from nameparser import HumanName
        ref = HumanName(reference_surrogate)
        parts = []
        if member.title:
            parts.append(member.title)
        if member.canonical_first is not None and ref.first:
            parts.append(ref.first)
        if member.last is not None and ref.last:
            parts.append(ref.last)
        return " ".join(parts) if parts else reference_surrogate

    # ------------------------------------------------------------------
    # Entity resolution: fallback (no clustering)
    # ------------------------------------------------------------------

    def _resolve_entities_fallback(self, entities: list, candidates: dict) -> list[dict]:
        """No clustering - each entity gets its own candidate mapping."""
        fallback = []
        for ent in entities:
            original = ent["original_value"]
            entity_type = ent["entity_type"]
            normalized = self._normalize_key(original)

            existing = self._anon_map.get(entity_type, {}).get(normalized)
            if existing:
                fallback.append({
                    "original_value": original,
                    "surrogate_value": existing,
                    "entity_type": entity_type,
                    "cluster_id": normalized,
                })
            elif original in candidates:
                fallback.append({
                    "original_value": original,
                    "surrogate_value": candidates[original],
                    "entity_type": entity_type,
                    "cluster_id": normalized,
                })
        return fallback

    # ------------------------------------------------------------------
    # Local LLM entity resolution
    # ------------------------------------------------------------------

    async def _resolve_person_names_with_llm(
        self, text: str, entities: list, candidates: dict
    ) -> dict:
        """Use local LLM to cluster PERSON name entities.

        Only called when entity_resolution_mode == "llm" AND there are
        PERSON candidates to resolve.

        Returns dict: {original_name -> surrogate_name} for PERSON entities.
        Falls back to person_candidates as-is if LLM is unavailable or parse fails.
        """
        person_names = {
            ent["original_value"]
            for ent in entities
            if ent["entity_type"] == "PERSON"
        }
        person_candidates = {
            name: surr for name, surr in candidates.items()
            if name in person_names
        }

        if not person_candidates:
            return person_candidates

        # Build existing PERSON registry
        person_registry = {}
        for normalized, surrogate in self._anon_map.get("PERSON", {}).items():
            person_registry[normalized] = surrogate

        prompt = (
            "You are a name resolution specialist.\n\n"
            "Given person names with proposed surrogate replacements, determine which "
            "names refer to the same person and assign consistent surrogates.\n\n"
            f'Text: "{text}"\n'
            f"Names to resolve: {json.dumps(person_candidates)}\n"
            f"Already-assigned names: {json.dumps(person_registry)}\n\n"
            "Rules:\n"
            "- Cluster names referring to the same person: nicknames "
            "(Danny/Daniel), abbreviations (M. Thompson/Margaret), titles\n"
            "- Clustered names share a surrogate family "
            '(e.g. "Daniel Walsh" -> "Marcus Smith" means "Danny" -> "Marcus")\n'
            "- Already-assigned names -> reuse existing surrogate exactly\n\n"
            "Output JSON:\n"
            '{"mappings": {"original_name": "surrogate", ...}}'
        )

        raw = await call_local_llm(prompt, response_format=_JSON_RESPONSE_FORMAT)
        if isinstance(raw, str):
            try:
                parsed = json.loads(raw)
                mappings = parsed.get("mappings", {})
                if mappings and isinstance(mappings, dict):
                    return mappings
            except (json.JSONDecodeError, KeyError, TypeError):
                logger.warning("Failed to parse local LLM name resolution response")

        return person_candidates

    async def _scan_missed_pii_with_llm(self, text: str) -> list[dict]:
        """Use local LLM to scan for hard-redact PII that Presidio missed.

        Called when pii_missed_scan_enabled is True, regardless of
        entity_resolution_mode.

        Returns list[dict]: missed hard-redact entities
        [{"text": ..., "entity_type": ...}]. Returns [] on failure.
        """
        _, redact_set = get_pii_entity_sets()
        redact_types_str = ", ".join(sorted(redact_set))

        prompt = (
            "You are a PII detection specialist. Scan the text for sensitive data that "
            "should have been replaced with [TYPE] placeholders but was missed.\n"
            f"Look for: {redact_types_str}.\n"
            "Only report items that are NOT already replaced with [TYPE] placeholders.\n\n"
            f'Text: "{text}"\n\n'
            "Output JSON (max 5 unique items, no duplicates):\n"
            '{"missed_redactions": [{"text": "exact text found", "entity_type": "CREDIT_CARD"}]}'
        )

        raw = await call_local_llm(prompt, response_format=_JSON_RESPONSE_FORMAT)
        if isinstance(raw, str):
            try:
                parsed = json.loads(raw)
                missed_redactions = parsed.get("missed_redactions", [])

                valid_missed: list[dict] = []
                seen_missed: set[str] = set()
                for entry in missed_redactions:
                    if not isinstance(entry, dict):
                        continue
                    entry_text = entry.get("text", "")
                    entry_type = entry.get("entity_type", "")
                    if not entry_text or not entry_type or entry_type.upper() not in redact_set:
                        continue
                    dedup_key = f"{entry_text}|{entry_type.upper()}"
                    if dedup_key in seen_missed:
                        continue
                    seen_missed.add(dedup_key)
                    valid_missed.append({
                        "text": entry_text,
                        "entity_type": entry_type.upper(),
                    })

                if valid_missed:
                    logger.info(f"LLM found {len(valid_missed)} missed hard-redact entities")

                return valid_missed
            except (json.JSONDecodeError, KeyError, TypeError):
                logger.warning("Failed to parse local LLM missed PII scan response")

        return []

    # ------------------------------------------------------------------
    # Entity resolution: algorithmic (no LLM)
    # ------------------------------------------------------------------

    async def _resolve_entities_algorithmic(
        self, text: str, entities: list, candidates: dict
    ) -> list[dict]:
        """Cluster entities using name parsing + nickname resolution + union-find."""
        person_ents = [e for e in entities if e["entity_type"] == "PERSON"]
        non_person_ents = [e for e in entities if e["entity_type"] != "PERSON"]

        result = []

        # --- Non-PERSON: group by (type, normalized) ---
        non_person_groups: dict[tuple[str, str], str] = {}
        for ent in non_person_ents:
            original = ent["original_value"]
            entity_type = ent["entity_type"]
            normalized = self._normalize_non_person_entity(entity_type, original)
            key = (entity_type, normalized)

            # Check existing registry
            std_norm = self._normalize_key(original)
            existing = self._anon_map.get(entity_type, {}).get(std_norm)

            if existing:
                result.append({
                    "original_value": original,
                    "surrogate_value": existing,
                    "entity_type": entity_type,
                    "cluster_id": normalized,
                })
            elif key in non_person_groups:
                result.append({
                    "original_value": original,
                    "surrogate_value": non_person_groups[key],
                    "entity_type": entity_type,
                    "cluster_id": normalized,
                })
            elif original in candidates:
                non_person_groups[key] = candidates[original]
                result.append({
                    "original_value": original,
                    "surrogate_value": candidates[original],
                    "entity_type": entity_type,
                    "cluster_id": normalized,
                })

        if not person_ents:
            return result

        # --- PERSON: parse + cluster ---
        nn = get_nicknamer()

        new_parsed = []
        for i, ent in enumerate(person_ents):
            pp = self._parse_person_entity(ent["original_value"])
            pp.index = i
            new_parsed.append(pp)

        n = len(new_parsed)
        uf = UnionFind(n)

        # Parse existing PERSON registry entries
        existing_full: dict[tuple[str, str], str] = {}
        existing_by_last: dict[str, list[str]] = defaultdict(list)
        existing_by_first: dict[str, list[str]] = defaultdict(list)

        for norm_key, surrogate in self._anon_map.get("PERSON", {}).items():
            from nameparser import HumanName
            ep = HumanName(norm_key)
            first = ep.first.lower().strip() if ep.first else None
            last = ep.last.lower().strip() if ep.last else None
            canon = None
            if first:
                canonicals = nn.canonicals_of(first)
                all_names = {first} | canonicals
                canon = min(all_names)
            if canon and last:
                existing_full[(canon, last)] = surrogate
                existing_by_last[last].append(surrogate)
                existing_by_first[canon].append(surrogate)

        # Match new entities to existing registry
        matched_to_existing: dict[int, str] = {}
        for i, pp in enumerate(new_parsed):
            std_norm = self._normalize_key(pp.original_value)
            existing = self._anon_map.get("PERSON", {}).get(std_norm)
            if existing:
                matched_to_existing[i] = existing
                continue
            if pp.canonical_first and pp.last:
                existing = existing_full.get((pp.canonical_first, pp.last))
                if existing:
                    matched_to_existing[i] = existing

        # Rule A: Same (canonical_first, last) among new entities
        for i in range(n):
            for j in range(i + 1, n):
                pi, pj = new_parsed[i], new_parsed[j]
                if (pi.canonical_first and pj.canonical_first
                        and pi.last and pj.last
                        and pi.canonical_first == pj.canonical_first
                        and pi.last == pj.last):
                    uf.union(i, j)

        # Union entities matched to same existing surrogate
        surr_to_idx: dict[str, list[int]] = defaultdict(list)
        for i, surr in matched_to_existing.items():
            surr_to_idx[surr].append(i)
        for indices in surr_to_idx.values():
            for k in range(1, len(indices)):
                uf.union(indices[0], indices[k])

        def _build_clusters():
            c = defaultdict(list)
            for i in range(n):
                c[uf.find(i)].append(i)
            return c

        # Collect full-name last names (new clusters + existing)
        clusters = _build_clusters()
        all_lasts: dict[str, set] = defaultdict(set)
        for root, members in clusters.items():
            for m in members:
                if new_parsed[m].canonical_first and new_parsed[m].last:
                    all_lasts[new_parsed[m].last].add(("new", root))
                    break
        for (canon, last), surr in existing_full.items():
            all_lasts[last].add(("existing", surr))

        # Rule B: Last-name-only -> unambiguous cluster
        for i in range(n):
            if i in matched_to_existing:
                continue
            pp = new_parsed[i]
            if pp.last and not pp.canonical_first:
                matches = all_lasts.get(pp.last, set())
                if len(matches) == 1:
                    match = next(iter(matches))
                    if match[0] == "new":
                        uf.union(i, match[1])
                    else:
                        matched_to_existing[i] = match[1]

        # Rebuild for Rule C
        clusters = _build_clusters()
        all_firsts: dict[str, set] = defaultdict(set)
        for root, members in clusters.items():
            for m in members:
                if new_parsed[m].canonical_first and new_parsed[m].last:
                    all_firsts[new_parsed[m].canonical_first].add(("new", root))
                    break
        for (canon, last), surr in existing_full.items():
            all_firsts[canon].add(("existing", surr))

        # Rule C: First-name-only -> unambiguous cluster
        for i in range(n):
            if i in matched_to_existing:
                continue
            pp = new_parsed[i]
            if pp.canonical_first and not pp.last:
                matches = all_firsts.get(pp.canonical_first, set())
                if len(matches) == 1:
                    match = next(iter(matches))
                    if match[0] == "new":
                        uf.union(i, match[1])
                    else:
                        matched_to_existing[i] = match[1]

        # Final surrogate assignment
        clusters = _build_clusters()
        for root, members in clusters.items():
            ref_surrogate = None
            for m in members:
                if m in matched_to_existing:
                    ref_surrogate = matched_to_existing[m]
                    break

            if not ref_surrogate:
                ref_idx = max(members, key=lambda i: len(new_parsed[i].original_value))
                ref_surrogate = candidates.get(person_ents[ref_idx]["original_value"])
                if not ref_surrogate:
                    for m in members:
                        cand = candidates.get(person_ents[m]["original_value"])
                        if cand:
                            ref_surrogate = cand
                            break

            if not ref_surrogate:
                continue

            for m in members:
                pp = new_parsed[m]
                orig = person_ents[m]["original_value"]

                if pp.canonical_first and pp.last:
                    surrogate = ref_surrogate
                else:
                    surrogate = self._derive_sub_surrogate(ref_surrogate, pp)

                result.append({
                    "original_value": orig,
                    "surrogate_value": surrogate,
                    "entity_type": "PERSON",
                    "cluster_id": f"person_cluster_{root}",
                })

        logger.debug(
            f"[ALGORITHMIC] Resolved {len(result)} entities "
            f"({len(clusters)} PERSON clusters)"
        )
        return result

    # ------------------------------------------------------------------
    # Algorithmic de-anonymization (no LLM)
    # ------------------------------------------------------------------

    def _deanonymize_algorithmic(self, text: str) -> str:
        """Find fuzzy surrogate references using nameparser."""
        person_surrogates = self._anon_map.get("PERSON", {})
        if not person_surrogates:
            return text

        surrogate_info = []
        for _norm_key, surrogate in person_surrogates.items():
            original = self._deanon_map.get(surrogate)
            if not original:
                continue
            from nameparser import HumanName
            ps = HumanName(surrogate)
            po = HumanName(original)
            surrogate_info.append((surrogate, original, ps, po))

        if not surrogate_info:
            return text

        # Count last/first names for ambiguity check
        last_count: dict[str, int] = defaultdict(int)
        first_count: dict[str, int] = defaultdict(int)
        for _, _, ps, _ in surrogate_info:
            if ps.last:
                last_count[ps.last] += 1
            if ps.first:
                first_count[ps.first] += 1

        all_replacements = []
        for surrogate, original, ps, po in surrogate_info:
            if surrogate in text:
                continue  # Handled by exact match

            # Title + Last (high confidence)
            if ps.last:
                for title in ["Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Miss"]:
                    form = f"{title} {ps.last}"
                    if form in text:
                        repl = f"{title} {po.last}" if po.last else original
                        all_replacements.append((len(form), form, repl))

            # Last name only (unambiguous)
            if ps.last and last_count[ps.last] == 1:
                if po.last and re.search(r"\b" + re.escape(ps.last) + r"\b", text):
                    all_replacements.append((len(ps.last), ps.last, po.last))

            # First name only (unambiguous)
            if ps.first and first_count[ps.first] == 1:
                if po.first and re.search(r"\b" + re.escape(ps.first) + r"\b", text):
                    all_replacements.append((len(ps.first), ps.first, po.first))

        # Sort longest first to avoid partial replacement issues
        all_replacements.sort(key=lambda x: x[0], reverse=True)
        for _, form, replacement in all_replacements:
            text = re.sub(r"\b" + re.escape(form) + r"\b", replacement, text)

        return text

    # ------------------------------------------------------------------
    # Core anonymize / deanonymize
    # ------------------------------------------------------------------

    async def anonymize(self, text: str) -> str:
        """Detect PII and replace with consistent surrogates.

        Pipeline:
        1. Presidio entity detection
        2. Check registry for existing mappings
        3. Generate Faker candidates for new entities
        4. Call local LLM for entity resolution (optional)
        5. Sort replacements by position (reverse) to preserve offsets
        6. Programmatic string replacement
        7. Update internal maps
        8. Persist new mappings to DB
        """
        if not text:
            return text

        # Step 1: Single-pass Presidio detection with all entity types
        logger.debug(f"[ANONYMIZE] Input text ({len(text)} chars): {text[:200]}...")
        surrogate_set, redact_set = get_pii_entity_sets()

        settings = get_settings()
        surrogate_threshold = settings.pii_surrogate_score_threshold
        redact_threshold = settings.pii_redact_score_threshold

        # Single Presidio call at the lower threshold, then filter by type
        # This halves the CPU-bound NLP inference cost vs two separate passes.
        all_results = self._analyzer.analyze(
            text=text,
            language="en",
            entities=list(surrogate_set | redact_set),
            score_threshold=min(surrogate_threshold, redact_threshold),
        )

        # Post-filter: discard detections overlapping with UUIDs
        # Presidio matches hex segments inside UUIDs as US_DRIVER_LICENSE etc.
        uuid_spans = [(m.start(), m.end()) for m in _UUID_RE.finditer(text)]
        if uuid_spans:
            pre_count = len(all_results)
            all_results = [
                r for r in all_results
                if not any(u_s <= r.start and r.end <= u_e for u_s, u_e in uuid_spans)
            ]
            dropped = pre_count - len(all_results)
            if dropped:
                logger.debug(
                    f"[ANONYMIZE] Dropped {dropped} result(s) overlapping "
                    f"with {len(uuid_spans)} UUID span(s)"
                )

        # Split results by type and apply the appropriate score threshold
        surrogate_results = [
            r for r in all_results
            if r.entity_type in surrogate_set and r.score >= surrogate_threshold
        ]
        hard_redact_results = [
            r for r in all_results
            if r.entity_type in redact_set and r.score >= redact_threshold
        ]

        # Resolve overlaps: two separate Presidio passes bypass its internal
        # overlap resolution, so we reconcile here.
        # 1) Drop hard-redact detections fully inside a larger surrogate span
        # 2) Deduplicate same-position entities (keep highest score per span)
        filtered_hard = []
        for hr in hard_redact_results:
            inside_surrogate = any(
                sr.start <= hr.start and hr.end <= sr.end
                and (sr.start != hr.start or sr.end != hr.end)
                for sr in surrogate_results
            )
            if inside_surrogate:
                logger.debug(
                    f"[ANONYMIZE] Dropping overlapping hard-redact: "
                    f"{hr.entity_type}:'{text[hr.start:hr.end]}' inside surrogate span"
                )
            else:
                filtered_hard.append(hr)

        # Deduplicate same-span hard-redact entities (e.g. a 9-digit number
        # detected as both US_BANK_NUMBER and US_PASSPORT at the same position).
        # Keep the highest-scoring detection per span to avoid double-replacement.
        seen_spans: dict[tuple[int, int], object] = {}
        for hr in filtered_hard:
            span = (hr.start, hr.end)
            if span in seen_spans:
                existing = seen_spans[span]
                if hr.score > existing.score:
                    seen_spans[span] = hr
                    logger.debug(
                        f"[ANONYMIZE] Dedup: replaced {existing.entity_type} with "
                        f"{hr.entity_type} at {span} (score {existing.score:.2f} -> {hr.score:.2f})"
                    )
            else:
                seen_spans[span] = hr
        deduped_hard = list(seen_spans.values())

        results = surrogate_results + deduped_hard
        logger.debug(f"[ANONYMIZE] Presidio found {len(results)} entities")
        for r in results:
            logger.debug(f"  -> {r.entity_type}: '{text[r.start:r.end]}' (score={r.score:.2f}, pos={r.start}-{r.end})")

        if not results:
            logger.debug("[ANONYMIZE] No entities detected, returning original text")
            return text

        # Step 2: Build entity list, skipping known surrogates,
        # and split into hard-redact vs surrogate groups
        hard_redact_entities = []
        entities = []
        for r in results:
            detected = text[r.start:r.end]
            if detected in self._all_surrogates:
                logger.debug(f"Skipping '{detected}' — already a known surrogate")
                continue
            ent = {
                "original_value": detected,
                "entity_type": r.entity_type,
                "start": r.start,
                "end": r.end,
            }
            if r.entity_type in redact_set:
                hard_redact_entities.append(ent)
            else:
                entities.append(ent)

        if not entities and not hard_redact_entities:
            logger.debug("[ANONYMIZE] All detected entities are known surrogates, returning original")
            return text

        logger.debug(
            f"[ANONYMIZE] {len(entities)} surrogate entities, "
            f"{len(hard_redact_entities)} hard-redact entities"
        )

        # Step 2b: Apply hard redaction (replace with [ENTITY_TYPE] placeholders)
        # These are never reversible - no registry entry, no Faker generation
        if hard_redact_entities:
            # Sort by position descending to preserve offsets
            hard_sorted = sorted(hard_redact_entities, key=lambda e: e["start"], reverse=True)
            for ent in hard_sorted:
                placeholder = f"[{ent['entity_type']}]"
                text = text[:ent["start"]] + placeholder + text[ent["end"]:]
                logger.debug(
                    f"  -> Hard-redacted '{ent['original_value']}' => '{placeholder}'"
                )

            # Recalculate positions for surrogate entities since text changed
            # Re-run Presidio on the updated text to get correct offsets
            if entities:
                results = self._analyzer.analyze(
                    text=text,
                    language="en",
                    entities=list(surrogate_set),
                    score_threshold=0.7,
                )
                entities = []
                for r in results:
                    detected = text[r.start:r.end]
                    if detected in self._all_surrogates:
                        continue
                    if r.entity_type in surrogate_set:
                        entities.append({
                            "original_value": detected,
                            "entity_type": r.entity_type,
                            "start": r.start,
                            "end": r.end,
                        })

        if not entities:
            logger.debug("[ANONYMIZE] No surrogate entities remaining after hard redaction")
            return text

        logger.debug(f"[ANONYMIZE] {len(entities)} entities to process after filtering")

        # Step 3: Generate candidate surrogates for new entities
        candidates = self._generate_candidate_surrogates(entities)
        logger.debug(f"[ANONYMIZE] Generated {len(candidates)} candidate surrogates:")
        for orig, surr in candidates.items():
            logger.debug(f"  -> '{orig}' => '{surr}'")

        # Step 4: Entity resolution (dispatch by mode)
        mode = get_entity_resolution_mode()
        if mode == "algorithmic":
            logger.debug("[ANONYMIZE] Using algorithmic entity resolution...")
            resolved = await self._resolve_entities_algorithmic(text, entities, candidates)
            resolved_map = {m["original_value"]: m["surrogate_value"] for m in resolved}
        elif mode == "none":
            logger.debug("[ANONYMIZE] No entity resolution (each entity gets own surrogate)...")
            resolved = self._resolve_entities_fallback(entities, candidates)
            resolved_map = {m["original_value"]: m["surrogate_value"] for m in resolved}
        else:
            logger.debug("[ANONYMIZE] Using local LLM entity resolution...")
            person_names = {e["original_value"] for e in entities if e["entity_type"] == "PERSON"}
            has_person_candidates = any(name in candidates for name in person_names)
            if has_person_candidates:
                resolved_map = await self._resolve_person_names_with_llm(text, entities, candidates)
            else:
                resolved = self._resolve_entities_fallback(entities, candidates)
                resolved_map = {m["original_value"]: m["surrogate_value"] for m in resolved}
        logger.debug(f"[ANONYMIZE] Resolved {len(resolved_map)} mappings")

        # Step 4b: Missed PII scan (independent of resolution mode)
        missed_hard_redactions: list[dict] = []
        if settings.pii_missed_scan_enabled:
            missed_hard_redactions = await self._scan_missed_pii_with_llm(text)

        # Step 4c: Apply any missed hard-redact entities found by the LLM
        if missed_hard_redactions:
            text_changed = False
            for missed in missed_hard_redactions:
                missed_text = missed["text"]
                placeholder = f"[{missed['entity_type']}]"
                if missed_text in text:
                    text = text.replace(missed_text, placeholder)
                    text_changed = True
                    logger.debug(
                        f"  -> LLM-detected hard-redact: '{missed_text}' => '{placeholder}'"
                    )
            if text_changed:
                # Re-run Presidio to get correct offsets for surrogate entities
                results = self._analyzer.analyze(
                    text=text,
                    language="en",
                    entities=list(surrogate_set),
                    score_threshold=0.7,
                )
                entities = []
                for r in results:
                    detected = text[r.start:r.end]
                    if detected in self._all_surrogates:
                        continue
                    if r.entity_type in surrogate_set:
                        entities.append({
                            "original_value": detected,
                            "entity_type": r.entity_type,
                            "start": r.start,
                            "end": r.end,
                        })
                # Regenerate candidates for any new entities
                candidates = self._generate_candidate_surrogates(entities)
                logger.debug(
                    f"[ANONYMIZE] After LLM missed-redaction pass: "
                    f"{len(entities)} surrogate entities, "
                    f"{len(candidates)} new candidates"
                )

        # Step 5: Sort by position descending
        entities_sorted = sorted(entities, key=lambda e: e["start"], reverse=True)

        # Step 6: Programmatic replacement
        anonymized = text
        new_mappings = []
        for ent in entities_sorted:
            original = ent["original_value"]
            entity_type = ent["entity_type"]
            normalized = self._normalize_key(original)

            # Determine surrogate: resolved map > existing registry > candidate
            # Validate that LLM-assigned surrogates match the entity type
            # (e.g. reject a person name for an EMAIL_ADDRESS).
            surrogate = resolved_map.get(original)
            if surrogate and not self._is_surrogate_valid_for_type(entity_type, surrogate):
                logger.debug(
                    f"[ANONYMIZE] Rejected LLM surrogate '{surrogate}' for "
                    f"{entity_type} '{original}' — format mismatch"
                )
                surrogate = None
            if not surrogate:
                surrogate = self._anon_map.get(entity_type, {}).get(normalized)
            if not surrogate:
                surrogate = candidates.get(original)
            if not surrogate:
                continue

            anonymized = anonymized[:ent["start"]] + surrogate + anonymized[ent["end"]:]

            # Step 7: Update internal maps
            if normalized not in self._anon_map.get(entity_type, {}):
                self._anon_map[entity_type][normalized] = surrogate
                # Prefer the longest original for de-anonymization
                # (e.g. "Margaret Thompson" over "M. Thompson")
                if surrogate not in self._deanon_map or len(original) > len(self._deanon_map[surrogate]):
                    self._deanon_map[surrogate] = original
                self._all_surrogates.add(surrogate)
                # Track original PERSON name components for Faker collision prevention
                if entity_type == "PERSON":
                    from nameparser import HumanName
                    parsed_orig = HumanName(original)
                    if parsed_orig.first:
                        self._original_person_components.add(parsed_orig.first.lower().strip())
                    if parsed_orig.last:
                        self._original_person_components.add(parsed_orig.last.lower().strip())
                new_mappings.append({
                    "thread_id": self._thread_id,
                    "entity_type": entity_type,
                    "original_value": original,
                    "surrogate_value": surrogate,
                    "normalized_key": normalized,
                })

        # Step 8: Persist
        if new_mappings:
            logger.debug(f"[ANONYMIZE] Persisting {len(new_mappings)} new mappings to DB")
            await self._persist_mappings(new_mappings)

        logger.debug(f"[ANONYMIZE] Output text ({len(anonymized)} chars): {anonymized[:200]}...")
        return anonymized

    def deanonymize(self, text: str) -> str:
        """Replace all surrogate values with originals using word-boundary matching.

        Uses regex word boundaries to prevent mid-word replacements
        (e.g. surrogate "Art" matching inside "artificial").
        Sorts by surrogate length (longest first) to avoid partial matches.
        """
        if not text:
            return text

        logger.debug(f"[DEANONYMIZE] Input ({len(text)} chars): {text[:200]}...")
        logger.debug(f"[DEANONYMIZE] Registry has {len(self._deanon_map)} surrogate->original mappings")

        # Sort by length descending
        sorted_mappings = sorted(
            self._deanon_map.items(),
            key=lambda x: len(x[0]),
            reverse=True,
        )

        replacements = 0
        for surrogate, original in sorted_mappings:
            pattern = r"\b" + re.escape(surrogate) + r"\b"
            new_text = re.sub(pattern, original, text, flags=re.IGNORECASE)
            if new_text != text:
                text = new_text
                replacements += 1
                logger.debug(f"  -> Replaced '{surrogate}' with '{original}'")

        logger.debug(f"[DEANONYMIZE] Made {replacements} replacements")
        return text

    # ------------------------------------------------------------------
    # Placeholder helpers (collision-safe de-anonymization)
    # ------------------------------------------------------------------

    @staticmethod
    def _make_placeholder(index: int) -> str:
        """Return a unique placeholder token like ``<<PH_0000>>``."""
        return f"<<PH_{index:04d}>>"

    def _deanonymize_to_placeholders(self, text: str) -> tuple[str, dict[str, str]]:
        """Replace surrogates with unique placeholder tokens (case-insensitive).

        Returns ``(modified_text, {placeholder: original_value})``.
        """
        if not text:
            return text, {}

        sorted_mappings = sorted(
            self._deanon_map.items(),
            key=lambda x: len(x[0]),
            reverse=True,
        )

        placeholder_map: dict[str, str] = {}
        counter = 0
        for surrogate, original in sorted_mappings:
            pattern = r"\b" + re.escape(surrogate) + r"\b"
            new_text = re.sub(pattern, lambda _m, _ph=self._make_placeholder(counter): _ph, text, flags=re.IGNORECASE)
            if new_text != text:
                placeholder_map[self._make_placeholder(counter)] = original
                text = new_text
                counter += 1

        return text, placeholder_map

    @staticmethod
    def _resolve_placeholders(text: str, placeholder_map: dict[str, str]) -> str:
        """Replace all ``<<PH_NNNN>>`` tokens with their real original values."""
        for placeholder, original in placeholder_map.items():
            text = text.replace(placeholder, original)
        return text

    @traceable(name="pii_deanonymize_llm_response", run_type="chain", tags=["pii-redaction", "local-llm"])
    async def deanonymize_llm_response(self, text: str) -> str:
        """De-anonymize an LLM response using a placeholder pipeline.

        Three-phase approach to prevent fuzzy de-anonymization from
        corrupting already-restored real names:

        1. **Exact match -> placeholders**: Replace surrogates with unique
           ``<<PH_NNNN>>`` tokens (no real names in text yet).
        2. **Fuzzy pass**: Algorithmic or LLM fuzzy matching runs on
           placeholder'd text — no real names visible, so no collision.
        3. **Resolve placeholders -> real names**: Replace all placeholders
           with their original values.
        """
        if not text:
            return text

        if not self._deanon_map:
            return text

        # Phase 1: Exact match -> placeholders
        text, placeholder_map = self._deanonymize_to_placeholders(text)

        # Phase 2: Fuzzy pass (dispatch by mode)
        mode = get_entity_resolution_mode()

        if mode == "algorithmic":
            text = self._deanonymize_algorithmic(text)
        elif mode == "none":
            pass  # No fuzzy de-anonymization
        else:
            # LLM fuzzy pass — only PERSON surrogates need fuzzy matching
            person_surrogates = self._anon_map.get("PERSON", {})
            registry_for_prompt = {}
            for _norm, surrogate in person_surrogates.items():
                original = self._deanon_map.get(surrogate)
                if original:
                    registry_for_prompt[surrogate] = original

            if registry_for_prompt:
                prompt = (
                    "Find references in this LLM response that refer to known surrogates "
                    "but aren't exact matches (e.g., \"Mr. Smith\" for \"Marcus Smith\").\n\n"
                    "Tokens like <<PH_0000>> are placeholders for already-matched "
                    "surrogates. Ignore them.\n\n"
                    f'Response: "{text}"\n'
                    f"Registry: {json.dumps(registry_for_prompt)}\n\n"
                    'Output ONLY JSON: {"additional_mappings": ['
                    '{"text_in_response": "Mr. Smith", "maps_to_surrogate": "Marcus Smith"}]}'
                )

                raw = await call_local_llm(prompt, response_format=_JSON_RESPONSE_FORMAT)
                if raw:
                    try:
                        parsed = json.loads(raw)
                        additional = parsed.get("additional_mappings", [])
                        for mapping in additional:
                            text_in_response = mapping.get("text_in_response", "")
                            maps_to_surrogate = mapping.get("maps_to_surrogate", "")
                            if text_in_response and maps_to_surrogate:
                                original = self._deanon_map.get(maps_to_surrogate)
                                if original and text_in_response in text:
                                    text = text.replace(text_in_response, original)
                    except (json.JSONDecodeError, KeyError):
                        logger.warning("Failed to parse local LLM de-anonymization response")

        # Phase 3: Resolve placeholders -> real names
        text = self._resolve_placeholders(text, placeholder_map)

        return text

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    async def _persist_mappings(self, new_mappings: list[dict]):
        """Upsert new entity mappings to the thread_entity_registry table.

        Uses a single batch upsert to ensure atomicity — either all
        mappings are persisted or the error is logged.  Individual upserts
        risked partial registry corruption on connection drops.
        """
        if not new_mappings:
            return

        try:
            self._supabase.table("thread_entity_registry").upsert(
                new_mappings,
                on_conflict="thread_id,entity_type,normalized_key"
            ).execute()
        except Exception as e:
            logger.warning(f"Failed to persist {len(new_mappings)} entity mappings: {e}")


# ---------------------------------------------------------------------------
# Factory function
# ---------------------------------------------------------------------------

async def create_thread_redaction_service(thread_id: str) -> ThreadRedactionService:
    """Create and initialise a ThreadRedactionService for the given thread."""
    supabase = get_supabase_client()
    svc = ThreadRedactionService(thread_id, supabase)
    await svc.load_registry()
    return svc
