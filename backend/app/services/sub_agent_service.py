"""Sub-agent service for deep document analysis."""
import json
import logging
from typing import AsyncGenerator, Any

from app.services.document_service import get_full_document_content
from app.services.llm_service import (
    CODEX_SUB_AGENT_REASONING_EFFORT,
    get_global_llm_settings,
    codex_chat_client_for,
)
from app.services.langsmith import get_traced_async_openai_client, traceable
from app.services.citation_service import (
    CitationContext,
    EvidenceSpan,
    canonical_source_id,
    canonical_span_id,
    content_type_for_document_title,
    inline_label_result,
    split_into_spans,
)

logger = logging.getLogger(__name__)

SUB_AGENT_SYSTEM_PROMPT = """You are a document analysis specialist. Your task is to analyze the provided document content and answer the user's question about it.

You have access to the FULL content of a single document. Provide thorough, detailed analysis based on what you find in the document.

Guidelines:
- Base your analysis solely on the document content provided
- Be specific and cite relevant sections when appropriate
- Cite supporting evidence inline using the exact {[S#]} tokens shown next to passages in tool results
- Do not invent citation tokens; if no supplied token supports a statement, omit the citation
- If the document doesn't contain information to answer the question, say so clearly
- Structure your response clearly with headings if appropriate for longer analyses

The document content will be provided in the first user message."""


def _spans_for_document(doc_data: dict[str, Any]) -> list[EvidenceSpan]:
    """Every sentence of the document, in reading order, is a citable span.

    Plan 23 A3: analyze_document inline-labels the full document body (shown to
    the model exactly once) instead of selecting the top-N keyword matches into a
    separate re-quoted evidence block. The model can then cite any passage it
    uses, not just the highest-scoring ones, with no duplication of the content.
    """
    content = doc_data.get("content") or ""
    if not content.strip():
        return []

    source_id = canonical_source_id(
        document_id=doc_data.get("id"),
        file_path=None,
        thread_id=None,
        uri=None,
    )
    metadata = doc_data.get("metadata") or {}
    if not isinstance(metadata, dict):
        metadata = {}
    # Infer from the filename when metadata omits content_type so PDF-backed
    # analyses cite as application/pdf (page render) instead of the text view.
    content_type = metadata.get("content_type") or content_type_for_document_title(
        doc_data.get("filename")
    )

    return [
        EvidenceSpan(
            span_id=canonical_span_id(source_id, span_text, idx),
            source_id=source_id,
            source_type="document",
            title=doc_data.get("filename") or "document",
            text=span_text,
            document_id=doc_data.get("id"),
            content_type=content_type,
        )
        for idx, span_text in enumerate(split_into_spans(content) or [content])
    ]


def _reduce_sub_agent_events(events: list) -> dict:
    """Reduce sub-agent SSE events to a summary for LangSmith tracing."""
    for event in reversed(events):
        if isinstance(event, dict):
            if event.get("type") == "sub_agent_complete":
                return {"result": event.get("result", "")[:500]}
            if event.get("type") == "sub_agent_error":
                return {"error": event.get("error", "")}
    return {"events": len(events)}


@traceable(name="sub_agent_analyze_document", run_type="chain", reduce_fn=_reduce_sub_agent_events)
async def run_sub_agent(
    document_id: str,
    user_id: str,
    user_query: str,
    redaction_svc=None,
    citation_context: CitationContext | None = None,
) -> AsyncGenerator[dict[str, Any], None]:
    """
    Run a sub-agent to analyze a document in depth.

    This spawns an isolated LLM call with the full document content
    and streams the analysis back as SSE events.

    Args:
        document_id: UUID of the document to analyze
        user_id: UUID of the user (for access control)
        user_query: What to analyze or extract from the document

    Yields:
        SSE event dicts:
        - sub_agent_start: {document_id, filename, token_count}
        - sub_agent_reasoning: {content} (streaming)
        - sub_agent_complete: {result}
        - sub_agent_error: {error}
    """
    # Get the full document content
    doc_data = await get_full_document_content(document_id, user_id)

    if not doc_data:
        yield {
            "type": "sub_agent_error",
            "error": f"Document not found or not accessible: {document_id}"
        }
        return

    if not doc_data["fits_context"]:
        yield {
            "type": "sub_agent_error",
            "error": f"Document too large for analysis ({doc_data['token_count']:,} tokens). Maximum is 100,000 tokens."
        }
        return

    # Signal that sub-agent is starting
    yield {
        "type": "sub_agent_start",
        "document_id": doc_data["id"],
        "filename": doc_data["filename"],
        "token_count": doc_data["token_count"],
    }

    labeled_content = doc_data["content"]
    if citation_context is not None:
        try:
            spans = _spans_for_document(doc_data)
            aliases = citation_context.register_spans(spans)
            # Inline-label the document body the model already sees (shown once);
            # no separate re-quoted evidence block (Plan 23 A3).
            labeled_content = inline_label_result(doc_data["content"], aliases)
        except Exception as cite_err:
            logger.warning(f"[CITATION] failed to register spans for analyze_document: {cite_err}")

    # Build the user content and optionally anonymize it. The document body is
    # shown once, carrying inline {[S#]} markers for every passage.
    raw_content = f"## Document: {doc_data['filename']}\n\n{labeled_content}\n\n---\n\n## Analysis Request\n\n{user_query}"
    if redaction_svc:
        anon_content = await redaction_svc.anonymize(raw_content)
    else:
        anon_content = raw_content

    # Build the messages for the sub-agent
    messages = [
        {"role": "system", "content": SUB_AGENT_SYSTEM_PROMPT},
        {"role": "user", "content": anon_content}
    ]

    # Get LLM settings and create client. Try Codex first so analyze_document
    # does not require the OpenAI-compatible LLM key when LLM_PROVIDER=codex.
    llm_settings: dict[str, Any] = {}
    client = codex_chat_client_for(
        "agent",
        llm_settings,
        reasoning_effort=CODEX_SUB_AGENT_REASONING_EFFORT,
    )
    if client is None:
        llm_settings = get_global_llm_settings()
        client = get_traced_async_openai_client(
            base_url=llm_settings["base_url"],
            api_key=llm_settings["api_key"],
        )

    try:
        # Stream the sub-agent response
        stream = await client.chat.completions.create(
            model=llm_settings["model"],
            messages=messages,
            stream=True,
        )

        full_response = ""
        finish_reason = None
        async for chunk in stream:
            delta = chunk.choices[0].delta if chunk.choices else None
            # Only update finish_reason when set (some providers send
            # extra trailing chunks with finish_reason=None).
            chunk_finish = chunk.choices[0].finish_reason if chunk.choices else None
            if chunk_finish:
                finish_reason = chunk_finish

            if delta and delta.content:
                full_response += delta.content
                yield {
                    "type": "sub_agent_reasoning",
                    "content": delta.content,
                }

            if finish_reason == "stop":
                if redaction_svc:
                    deanon_response = await redaction_svc.deanonymize_llm_response(full_response)
                else:
                    deanon_response = full_response
                yield {
                    "type": "sub_agent_complete",
                    "result": deanon_response,
                }

    except Exception as e:
        logger.error(f"Sub-agent error: {e}")
        yield {
            "type": "sub_agent_error",
            "error": str(e),
        }
