"""Ingestion orchestration: extract -> chunk -> embed -> store."""
import asyncio
import gc
import json
import logging
import os
import re
import sys
import threading
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from docling.backend.docling_parse_backend import (
    DoclingParseDocumentBackend,
    ThreadedDoclingParseDocumentBackend,
)
from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
from docling.datamodel.accelerator_options import AcceleratorOptions
from docling.datamodel.backend_options import ThreadedDoclingParseBackendOptions
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import (
    PdfBackend,
    RapidOcrOptions,
    TableFormerMode,
    ThreadedPdfPipelineOptions,
    normalize_pdf_backend,
)
from docling.document_converter import (
    DocumentConverter,
    ImageFormatOption,
    PdfFormatOption,
)
from docling.pipeline.threaded_standard_pdf_pipeline import ThreadedStandardPdfPipeline
from app.config import get_settings
from app.db.supabase import get_supabase_client
from app.services.chunking_service import chunk_text
from app.services.embedding_service import get_embeddings
from app.services.metadata_service import extract_metadata
from app.services.smart_chunker import SmartMarkdownChunker
from app.services.hierarchy_extractor import MarkdownHierarchyExtractor
from app.services.chunk_merger import ChunkSectionMerger
from app.services.document_render import (
    DocumentRenderExtraction,
    attach_chunk_ranges_to_structure,
    build_docling_render,
    build_plain_text_render,
)

logger = logging.getLogger(__name__)

# Converter instances are expensive to create, so each Docling executor thread
# reuses its own instances instead of sharing converters across threads.
_converter_local = threading.local()


def _get_converter(
    do_ocr: bool | None = None,
    force_full_page_ocr: bool | None = None,
) -> DocumentConverter:
    converters = getattr(_converter_local, "converters", None)
    if converters is None:
        converters = {}
        _converter_local.converters = converters

    cache_key = _docling_converter_cache_key(do_ocr, force_full_page_ocr)
    converter = converters.get(cache_key)
    if converter is None:
        converter = _build_document_converter(
            do_ocr=do_ocr,
            force_full_page_ocr=force_full_page_ocr,
        )
        converters[cache_key] = converter
    return converter


def _positive_int(value: int, fallback: int = 1) -> int:
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return fallback


def _non_negative_int(value: int, fallback: int = 0) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return fallback


def _positive_float(value: float, fallback: float = 1.0) -> float:
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        return fallback


def _positive_float_min(value: float, fallback: float = 1.0) -> float:
    try:
        return max(0.1, float(value))
    except (TypeError, ValueError):
        return fallback


def _clamped_progress(progress: int) -> int:
    return min(100, max(0, int(progress)))


def _update_ingestion_progress(
    supabase,
    document_id: str,
    *,
    stage: str,
    progress: int,
    message: str,
    status: str | None = None,
    extra: dict | None = None,
) -> None:
    payload = {
        "ingestion_stage": stage,
        "ingestion_progress": _clamped_progress(progress),
        "ingestion_message": message,
    }
    if status is not None:
        payload["status"] = status
    if extra:
        payload.update(extra)

    supabase.table("documents").update(payload).eq("id", document_id).execute()


@dataclass(frozen=True)
class PdfTextPreflight:
    page_count: int
    sampled_pages: int
    readable_pages: int
    total_text_chars: int
    total_non_ws_chars: int
    total_text_area_ratio: float = 0.0
    total_text_density: float = 0.0
    visual_pages: int = 0
    sparse_visual_pages: int = 0

    @property
    def readable_page_ratio(self) -> float:
        if self.sampled_pages <= 0:
            return 0.0
        return self.readable_pages / self.sampled_pages

    @property
    def avg_text_area_ratio(self) -> float:
        if self.sampled_pages <= 0:
            return 0.0
        return self.total_text_area_ratio / self.sampled_pages

    @property
    def avg_text_density(self) -> float:
        if self.sampled_pages <= 0:
            return 0.0
        return self.total_text_density / self.sampled_pages

    @property
    def visual_page_ratio(self) -> float:
        if self.sampled_pages <= 0:
            return 0.0
        return self.visual_pages / self.sampled_pages

    @property
    def sparse_visual_page_ratio(self) -> float:
        if self.sampled_pages <= 0:
            return 0.0
        return self.sparse_visual_pages / self.sampled_pages


@dataclass(frozen=True)
class DoclingOcrDecision:
    do_ocr: bool
    force_full_page_ocr: bool
    preflight: PdfTextPreflight | None = None
    reason: str = ""


async def _with_ingestion_heartbeat(
    operation,
    *,
    on_progress,
    stage: str,
    start_progress: int,
    max_progress: int,
    message: str,
    interval_seconds: float = 5.0,
):
    async def heartbeat():
        started = asyncio.get_running_loop().time()
        progress = start_progress
        while True:
            await asyncio.sleep(interval_seconds)
            elapsed = int(asyncio.get_running_loop().time() - started)
            progress = min(max_progress, progress + 2)
            on_progress(
                stage=stage,
                progress=progress,
                message=f"{message} ({elapsed}s)",
            )

    heartbeat_task = asyncio.create_task(heartbeat())
    try:
        return await operation
    finally:
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass


def _effective_docling_do_ocr(do_ocr: bool | None = None) -> bool:
    settings = get_settings()
    if not bool(getattr(settings, "docling_do_ocr", True)):
        return False
    if do_ocr is not None:
        return bool(do_ocr)
    return str(getattr(settings, "docling_ocr_mode", "auto") or "auto").lower() != "never"


def _docling_converter_cache_key(
    do_ocr: bool | None = None,
    force_full_page_ocr: bool | None = None,
) -> tuple:
    settings = get_settings()
    effective_force_full_page_ocr = (
        bool(force_full_page_ocr)
        if force_full_page_ocr is not None
        else bool(getattr(settings, "docling_force_full_page_ocr", False))
    )
    return (
        _effective_docling_do_ocr(do_ocr),
        getattr(settings, "docling_device", "auto"),
        _positive_int(getattr(settings, "docling_num_threads", 2), fallback=2),
        _positive_int(getattr(settings, "docling_batch_size", 1)),
        _positive_int(getattr(settings, "docling_table_batch_size", 4), fallback=4),
        _positive_int(getattr(settings, "docling_queue_max_size", 8), fallback=8),
        bool(getattr(settings, "docling_do_table_structure", True)),
        getattr(settings, "docling_table_mode", "accurate"),
        getattr(settings, "docling_ocr_backend", "auto"),
        effective_force_full_page_ocr,
        getattr(settings, "docling_pdf_backend", "docling_parse"),
    )


def _build_docling_pipeline_options(
    do_ocr: bool | None = None,
    force_full_page_ocr: bool | None = None,
) -> ThreadedPdfPipelineOptions:
    settings = get_settings()
    batch_size = _positive_int(settings.docling_batch_size)
    effective_do_ocr = _effective_docling_do_ocr(do_ocr)
    options = ThreadedPdfPipelineOptions(
        accelerator_options=AcceleratorOptions(
            num_threads=_positive_int(settings.docling_num_threads, fallback=2),
            device=settings.docling_device or "auto",
        ),
        do_ocr=effective_do_ocr,
        do_table_structure=settings.docling_do_table_structure,
        ocr_batch_size=batch_size,
        layout_batch_size=batch_size,
        table_batch_size=_positive_int(
            settings.docling_table_batch_size,
            fallback=4,
        ),
        queue_max_size=max(
            batch_size,
            _positive_int(settings.docling_queue_max_size, fallback=8),
        ),
    )
    table_mode = str(
        getattr(settings, "docling_table_mode", "accurate") or "accurate"
    ).lower()
    options.table_structure_options.mode = (
        TableFormerMode.FAST
        if table_mode == TableFormerMode.FAST.value
        else TableFormerMode.ACCURATE
    )

    effective_force_full_page_ocr = (
        bool(force_full_page_ocr)
        if force_full_page_ocr is not None
        else bool(getattr(settings, "docling_force_full_page_ocr", False))
    )
    if effective_do_ocr and settings.docling_ocr_backend != "auto":
        options.ocr_options = RapidOcrOptions(
            backend=settings.docling_ocr_backend,
            force_full_page_ocr=effective_force_full_page_ocr,
        )
    else:
        options.ocr_options.force_full_page_ocr = effective_force_full_page_ocr
    return options


def _sample_pdf_page_indices(page_count: int, max_pages: int) -> list[int]:
    if page_count <= 0:
        return []
    if max_pages <= 0 or max_pages >= page_count:
        return list(range(page_count))
    if max_pages == 1:
        return [0]

    return sorted({
        round(index * (page_count - 1) / (max_pages - 1))
        for index in range(max_pages)
    })


def _pdf_rect_area(
    bounds: tuple[float, float, float, float],
    page_width: float,
    page_height: float,
) -> float:
    left, bottom, right, top = bounds
    clipped_left = min(max(0.0, left), page_width)
    clipped_right = min(max(0.0, right), page_width)
    clipped_bottom = min(max(0.0, bottom), page_height)
    clipped_top = min(max(0.0, top), page_height)
    return max(0.0, clipped_right - clipped_left) * max(
        0.0,
        clipped_top - clipped_bottom,
    )


def _pdf_text_area_ratio(text_page, page_width: float, page_height: float) -> float:
    page_area = max(1.0, page_width * page_height)
    try:
        rect_count = text_page.count_rects()
    except Exception:
        return 0.0

    total_area = 0.0
    for rect_index in range(max(0, rect_count)):
        try:
            total_area += _pdf_rect_area(
                text_page.get_rect(rect_index),
                page_width,
                page_height,
            )
        except Exception:
            continue
    return min(1.0, total_area / page_area)


def _pdf_visual_area_ratio(page, page_width: float, page_height: float) -> float:
    page_area = max(1.0, page_width * page_height)
    try:
        import pypdfium2.raw as pdfium_raw

        visual_types = {
            pdfium_raw.FPDF_PAGEOBJ_IMAGE,
            pdfium_raw.FPDF_PAGEOBJ_PATH,
            pdfium_raw.FPDF_PAGEOBJ_SHADING,
            pdfium_raw.FPDF_PAGEOBJ_FORM,
        }
        text_type = pdfium_raw.FPDF_PAGEOBJ_TEXT
    except Exception:
        return 0.0

    total_area = 0.0
    try:
        objects = page.get_objects()
    except Exception:
        return 0.0

    for obj in objects:
        if getattr(obj, "type", None) == text_type:
            continue
        if getattr(obj, "type", None) not in visual_types:
            continue
        try:
            total_area += _pdf_rect_area(obj.get_bounds(), page_width, page_height)
        except Exception:
            continue
    return min(1.0, total_area / page_area)


def _is_pdf_page_machine_readable(
    *,
    non_ws_chars: int,
    text_area_ratio: float,
    text_density: float,
    visual_area_ratio: float,
) -> bool:
    settings = get_settings()
    min_chars_per_page = _positive_int(
        getattr(settings, "docling_ocr_auto_min_chars_per_page", 60),
        fallback=60,
    )
    min_text_area_ratio = min(
        1.0,
        _positive_float(
            getattr(settings, "docling_ocr_auto_min_text_area_ratio", 0.01),
            fallback=0.01,
        ),
    )
    min_text_density = _positive_float(
        getattr(settings, "docling_ocr_auto_min_text_density", 40.0),
        fallback=40.0,
    )
    min_visual_area_ratio = min(
        1.0,
        _positive_float(
            getattr(settings, "docling_ocr_auto_min_visual_area_ratio", 0.2),
            fallback=0.2,
        ),
    )

    # If there is no substantial visual content, OCR has nothing meaningful to
    # recover. Treat short text-only pages and blank pages as already handled.
    if visual_area_ratio < min_visual_area_ratio:
        return True

    if non_ws_chars < min_chars_per_page:
        return False

    if (
        text_area_ratio >= min_text_area_ratio
        or text_density >= min_text_density
    ):
        return True

    return False


def _analyze_pdf_text_layer(path: str) -> PdfTextPreflight:
    settings = get_settings()
    try:
        max_pages = int(getattr(settings, "docling_ocr_auto_max_pages", 50))
    except (TypeError, ValueError):
        max_pages = 50
    min_visual_area_ratio = min(
        1.0,
        _positive_float(
            getattr(settings, "docling_ocr_auto_min_visual_area_ratio", 0.2),
            fallback=0.2,
        ),
    )

    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(path)
    try:
        page_count = len(pdf)
        page_indices = _sample_pdf_page_indices(page_count, max_pages)
        readable_pages = 0
        total_text_chars = 0
        total_non_ws_chars = 0
        total_text_area_ratio = 0.0
        total_text_density = 0.0
        visual_pages = 0
        sparse_visual_pages = 0

        for page_index in page_indices:
            page = pdf[page_index]
            try:
                page_width = float(page.get_width())
                page_height = float(page.get_height())
                text_page = page.get_textpage()
                try:
                    text = text_page.get_text_range() or ""
                    text_area_ratio = _pdf_text_area_ratio(
                        text_page,
                        page_width,
                        page_height,
                    )
                finally:
                    text_page.close()
                visual_area_ratio = _pdf_visual_area_ratio(
                    page,
                    page_width,
                    page_height,
                )
            finally:
                page.close()

            non_ws_chars = sum(1 for char in text if not char.isspace())
            text_density = non_ws_chars / max(1.0, page_width * page_height) * 100000
            total_text_chars += len(text)
            total_non_ws_chars += non_ws_chars
            total_text_area_ratio += text_area_ratio
            total_text_density += text_density
            if visual_area_ratio >= min_visual_area_ratio:
                visual_pages += 1

            is_readable = _is_pdf_page_machine_readable(
                non_ws_chars=non_ws_chars,
                text_area_ratio=text_area_ratio,
                text_density=text_density,
                visual_area_ratio=visual_area_ratio,
            )
            if is_readable:
                readable_pages += 1
            elif visual_area_ratio >= min_visual_area_ratio and non_ws_chars > 0:
                sparse_visual_pages += 1

        return PdfTextPreflight(
            page_count=page_count,
            sampled_pages=len(page_indices),
            readable_pages=readable_pages,
            total_text_chars=total_text_chars,
            total_non_ws_chars=total_non_ws_chars,
            total_text_area_ratio=total_text_area_ratio,
            total_text_density=total_text_density,
            visual_pages=visual_pages,
            sparse_visual_pages=sparse_visual_pages,
        )
    finally:
        pdf.close()


def _resolve_docling_ocr_decision(path: str, file_type: str) -> DoclingOcrDecision:
    settings = get_settings()
    if not bool(getattr(settings, "docling_do_ocr", True)):
        return DoclingOcrDecision(
            do_ocr=False,
            force_full_page_ocr=False,
            reason="docling_do_ocr_disabled",
        )

    mode = str(getattr(settings, "docling_ocr_mode", "auto") or "auto").lower()
    force_full_page_ocr = bool(
        getattr(settings, "docling_force_full_page_ocr", False)
    )
    if mode == "never":
        return DoclingOcrDecision(
            do_ocr=False,
            force_full_page_ocr=False,
            reason="ocr_mode_never",
        )
    if mode == "always":
        return DoclingOcrDecision(
            do_ocr=True,
            force_full_page_ocr=force_full_page_ocr,
            reason="ocr_mode_always",
        )
    if file_type != "application/pdf":
        return DoclingOcrDecision(
            do_ocr=True,
            force_full_page_ocr=force_full_page_ocr,
            reason="non_pdf",
        )

    try:
        preflight = _analyze_pdf_text_layer(path)
    except Exception as exc:
        logger.warning("PDF text preflight failed; enabling OCR fallback: %s", exc)
        return DoclingOcrDecision(
            do_ocr=True,
            force_full_page_ocr=force_full_page_ocr,
            reason="preflight_failed",
        )

    min_ratio = min(
        1.0,
        _positive_float(
            getattr(settings, "docling_ocr_auto_min_readable_page_ratio", 0.8),
            fallback=0.8,
        ),
    )
    should_ocr = (
        preflight.sampled_pages <= 0
        or preflight.readable_page_ratio < min_ratio
    )
    if should_ocr and (
        preflight.visual_page_ratio > 0
        or preflight.sparse_visual_page_ratio > 0
    ):
        force_full_page_ocr = True
    logger.info(
        "PDF OCR auto preflight: pages=%d sampled=%d readable=%d ratio=%.2f "
        "threshold=%.2f chars=%d avg_text_area=%.4f avg_density=%.1f "
        "visual_pages=%d sparse_visual_pages=%d -> do_ocr=%s force_full_page_ocr=%s",
        preflight.page_count,
        preflight.sampled_pages,
        preflight.readable_pages,
        preflight.readable_page_ratio,
        min_ratio,
        preflight.total_non_ws_chars,
        preflight.avg_text_area_ratio,
        preflight.avg_text_density,
        preflight.visual_pages,
        preflight.sparse_visual_pages,
        should_ocr,
        force_full_page_ocr,
    )
    return DoclingOcrDecision(
        do_ocr=should_ocr,
        force_full_page_ocr=force_full_page_ocr if should_ocr else False,
        preflight=preflight,
        reason="auto_preflight",
    )


def _resolve_docling_do_ocr(path: str, file_type: str) -> bool:
    return _resolve_docling_ocr_decision(path, file_type).do_ocr


def _build_pdf_backend_options():
    settings = get_settings()
    raw_backend = str(
        getattr(settings, "docling_pdf_backend", "docling_parse") or "docling_parse"
    ).strip().lower()
    try:
        pdf_backend = normalize_pdf_backend(PdfBackend(raw_backend))
    except ValueError as exc:
        allowed = ", ".join(backend.value for backend in PdfBackend)
        raise ValueError(
            f"Unsupported DOCLING_PDF_BACKEND={raw_backend!r}. "
            f"Expected one of: {allowed}."
        ) from exc

    if pdf_backend == PdfBackend.DOCLING_PARSE:
        return DoclingParseDocumentBackend, None

    if pdf_backend == PdfBackend.THREADED_DOCLING_PARSE:
        return (
            ThreadedDoclingParseDocumentBackend,
            ThreadedDoclingParseBackendOptions(
                parser_threads=_positive_int(
                    getattr(settings, "docling_num_threads", 2),
                    fallback=2,
                ),
            ),
        )

    if pdf_backend == PdfBackend.PYPDFIUM2:
        return PyPdfiumDocumentBackend, None

    raise ValueError(f"Unexpected Docling PDF backend: {pdf_backend.value}")


def _build_document_converter(
    do_ocr: bool | None = None,
    force_full_page_ocr: bool | None = None,
) -> DocumentConverter:
    pdf_backend, pdf_backend_options = _build_pdf_backend_options()
    return DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(
                backend=pdf_backend,
                backend_options=pdf_backend_options,
                pipeline_cls=ThreadedStandardPdfPipeline,
                pipeline_options=_build_docling_pipeline_options(
                    do_ocr=do_ocr,
                    force_full_page_ocr=force_full_page_ocr,
                ),
            ),
            InputFormat.IMAGE: ImageFormatOption(
                pipeline_options=_build_docling_pipeline_options(
                    do_ocr=do_ocr,
                    force_full_page_ocr=force_full_page_ocr,
                ),
            ),
        }
    )


def _is_docling_file_type(file_type: str) -> bool:
    return file_type not in ("text/plain", "text/markdown")


# Map content-type to file extension for temp file creation
CONTENT_TYPE_TO_EXTENSION = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "text/html": ".html",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/tiff": ".tiff",
}

# Performance tuning constants
BATCH_SIZE = 50  # embeddings per batch; keep OpenRouter requests modest and recoverable
INGESTION_CHILD_ENV = "TAIA_INGESTION_CHILD"

# Semaphore to limit concurrent ingestion tasks (prevents memory exhaustion)
_ingestion_semaphore: asyncio.Semaphore | None = None
_ingestion_semaphore_limit: int | None = None
_ingestion_semaphore_loop: asyncio.AbstractEventLoop | None = None

# Separate Docling gate: conversion is the native-memory-heavy stage.
_docling_semaphore: asyncio.Semaphore | None = None
_docling_semaphore_limit: int | None = None
_docling_semaphore_loop: asyncio.AbstractEventLoop | None = None
_docling_executor: ThreadPoolExecutor | None = None
_docling_executor_workers: int | None = None
_docling_executor_lock = threading.Lock()


def _get_ingestion_limit() -> int:
    return _positive_int(get_settings().ingestion_max_concurrent_documents, fallback=4)


def _get_docling_conversion_limit() -> int:
    return _positive_int(get_settings().docling_max_concurrent_conversions, fallback=2)


def _get_docling_page_chunk_size() -> int:
    return _non_negative_int(
        getattr(get_settings(), "docling_max_pages_per_chunk", 0),
        fallback=0,
    )


def _get_docling_parallel_page_chunk_limit() -> int:
    return _positive_int(
        getattr(get_settings(), "docling_max_parallel_page_chunks_per_document", 1),
        fallback=1,
    )


def _get_ocr_blank_fallback_scale() -> float:
    return _positive_float_min(
        getattr(get_settings(), "docling_ocr_blank_fallback_scale", 3.0),
        fallback=3.0,
    )


def _get_pdf_text_layer_fallback_min_ratio() -> float:
    return min(
        1.0,
        _positive_float(
            getattr(get_settings(), "docling_pdf_text_layer_fallback_min_ratio", 0.5),
            fallback=0.5,
        ),
    )


def _get_ingestion_semaphore() -> asyncio.Semaphore:
    """Get or create the ingestion semaphore (lazy init for event loop compatibility)."""
    global _ingestion_semaphore, _ingestion_semaphore_limit, _ingestion_semaphore_loop
    limit = _get_ingestion_limit()
    loop = asyncio.get_running_loop()
    if (
        _ingestion_semaphore is None
        or _ingestion_semaphore_limit != limit
        or _ingestion_semaphore_loop is not loop
    ):
        _ingestion_semaphore = asyncio.Semaphore(limit)
        _ingestion_semaphore_limit = limit
        _ingestion_semaphore_loop = loop
    return _ingestion_semaphore


def _get_docling_semaphore() -> asyncio.Semaphore:
    """Limit concurrent Docling conversions independently from ingestion."""
    global _docling_semaphore, _docling_semaphore_limit, _docling_semaphore_loop
    limit = _get_docling_conversion_limit()
    loop = asyncio.get_running_loop()
    if (
        _docling_semaphore is None
        or _docling_semaphore_limit != limit
        or _docling_semaphore_loop is not loop
    ):
        _docling_semaphore = asyncio.Semaphore(limit)
        _docling_semaphore_limit = limit
        _docling_semaphore_loop = loop
    return _docling_semaphore


def _get_docling_executor() -> ThreadPoolExecutor:
    """Use a bounded executor so Docling cannot consume the default pool."""
    global _docling_executor, _docling_executor_workers
    workers = _get_docling_conversion_limit()
    with _docling_executor_lock:
        if _docling_executor is None or _docling_executor_workers != workers:
            old_executor = _docling_executor
            _docling_executor = ThreadPoolExecutor(
                max_workers=workers,
                thread_name_prefix="docling",
            )
            _docling_executor_workers = workers
            if old_executor is not None:
                old_executor.shutdown(wait=False, cancel_futures=False)
    return _docling_executor


def shutdown_ingestion_resources() -> None:
    """Release ingestion-owned executor threads during app shutdown/tests."""
    global _docling_executor, _docling_executor_workers
    with _docling_executor_lock:
        executor = _docling_executor
        _docling_executor = None
        _docling_executor_workers = None
    if executor is not None:
        executor.shutdown(wait=False, cancel_futures=True)


def _convert_with_docling(
    path: str,
    do_ocr: bool | None = None,
    force_full_page_ocr: bool | None = None,
    page_range: tuple[int, int] | None = None,
):
    converter = _get_converter(
        do_ocr=do_ocr,
        force_full_page_ocr=force_full_page_ocr,
    )
    if page_range is not None:
        return converter.convert(path, page_range=page_range)
    return converter.convert(path)


def _release_thread_converters() -> None:
    """Drop this thread's cached converters and reclaim native memory.

    The docling-parse backend accumulates native memory and Docling performs no
    explicit cleanup, so dropping the converter plus a GC is the only reliable
    in-process reclaim (docling #2209 / discussion #2115).
    """
    converters = getattr(_converter_local, "converters", None)
    if converters:
        converters.clear()
    _converter_local.converters = None
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _note_document_converted() -> None:
    """Recycle this thread's converters after ``docling_converter_recycle_after``
    conversions.

    In the chunked path each page-range window is a separate conversion, so this
    releases the docling-parse backend's native per-page accumulation (docling
    #2209) between windows, not only between documents.
    """
    try:
        recycle_after = int(getattr(get_settings(), "docling_converter_recycle_after", 1))
    except (TypeError, ValueError):
        recycle_after = 1
    if recycle_after <= 0:
        return
    count = getattr(_converter_local, "doc_count", 0) + 1
    if count >= recycle_after:
        _release_thread_converters()
        count = 0
    _converter_local.doc_count = count


def _convert_document_render(
    path: str,
    do_ocr: bool | None = None,
    force_full_page_ocr: bool | None = None,
    page_range: tuple[int, int] | None = None,
) -> DocumentRenderExtraction:
    result = _convert_with_docling(
        path,
        do_ocr=do_ocr,
        force_full_page_ocr=force_full_page_ocr,
        page_range=page_range,
    )
    try:
        return build_docling_render(result.document)
    finally:
        del result
        gc.collect()
        _note_document_converted()


def _shifted_page_no(value, offset: int):
    if value is None:
        return None
    try:
        return int(value) + offset
    except (TypeError, ValueError):
        return value


def _merge_render_extractions(
    extractions: list[tuple[int, DocumentRenderExtraction]],
) -> DocumentRenderExtraction:
    """Merge Docling page-range renders, normalizing pages to absolute numbers."""
    merged_md: list[str] = []
    merged_pages: list[dict] = []
    merged_layout_pages: list[dict] = []
    merged_text_items: list[dict] = []
    merged_nodes: list[dict] = []
    structure_source = None
    layout_source = None
    has_layout = False

    ordered_extractions = sorted(extractions, key=lambda item: item[0])
    for chunk_idx, (start_page, ext) in enumerate(ordered_extractions):
        page_nos = [
            page["page_no"]
            for page in (ext.pages or [])
            if isinstance(page, dict) and page.get("page_no") is not None
        ]
        offset = (start_page - min(page_nos)) if page_nos else (start_page - 1)

        if ext.markdown:
            merged_md.append(ext.markdown)

        for page in (ext.pages or []):
            entry = dict(page)
            entry["page_no"] = _shifted_page_no(entry.get("page_no"), offset)
            merged_pages.append(entry)

        if ext.structure and isinstance(ext.structure.get("nodes"), list):
            structure_source = ext.structure.get("source") or structure_source
            for node in ext.structure["nodes"]:
                entry = dict(node)
                entry["page_no"] = _shifted_page_no(entry.get("page_no"), offset)
                if entry.get("kind") == "page" and entry.get("page_no") is not None:
                    entry["id"] = f"page-{entry['page_no']}"
                elif entry.get("id"):
                    entry["id"] = f"c{chunk_idx}-{entry['id']}"
                merged_nodes.append(entry)

        if ext.layout:
            has_layout = True
            layout_source = ext.layout.get("source") or layout_source
            for page in ext.layout.get("pages", []):
                entry = dict(page)
                entry["page_no"] = _shifted_page_no(entry.get("page_no"), offset)
                merged_layout_pages.append(entry)
            for item in ext.layout.get("text_items", []):
                entry = dict(item)
                entry["page_no"] = _shifted_page_no(entry.get("page_no"), offset)
                if entry.get("id"):
                    entry["id"] = f"c{chunk_idx}-{entry['id']}"
                prov = entry.get("prov")
                if isinstance(prov, list):
                    entry["prov"] = [
                        {**seg, "page_no": _shifted_page_no(seg.get("page_no"), offset)}
                        if isinstance(seg, dict)
                        else seg
                        for seg in prov
                    ]
                merged_text_items.append(entry)

    structure = (
        {"version": 1, "source": structure_source or "docling", "nodes": merged_nodes}
        if merged_nodes
        else None
    )
    layout = (
        {
            "version": 1,
            "source": layout_source or "docling",
            "coordinate_system": "pdf_points",
            "pages": merged_layout_pages,
            "text_items": merged_text_items,
        }
        if has_layout
        else None
    )
    return DocumentRenderExtraction(
        markdown="\n\n".join(merged_md),
        pages=merged_pages,
        structure=structure,
        layout=layout,
    )


def _pdf_page_ranges(page_count: int, chunk_size: int) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    start = 1
    while start <= page_count:
        end = min(start + chunk_size - 1, page_count)
        ranges.append((start, end))
        start = end + 1
    return ranges


def _get_pdf_page_count(path: str) -> int | None:
    try:
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(path)
        try:
            return len(pdf)
        finally:
            pdf.close()
    except Exception as exc:
        logger.warning(
            "PDF page-count preflight failed; using single-shot Docling: %s",
            exc,
        )
        return None


def _preflight_pdf(path: str) -> int | None:
    """Return the page count, raising ValueError if a page or embedded image
    would exceed the configured memory caps. Reads geometry only — never decodes
    an image. Returns None when the PDF can't be parsed (fail-open: the caller
    falls back to a pypdfium2 page count and the real conversion still runs).
    """
    settings = get_settings()

    def _cap(name: str) -> int:
        try:
            return max(0, int(getattr(settings, name, 0) or 0))
        except (TypeError, ValueError):
            return 0

    max_page_px = _cap("docling_max_page_pixels")
    max_img_px = _cap("docling_max_image_pixels")

    try:
        from pypdf import PdfReader
    except ImportError:
        from PyPDF2 import PdfReader

    try:
        reader = PdfReader(path)
        try:
            if reader.is_encrypted:
                reader.decrypt("")
        except Exception:
            pass
        pages = list(reader.pages)
    except Exception as exc:
        logger.warning("PDF preflight could not parse the file: %s", exc)
        return None

    dpi = 216
    for index, page in enumerate(pages):
        if max_page_px:
            w_in = h_in = 0.0
            try:
                mb = page.mediabox
                uu = float(page.get("/UserUnit", 1) or 1)
                w_in = float(mb.width) * uu / 72.0
                h_in = float(mb.height) * uu / 72.0
                pixels = (w_in * dpi) * (h_in * dpi)
            except Exception:
                pixels = 0
            if pixels > max_page_px:
                raise ValueError(
                    f"Page {index + 1} is too large to process safely "
                    f"(~{w_in:.0f}x{h_in:.0f} in, ~{pixels / 1e6:.0f} megapixels at "
                    f"{dpi} DPI). Split or downscale the document and re-upload."
                )
        if max_img_px:
            try:
                resources = page.get("/Resources")
                xobjects = (
                    resources.get("/XObject").get_object()
                    if resources and resources.get("/XObject")
                    else None
                )
            except Exception:
                xobjects = None
            for ref in (xobjects or {}).values():
                try:
                    obj = ref.get_object()
                    if obj.get("/Subtype") != "/Image":
                        continue
                    pixels = int(obj.get("/Width", 0) or 0) * int(
                        obj.get("/Height", 0) or 0
                    )
                except Exception:
                    continue
                if pixels > max_img_px:
                    raise ValueError(
                        f"Page {index + 1} embeds an image too large to process "
                        f"(~{pixels / 1e6:.0f} megapixels). Downscale images and "
                        "re-upload."
                    )
    return len(pages)


def _normalize_fallback_line(line: str) -> str:
    return re.sub(r"\s+", " ", line).strip()


def _looks_like_fallback_heading(line: str, *, is_first_title: bool = False) -> bool:
    text = _normalize_fallback_line(line)
    if not text:
        return False
    if is_first_title and 8 <= len(text) <= 120:
        return True
    if len(text) > 90 or text.endswith((".", ",", ";", ":")):
        return False
    if text.startswith(("■", "-", "*", "NOTE:")):
        return False
    if text.upper() in {"CORPORATION"}:
        return False
    if " " not in text and (any(char.isdigit() for char in text) or len(text) < 10):
        return False

    letters = [char for char in text if char.isalpha()]
    if len(letters) < 4:
        return False

    upper_ratio = sum(1 for char in letters if char.isupper()) / len(letters)
    if upper_ratio >= 0.75:
        return True

    words = [word for word in re.split(r"\s+", text) if word]
    title_words = sum(1 for word in words if word[:1].isupper())
    return len(words) >= 4 and title_words >= max(3, len(words) - 1)


def _format_fallback_markdown_page(lines: list[str]) -> str:
    formatted: list[str] = []
    title_seen = False

    for raw_line in lines:
        line = _normalize_fallback_line(raw_line)
        if not line:
            continue

        is_first_title = (
            not title_seen
            and len(line) >= 8
            and any(char.isalpha() for char in line)
            and not line.islower()
        )
        if _looks_like_fallback_heading(line, is_first_title=is_first_title):
            title_seen = True
            formatted.append(f"## {line}")
        else:
            formatted.append(line)

    return "\n".join(formatted)


def _fallback_structure_from_pages(
    pages: list[dict],
    *,
    source: str,
) -> dict:
    nodes: list[dict] = []
    section_count = 0

    for page in pages:
        page_no = page.get("page_no")
        nodes.append({
            "id": f"page-{page_no}",
            "kind": "page",
            "title": f"Page {page_no}",
            "level": 1,
            "page_no": page_no,
        })
        for line in str(page.get("markdown") or "").splitlines():
            heading = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
            if not heading:
                continue
            section_count += 1
            title = heading.group(2).strip()
            nodes.append({
                "id": f"section-{section_count}",
                "kind": "section",
                "title": title,
                "level": len(heading.group(1)),
                "page_no": page_no,
                "hierarchy_path": title,
            })

    return {"version": 1, "source": source, "nodes": nodes}


def _resolve_rapidocr_fallback_backend() -> str:
    backend = str(getattr(get_settings(), "docling_ocr_backend", "auto") or "auto")
    if backend != "auto":
        return backend
    try:
        import torch

        if torch.cuda.is_available():
            return "torch"
    except Exception:
        pass
    return "onnxruntime"


def _build_rapidocr_fallback_engine():
    from rapidocr import RapidOCR
    from rapidocr.utils.typings import EngineType

    backend_name = _resolve_rapidocr_fallback_backend()
    aliases = {
        "onnxruntime": EngineType.ONNXRUNTIME,
        "openvino": EngineType.OPENVINO,
        "paddle": EngineType.PADDLE,
        "torch": EngineType.TORCH,
    }
    backend = aliases.get(backend_name, EngineType.TORCH)
    use_cuda = str(getattr(get_settings(), "docling_device", "auto") or "auto").lower()
    use_cuda = use_cuda.startswith("cuda")
    params = {
        "Det.engine_type": backend,
        "Cls.engine_type": backend,
        "Rec.engine_type": backend,
        "EngineConfig.torch.use_cuda": use_cuda,
        "EngineConfig.torch.cuda_ep_cfg.device_id": 0,
        "EngineConfig.paddle.use_cuda": use_cuda,
        "EngineConfig.paddle.gpu_id": 0,
        "EngineConfig.onnxruntime.use_cuda": use_cuda,
    }
    return RapidOCR(params=params)


def _ocr_box_to_pdf_bbox(box, scale: float) -> dict:
    xs = [float(point[0]) for point in box]
    ys = [float(point[1]) for point in box]
    return {
        "l": min(xs) / scale,
        "t": min(ys) / scale,
        "r": max(xs) / scale,
        "b": max(ys) / scale,
        "coord_origin": "TOPLEFT",
    }


def _extract_pdf_with_rapidocr_fallback(path: str) -> DocumentRenderExtraction:
    """Direct RapidOCR recovery for image-only PDFs that Docling leaves blank."""
    import numpy as np
    import pypdfium2 as pdfium

    engine = _build_rapidocr_fallback_engine()
    scale = _get_ocr_blank_fallback_scale()
    pdf = pdfium.PdfDocument(path)
    pages: list[dict] = []
    layout_pages: list[dict] = []
    text_items: list[dict] = []
    markdown_pages: list[str] = []

    try:
        for page_index in range(len(pdf)):
            page_no = page_index + 1
            page = pdf[page_index]
            try:
                width, height = page.get_size()
                bitmap = page.render(scale=scale)
                try:
                    image = bitmap.to_pil().convert("RGB")
                finally:
                    bitmap.close()
                result = engine(np.array(image))
            finally:
                page.close()

            page_lines: list[str] = []
            boxes = getattr(result, "boxes", None)
            txts = getattr(result, "txts", None) or ()
            scores = getattr(result, "scores", None) or ()
            if boxes is not None:
                for line_index, (box, text, score) in enumerate(
                    zip(boxes.tolist(), txts, scores),
                    start=1,
                ):
                    clean_text = str(text or "").strip()
                    if not clean_text:
                        continue
                    page_lines.append(clean_text)
                    bbox = _ocr_box_to_pdf_bbox(box, scale)
                    text_items.append({
                        "id": f"fallback-p{page_no}-text-{line_index}",
                        "page_no": page_no,
                        "text": clean_text,
                        "label": "ocr_text",
                        "bbox": bbox,
                        "confidence": float(score),
                    })

            page_markdown = _format_fallback_markdown_page(page_lines)
            pages.append({"page_no": page_no, "markdown": page_markdown})
            markdown_pages.append(page_markdown)
            layout_pages.append({"page_no": page_no, "width": width, "height": height})
    finally:
        pdf.close()

    markdown = "\n\n".join(page for page in markdown_pages if page.strip())
    return DocumentRenderExtraction(
        markdown=markdown,
        pages=pages,
        structure=_fallback_structure_from_pages(
            pages,
            source="rapidocr_fallback",
        ),
        layout={
            "version": 1,
            "source": "rapidocr_fallback",
            "coordinate_system": "pdf_points",
            "pages": layout_pages,
            "text_items": text_items,
        },
    )


async def _run_rapidocr_blank_fallback(path: str) -> DocumentRenderExtraction:
    semaphore = _get_docling_semaphore()
    async with semaphore:
        if (
            _ingestion_process_isolation_enabled()
            and os.environ.get(INGESTION_CHILD_ENV) != "1"
        ):
            result = await _run_native_extraction_child(
                "rapidocr_fallback",
                {"path": path},
            )
            return _render_extraction_from_dict(result)

        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            _get_docling_executor(),
            _extract_pdf_with_rapidocr_fallback,
            path,
        )


def _normalize_pdf_text_layer_text(text: str) -> str:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return "\n".join(line.rstrip() for line in lines).strip()


def _extract_pdf_text_layer_fallback(path: str) -> DocumentRenderExtraction:
    """Direct PDFium text-layer recovery for readable PDFs Docling under-extracts."""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(path)
    try:
        pages: list[dict] = []
        layout_pages: list[dict] = []
        markdown_pages: list[str] = []

        for page_index in range(len(pdf)):
            page_no = page_index + 1
            page = pdf[page_index]
            try:
                width = float(page.get_width())
                height = float(page.get_height())
                text_page = page.get_textpage()
                try:
                    page_text = _format_fallback_markdown_page(
                        _normalize_pdf_text_layer_text(
                            text_page.get_text_range() or ""
                        ).splitlines()
                    )
                finally:
                    text_page.close()
            finally:
                page.close()

            pages.append({"page_no": page_no, "markdown": page_text})
            if page_text:
                markdown_pages.append(page_text)
            layout_pages.append({
                "page_no": page_no,
                "width": width,
                "height": height,
            })

        return DocumentRenderExtraction(
            markdown="\n\n".join(markdown_pages),
            pages=pages,
            structure=_fallback_structure_from_pages(
                pages,
                source="pdf_text_layer",
            ),
            layout={
                "version": 1,
                "source": "pdf_text_layer",
                "coordinate_system": "pdf_points",
                "pages": layout_pages,
                "text_items": [],
            },
        )
    finally:
        pdf.close()


async def _run_pdf_text_layer_fallback(path: str) -> DocumentRenderExtraction:
    if (
        _ingestion_process_isolation_enabled()
        and os.environ.get(INGESTION_CHILD_ENV) != "1"
    ):
        result = await _run_native_extraction_child(
            "pdf_text_layer_fallback",
            {"path": path},
        )
        return _render_extraction_from_dict(result)

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None,
        _extract_pdf_text_layer_fallback,
        path,
    )


def _non_ws_char_count(text: str) -> int:
    return sum(1 for char in text if not char.isspace())


def _should_retry_pdf_text_layer(
    extracted: DocumentRenderExtraction,
    decision: DoclingOcrDecision,
) -> bool:
    settings = get_settings()
    if not bool(
        getattr(settings, "docling_pdf_text_layer_fallback_enabled", True)
    ):
        return False
    if decision.preflight is None:
        return False

    expected_chars = decision.preflight.total_non_ws_chars
    min_chars = _positive_int(
        getattr(settings, "docling_pdf_text_layer_fallback_min_chars", 200),
        fallback=200,
    )
    if expected_chars < min_chars:
        return False

    min_ratio = min(
        1.0,
        _positive_float(
            getattr(settings, "docling_pdf_text_layer_fallback_min_ratio", 0.5),
            fallback=0.5,
        ),
    )
    extracted_chars = _non_ws_char_count(extracted.markdown)
    return extracted_chars < expected_chars * min_ratio


def _fallback_captures_expected_text(
    fallback: DocumentRenderExtraction,
    decision: DoclingOcrDecision,
) -> bool:
    if decision.preflight is None:
        return bool(fallback.markdown.strip())
    expected_chars = decision.preflight.total_non_ws_chars
    if expected_chars <= 0:
        return bool(fallback.markdown.strip())
    return (
        _non_ws_char_count(fallback.markdown)
        >= expected_chars * _get_pdf_text_layer_fallback_min_ratio()
    )


def _docling_markdown_has_image_placeholder(markdown: str) -> bool:
    return "<!-- image" in markdown.lower()


def _should_retry_sparse_pdf_with_rapidocr(
    extracted: DocumentRenderExtraction,
    decision: DoclingOcrDecision,
) -> tuple[bool, str]:
    markdown = extracted.markdown or ""
    if not decision.do_ocr:
        return False, ""
    if not markdown.strip():
        return True, "blank"
    if not decision.force_full_page_ocr or decision.preflight is None:
        return False, ""
    if decision.preflight.visual_page_ratio <= 0:
        return False, ""
    if not _docling_markdown_has_image_placeholder(markdown):
        return False, ""

    settings = get_settings()
    min_chars_per_page = _positive_int(
        getattr(settings, "docling_ocr_sparse_fallback_min_chars_per_page", 120),
        fallback=120,
    )
    page_count = max(
        1,
        len(extracted.pages or []) or decision.preflight.page_count,
    )
    if _non_ws_char_count(markdown) >= min_chars_per_page * page_count:
        return False, ""
    return True, "sparse_visual"


async def _run_docling_render_slot(
    path: str,
    do_ocr: bool | None = None,
    force_full_page_ocr: bool | None = None,
    page_range: tuple[int, int] | None = None,
) -> DocumentRenderExtraction:
    semaphore = _get_docling_semaphore()
    async with semaphore:
        if (
            _ingestion_process_isolation_enabled()
            and os.environ.get(INGESTION_CHILD_ENV) != "1"
        ):
            result = await _run_native_extraction_child(
                "docling_render",
                {
                    "path": path,
                    "do_ocr": do_ocr,
                    "force_full_page_ocr": force_full_page_ocr,
                    "page_range": list(page_range) if page_range else None,
                },
            )
            return _render_extraction_from_dict(result)

        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            _get_docling_executor(),
            _convert_document_render,
            path,
            do_ocr,
            force_full_page_ocr,
            page_range,
        )


async def _run_docling_conversion(
    path: str,
    file_type: str,
    do_ocr: bool | None = None,
    force_full_page_ocr: bool | None = None,
    on_progress=None,
    page_count: int | None = None,
) -> DocumentRenderExtraction:
    limit = _get_docling_conversion_limit()
    chunk_size = _get_docling_page_chunk_size()
    chunked = (
        file_type == "application/pdf"
        and bool(page_count)
        and bool(chunk_size)
        and page_count > chunk_size
    )

    if not chunked:
        if on_progress:
            on_progress(
                stage="waiting_docling",
                progress=16,
                message=f"Waiting for Docling conversion slot ({limit} at a time)",
            )
        logger.info(
            "Docling conversion starting for %s (ocr=%s force_full_page_ocr=%s "
            "max concurrent conversions=%d)",
            file_type,
            do_ocr,
            force_full_page_ocr,
            limit,
        )
        try:
            operation = _run_docling_render_slot(
                path,
                do_ocr=do_ocr,
                force_full_page_ocr=force_full_page_ocr,
            )
            if not on_progress:
                return await operation
            on_progress(
                stage="extracting",
                progress=18,
                message="Extracting text and layout with Docling",
            )
            return await _with_ingestion_heartbeat(
                operation,
                on_progress=on_progress,
                stage="extracting",
                start_progress=18,
                max_progress=55,
                message="Extracting text and layout with Docling",
            )
        except Exception as exc:
            if "bad_alloc" in str(exc):
                raise RuntimeError(
                    "Docling ran out of native memory while preprocessing this file. "
                    "Try again with fewer simultaneous uploads, or lower "
                    "DOCLING_MAX_CONCURRENT_CONVERSIONS, DOCLING_BATCH_SIZE, or "
                    "DOCLING_NUM_THREADS."
                ) from exc
            raise

    ranges = _pdf_page_ranges(page_count, chunk_size)
    per_document_limit = min(
        len(ranges),
        _get_docling_parallel_page_chunk_limit(),
        limit,
    )
    per_document_semaphore = asyncio.Semaphore(per_document_limit)
    completion_lock = asyncio.Lock()
    completed = 0

    if on_progress:
        on_progress(
            stage="waiting_docling",
            progress=16,
            message=(
                f"Waiting for Docling slots ({limit} global, "
                f"{per_document_limit} for this PDF)"
            ),
        )

    logger.info(
        "Docling chunked conversion starting for %s (%d pages, %d windows, "
        "chunk_size=%d, per_document_parallel=%d, global_limit=%d)",
        file_type,
        page_count,
        len(ranges),
        chunk_size,
        per_document_limit,
        limit,
    )

    async def run_range(page_range: tuple[int, int]):
        nonlocal completed
        start, end = page_range
        async with per_document_semaphore:
            if on_progress:
                on_progress(
                    stage="extracting",
                    progress=18 + int((completed / max(1, len(ranges))) * 37),
                    message=f"Extracting pages {start}-{end} of {page_count} with Docling",
                )
            render = await _run_docling_render_slot(
                path,
                do_ocr=do_ocr,
                force_full_page_ocr=force_full_page_ocr,
                page_range=page_range,
            )
            async with completion_lock:
                completed += 1
                if on_progress:
                    on_progress(
                        stage="extracting",
                        progress=18 + int((completed / max(1, len(ranges))) * 37),
                        message=(
                            f"Extracted page window {completed}/{len(ranges)} "
                            f"with Docling"
                        ),
                    )
            return start, render

    tasks = [
        asyncio.create_task(run_range(page_range))
        for page_range in ranges
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    first_error = next(
        (result for result in results if isinstance(result, Exception)),
        None,
    )
    if first_error is not None:
        if "bad_alloc" in str(first_error):
            raise RuntimeError(
                "Docling ran out of native memory while preprocessing this file. "
                "Try again with fewer simultaneous uploads, or lower "
                "DOCLING_MAX_CONCURRENT_CONVERSIONS, DOCLING_BATCH_SIZE, or "
                "DOCLING_NUM_THREADS."
            ) from first_error
        raise first_error

    merged = _merge_render_extractions(results)
    logger.info(
        "Docling chunked conversion stitched %d windows (%d pages)",
        len(ranges),
        page_count,
    )
    return merged


def _ingestion_process_isolation_enabled() -> bool:
    return bool(
        getattr(get_settings(), "ingestion_process_isolation_enabled", True)
    )


def _backend_root() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _python_executable() -> str:
    exe_name = "python.exe" if os.name == "nt" else "python"
    candidate = os.path.join(
        sys.prefix,
        "Scripts" if os.name == "nt" else "bin",
        exe_name,
    )
    return candidate if os.path.exists(candidate) else sys.executable


def _short_error(value: str, limit: int = 2000) -> str:
    text = re.sub(r"\s+", " ", value or "").strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit]}..."


def _render_extraction_to_dict(extracted: DocumentRenderExtraction) -> dict:
    return {
        "markdown": extracted.markdown,
        "pages": extracted.pages,
        "structure": extracted.structure,
        "layout": extracted.layout,
    }


def _render_extraction_from_dict(data: dict) -> DocumentRenderExtraction:
    return DocumentRenderExtraction(
        markdown=data.get("markdown") or "",
        pages=data.get("pages") or [],
        structure=data.get("structure"),
        layout=data.get("layout"),
    )


async def _run_native_extraction_child(action: str, payload: dict) -> dict:
    env = os.environ.copy()
    env[INGESTION_CHILD_ENV] = "1"
    output = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
    output_path = output.name
    output.close()

    cmd = [
        _python_executable(),
        "-m",
        "app.services.ingestion_service",
        "--native-child",
        action,
        output_path,
    ]
    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=_backend_root(),
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate(
            json.dumps(payload).encode("utf-8")
        )
        if process.returncode != 0:
            stderr_text = stderr.decode("utf-8", errors="replace")
            stdout_text = stdout.decode("utf-8", errors="replace")
            details = _short_error(stderr_text or stdout_text)
            raise RuntimeError(
                f"Isolated native extraction exited with code {process.returncode}"
                + (f": {details}" if details else "")
            )

        with open(output_path, "r", encoding="utf-8") as fh:
            result = json.load(fh)
        if not result.get("ok"):
            raise RuntimeError(result.get("error") or "Native extraction failed")
        return result.get("data") or {}
    finally:
        try:
            os.unlink(output_path)
        except OSError:
            pass


async def process_document(
    document_id: str,
    user_id: str,
    file_bytes: bytes | None = None,
) -> None:
    """
    Process an uploaded document: extract text, chunk, embed, and store.

    Updates document status throughout the process.
    Docling conversion is separately bounded because it is the native-memory-heavy
    stage. Metadata and embedding calls are not held behind that gate.

    Args:
        document_id: The document ID to process
        user_id: The user who owns the document
        file_bytes: Optional pre-loaded file bytes (avoids re-downloading from storage)
    """
    logger.info("Document %s: starting ingestion", document_id)
    # Outer ingestion-wide concurrency bound (memory + event-loop protection).
    # Docling conversion has its own inner gate; this caps how many documents
    # run the full pipeline at once (ingestion_max_concurrent_documents).
    async with _get_ingestion_semaphore():
        await _process_document_inner(document_id, user_id, file_bytes)


async def _process_document_inner(
    document_id: str,
    user_id: str,
    file_bytes: bytes | None = None,
) -> None:
    """Inner processing logic, called within semaphore context."""
    supabase = get_supabase_client()

    def set_progress(
        *,
        stage: str,
        progress: int,
        message: str,
        status: str | None = None,
        extra: dict | None = None,
    ) -> None:
        _update_ingestion_progress(
            supabase,
            document_id,
            stage=stage,
            progress=progress,
            message=message,
            status=status,
            extra=extra,
        )

    try:
        set_progress(
            status="processing",
            stage="starting",
            progress=5,
            message="Starting ingestion",
            extra={"error_message": None},
        )

        # Get the lightweight document fields needed for ingestion. Avoid
        # loading large render/layout JSON blobs here.
        set_progress(
            stage="loading",
            progress=10,
            message="Loading document record",
        )
        doc_result = supabase.table("documents").select(
            "id,user_id,filename,file_type,storage_path"
        ).eq("id", document_id).single().execute()
        doc = doc_result.data

        if not doc:
            raise ValueError(f"Document {document_id} not found")

        # Use provided file_bytes or download from storage (fallback for updates)
        if file_bytes is None:
            set_progress(
                stage="loading",
                progress=12,
                message="Downloading uploaded file",
            )
            storage_path = doc["storage_path"]
            file_bytes = supabase.storage.from_("documents").download(storage_path)

        # Extract markdown and page-aware render metadata based on file type
        extraction_message = (
            "Extracting text and layout with Docling"
            if _is_docling_file_type(doc["file_type"])
            else "Reading text content"
        )
        set_progress(
            stage="extracting",
            progress=15,
            message=extraction_message,
        )
        extracted = await extract_document_content(
            file_bytes,
            doc["file_type"],
            on_progress=set_progress if _is_docling_file_type(doc["file_type"]) else None,
        )
        text = extracted.markdown

        if not text.strip():
            raise ValueError("No text content extracted from document")

        set_progress(
            stage="rendering",
            progress=58,
            message="Saving extracted text and page structure",
        )
        # Store full markdown before chunking (for grep/read tools in Phase 5-6)
        supabase.table("documents").update({
            "full_markdown": text,
            "document_pages": extracted.pages,
            "document_structure": extracted.structure,
            "document_layout": extracted.layout,
        }).eq("id", document_id).execute()

        set_progress(
            stage="chunking",
            progress=62,
            message="Chunking extracted text",
        )

        settings = get_settings()
        hierarchical_index = None

        if settings.chunking_strategy == "smart":
            logger.info("Document %s: using smart chunking strategy", document_id)
            chunker = SmartMarkdownChunker()
            extractor = MarkdownHierarchyExtractor()

            # Step 1-3: Parse, split, merge
            sections_raw = chunker.parse_markdown_sections(text, [1, 2, 3, 4, 5, 6])
            all_chunk_data = []
            for sec in sections_raw:
                all_chunk_data.extend(chunker.split_section_into_chunks(sec))
            merged_chunk_data = chunker.merge_small_chunks(all_chunk_data)
            logger.info("Document %s: %d sections, %d chunks after merge",
                        document_id, len(sections_raw), len(merged_chunk_data))

            if not merged_chunk_data:
                raise ValueError("No chunks generated from document")

            # Await metadata for headline extraction
            set_progress(
                stage="analyzing",
                progress=70,
                message="Extracting document metadata",
            )
            doc_metadata = await extract_metadata(text, user_id)

            # Step 4: Headline prepend (mutates ChunkData in-place before metadata creation)
            headline_desc = doc_metadata.get("document_headline")
            if headline_desc:
                headline_str = f"This chunk is from {headline_desc}, specifically "
                SmartMarkdownChunker.add_document_headline(merged_chunk_data, headline_str)

            processed_chunks = SmartMarkdownChunker.create_chunk_metadata(merged_chunk_data)

            # Hierarchy extraction and merging
            hierarchy_sections = extractor.extract_hierarchy(text)
            sections_with_chunks = extractor.map_sections_to_chunks(
                hierarchy_sections,
                [{"chunk": pc.chunk, "chunk_metadata": pc.chunk_metadata} for pc in processed_chunks],
            )
            hierarchical_index = MarkdownHierarchyExtractor.build_hierarchical_index(
                sections_with_chunks
            )
            extracted.structure = attach_chunk_ranges_to_structure(
                extracted.structure,
                sections_with_chunks,
            )

            # Merge section ranges into chunk metadata
            chunk_dicts = [
                {"chunk": pc.chunk, "chunk_metadata": pc.chunk_metadata}
                for pc in processed_chunks
            ]
            enhanced_chunks = ChunkSectionMerger.merge_data(
                sections_with_chunks, chunk_dicts
            )

            # Build final chunk list: (content, index, metadata)
            chunk_contents = []
            chunk_citable_texts = []
            chunk_metadatas = []
            for idx, ec in enumerate(enhanced_chunks):
                chunk_contents.append(ec["chunk"])
                # enhanced_chunks preserves processed_chunks order 1:1, so the
                # verbatim citable slice aligns by index. Embeddings below still
                # use the enriched chunk content; only citations quote this.
                chunk_citable_texts.append(processed_chunks[idx].citable_text)
                meta = ec["chunk_metadata"]
                chunk_metadatas.append({
                    "filename": doc["filename"],
                    "chunk_index": meta["chunk_index"],
                    "cascading_path": meta.get("cascading_path"),
                    "childRange": meta.get("childRange"),
                    "parentRange": meta.get("parentRange"),
                    "content_length": meta.get("content_length"),
                    **doc_metadata,
                })

        else:
            # Simple recursive character splitter (default)
            chunks = chunk_text(text)
            set_progress(
                stage="analyzing",
                progress=70,
                message="Extracting document metadata",
            )
            doc_metadata = await extract_metadata(text, user_id)

            if not chunks:
                raise ValueError("No chunks generated from document")

            chunk_contents = chunks
            # Simple splitter applies no enrichment, so the chunk text is already
            # verbatim — citable_text mirrors content.
            chunk_citable_texts = list(chunks)
            chunk_metadatas = None  # Built inline below

        set_progress(
            stage="indexing",
            progress=76,
            message=f"Prepared {len(chunk_contents)} chunks",
        )
        # Update document record with extracted metadata + hierarchical index
        doc_update = {
            "metadata": doc_metadata,
            "document_pages": extracted.pages,
            "document_structure": extracted.structure,
            "document_layout": extracted.layout,
        }
        if hierarchical_index is not None:
            doc_update["hierarchical_index"] = hierarchical_index
        supabase.table("documents").update(doc_update).eq("id", document_id).execute()

        # Batch embed and store chunks
        total_chunks = 0
        total_batches = max(1, (len(chunk_contents) + BATCH_SIZE - 1) // BATCH_SIZE)
        for batch_number, i in enumerate(range(0, len(chunk_contents), BATCH_SIZE), start=1):
            batch = chunk_contents[i:i + BATCH_SIZE]

            set_progress(
                stage="embedding",
                progress=78 + int(((batch_number - 1) / total_batches) * 16),
                message=f"Embedding chunk batch {batch_number}/{total_batches}",
            )
            # Generate embeddings from chunk content
            embeddings = await get_embeddings(batch, user_id=user_id)

            # Insert chunks with embeddings
            chunk_records = []
            for j, (chunk_content, embedding) in enumerate(zip(batch, embeddings)):
                if chunk_metadatas is not None:
                    # Smart chunking: use pre-built metadata
                    cm = chunk_metadatas[i + j]
                else:
                    # Simple chunking: build metadata inline
                    cm = {
                        "filename": doc["filename"],
                        "chunk_index": i + j,
                        **doc_metadata,
                    }
                chunk_records.append({
                    "document_id": document_id,
                    "user_id": user_id,
                    "content": chunk_content,
                    "citable_text": chunk_citable_texts[i + j],
                    "chunk_index": i + j,
                    "embedding": embedding,
                    "metadata": cm,
                })

            supabase.table("chunks").insert(chunk_records).execute()
            total_chunks += len(batch)
            set_progress(
                stage="embedding",
                progress=78 + int((batch_number / total_batches) * 16),
                message=f"Stored chunk batch {batch_number}/{total_batches}",
            )

        # Update document status to completed
        set_progress(
            status="completed",
            stage="completed",
            progress=100,
            message="Ready",
            extra={"chunk_count": total_chunks},
        )

        logger.info(f"Document {document_id} processed: {total_chunks} chunks created")

    except Exception as e:
        logger.error(f"Error processing document {document_id}: {e}")
        set_progress(
            status="failed",
            stage="failed",
            progress=100,
            message=str(e),
            extra={"error_message": str(e)},
        )


async def extract_document_content(
    file_bytes: bytes,
    file_type: str,
    on_progress=None,
) -> DocumentRenderExtraction:
    """Extract markdown plus render metadata from file bytes."""
    # Fast-path: plain text and markdown — simple UTF-8 decode
    if file_type in ("text/plain", "text/markdown"):
        return build_plain_text_render(file_bytes.decode("utf-8"))

    # All other types: use Docling for conversion
    ext = CONTENT_TYPE_TO_EXTENSION.get(file_type)
    if not ext:
        raise ValueError(f"Unsupported file type: {file_type}")

    # Write to temp file (Docling requires a file path)
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
    try:
        tmp.write(file_bytes)
        tmp.close()

        if on_progress:
            on_progress(
                stage="preparing_docling",
                progress=15,
                message="Preparing Docling conversion",
            )

        page_count = None
        if file_type == "application/pdf":
            loop = asyncio.get_running_loop()
            # Geometry-only preflight: reject pathologically large (gigapixel-bomb)
            # pages/images before they can exhaust memory, and return the page count
            # so large PDFs convert in memory-safe page-range windows. If pypdf can't
            # parse the file, fall back to a pypdfium2 page count so chunking still
            # applies (the per-page memory ceiling remains the backstop).
            page_count = await loop.run_in_executor(None, _preflight_pdf, tmp.name)
            if page_count is None:
                page_count = await loop.run_in_executor(
                    None, _get_pdf_page_count, tmp.name
                )

        # Run Docling conversion in a bounded executor to avoid blocking the
        # event loop or oversubscribing native preprocessing memory.
        ocr_decision = _resolve_docling_ocr_decision(tmp.name, file_type)
        extracted = await _run_docling_conversion(
            tmp.name,
            file_type,
            do_ocr=ocr_decision.do_ocr,
            force_full_page_ocr=ocr_decision.force_full_page_ocr,
            on_progress=on_progress,
            page_count=page_count,
        )
        fallback_enabled = bool(
            getattr(get_settings(), "docling_ocr_blank_fallback_enabled", True)
        )
        if (
            file_type == "application/pdf"
            and _should_retry_pdf_text_layer(extracted, ocr_decision)
        ):
            logger.warning(
                "Docling returned substantially less text than the PDF text layer; "
                "retrying with direct RapidOCR before PDFium text extraction"
            )
            if on_progress:
                on_progress(
                    stage="extracting",
                    progress=55,
                    message="Recovering under-extracted PDF with direct OCR",
                )
            original_extracted = extracted
            if fallback_enabled:
                ocr_fallback = await _run_rapidocr_blank_fallback(tmp.name)
                if (
                    _non_ws_char_count(ocr_fallback.markdown)
                    > _non_ws_char_count(original_extracted.markdown)
                    and _fallback_captures_expected_text(ocr_fallback, ocr_decision)
                ):
                    extracted = ocr_fallback
                else:
                    logger.warning(
                        "Direct RapidOCR fallback did not recover enough of the "
                        "embedded text layer; trying PDFium text extraction"
                    )

            if extracted is original_extracted:
                if on_progress:
                    on_progress(
                        stage="extracting",
                        progress=56,
                        message="Recovering embedded PDF text layer",
                    )
                text_layer_fallback = await _run_pdf_text_layer_fallback(tmp.name)
                if _non_ws_char_count(
                    text_layer_fallback.markdown
                ) > _non_ws_char_count(original_extracted.markdown):
                    extracted = text_layer_fallback
                else:
                    logger.warning(
                        "PDF text-layer fallback did not improve extracted text length; "
                        "keeping Docling output"
                    )

        should_retry, retry_reason = _should_retry_sparse_pdf_with_rapidocr(
            extracted,
            ocr_decision,
        )
        if file_type == "application/pdf" and fallback_enabled and should_retry:
            if retry_reason == "blank":
                logger.warning(
                    "Docling OCR returned blank markdown for image-only PDF; "
                    "retrying with direct RapidOCR fallback"
                )
                progress_message = "Retrying blank PDF with direct RapidOCR"
            else:
                logger.warning(
                    "Docling OCR returned sparse markdown for visually dense PDF; "
                    "retrying with direct RapidOCR fallback"
                )
                progress_message = "Retrying sparse visual PDF with direct RapidOCR"

            if on_progress:
                on_progress(
                    stage="extracting",
                    progress=55,
                    message=progress_message,
                )
            fallback = await _run_rapidocr_blank_fallback(tmp.name)
            if _non_ws_char_count(fallback.markdown) > _non_ws_char_count(
                extracted.markdown
            ):
                extracted = fallback
            else:
                logger.warning(
                    "Direct RapidOCR fallback did not improve extracted text length; "
                    "keeping Docling output"
                )

        return extracted
    finally:
        os.unlink(tmp.name)


async def extract_text(file_bytes: bytes, file_type: str) -> str:
    """Extract text from file bytes based on file type using Docling."""
    return (await extract_document_content(file_bytes, file_type)).markdown


def _run_native_child_action(action: str, payload: dict) -> dict:
    if action == "docling_render":
        page_range = payload.get("page_range")
        extracted = _convert_document_render(
            payload["path"],
            payload.get("do_ocr"),
            payload.get("force_full_page_ocr"),
            tuple(page_range) if page_range else None,
        )
        return _render_extraction_to_dict(extracted)

    if action == "rapidocr_fallback":
        return _render_extraction_to_dict(
            _extract_pdf_with_rapidocr_fallback(payload["path"])
        )

    if action == "pdf_text_layer_fallback":
        return _render_extraction_to_dict(
            _extract_pdf_text_layer_fallback(payload["path"])
        )

    raise ValueError(f"Unknown native extraction action: {action}")


def _main() -> int:
    if len(sys.argv) == 4 and sys.argv[1] == "--native-child":
        action = sys.argv[2]
        output_path = sys.argv[3]
        payload = json.loads(sys.stdin.read() or "{}")
        try:
            result = {
                "ok": True,
                "data": _run_native_child_action(action, payload),
            }
        except Exception as exc:  # noqa: BLE001 - child reports Python errors
            logger.exception("Native extraction child failed")
            result = {"ok": False, "error": _short_error(str(exc))}

        with open(output_path, "w", encoding="utf-8") as fh:
            json.dump(result, fh)
        return 0

    print(
        "Usage: python -m app.services.ingestion_service "
        "--native-child <action> <output_json_path>",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(_main())
