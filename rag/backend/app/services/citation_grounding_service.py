"""On-demand citation grounding check (the "Check Citations" button).

For each citation on a finished assistant message we build two excerpts:

  * the **generated** passage around the ``{[S#]}`` marker in the answer, plus a
    sliding window of the surrounding prose (the cited sentence is flagged), and
  * the **cited source context** — the retrieved chunk's verbatim text around the
    cited span, plus a sliding window around it.

Both are handed to a utility LLM whose only job is to decide whether the
generated claim is *faithfully grounded* in the cited source context. The
verdict maps onto the citation status vocabulary the UI already renders
(``verified`` / ``partially_supported`` / ``not_verified`` / ``contradicted``),
so callers can write it straight back into ``answer_citations`` and flip the
message into ``semantic-text`` ("Checked Citations") mode.

This is a utility call: it always uses the ``LLM_*`` provider (never the Codex
subscription), mirroring metadata/compaction/title extraction.
"""
import asyncio
import json
import logging
import re

from app.config import get_settings
from app.db.supabase import get_supabase_client
from app.services.langsmith import get_traced_async_openai_client, traceable

logger = logging.getLogger(__name__)

# Sliding-window radii (characters) on either side of the cited location.
GEN_WINDOW_CHARS = 600
SRC_WINDOW_CHARS = 600
# Hard cap on how much source context we send per citation.
MAX_SRC_CHARS = 4000
# Cap when we fall back to the whole answer (marker not found).
MAX_GEN_FALLBACK_CHARS = 1600
# Concurrent verdict calls. Citations on one answer are usually < 10.
MAX_CONCURRENCY = 8
LLM_TIMEOUT_SECONDS = 45

# Matches any {[S#]} / {[S1, S8]} citation token so we can strip them from the
# prose we show the grader (mirrors the frontend ALIAS_BLOCK_PATTERN).
_ALIAS_TOKEN = re.compile(r"\{\s*\[?\s*S?\s*\d+\s*\]?(?:\s*,?\s*\[?\s*S?\s*\d+\s*\]?)*\s*\}")

_VALID_STATUS = {"verified", "partially_supported", "not_verified", "contradicted"}

_VERDICT_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": sorted(_VALID_STATUS)},
        "support_score": {"type": "number", "minimum": 0, "maximum": 1},
        "problem": {"type": "string"},
    },
    "required": ["status", "support_score", "problem"],
    "additionalProperties": False,
}

_SYSTEM_PROMPT = (
    "You are a citation faithfulness checker for a retrieval-augmented assistant. "
    "You receive (1) a GENERATED CLAIM written by the assistant, with the cited "
    "location flagged by the token ⟦CITED⟧, and (2) the CITED SOURCE CONTEXT — one "
    "or more sources the assistant cited for that claim, with the exact cited span "
    "wrapped in ⟦SPAN⟧ … ⟦/SPAN⟧ when its position is known.\n\n"
    "Decide whether the claim is faithfully grounded in the cited source context — "
    "i.e. a careful reader would agree the sources support the claim, relying only "
    "on the provided sources and not on outside knowledge. When more than one source "
    "is given, judge them TOGETHER: the claim is supported when the sources "
    "COLLECTIVELY back it, even if each individual source only covers part of it. Do "
    "not penalise the claim because one source omits a detail that another source "
    "supplies.\n\n"
    "Return JSON with exactly these keys:\n"
    "- status: 'verified' (the sources clearly support the whole claim), "
    "'partially_supported' (only part of the claim is supported, or support is "
    "weak, vague, or indirect), 'not_verified' (the sources do not contain support "
    "for the claim), or 'contradicted' (a source states something that conflicts "
    "with the claim).\n"
    "- support_score: a number 0.0–1.0, your confidence that the claim is grounded.\n"
    "- problem: one short sentence naming the gap when the claim is not fully "
    "supported; use an empty string when status is 'verified'."
)


def _strip_alias_tokens(text: str) -> str:
    return _ALIAS_TOKEN.sub("", text)


def _ellipsize(text: str, lead: bool, trail: bool) -> str:
    return f"{'… ' if lead else ''}{text.strip()}{' …' if trail else ''}"


def generated_excerpt(content: str, display_ref: str) -> str:
    """Generated passage around the citation marker, plus a sliding window.

    The marker itself is replaced by ⟦CITED⟧ so the grader knows which sentence
    is being attributed; every other ``{[S#]}`` token is stripped for clean prose.
    """
    if not content:
        return ""
    pos = content.find(display_ref) if display_ref else -1
    if pos < 0:
        # Marker not present (e.g. answer text was rewritten post-finalize):
        # fall back to a capped, de-tokenized slice of the whole answer.
        return _strip_alias_tokens(content).strip()[:MAX_GEN_FALLBACK_CHARS]
    start = max(0, pos - GEN_WINDOW_CHARS)
    end = min(len(content), pos + len(display_ref) + GEN_WINDOW_CHARS)
    window = content[start:end].replace(display_ref, " ⟦CITED⟧ ", 1)
    window = _strip_alias_tokens(window)
    return _ellipsize(window, start > 0, end < len(content))


def parse_citation_groups(content: str) -> list[dict]:
    """Group adjacent ``{[S#]}`` markers into co-citation claims.

    Markers separated only by whitespace back the SAME claim (mirrors the
    frontend's run-grouping in ``injectCitationLinks``), so e.g. ``{[S67]}{[S71]}``
    is one group of two. Returns groups in document order as
    ``{"numbers": [int, ...], "start": int, "end": int}`` where start/end bound the
    marker run in ``content``.
    """
    groups: list[dict] = []
    for match in _ALIAS_TOKEN.finditer(content):
        numbers = [int(n) for n in re.findall(r"\d+", match.group(0))]
        if not numbers:
            continue
        if groups and content[groups[-1]["end"]:match.start()].strip() == "":
            groups[-1]["numbers"].extend(numbers)
            groups[-1]["end"] = match.end()
        else:
            groups.append({"numbers": list(numbers), "start": match.start(), "end": match.end()})

    for group in groups:  # de-dupe numbers within a group, preserve order
        seen: set[int] = set()
        unique: list[int] = []
        for n in group["numbers"]:
            if n not in seen:
                seen.add(n)
                unique.append(n)
        group["numbers"] = unique
    return groups


def _claim_excerpt(content: str, group: dict, prev_end: int, next_start: int) -> str:
    """Generated text for a citation group's claim, with a sliding window.

    The window is clamped to the group's own paragraph and to the neighbouring
    citation groups, so a claim isn't judged on prose that belongs to a sibling
    citation. The marker run is flagged ⟦CITED⟧ and other tokens are stripped.
    """
    if not content:
        return ""
    start, end = group["start"], group["end"]
    para_start = content.rfind("\n\n", 0, start)
    para_start = 0 if para_start < 0 else para_start + 2
    para_end = content.find("\n\n", end)
    para_end = len(content) if para_end < 0 else para_end
    left = max(para_start, prev_end, start - GEN_WINDOW_CHARS)
    right = min(para_end, next_start, end + GEN_WINDOW_CHARS)
    window = content[left:right]
    cited_start, cited_end = start - left, end - left
    window = window[:cited_start] + " ⟦CITED⟧ " + window[cited_end:]
    window = _strip_alias_tokens(window)
    return _ellipsize(window, left > 0, right < len(content))


def _fetch_chunk_text(chunk_id: str, user_id: str | None) -> str:
    """Verbatim chunk text for a cited document chunk (owner-scoped)."""
    try:
        supabase = get_supabase_client()
        query = supabase.table("chunks").select("citable_text, content").eq("id", chunk_id)
        if user_id:
            query = query.eq("user_id", user_id)
        res = query.limit(1).execute()
        row = (res.data or [None])[0]
        if row:
            return row.get("citable_text") or row.get("content") or ""
    except Exception as e:  # pragma: no cover - defensive, logged
        logger.warning(f"[CITATION-CHECK] chunk fetch failed for {chunk_id}: {e}")
    return ""


def cited_context(row: dict) -> str:
    """Cited source context around the cited span, plus a sliding window.

    Prefers the verbatim chunk text (located via target offsets, then by quote
    search); falls back to the citation's stored prefix/exact/suffix or quote
    when the chunk is unavailable (web / workspace sources, or a deleted chunk).
    """
    target = row.get("target") or {}
    chunk_id = target.get("chunk_id")
    text = _fetch_chunk_text(chunk_id, row.get("user_id")) if chunk_id else ""

    if text:
        start_char, end_char = target.get("start_char"), target.get("end_char")
        if (
            isinstance(start_char, int)
            and isinstance(end_char, int)
            and 0 <= start_char < end_char <= len(text)
        ):
            wstart = max(0, start_char - SRC_WINDOW_CHARS)
            wend = min(len(text), end_char + SRC_WINDOW_CHARS)
            marked = (
                text[wstart:start_char]
                + "⟦SPAN⟧" + text[start_char:end_char] + "⟦/SPAN⟧"
                + text[end_char:wend]
            )
            return _ellipsize(marked, wstart > 0, wend < len(text))[:MAX_SRC_CHARS]

        needle = (target.get("exact") or row.get("quote") or "").strip()
        idx = text.find(needle) if needle else -1
        if idx >= 0:
            wstart = max(0, idx - SRC_WINDOW_CHARS)
            wend = min(len(text), idx + len(needle) + SRC_WINDOW_CHARS)
            marked = (
                text[wstart:idx]
                + "⟦SPAN⟧" + needle + "⟦/SPAN⟧"
                + text[idx + len(needle):wend]
            )
            return _ellipsize(marked, wstart > 0, wend < len(text))[:MAX_SRC_CHARS]

        return text[:MAX_SRC_CHARS]

    # No chunk text — assemble from what the citation captured at answer time.
    prefix = target.get("prefix") or ""
    exact = target.get("exact") or row.get("quote") or ""
    suffix = target.get("suffix") or ""
    if exact:
        assembled = f"{prefix}⟦SPAN⟧{exact}⟦/SPAN⟧{suffix}".strip()
    else:
        assembled = (row.get("quote") or "").strip()
    return assembled[:MAX_SRC_CHARS]


def _coerce_verdict(raw: str) -> dict:
    data = json.loads(raw or "{}")
    status = data.get("status")
    if status not in _VALID_STATUS:
        status = "not_verified"
    score = data.get("support_score")
    try:
        score = float(score) if score is not None else None
    except (TypeError, ValueError):
        score = None
    if score is not None:
        score = max(0.0, min(1.0, score))
    problem = (data.get("problem") or "").strip() or None
    if status == "verified":
        problem = None
    return {"status": status, "support_score": score, "problem": problem}


def _format_sources(sources: list[tuple]) -> tuple[str, str]:
    """Render the cited-context block plus a note when several sources co-cite."""
    real = [(num, text) for num, text in sources if (text or "").strip()]
    if len(real) <= 1:
        body = real[0][1] if real else ""
        return f'"""\n{body}\n"""', ""
    labeled = "\n\n".join(f"[Source {num}]\n{text}" for num, text in real)
    note = (
        "\n\nThis claim cites MULTIPLE sources. Judge them TOGETHER: if one source "
        "supports part of the claim and another supports the rest, the claim is "
        "supported. Do not mark it unsupported merely because a single source omits "
        "part of the claim."
    )
    return f'"""\n{labeled}\n"""', note


async def _grade_group(generated: str, sources: list[tuple], client, model: str) -> dict:
    """Grade one claim (with its co-cited sources) for faithful grounding."""
    if not any((text or "").strip() for _, text in sources):
        return {
            "status": "verification_failed",
            "support_score": None,
            "problem": "The cited source text could not be retrieved.",
        }

    source_block, multi_note = _format_sources(sources)
    user_msg = (
        f"GENERATED CLAIM (cited location flagged ⟦CITED⟧):\n"
        f'"""\n{generated}\n"""\n\n'
        f"CITED SOURCE CONTEXT (cited span wrapped ⟦SPAN⟧ … ⟦/SPAN⟧ when known):\n"
        f"{source_block}{multi_note}\n\n"
        "Is the claim faithfully grounded in the cited source context? Respond with "
        "the JSON object as instructed."
    )
    resp = await asyncio.wait_for(
        client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "citation_verdict",
                    "strict": True,
                    "schema": _VERDICT_SCHEMA,
                },
            },
            temperature=0.0,
        ),
        timeout=LLM_TIMEOUT_SECONDS,
    )
    return _coerce_verdict(resp.choices[0].message.content)


# Used to keep the most-supported verdict when a citation appears in more than
# one claim (the same {[S#]} marker reused across the answer).
_STATUS_RANK = {
    "verified": 4,
    "partially_supported": 3,
    "not_verified": 2,
    "contradicted": 1,
    "verification_failed": 0,
}


@traceable(name="check_citations", run_type="chain")
async def grade_citations(*, content: str, rows: list[dict], user_id: str) -> dict[str, dict]:
    """Grade each citation for faithful grounding, co-citations judged together.

    Citations that sit on the same claim (adjacent ``{[S#]}`` markers) are graded
    against the UNION of their sources and share one verdict, so a citation that
    only covers part of a claim isn't flagged "unsupported" when a co-citation
    covers the rest.

    Returns ``{answer_citations.id: {status, support_score, problem}}``. Never
    raises — a row that errors (or a missing LLM config) yields a
    ``verification_failed`` verdict so the caller can persist a complete set.
    """
    if not rows:
        return {}

    settings = get_settings()
    if not settings.llm_api_key:
        logger.warning("[CITATION-CHECK] LLM_API_KEY not set; cannot grade citations")
        return {
            r["id"]: {
                "status": "verification_failed",
                "support_score": None,
                "problem": "Citation checking is not configured on the server.",
            }
            for r in rows
        }

    model = settings.citation_check_model or settings.llm_model or "gpt-4o"
    client = get_traced_async_openai_client(
        base_url=settings.llm_base_url or None,
        api_key=settings.llm_api_key,
    )

    row_by_number: dict[int, dict] = {}
    for r in rows:
        number = r.get("display_number")
        if isinstance(number, int):
            row_by_number[number] = r

    # Build the work list: one item per claim (co-citation group), plus a solo
    # item for any citation whose marker no longer appears in the answer text.
    groups = parse_citation_groups(content)
    work: list[dict] = []
    covered_ids: set[str] = set()
    for i, group in enumerate(groups):
        member_rows = [row_by_number[n] for n in group["numbers"] if n in row_by_number]
        if not member_rows:
            continue
        for member in member_rows:
            covered_ids.add(member["id"])
        prev_end = groups[i - 1]["end"] if i > 0 else 0
        next_start = groups[i + 1]["start"] if i + 1 < len(groups) else len(content)
        work.append({
            "rows": member_rows,
            "generated": _claim_excerpt(content, group, prev_end, next_start),
            "sources": [(m.get("display_number"), cited_context(m)) for m in member_rows],
        })

    for r in rows:
        if r["id"] in covered_ids:
            continue
        work.append({
            "rows": [r],
            "generated": generated_excerpt(content, r.get("display_ref") or ""),
            "sources": [(r.get("display_number"), cited_context(r))],
        })

    semaphore = asyncio.Semaphore(MAX_CONCURRENCY)

    async def _run(item: dict) -> list[tuple[str, dict]]:
        async with semaphore:
            try:
                verdict = await _grade_group(item["generated"], item["sources"], client, model)
            except Exception as e:
                logger.warning(f"[CITATION-CHECK] grading failed: {e}")
                verdict = {
                    "status": "verification_failed",
                    "support_score": None,
                    "problem": "This citation could not be checked.",
                }
            return [(member["id"], verdict) for member in item["rows"]]

    grouped = await asyncio.gather(*[_run(w) for w in work])

    out: dict[str, dict] = {}
    for pairs in grouped:
        for cid, verdict in pairs:
            existing = out.get(cid)
            if existing is None or _STATUS_RANK.get(verdict["status"], 0) > _STATUS_RANK.get(existing["status"], 0):
                out[cid] = verdict
    return out
