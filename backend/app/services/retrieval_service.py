"""Hybrid search: keyword (FTS) + vector -> RRF fusion -> optional reranking."""
import logging
from app.db.supabase import get_supabase_client
from app.services.embedding_service import get_embeddings
from app.services.rerank_service import rerank_documents
from app.services.langsmith import traceable

logger = logging.getLogger(__name__)


@traceable(name="vector_search", run_type="retriever")
async def vector_search(
    query: str,
    user_id: str,
    top_k: int = 20,
    threshold: float = 0.3,
    metadata_filter: dict | None = None,
    folder_ids: list[str] | None = None,
) -> list[dict]:
    """Run vector similarity search via match_chunks RPC."""
    logger.debug(f"[VECTOR_SEARCH] query='{query}', top_k={top_k}, threshold={threshold}, filter={metadata_filter}, folder_ids={folder_ids}")
    query_embedding = await get_embeddings([query], user_id=user_id)
    logger.debug(f"[VECTOR_SEARCH] Got embedding (dim={len(query_embedding[0]) if query_embedding else 0})")

    supabase = get_supabase_client()
    rpc_params = {
        "query_embedding": query_embedding[0],
        "match_threshold": threshold,
        "match_count": top_k,
        "p_user_id": user_id,
    }
    if metadata_filter:
        rpc_params["p_metadata_filter"] = metadata_filter
    if folder_ids:  # non-empty only; [] means "no restriction", not "no folders"
        rpc_params["p_folder_ids"] = folder_ids

    result = supabase.rpc("match_chunks", rpc_params).execute()
    results = result.data or []
    logger.debug(f"[VECTOR_SEARCH] Returned {len(results)} chunks")
    for i, r in enumerate(results[:5]):
        logger.debug(f"  [{i}] similarity={r.get('similarity', 'N/A'):.3f} content='{r.get('content', '')[:80]}...'")
    return results


@traceable(name="keyword_search", run_type="retriever")
async def keyword_search(
    query: str,
    user_id: str,
    top_k: int = 20,
    metadata_filter: dict | None = None,
    folder_ids: list[str] | None = None,
) -> list[dict]:
    """Run full-text keyword search via keyword_search_chunks RPC."""
    logger.debug(f"[KEYWORD_SEARCH] query='{query}', top_k={top_k}, filter={metadata_filter}, folder_ids={folder_ids}")
    supabase = get_supabase_client()
    rpc_params = {
        "p_query": query,
        "p_match_count": top_k,
        "p_user_id": user_id,
    }
    if metadata_filter:
        rpc_params["p_metadata_filter"] = metadata_filter
    if folder_ids:  # non-empty only; [] means "no restriction", not "no folders"
        rpc_params["p_folder_ids"] = folder_ids

    result = supabase.rpc("keyword_search_chunks", rpc_params).execute()
    results = result.data or []
    logger.debug(f"[KEYWORD_SEARCH] Returned {len(results)} chunks")
    for i, r in enumerate(results[:5]):
        logger.debug(f"  [{i}] rank={r.get('rank', 'N/A')} content='{r.get('content', '')[:80]}...'")
    return results


def reciprocal_rank_fusion(result_lists: list[list[dict]], k: int = 60) -> list[dict]:
    """
    Merge multiple ranked result lists using Reciprocal Rank Fusion.

    Score for each document = sum(1 / (k + rank)) across all lists it appears in.

    Args:
        result_lists: List of ranked result lists (each item must have 'id')
        k: RRF constant (default 60, standard value from literature)

    Returns:
        Merged list sorted by RRF score descending, with 'rrf_score' added
    """
    scores: dict[str, float] = {}
    docs: dict[str, dict] = {}

    for result_list in result_lists:
        for rank, doc in enumerate(result_list):
            doc_id = doc["id"]
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank + 1)
            if doc_id not in docs:
                docs[doc_id] = doc.copy()

    # Sort by RRF score descending
    sorted_ids = sorted(scores.keys(), key=lambda did: scores[did], reverse=True)

    merged = []
    for doc_id in sorted_ids:
        doc = docs[doc_id]
        doc["rrf_score"] = scores[doc_id]
        merged.append(doc)

    return merged


@traceable(name="search_documents", run_type="retriever")
async def search_documents(
    query: str,
    user_id: str,
    top_k: int = 10,
    threshold: float = 0.3,
    metadata_filter: dict | None = None,
    search_mode: str = "hybrid",
    folder_ids: list[str] | None = None,
) -> list[dict]:
    """
    Search user's documents using the specified search strategy.

    Args:
        query: Search query text
        user_id: The user's ID for RLS filtering
        top_k: Maximum number of final results
        threshold: Minimum similarity threshold (vector search only)
        metadata_filter: Optional JSONB containment filter for chunk metadata
        search_mode: "hybrid" (default), "vector", or "keyword"
        folder_ids: Optional list of folder UUIDs to restrict search scope

    Returns:
        List of matching chunks with scores
    """
    candidate_count = 4 * top_k  # Fetch more candidates for fusion/reranking
    logger.debug(f"[SEARCH] query='{query}', mode={search_mode}, top_k={top_k}, candidates={candidate_count}, folder_ids={folder_ids}")

    if search_mode == "vector":
        results = await vector_search(query, user_id, candidate_count, threshold, metadata_filter, folder_ids=folder_ids)
        results = results[:top_k]
        results = await rerank_documents(query, results, top_n=top_k)
        return results

    if search_mode == "keyword":
        results = await keyword_search(query, user_id, candidate_count, metadata_filter, folder_ids=folder_ids)
        results = results[:top_k]
        results = await rerank_documents(query, results, top_n=top_k)
        return results

    # Hybrid: run both searches, fuse with RRF, then rerank
    vector_results = await vector_search(query, user_id, candidate_count, threshold, metadata_filter, folder_ids=folder_ids)
    keyword_results = await keyword_search(query, user_id, candidate_count, metadata_filter, folder_ids=folder_ids)

    if not vector_results and not keyword_results:
        return []

    fused = reciprocal_rank_fusion([vector_results, keyword_results])
    fused = fused[:candidate_count]

    # Rerank the fused results
    reranked = await rerank_documents(query, fused, top_n=top_k)
    return reranked[:top_k]
