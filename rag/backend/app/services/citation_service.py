"""Citation modes service.

Implements Fast Mode (Prompt-Only / Inline / Span-Level Citation, Unverified)
per citation_mode_spec.md: deterministic span splitting, canonical IDs that
stay stable across turns, answer-local aliases ({[S1]}..{[SN]}), alias parsing,
and validation that cited aliases exist in the current evidence set.

Key invariants:
- Canonical source_id derived from a stable identifier (document_id or
  workspace_file path + thread). Span_id appends a content-hash-based index.
- Answer-local display_ref is {[S<n>]} where n increments per turn (1-based).
- Aliases parsed from the model output are validated against the alias map
  for the current turn only.
- Two turns may both expose ``{[S3]}`` for different canonical span_ids --
  aliases are answer-local by design.
"""

from __future__ import annotations

import hashlib
import logging
import re
import uuid
from dataclasses import dataclass, field, asdict, fields
from typing import Iterable

from app.config import get_settings

logger = logging.getLogger(__name__)

# Canonical citation token is brace-wrapped: {[S<n>]}. The braces make the
# marker lexically distinct from the navigation labels and bracketed numbers
# that appear in tool output / quoted content (e.g. [doc:.. chunk:72], chunk
# ranges [72-73], footnotes) -- which the model used to conflate with citations.
ALIAS_PATTERN = re.compile(r"\{\[S(\d+)\]\}")
# Combined-reference token: one brace pair carrying one or more S-numbers, in
# any of the grouping forms models actually produce:
#   {[S1]}            single
#   {[S1, S8]}        numbers inside one bracket (second+ S optional)
#   {[S1, 2, 3]}      drop-the-prefix
#   {[S1], [S5]}      separate brackets merged in one brace pair
# Each S-number atom is `[?Sn]?`; atoms are separated by an optional comma. The
# atoms never contain { or }, so a match can't span across adjacent tokens.
ALIAS_BLOCK_PATTERN = re.compile(
    r"\{\s*\[?\s*S\s*\d+\s*\]?(?:\s*,?\s*\[?\s*S?\s*\d+\s*\]?)*\s*\}"
)
# Defensive fallback: catch alternate-wrapper tokens the model emits when it
# drops the braces or falls back to a training-default convention -- bare
# [S#] / [W#] / [D#] / [N#] (and lowercase). The (?<!\{)..(?!\}) guards exclude
# the inner [S#] of a canonical {[S#]} token so we never double-process it.
# These are re-interpreted as {[S#]} only when no canonical tokens were used and
# the number matches a registered alias.
FALLBACK_ALIAS_PATTERN = re.compile(r"(?<!\{)\[(?:S|W|D|N|s|w)(\d+)\](?!\})")
FALLBACK_BLOCK_PATTERN = re.compile(
    r"(?<!\{)\[\s*(?:S|W|D|N|s|w)\s*\d+(?:\s*,\s*(?:S|W|D|N|s|w)?\s*\d+)*\s*\](?!\})"
)
NUMBER_PATTERN = re.compile(r"\d+")
SENTENCE_BOUNDARY = re.compile(r"(?<=[\.!?])\s+(?=[A-Z\(\"\'])")

DEFAULT_MAX_SPAN_LEN = 400  # chars
DEFAULT_MIN_SPAN_LEN = 60


# ---- canonical id helpers --------------------------------------------------

def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical_source_id(*, document_id: str | None, file_path: str | None, thread_id: str | None, uri: str | None) -> str:
    """Produce a stable, opaque source id.

    document_id wins (already opaque). For workspace files we hash
    thread_id+file_path. For web sources we hash uri.
    """
    if document_id:
        return f"doc_{document_id[:12]}"
    if thread_id and file_path:
        h = _sha(f"{thread_id}|{file_path}")[:12]
        return f"ws_{h}"
    if uri:
        h = _sha(uri)[:12]
        return f"web_{h}"
    return f"src_{uuid.uuid4().hex[:12]}"


def canonical_span_id(source_id: str, span_text: str, span_index: int) -> str:
    """span_id is source-scoped and content-stable.

    We use ``source_id.span_<idx>_<hash6>``; the hash is over the trimmed
    span text so identical content across turns shares the same id and the
    span_index disambiguates near-duplicates.
    """
    h = _sha(span_text.strip())[:6]
    return f"{source_id}.span_{span_index:04d}_{h}"


# ---- span splitting --------------------------------------------------------

def split_into_spans(text: str, *, max_len: int = DEFAULT_MAX_SPAN_LEN, min_len: int = DEFAULT_MIN_SPAN_LEN) -> list[str]:
    """Split ``text`` into citable spans deterministically.

    Strategy: sentence-split first, then merge very short fragments forward
    so a span has at least ``min_len`` chars, and break sentences that exceed
    ``max_len`` on whitespace. Pure code, no LLM in the loop.
    """
    text = (text or "").strip()
    if not text:
        return []

    # Initial split on sentence boundaries.
    rough = SENTENCE_BOUNDARY.split(text)

    spans: list[str] = []
    buf = ""
    for piece in rough:
        piece = piece.strip()
        if not piece:
            continue
        # Break overly long sentences on whitespace.
        while len(piece) > max_len:
            cut = piece.rfind(" ", 0, max_len)
            if cut <= 0:
                cut = max_len
            head, piece = piece[:cut].strip(), piece[cut:].strip()
            if head:
                if buf and len(buf) < min_len:
                    spans.append((buf + " " + head).strip())
                    buf = ""
                else:
                    if buf:
                        spans.append(buf)
                    spans.append(head)
                    buf = ""
        # Merge short fragments with buffer until min_len reached.
        candidate = (buf + " " + piece).strip() if buf else piece
        if len(candidate) >= min_len:
            spans.append(candidate)
            buf = ""
        else:
            buf = candidate

    if buf:
        if spans:
            spans[-1] = (spans[-1] + " " + buf).strip()
        else:
            spans.append(buf)

    return spans


# ---- evidence registration -------------------------------------------------

@dataclass
class EvidenceSpan:
    span_id: str
    source_id: str
    source_type: str  # 'document' | 'workspace_file' | 'web'
    title: str
    text: str
    document_id: str | None = None
    file_path: str | None = None
    thread_id: str | None = None
    content_type: str | None = None
    uri: str | None = None
    chunk_id: str | None = None
    start_char_in_chunk: int | None = None
    end_char_in_chunk: int | None = None


@dataclass
class AnswerAlias:
    display_ref: str
    display_number: int
    span: EvidenceSpan


def span_to_registry_dict(span: EvidenceSpan) -> dict:
    """Serialise an EvidenceSpan for the per-thread citation registry (Plan 23 B)."""
    return asdict(span)


def span_from_registry_dict(data: dict) -> EvidenceSpan:
    """Rebuild an EvidenceSpan from a registry entry, tolerating schema drift.

    Unknown keys are dropped; a missing required field raises (caught by the
    caller per-entry) so one bad row can't break a whole rehydration.
    """
    allowed = {f.name for f in fields(EvidenceSpan)}
    return EvidenceSpan(**{k: v for k, v in (data or {}).items() if k in allowed})


@dataclass
class CitationContext:
    """Per-turn context that tracks the aliases registered so far.

    A new CitationContext is created at the start of every assistant turn so
    aliases are answer-local. Canonical span_ids and source_ids carry across
    turns; their alias mapping does not.
    """

    turn_id: str
    aliases: list[AnswerAlias] = field(default_factory=list)
    _by_span: dict[str, AnswerAlias] = field(default_factory=dict)
    _next_number: int = 1
    max_aliases: int = 0
    # Side-channel of captured web page text, keyed by canonical source_id.
    # Populated by register_web_results at search time; drained by the citation
    # finalizer in chat.py to persist snapshots for cited web sources.
    web_snapshots: dict[str, dict] = field(default_factory=dict)
    # Plan 23 B: thread-stable numbering. ``_persisted`` maps span_id -> a
    # rehydrated alias (number + span) from the thread's citation registry;
    # ``_persisted_by_number`` indexes the same by display number for validating
    # tokens cited in earlier turns. ``new_assignments`` collects span_ids first
    # numbered this turn, to merge back into the registry.
    _persisted: dict[str, AnswerAlias] = field(default_factory=dict)
    _persisted_by_number: dict[int, AnswerAlias] = field(default_factory=dict)
    new_assignments: dict[str, AnswerAlias] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.max_aliases <= 0:
            self.max_aliases = get_settings().citation_max_aliases_per_turn

    def seed_persisted_aliases(self, registry: dict) -> None:
        """Rehydrate thread-stable numbering from a persisted registry (Plan 23 B).

        ``registry`` maps span_id -> {"n": display_number, "s": EvidenceSpan
        fields}. Loaded once at the start of a turn so a span keeps its display
        number across the whole thread; the next new span numbers above the max.
        Seeded entries populate the lookup only -- not ``aliases`` -- so they
        never consume the per-turn alias cap.
        """
        max_n = 0
        for span_id, entry in (registry or {}).items():
            try:
                number = int(entry["n"])
                span = span_from_registry_dict(entry["s"])
            except (KeyError, TypeError, ValueError):
                continue
            alias = AnswerAlias(
                display_ref=f"{{[S{number}]}}",
                display_number=number,
                span=span,
            )
            self._persisted[str(span_id)] = alias
            self._persisted_by_number[number] = alias
            if number > max_n:
                max_n = number
        if max_n >= self._next_number:
            self._next_number = max_n + 1

    def register_spans(self, spans: Iterable[EvidenceSpan]) -> list[AnswerAlias]:
        """Assign aliases to new spans. Idempotent per span_id.

        Numbering is thread-stable when the context was seeded from a persisted
        registry (Plan 23 B): a span already seen in this thread keeps its
        display number; otherwise it gets the next free number and is recorded in
        ``new_assignments`` for persistence.
        """
        out: list[AnswerAlias] = []
        for span in spans:
            existing = self._by_span.get(span.span_id)
            if existing is not None:
                out.append(existing)
                continue
            if len(self.aliases) >= self.max_aliases:
                logger.warning(
                    "[CITATION] alias cap reached (%d) on turn %s; dropping span %s "
                    "and any later spans this call -- newest evidence may be uncitable",
                    self.max_aliases, self.turn_id, span.span_id,
                )
                break
            persisted = self._persisted.get(span.span_id)
            if persisted is not None:
                # Re-fetched this turn: keep the thread-stable number, bind the
                # fresh span (current source metadata).
                alias = AnswerAlias(
                    display_ref=persisted.display_ref,
                    display_number=persisted.display_number,
                    span=span,
                )
            else:
                alias = AnswerAlias(
                    display_ref=f"{{[S{self._next_number}]}}",
                    display_number=self._next_number,
                    span=span,
                )
                self._next_number += 1
                self.new_assignments[span.span_id] = alias
            self.aliases.append(alias)
            self._by_span[span.span_id] = alias
            out.append(alias)
        return out

    def registry_updates(self) -> dict:
        """span_id -> registry entry for spans first numbered this turn (Plan 23 B)."""
        return {
            span_id: {"n": alias.display_number, "s": span_to_registry_dict(alias.span)}
            for span_id, alias in self.new_assignments.items()
        }

    def mark_registry_persisted(self) -> None:
        """Clear the pending registry delta after it has been written."""
        self.new_assignments.clear()

    def alias_by_number(self, n: int) -> AnswerAlias | None:
        for a in self.aliases:
            if a.display_number == n:
                return a
        # Plan 23 B: a number cited from a prior turn's still-visible tool result
        # resolves against the persisted thread registry even when no tool
        # re-registered that span this turn.
        return self._persisted_by_number.get(n)

    def parse_aliases(self, text: str) -> list[int]:
        """Return the integer numbers of every [S#] occurrence in ``text``.

        Handles both singular ``[S3]`` and combined ``[S1, S8]`` brackets.

        Defensive fallback: if no [S#] tokens were found but the text contains
        [W#] / [D#] / [N#] tokens whose numbers match registered aliases, treat
        them as if they were [S#]. This recovers from LLMs that fall back to
        their training-default web-citation convention.
        """
        body = text or ""
        nums: list[int] = []
        for block in ALIAS_BLOCK_PATTERN.finditer(body):
            nums.extend(int(n) for n in NUMBER_PATTERN.findall(block.group(0)))
        if nums:
            return nums
        fallback: list[int] = []
        for block in FALLBACK_BLOCK_PATTERN.finditer(body):
            fallback.extend(int(n) for n in NUMBER_PATTERN.findall(block.group(0)))
        if not fallback or not self.aliases:
            return fallback
        valid_numbers = {a.display_number for a in self.aliases}
        return [n for n in fallback if n in valid_numbers]

    def validate(self, numbers: Iterable[int]) -> tuple[list[AnswerAlias], list[int]]:
        """Split parsed numbers into (valid_aliases, invalid_numbers).

        Per spec: ``Validate only that cited aliases exist in the current
        answer evidence set.``
        """
        valid: list[AnswerAlias] = []
        invalid: list[int] = []
        seen: set[int] = set()
        for n in numbers:
            if n in seen:
                continue
            seen.add(n)
            a = self.alias_by_number(n)
            if a is None:
                invalid.append(n)
            else:
                valid.append(a)
        return valid, invalid


# ---- adapters --------------------------------------------------------------

_MD_IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_MD_LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_BLANK_RUN_RE = re.compile(r"\n{3,}")


def clean_web_text(text: str) -> str:
    """Flatten Tavily ``raw_content`` markdown links/images to readable text.

    Tavily returns page text as markdown (``![alt](url)``, ``[text](url)``,
    ``[](url)``). The link *targets* are noise in a citation snapshot and the
    image syntax renders as broken images, so we drop image syntax and replace
    links with their anchor text (empty-anchor links vanish). Headings, bold,
    lists and tables are kept so the snapshot renders as nicely-formatted
    markdown. Web citation spans are generated from result snippets instead;
    this cleaning is only for the stored source snapshot.
    """
    if not text:
        return ""
    text = _MD_IMAGE_RE.sub("", text)        # drop images entirely
    text = _MD_LINK_RE.sub(r"\1", text)      # links -> anchor text ([](url) -> "")
    text = _BLANK_RUN_RE.sub("\n\n", text)   # collapse blank-line runs
    return text.strip()


def spans_from_web_results(
    results: list[dict],
    *,
    max_spans_per_result: int | None = None,
) -> list[EvidenceSpan]:
    """Transform ``web_search`` results into citable EvidenceSpans.

    Web sources have ``{title, url, content, raw_content?}`` shape.
    canonical_source_id uses the URL as the stable identifier so the same
    article cited across turns keeps the same source_id.

    Web search only shows the model the short ``content`` snippet in the tool
    result, so citation aliases must be generated from that same snippet.
    ``raw_content`` is retained separately for source snapshots, not citation
    span generation.
    """
    out: list[EvidenceSpan] = []
    for r in results or []:
        url = r.get("url") or ""
        title = r.get("title") or url or "web source"
        snippet = (r.get("content") or "").strip()
        body = snippet
        if not body or not url:
            continue
        source_id = canonical_source_id(document_id=None, file_path=None, thread_id=None, uri=url)
        sub_spans = split_into_spans(body)[:max_spans_per_result] or [body]
        running_offset = 0
        for idx, span_text in enumerate(sub_spans):
            start = body.find(span_text, running_offset)
            if start >= 0:
                end = start + len(span_text)
                running_offset = end
            else:
                start = end = None
            out.append(EvidenceSpan(
                span_id=canonical_span_id(source_id, span_text, idx),
                source_id=source_id,
                source_type="web",
                title=title,
                text=span_text,
                uri=url,
                content_type="text/html",
                start_char_in_chunk=start,
                end_char_in_chunk=end,
            ))
    return out


def register_web_results(
    context: CitationContext,
    results: list[dict],
    *,
    fetched_at: str | None = None,
    max_spans_per_result: int | None = None,
) -> list[AnswerAlias]:
    """Register ``web_search`` results as citable spans and stash page snapshots.

    Returns the answer-local aliases for the new spans (as ``register_spans``
    would) and, as a side effect, records the full captured page text on
    ``context.web_snapshots`` keyed by canonical source_id so the citation
    finalizer can persist it. Only results that carry ``raw_content`` produce a
    snapshot; snippet-only results fall back to the no-snapshot UI.
    """
    spans = spans_from_web_results(results, max_spans_per_result=max_spans_per_result)
    aliases = context.register_spans(spans)
    for r in results or []:
        url = r.get("url") or ""
        raw_content = clean_web_text(r.get("raw_content") or "")
        if not url or not raw_content:
            continue
        source_id = canonical_source_id(document_id=None, file_path=None, thread_id=None, uri=url)
        context.web_snapshots[source_id] = {
            "source_id": source_id,
            "url": url,
            "title": r.get("title") or url or "web source",
            "content": raw_content,
            # Markdown so the citation panel renders it as a formatted page.
            "content_type": "text/markdown",
            "fetched_at": fetched_at,
        }
    return aliases


def spans_from_search_chunks(
    chunks: list[dict],
    *,
    thread_id: str | None,
    max_spans_per_chunk: int | None = None,
) -> list[EvidenceSpan]:
    """Transform ``search_documents`` results into citable EvidenceSpans.

    The retrieval result shape uses ``content`` for the chunk text and
    ``metadata`` for filename/document_id/content_type fields.
    """
    out: list[EvidenceSpan] = []
    for chunk in chunks or []:
        meta = chunk.get("metadata", {}) or {}
        # Quote the verbatim citable slice so the span text exists in the source
        # document; fall back to enriched content for not-yet-re-ingested rows.
        content = chunk.get("citable_text") or chunk.get("content", "") or ""
        if not content.strip():
            continue
        document_id = chunk.get("document_id") or meta.get("document_id")
        filename = meta.get("filename") or chunk.get("filename") or "source"
        content_type = meta.get("content_type")
        source_id = canonical_source_id(
            document_id=document_id,
            file_path=None,
            thread_id=None,
            uri=None,
        )
        sub_spans = split_into_spans(content)[:max_spans_per_chunk] or [content]
        running_offset = 0
        for idx, span_text in enumerate(sub_spans):
            start = content.find(span_text, running_offset)
            if start < 0:
                start = running_offset
            end = start + len(span_text)
            running_offset = end
            span = EvidenceSpan(
                span_id=canonical_span_id(source_id, span_text, idx),
                source_id=source_id,
                source_type="document",
                title=filename,
                text=span_text,
                document_id=document_id,
                content_type=content_type,
                chunk_id=str(chunk.get("id") or chunk.get("chunk_id") or "") or None,
                start_char_in_chunk=start,
                end_char_in_chunk=end,
            )
            out.append(span)
    return out


def content_type_for_document_title(
    title: str | None,
    *,
    fallback: str = "text/markdown",
) -> str:
    """Infer the citation content type for a grep/read document span.

    Grep and read cite the *extracted* markdown text, but the citation panel
    decides whether to show the original PDF page render (with bbox highlights)
    purely from ``content_type``. Tag PDF-backed documents ``application/pdf`` so
    the viewer takes the page-render path the way semantic-search citations do;
    every other file keeps the markdown text view (where exact-quote text
    highlighting already works). Mirrors the ``.pdf`` heuristic used by the
    frontend's ``inferContentTypeFromName`` and ``_document_is_pdf``.
    """
    if title and title.strip().lower().endswith(".pdf"):
        return "application/pdf"
    return fallback


def spans_from_grep_result(
    result: str,
    *,
    max_spans_per_document: int | None = None,
) -> list[EvidenceSpan]:
    """Transform formatted ``grep`` output into citable document spans."""
    out: list[EvidenceSpan] = []
    current: dict | None = None
    per_document_counts: dict[str, int] = {}

    doc_header = re.compile(r"^\*\*(?P<title>.+?)\*\* \(id: (?P<document_id>[^)]+)\)\s*$")
    line_match = re.compile(r"^\s*Line (?P<line>\d+): (?P<excerpt>.+?)\s*$")

    for raw_line in (result or "").splitlines():
        header = doc_header.match(raw_line)
        if header:
            current = header.groupdict()
            per_document_counts.setdefault(current["document_id"], 0)
            continue

        match = line_match.match(raw_line)
        if not match or not current:
            continue

        document_id = current["document_id"]
        count = per_document_counts.get(document_id, 0)
        if max_spans_per_document is not None and count >= max_spans_per_document:
            continue

        excerpt = match.group("excerpt").strip()
        if not excerpt:
            continue

        source_id = canonical_source_id(
            document_id=document_id,
            file_path=None,
            thread_id=None,
            uri=None,
        )
        span = EvidenceSpan(
            span_id=canonical_span_id(source_id, excerpt, count),
            source_id=source_id,
            source_type="document",
            title=current["title"],
            text=excerpt,
            document_id=document_id,
            content_type=content_type_for_document_title(current["title"]),
        )
        out.append(span)
        per_document_counts[document_id] = count + 1

    return out


def spans_from_read_result(
    result: str,
    *,
    document_id: str,
    content_type: str | None = None,
    max_spans: int | None = None,
) -> list[EvidenceSpan]:
    """Transform formatted ``read`` output into citable document spans.

    ``content_type`` overrides the inferred type; when omitted it's derived from
    the document filename so PDF-backed reads cite as ``application/pdf`` (page
    render) and everything else as markdown text.
    """
    body = result or ""
    header_match = re.search(r"^\*\*Document: (?P<title>.+?)\*\*", body, re.MULTILINE)
    title = header_match.group("title").strip() if header_match else "document"
    effective_content_type = content_type or content_type_for_document_title(title)
    source_id = canonical_source_id(
        document_id=document_id,
        file_path=None,
        thread_id=None,
        uri=None,
    )

    line_match = re.compile(r"^\s*(?P<line>\d+):\s?(?P<text>.*)$")
    content_lines: list[tuple[int, str]] = []
    for raw_line in body.splitlines():
        match = line_match.match(raw_line)
        if not match:
            continue
        text = match.group("text").rstrip()
        if not text:
            continue
        content_lines.append((int(match.group("line")), text))

    if content_lines:
        content = "\n".join(text for _, text in content_lines)
        first_line = content_lines[0][0]
    else:
        # Fallback for tests or future formatter changes: strip the header and
        # cite the remaining body if it contains real document text.
        lines = body.splitlines()
        content = "\n".join(lines[2:] if len(lines) > 2 else lines).strip()
        first_line = 1

    if not content:
        return []

    spans: list[EvidenceSpan] = []
    for idx, span_text in enumerate(split_into_spans(content)[:max_spans] or [content]):
        spans.append(EvidenceSpan(
            span_id=canonical_span_id(source_id, span_text, first_line + idx),
            source_id=source_id,
            source_type="document",
            title=title,
            text=span_text,
            document_id=document_id,
            content_type=effective_content_type,
        ))
    return spans


_MARKDOWN_BULLET_RE = re.compile(r"^[-*+]\s+")
_MARKDOWN_NUMBERED_RE = re.compile(r"^\d+[\.)]\s+")
_OUTLINE_ONLY_RE = re.compile(r"^[-*+]\s+\d+(?:\.\d+)*\s+[A-Z0-9][A-Z0-9\s,:'\"()&/-]*$")


def _split_document_section_blocks(content: str, *, max_blocks: int) -> list[str]:
    """Split fetched document chunks into citable markdown-ish blocks.

    ``get_document_sections`` returns full chunks that often contain headings,
    bullets, and numbered continuations. Sentence splitting can drop later list
    items from the evidence block, so we keep list groups intact and skip
    outline-only headings that are poor standalone evidence.
    """
    blocks: list[str] = []
    current: list[str] = []

    def is_low_value(block: str) -> bool:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if not lines:
            return True
        return all(line.startswith("#") or _OUTLINE_ONLY_RE.match(line) for line in lines)

    def flush() -> None:
        nonlocal current
        block = "\n".join(current).strip()
        current = []
        if not block or is_low_value(block):
            return
        if len(block) > 900:
            blocks.extend(split_into_spans(block))
        else:
            blocks.append(block)

    for raw_line in (content or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        is_heading = line.startswith("#")
        is_bullet = bool(_MARKDOWN_BULLET_RE.match(line))
        is_numbered = bool(_MARKDOWN_NUMBERED_RE.match(line))

        if is_heading:
            flush()
            current.append(line)
            continue

        if is_bullet:
            # Attach a preceding heading to its first bullet, then start a new
            # evidence block for each later top-level bullet.
            if current and not all(item.startswith("#") for item in current):
                flush()
            current.append(line)
            continue

        if is_numbered:
            current.append(line)
            continue

        if current:
            current.append(line)
        else:
            current = [line]

    flush()
    return blocks[:max_blocks]


def spans_from_document_sections(
    chunks: list[dict],
    *,
    title_by_document_id: dict[str, str] | None = None,
    max_spans_per_chunk: int | None = None,
) -> list[EvidenceSpan]:
    """Transform ``get_document_sections`` chunk rows into citation spans."""
    out: list[EvidenceSpan] = []
    titles = title_by_document_id or {}
    for chunk in chunks or []:
        # Verbatim citable slice (fallback to enriched content pre-re-ingest).
        content = chunk.get("citable_text") or chunk.get("content") or ""
        if not content.strip():
            continue
        document_id = str(chunk.get("document_id") or "")
        if not document_id:
            continue
        meta = chunk.get("metadata") or {}
        if not isinstance(meta, dict):
            meta = {}
        title = titles.get(document_id) or meta.get("filename") or "document"
        # Chunk metadata usually omits content_type, so fall back to inferring it
        # from the filename (PDF -> page render) instead of forcing text/markdown,
        # which would trap PDF citations in the text view. Matches grep/read.
        content_type = meta.get("content_type") or content_type_for_document_title(title)
        source_id = canonical_source_id(
            document_id=document_id,
            file_path=None,
            thread_id=None,
            uri=None,
        )
        try:
            chunk_index = int(chunk.get("chunk_index") or 0)
        except (TypeError, ValueError):
            chunk_index = 0

        running_offset = 0
        sub_spans = _split_document_section_blocks(
            content,
            max_blocks=max_spans_per_chunk,
        ) or split_into_spans(content)[:max_spans_per_chunk] or [content]
        for local_idx, span_text in enumerate(sub_spans):
            start = content.find(span_text, running_offset)
            if start < 0:
                start = running_offset
            end = start + len(span_text)
            running_offset = end
            out.append(EvidenceSpan(
                span_id=canonical_span_id(source_id, span_text, chunk_index * 100 + local_idx),
                source_id=source_id,
                source_type="document",
                title=title,
                text=span_text,
                document_id=document_id,
                content_type=content_type,
                chunk_id=str(chunk.get("id") or "") or None,
                start_char_in_chunk=start,
                end_char_in_chunk=end,
            ))
    return out


def spans_from_document_structure(
    hierarchy: str,
    *,
    document_id: str,
    title: str,
    max_spans: int = 24,
) -> list[EvidenceSpan]:
    """Transform a hierarchical index into citable structural spans.

    These spans are intended only for claims about document structure, such as
    the existence of a section or chunk range.
    """
    source_id = canonical_source_id(
        document_id=document_id,
        file_path=None,
        thread_id=None,
        uri=None,
    )
    structural_lines: list[str] = []
    for raw_line in (hierarchy or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if re.search(r"\[\d+\s*-\s*\d+\]", line) or line.startswith("#"):
            structural_lines.append(line)
        if len(structural_lines) >= max_spans:
            break

    out: list[EvidenceSpan] = []
    for idx, line in enumerate(structural_lines):
        out.append(EvidenceSpan(
            span_id=canonical_span_id(source_id, line, 9000 + idx),
            source_id=source_id,
            source_type="document",
            title=title,
            text=line,
            document_id=document_id,
            content_type=content_type_for_document_title(title),
        ))
    return out


def spans_from_workspace_file(
    content: str,
    *,
    thread_id: str,
    file_path: str,
    content_type: str | None = None,
    max_spans: int | None = None,
) -> list[EvidenceSpan]:
    """Transform workspace file text into citable workspace-file spans."""
    body = (content or "").strip()
    if not body:
        return []
    source_id = canonical_source_id(
        document_id=None,
        file_path=file_path,
        thread_id=thread_id,
        uri=None,
    )
    out: list[EvidenceSpan] = []
    for idx, span_text in enumerate(split_into_spans(body)[:max_spans] or [body]):
        out.append(EvidenceSpan(
            span_id=canonical_span_id(source_id, span_text, idx),
            source_id=source_id,
            source_type="workspace_file",
            title=file_path,
            text=span_text,
            file_path=file_path,
            thread_id=thread_id,
            content_type=content_type or "text/plain",
        ))
    return out


def format_evidence_block(aliases: list[AnswerAlias]) -> str:
    """Format ``aliases`` as the citable evidence block sent to the LLM.

    The format must be unambiguous so the LLM knows which alias maps to which
    chunk. We use ``[S<n>] <title>: <quote>`` per spec.
    """
    if not aliases:
        return ""
    lines = ["Citable evidence (cite with the exact {[S#]} token inline; only these aliases are valid for this turn):"]
    for a in aliases:
        snippet = (a.span.text or "").strip().replace("\n", " ")
        if len(snippet) > 320:
            snippet = snippet[:317] + "..."
        lines.append(f"{a.display_ref} {a.span.title}: {snippet}")
    return "\n".join(lines)


def format_evidence_block_for_new_aliases(
    context: CitationContext,
    previous_alias_count: int,
) -> str:
    """Format only aliases registered after ``previous_alias_count``."""
    if previous_alias_count < 0:
        previous_alias_count = 0
    return format_evidence_block(context.aliases[previous_alias_count:])


def format_evidence_block_for_alias_numbers(
    context: CitationContext,
    alias_numbers: Iterable[int],
) -> str:
    """Format aliases matching ``alias_numbers`` while preserving turn order."""
    wanted = {int(n) for n in alias_numbers}
    if not wanted:
        return ""
    return format_evidence_block([
        alias for alias in context.aliases
        if alias.display_number in wanted
    ])


def _anchor_index(haystack: str, needle: str, start: int) -> int:
    """Best-effort locate ``needle`` in ``haystack`` at/after ``start``.

    Span text is sometimes reformatted by producers (lines re-joined with a
    space or a newline, line-number prefixes stripped) so it is not always a
    verbatim substring of the rendered result. Fall back through progressively
    shorter, more likely-verbatim anchors: full text, first line, first
    sentence, then the first several words.
    """
    candidates = [needle]
    first_line = needle.split("\n", 1)[0].strip()
    candidates.append(first_line)
    first_sentence = re.split(r"(?<=[.!?])\s+", needle, maxsplit=1)[0].strip()
    candidates.append(first_sentence)
    words = needle.split()
    if len(words) >= 6:
        candidates.append(" ".join(words[:6]))
    for cand in candidates:
        if len(cand) >= 12:
            idx = haystack.find(cand, start)
            if idx >= 0:
                return idx
    return -1


def inline_label_result(formatted_result: str, aliases: list[AnswerAlias]) -> str:
    """Inject ``{[S#]}`` citation tokens inline into a tool result that already
    contains the full passage text (search_documents, get_document_sections,
    read, read_file, grep).

    Walks ``aliases`` in registration order with a running cursor, finds each
    span's text as a substring of ``formatted_result`` at/after the cursor, and
    inserts the alias's ``display_ref`` (``{[S#]} ``) immediately before it. The
    content is shown exactly once; the markers only punctuate the citable
    passages -- there is no separate re-quoted evidence block. Spans whose text
    is not found (e.g. truncated or whitespace-normalised) are skipped rather
    than raising, so citation labeling can never break a tool call.
    """
    if not formatted_result or not aliases:
        return formatted_result
    out: list[str] = []
    cursor = 0
    for alias in aliases:
        needle = (alias.span.text or "").strip()
        if not needle:
            continue
        idx = _anchor_index(formatted_result, needle, cursor)
        if idx < 0:
            # Never drop a marker: anchor it at the cursor so every registered
            # span stays citable even when its text isn't a verbatim substring of
            # the result (whitespace-normalised or merged fragments). Aliases are
            # walked in registration (reading) order, so this lands the token in
            # the right neighbourhood rather than discarding it.
            idx = cursor
        out.append(formatted_result[cursor:idx])
        out.append(f"{alias.display_ref} ")
        cursor = idx
    out.append(formatted_result[cursor:])
    return "".join(out)


def inline_label_passages(aliases: list[AnswerAlias]) -> str:
    """Render citable passages as inline-labeled blocks for sources whose full
    text is NOT shown to the model (web_search shows only a short snippet).

    Each line is ``{[S#]} <title>: <quote>`` so the model cites the passage it
    can actually see. This is the page's citable surface, not a duplicate of
    in-context content, so it is appended to (not prepended over) the result.
    """
    if not aliases:
        return ""
    lines = ["Citable passages (cite the supporting one inline with the exact {[S#]} token shown):"]
    for a in aliases:
        snippet = (a.span.text or "").strip().replace("\n", " ")
        if len(snippet) > 320:
            snippet = snippet[:317] + "..."
        lines.append(f"{a.display_ref} {a.span.title}: {snippet}")
    return "\n".join(lines)


CITATION_SYSTEM_PROMPT = (
    "When you use evidence returned by any tool (search_documents, web_search, "
    "get_document_sections, etc.), cite the supporting passage inline using the "
    "exact citation token shown next to it in the tool result: {[S1]}, {[S2]}, "
    "{[S3]}, etc. (brace + bracket). Copy the token verbatim, braces included. "
    "To cite multiple sources, place the tokens next to each other like "
    "{[S1]}{[S2]}; do not merge them into one pair of braces. "
    "Use ONLY the {[S#]} tokens that appeared in tool results this turn. Do NOT "
    "invent tokens, change the number, or use bare/alternate forms like [S1], "
    "[1], [W1] -- those are discarded. Do NOT cite navigation labels such as "
    "'chunk:72' or chunk ranges; those are not citations. Do NOT include a "
    "manual 'Sources:' list at the end of your answer; the UI renders citation "
    "chips automatically from the {[S#]} tokens. If you are not citing any "
    "evidence, omit the tokens entirely."
)


def _split_block_into_chips(block: str, valid_numbers: set[int]) -> str | None:
    """Convert a combined alias block (e.g. ``{[S1, S8]}``) into separate
    single-alias tokens (``{[S1]}{[S8]}``).

    Returns the rewritten string, or None if no numbers in the block matched
    registered aliases (caller should keep the original text in that case).
    """
    nums = [int(n) for n in NUMBER_PATTERN.findall(block)]
    matched = [n for n in nums if n in valid_numbers]
    if not matched:
        return None
    return "".join(f"{{[S{n}]}}" for n in matched)


def normalize_aliases_in_text(text: str, context: CitationContext) -> str:
    """Rewrite alternate-wrapper [S#]/[W#]/[D#]/[N#] tokens to canonical
    {[S#]} brackets and split combined-reference brackets like ``{[S1, S8]}``
    into ``{[S1]}{[S8]}``.

    Both transforms keep the persisted answer text aligned with the
    chip-rendering regex on the frontend, which matches one ``{[S\\d+]}`` block
    at a time.
    """
    if not text or not context.aliases:
        return text
    valid_numbers = {a.display_number for a in context.aliases}

    # Step 1 -- split any combined {[S1, S8]} block into {[S1]}{[S8]} so chips render.
    def _split_canonical(match: re.Match) -> str:
        block = match.group(0)
        if "," not in block:
            return block
        replacement = _split_block_into_chips(block, valid_numbers)
        return replacement if replacement is not None else block

    out = ALIAS_BLOCK_PATTERN.sub(_split_canonical, text)

    # Step 2 -- if the model didn't use the canonical token at all, recover
    # bare [S#]/[W#]/[D#]/[N#] wrappers to {[S#]}.
    if not ALIAS_PATTERN.search(out):
        def _swap_fallback(match: re.Match) -> str:
            block = match.group(0)
            replacement = _split_block_into_chips(block, valid_numbers)
            return replacement if replacement is not None else block

        out = FALLBACK_BLOCK_PATTERN.sub(_swap_fallback, out)

    return out


def sanitize_unowned_aliases(text: str, owned_numbers: set[int]) -> str:
    """Remove citation aliases that are not owned by the current tool result.

    This is used for sub-agent/generator output before it is handed back to the
    parent model. It prevents a child agent's ``[S1]`` from accidentally
    resolving to an unrelated parent-turn span that happened to be registered
    earlier.
    """
    if not text:
        return text

    allowed = {int(n) for n in owned_numbers}

    def _rewrite_block(match: re.Match) -> str:
        nums = [int(n) for n in NUMBER_PATTERN.findall(match.group(0))]
        kept = [n for n in nums if n in allowed]
        return "".join(f"{{[S{n}]}}" for n in kept)

    out = ALIAS_BLOCK_PATTERN.sub(_rewrite_block, text)
    out = FALLBACK_BLOCK_PATTERN.sub(_rewrite_block, out)
    return re.sub(r"[ \t]{2,}", " ", out)


def strip_alias_numbers(text: str, numbers: set[int]) -> str:
    """Remove citation tokens for the given alias ``numbers`` from ``text``.

    Used to scrub *invalid* aliases -- numbers the model cited that were never
    registered this turn -- out of the persisted answer so they never reach the
    UI as raw markers. Combined blocks keep their still-valid members; leftover
    double spaces and space-before-punctuation are collapsed.
    """
    if not text or not numbers:
        return text
    drop = {int(n) for n in numbers}

    def _rewrite(match: re.Match) -> str:
        nums = [int(n) for n in NUMBER_PATTERN.findall(match.group(0))]
        kept = [n for n in nums if n not in drop]
        return "".join(f"{{[S{n}]}}" for n in kept)

    out = ALIAS_BLOCK_PATTERN.sub(_rewrite, text)
    out = re.sub(r" +([.,;:!?])", r"\1", out)  # leftover space before punctuation
    out = re.sub(r"[ \t]{2,}", " ", out)
    return out


def _alias_numbers_in_text(text: str) -> set[int]:
    numbers: set[int] = set()
    for block in ALIAS_BLOCK_PATTERN.finditer(text or ""):
        numbers.update(int(n) for n in NUMBER_PATTERN.findall(block.group(0)))
    return numbers


def _pdf_highlight_source_key(citation: dict | None) -> tuple | None:
    if not citation:
        return None

    source = citation.get("source") or {}
    target = citation.get("target") or {}
    bboxes = target.get("bboxes")
    if not isinstance(bboxes, list) or not bboxes:
        return None

    return (
        source.get("source_type"),
        source.get("source_id"),
        source.get("document_id"),
        source.get("file_path"),
        source.get("uri"),
    )


def _pdf_bbox_key(box: dict) -> tuple | None:
    try:
        page = int(box["page"])
        l = round(float(box["l"]), 3)
        t = round(float(box["t"]), 3)
        r = round(float(box["r"]), 3)
        b = round(float(box["b"]), 3)
    except (KeyError, TypeError, ValueError):
        return None
    return (
        page,
        l,
        t,
        r,
        b,
        str(box.get("coord_origin") or ""),
        str(box.get("item_id") or ""),
    )


def _pdf_highlight_key(citation: dict | None) -> tuple | None:
    source_key = _pdf_highlight_source_key(citation)
    if source_key is None:
        return None

    target = citation.get("target") or {}
    bboxes = target.get("bboxes")
    if not isinstance(bboxes, list) or not bboxes:
        return None

    box_key: list[tuple] = []
    for box in bboxes:
        if not isinstance(box, dict):
            return None
        coerced = _pdf_bbox_key(box)
        if coerced is None:
            return None
        box_key.append(coerced)

    page_value = target.get("page")
    try:
        page_key = int(page_value) if page_value is not None else None
    except (TypeError, ValueError):
        page_key = page_value

    return (*source_key, page_key, tuple(box_key))


def _pdf_highlight_item_key(citation: dict | None) -> tuple[tuple, frozenset[str]] | None:
    source_key = _pdf_highlight_source_key(citation)
    if source_key is None:
        return None

    bboxes = ((citation.get("target") or {}).get("bboxes") or [])
    item_ids = {
        str(box.get("item_id") or "")
        for box in bboxes
        if isinstance(box, dict) and str(box.get("item_id") or "")
    }
    if not item_ids:
        return None
    return source_key, frozenset(item_ids)


def _pdf_highlights_compatible(left: dict | None, right: dict | None) -> bool:
    left_exact = _pdf_highlight_key(left)
    right_exact = _pdf_highlight_key(right)
    if left_exact is not None and left_exact == right_exact:
        return True

    left_items = _pdf_highlight_item_key(left)
    right_items = _pdf_highlight_item_key(right)
    if left_items is None or right_items is None:
        return False

    left_source, left_item_ids = left_items
    right_source, right_item_ids = right_items
    return left_source == right_source and bool(left_item_ids & right_item_ids)


def _normalized_aggregate_text(citations: list[dict]) -> str:
    parts: list[str] = []
    seen: set[str] = set()
    for citation in citations:
        target = citation.get("target") or {}
        text = str(target.get("exact") or citation.get("quote") or "").strip()
        if not text:
            continue
        key = re.sub(r"\s+", " ", text).casefold()
        if key in seen:
            continue
        seen.add(key)
        parts.append(text)
    return re.sub(r"\s+", " ", " ".join(parts)).strip()


def _merge_citation_group(citations: list[dict]) -> dict:
    first = citations[0]
    merged = {
        **first,
        "source": {**(first.get("source") or {})},
        "target": {**(first.get("target") or {})},
    }

    aggregate = _normalized_aggregate_text(citations)
    if aggregate:
        merged["target"]["exact"] = aggregate
        merged["quote"] = aggregate

    pdf_bboxes: list[dict] = []
    seen_pdf_bboxes: set[tuple] = set()
    for citation in citations:
        target = citation.get("target") or {}
        for box in target.get("bboxes") or []:
            if not isinstance(box, dict):
                continue
            key = _pdf_bbox_key(box)
            if key is None or key in seen_pdf_bboxes:
                continue
            seen_pdf_bboxes.add(key)
            pdf_bboxes.append({**box})
    if pdf_bboxes:
        merged["target"]["bboxes"] = pdf_bboxes
        pages: list[int] = []
        for box in pdf_bboxes:
            try:
                pages.append(int(box["page"]))
            except (KeyError, TypeError, ValueError):
                continue
        if pages:
            merged["target"]["page"] = min(pages)

    chunk_ids = {
        (citation.get("target") or {}).get("chunk_id")
        for citation in citations
        if (citation.get("target") or {}).get("chunk_id")
    }
    if len(chunk_ids) == 1:
        starts = [
            (citation.get("target") or {}).get("start_char")
            for citation in citations
            if isinstance((citation.get("target") or {}).get("start_char"), int)
        ]
        ends = [
            (citation.get("target") or {}).get("end_char")
            for citation in citations
            if isinstance((citation.get("target") or {}).get("end_char"), int)
        ]
        if len(starts) == len(citations) and len(ends) == len(citations):
            merged["target"]["start_char"] = min(starts)
            merged["target"]["end_char"] = max(ends)
    elif len(chunk_ids) > 1:
        merged["target"].pop("chunk_id", None)
        merged["target"].pop("start_char", None)
        merged["target"].pop("end_char", None)

    return merged


def merge_same_pdf_highlight_citation_runs(
    answer_text: str,
    citations: list[dict],
) -> tuple[str, list[dict]]:
    """Merge adjacent Quick-mode citation aliases that point at one PDF region.

    Docling's PDF layout can only locate text-item boxes, so several citable
    spans from the same paragraph often enrich to identical page/bbox targets.
    Cross-page paragraphs can also enrich to different page boxes that share the
    same Docling item_id. When the answer cites those spans as one adjacent run,
    keep the first alias, replace its quote/exact text with the aggregate cited
    text, preserve the union of PDF boxes, and remove only the alias tokens that
    disappear from the rewritten answer.
    """
    if not answer_text or len(citations) < 2:
        return answer_text, citations

    by_number: dict[int, dict] = {}
    for citation in citations:
        try:
            by_number[int(citation.get("display_number"))] = citation
        except (TypeError, ValueError):
            continue
    if len(by_number) < 2:
        return answer_text, citations

    matches = list(ALIAS_BLOCK_PATTERN.finditer(answer_text))
    if len(matches) < 2:
        return answer_text, citations

    merged_by_first: dict[int, dict] = {}

    def _render_run(run: list[re.Match]) -> str:
        original = answer_text[run[0].start():run[-1].end()]
        raw_numbers = [
            int(n)
            for match in run
            for n in NUMBER_PATTERN.findall(match.group(0))
        ]
        numbers: list[int] = []
        seen_numbers: set[int] = set()
        for number in raw_numbers:
            if number in seen_numbers:
                continue
            seen_numbers.add(number)
            numbers.append(number)
        if len(numbers) < 2:
            return original

        rendered: list[str] = []
        changed = False
        group_numbers: list[int] = []
        group_citations: list[dict] = []

        def flush_group() -> None:
            nonlocal changed
            if not group_numbers:
                return
            if len(group_citations) > 1:
                first_number = group_numbers[0]
                merged_by_first[first_number] = _merge_citation_group(group_citations)
                rendered.append(f"{{[S{first_number}]}}")
                changed = True
            else:
                rendered.extend(f"{{[S{number}]}}" for number in group_numbers)

        for number in numbers:
            citation = by_number.get(number)
            if citation and any(
                _pdf_highlights_compatible(existing, citation)
                for existing in group_citations
            ):
                group_numbers.append(number)
                group_citations.append(citation)
                continue

            flush_group()
            group_numbers = [number]
            group_citations = [citation] if citation else []

        flush_group()
        return "".join(rendered) if changed else original

    out: list[str] = []
    cursor = 0
    run: list[re.Match] = []

    def flush_run() -> None:
        nonlocal run, cursor
        if not run:
            return
        out.append(_render_run(run))
        cursor = run[-1].end()
        run = []

    for match in matches:
        if not run:
            out.append(answer_text[cursor:match.start()])
            run = [match]
            cursor = match.end()
            continue

        between = answer_text[cursor:match.start()]
        if between.strip() == "":
            run.append(match)
            cursor = match.end()
            continue

        flush_run()
        out.append(answer_text[cursor:match.start()])
        run = [match]
        cursor = match.end()

    flush_run()
    out.append(answer_text[cursor:])

    if not merged_by_first:
        return answer_text, citations

    rewritten = "".join(out)
    remaining_numbers = _alias_numbers_in_text(rewritten)
    merged_citations: list[dict] = []
    for citation in citations:
        try:
            number = int(citation.get("display_number"))
        except (TypeError, ValueError):
            continue
        if number in remaining_numbers:
            merged_citations.append(merged_by_first.get(number, citation))
    return rewritten, merged_citations


def _citation_id_for_span(span_id: str) -> str:
    """Deterministic citation_id derived from the canonical span_id.

    Each cited alias maps 1:1 to a unique span within a turn, so this id is
    unique within an answer's citation set AND identical whether produced while
    streaming (``build_streaming_citations``) or at finalize
    (``build_answer_citations``). Stability is what lets a chip rendered
    mid-stream keep the same ``citation:`` href after the end-of-turn
    ``citation_metadata`` event narrows the bucket to cited-only.
    """
    return f"cite_{_sha(span_id)[:12]}"


def citation_dict_from_alias(
    alias: AnswerAlias,
    *,
    answer_id: str,
    thread_id: str | None,
    verification_mode: str = "unverified",
    lightweight: bool = False,
) -> dict:
    """Build a single AnswerCitation-shaped dict from a registered alias.

    Shared by ``build_answer_citations`` (finalize) and
    ``build_streaming_citations`` (mid-stream) so both agree on ``citation_id``
    and field shape.

    ``lightweight`` omits the quote/exact passage text (Plan 23 A4). The
    streaming alias->source map only needs to resolve a ``{[S#]}`` token to its
    source chip; shipping the full quote for every registered alias would
    re-send the whole tool-result body over SSE now that every passage is
    citable. The end-of-turn ``citation_metadata`` event carries the full
    quote/target for the cited subset (same ``citation_id``, so chips don't
    churn).
    """
    span = alias.span
    if lightweight:
        target: dict = {"kind": "text_quote"}
    else:
        target = {"kind": "text_quote", "exact": span.text}
        if span.chunk_id:
            target["chunk_id"] = span.chunk_id
        if span.start_char_in_chunk is not None:
            target["start_char"] = span.start_char_in_chunk
            target["end_char"] = span.end_char_in_chunk
    citation = {
        "citation_id": _citation_id_for_span(span.span_id),
        "answer_id": answer_id,
        "display_ref": alias.display_ref,
        "display_number": alias.display_number,
        "source": {
            "source_id": span.source_id,
            "source_type": span.source_type,
            "title": span.title,
            "uri": span.uri,
            "document_id": span.document_id,
            "thread_id": span.thread_id or thread_id,
            "file_path": span.file_path,
            "content_type": span.content_type,
        },
        "target": target,
        "status": "not_verified" if verification_mode == "unverified" else "verified",
        "support_score": None,
        "claim_id": None,
        "problem": None,
        # Carried by the message envelope, but stored per-citation for the DB row.
        "_verification_mode": verification_mode,
        "_span_id": span.span_id,
    }
    if not lightweight:
        citation["quote"] = span.text
    return citation


def build_streaming_citations(
    aliases: Iterable[AnswerAlias],
    *,
    answer_id: str,
    thread_id: str | None,
    verification_mode: str = "unverified",
) -> list[dict]:
    """Build lightweight AnswerCitation dicts for newly registered aliases mid-stream.

    Unlike ``build_answer_citations`` this does NOT inspect the answer text --
    it maps *all* given aliases so the frontend can resolve any ``{[S#]}`` token
    the model emits as the answer streams. Uncited aliases are harmless: the
    frontend only renders a chip for tokens actually present in the text.

    The dicts are ``lightweight`` -- source chip metadata only, no quote/exact
    passage text (Plan 23 A4) -- so streaming every citable passage doesn't
    re-send the tool-result bodies over SSE. The end-of-turn
    ``build_answer_citations`` is authoritative: it narrows to cited-only and
    fills in the full quote/target with the same ``citation_id`` per alias.
    """
    return [
        citation_dict_from_alias(
            alias,
            answer_id=answer_id,
            thread_id=thread_id,
            verification_mode=verification_mode,
            lightweight=True,
        )
        for alias in aliases
    ]


def build_newly_cited_full_citations(
    context: CitationContext,
    answer_text: str,
    *,
    already_sent: set[int],
    answer_id: str,
    thread_id: str | None,
    verification_mode: str = "unverified",
) -> list[dict]:
    """Full-target citations for aliases newly cited as the answer streams.

    Plan 23 A4 keeps the mid-stream alias->source map ``lightweight`` (source
    chip only, no passage text) so streaming every citable passage doesn't
    re-send the tool-result bodies over SSE. But a chip the model *actually*
    cites needs ``target.exact`` for the source preview to scroll to the cited
    passage on click -- without it, clicking a citation only navigates once the
    end-of-turn ``citation_metadata`` event lands (i.e. not while streaming).

    This bridges the gap: for each alias number present in ``answer_text`` but
    not yet in ``already_sent``, return the full citation dict (same
    ``citation_id`` as the lightweight one, so the frontend upgrades the chip in
    place) and record the number in ``already_sent`` so it's emitted once. Only
    cited spans pay the payload cost, so the all-aliases map stays lightweight.
    """
    valid, _invalid = context.validate(context.parse_aliases(answer_text))
    out: list[dict] = []
    for alias in valid:
        if alias.display_number in already_sent:
            continue
        already_sent.add(alias.display_number)
        out.append(
            citation_dict_from_alias(
                alias,
                answer_id=answer_id,
                thread_id=thread_id,
                verification_mode=verification_mode,
                lightweight=False,
            )
        )
    return out


def build_answer_citations(
    *,
    answer_text: str,
    context: CitationContext,
    message_id: str | None,
    thread_id: str | None,
    verification_mode: str = "unverified",
) -> tuple[list[dict], list[int]]:
    """Walk the answer for [S#] aliases and produce AnswerCitation rows.

    Returns ``(citations, invalid_numbers)``. ``citations`` is a list of dicts
    matching the frontend AnswerCitation type. ``invalid_numbers`` is the
    set of numbers the model cited that weren't in the current evidence set.
    """
    numbers = context.parse_aliases(answer_text)
    valid, invalid = context.validate(numbers)
    answer_id = message_id or context.turn_id
    citations = [
        citation_dict_from_alias(
            alias,
            answer_id=answer_id,
            thread_id=thread_id,
            verification_mode=verification_mode,
        )
        for alias in valid
    ]
    return citations, invalid
