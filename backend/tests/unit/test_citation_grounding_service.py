"""Unit tests for citation_grounding_service windowing + verdict helpers.

These cover the pure logic (no LLM, no DB): how the generated passage and cited
source context are sliced/marked, and how raw model JSON is coerced into a
status the citation UI understands.
"""

import asyncio
import types

import pytest

from app.services import citation_grounding_service as cgs


def test_generated_excerpt_marks_cited_token_and_strips_others():
    content = "Intro line. The sky is blue {[S1]} and clear. Other fact {[S2]} too."
    out = cgs.generated_excerpt(content, "{[S1]}")

    assert "⟦CITED⟧" in out          # ⟦CITED⟧ flags the cited spot
    assert "{[S1]}" not in out                 # the cited token is replaced
    assert "{[S2]}" not in out                 # other tokens are stripped
    assert "sky is blue" in out


def test_generated_excerpt_falls_back_when_marker_absent():
    out = cgs.generated_excerpt("No markers here at all.", "{[S9]}")
    assert "⟦CITED⟧" not in out
    assert out == "No markers here at all."


def test_generated_excerpt_windows_long_text():
    # Marker sits in the middle of text longer than the window on both sides.
    content = ("A" * 1000) + " {[S1]} " + ("B" * 1000)
    out = cgs.generated_excerpt(content, "{[S1]}")
    assert out.startswith("… ")          # leading ellipsis
    assert out.endswith(" …")             # trailing ellipsis
    assert len(out) < len(content)             # actually trimmed


def test_cited_context_uses_offsets_to_mark_span(monkeypatch):
    text = ("A" * 50) + "GROUNDED SPAN" + ("B" * 50)
    monkeypatch.setattr(cgs, "_fetch_chunk_text", lambda chunk_id, user_id: text)
    row = {"target": {"chunk_id": "c1", "start_char": 50, "end_char": 63}, "user_id": "u1"}

    out = cgs.cited_context(row)
    assert "⟦SPAN⟧GROUNDED SPAN⟦/SPAN⟧" in out


def test_cited_context_locates_quote_when_offsets_missing(monkeypatch):
    text = ("x" * 30) + "the cited fact" + ("y" * 30)
    monkeypatch.setattr(cgs, "_fetch_chunk_text", lambda chunk_id, user_id: text)
    row = {"target": {"chunk_id": "c1", "exact": "the cited fact"}, "user_id": "u1"}

    out = cgs.cited_context(row)
    assert "⟦SPAN⟧the cited fact⟦/SPAN⟧" in out


def test_cited_context_falls_back_to_target_prefix_suffix():
    # No chunk_id -> no DB lookup; assemble from what the citation captured.
    row = {"target": {"prefix": "pre ", "exact": "claim", "suffix": " post"}}
    out = cgs.cited_context(row)
    assert out == "pre ⟦SPAN⟧claim⟦/SPAN⟧ post"


def test_cited_context_falls_back_to_quote():
    row = {"target": {}, "quote": "just a quote"}
    out = cgs.cited_context(row)
    assert "just a quote" in out


@pytest.mark.parametrize(
    "raw,expected",
    [
        (
            '{"status":"verified","support_score":1.5,"problem":"ignored"}',
            {"status": "verified", "support_score": 1.0, "problem": None},
        ),
        (
            '{"status":"bogus","support_score":-1,"problem":"y"}',
            {"status": "not_verified", "support_score": 0.0, "problem": "y"},
        ),
        (
            '{"status":"contradicted","support_score":0.4,"problem":"conflicts"}',
            {"status": "contradicted", "support_score": 0.4, "problem": "conflicts"},
        ),
    ],
)
def test_coerce_verdict(raw, expected):
    assert cgs._coerce_verdict(raw) == expected


def test_coerce_verdict_handles_empty_json():
    out = cgs._coerce_verdict("{}")
    assert out["status"] == "not_verified"
    assert out["support_score"] is None


def test_parse_citation_groups_merges_adjacent_markers():
    # The bug case: three markers on one claim must form ONE co-citation group.
    content = "Damages of $10,647.00 were inadequate {[S67]} {[S68]}{[S71]} per the brief."
    groups = cgs.parse_citation_groups(content)
    assert len(groups) == 1
    assert groups[0]["numbers"] == [67, 68, 71]


def test_parse_citation_groups_separates_distinct_claims():
    content = "First claim {[S1]} and a separate later claim {[S2]}."
    groups = cgs.parse_citation_groups(content)
    assert [g["numbers"] for g in groups] == [[1], [2]]


def test_parse_citation_groups_handles_combined_token():
    content = "Both at once {[S1, S8]}."
    groups = cgs.parse_citation_groups(content)
    assert groups[0]["numbers"] == [1, 8]


def test_claim_excerpt_flags_group_and_clamps_to_paragraph():
    content = "Para one.\n\nClaim about damages {[S67]}{[S71]} here.\n\nPara three."
    group = cgs.parse_citation_groups(content)[0]
    out = cgs._claim_excerpt(content, group, 0, len(content))

    assert "⟦CITED⟧" in out          # the marker run is flagged
    assert "{[S67]}" not in out and "{[S71]}" not in out  # tokens stripped
    assert "damages" in out
    assert "Para one" not in out             # clamped to its own paragraph
    assert "Para three" not in out


class _FakeCompletions:
    def __init__(self, capture):
        self._capture = capture

    async def create(self, **kwargs):
        self._capture.append(kwargs)
        content = '{"status":"verified","support_score":0.9,"problem":""}'
        message = types.SimpleNamespace(content=content)
        return types.SimpleNamespace(choices=[types.SimpleNamespace(message=message)])


class _FakeClient:
    def __init__(self, capture):
        self.chat = types.SimpleNamespace(completions=_FakeCompletions(capture))


def test_grade_citations_judges_cocitations_together(monkeypatch):
    """The reported bug: co-cited 67 + 71 must be graded as one claim against the
    union of their sources, and share a single verdict — not flagged individually.
    """
    captured: list = []
    monkeypatch.setattr(
        cgs,
        "get_settings",
        lambda: types.SimpleNamespace(
            llm_api_key="k", citation_check_model="", llm_model="m", llm_base_url=""
        ),
    )
    monkeypatch.setattr(cgs, "get_traced_async_openai_client", lambda **_: _FakeClient(captured))
    sources = {
        "c67": "The brief lists five appellate issues.",
        "c71": "the jury awarded damages of $10,647.00 which was inadequate",
    }
    monkeypatch.setattr(cgs, "_fetch_chunk_text", lambda chunk_id, user_id: sources[chunk_id])

    content = "Whether the damages award of $10,647.00 was inadequate {[S67]}{[S71]} per the brief."
    rows = [
        {"id": "a67", "display_number": 67, "display_ref": "{[S67]}",
         "target": {"chunk_id": "c67"}, "user_id": "u"},
        {"id": "a71", "display_number": 71, "display_ref": "{[S71]}",
         "target": {"chunk_id": "c71"}, "user_id": "u"},
    ]

    result = asyncio.run(cgs.grade_citations(content=content, rows=rows, user_id="u"))

    # One grouped LLM call (not one per citation), and both share the verdict.
    assert len(captured) == 1
    assert result["a67"]["status"] == "verified"
    assert result["a71"]["status"] == result["a67"]["status"]

    # The single call saw BOTH sources (the union), labeled per source.
    user_msg = captured[0]["messages"][1]["content"]
    assert "[Source 67]" in user_msg and "[Source 71]" in user_msg
    assert "five appellate issues" in user_msg
    assert "$10,647.00" in user_msg
