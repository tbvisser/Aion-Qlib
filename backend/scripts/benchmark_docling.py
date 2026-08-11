r"""Benchmark Docling extraction through the app ingestion path.

Run from backend/:
    .\venv\Scripts\python.exe scripts\benchmark_docling.py `
        --input ..\frontend\tests\fixtures\sample.pdf `
        --repeat-pdf-pages 10 `
        --pdf-backend threaded_docling_parse
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import pathlib
import subprocess
import sys
import time
from typing import Any

BACKEND_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


CONTENT_TYPE_BY_SUFFIX = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".html": "text/html",
    ".htm": "text/html",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
}


def _bool_env(value: bool | None) -> str | None:
    if value is None:
        return None
    return "true" if value else "false"


def _set_env(name: str, value: Any) -> None:
    if value is not None:
        os.environ[name] = str(value)


def _load_input(path: pathlib.Path, repeat_pdf_pages: int) -> tuple[bytes, int | None]:
    data = path.read_bytes()
    if repeat_pdf_pages <= 1 or path.suffix.lower() != ".pdf":
        return data, None

    from PyPDF2 import PdfReader, PdfWriter

    reader = PdfReader(str(path))
    writer = PdfWriter()
    for _ in range(repeat_pdf_pages):
        for page in reader.pages:
            writer.add_page(page)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue(), len(reader.pages) * repeat_pdf_pages


def _nvidia_smi_snapshot() -> dict[str, Any] | None:
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.used,memory.total,utilization.gpu,power.draw",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return None

    first_line = result.stdout.strip().splitlines()[0] if result.stdout.strip() else ""
    if not first_line:
        return None
    memory_used, memory_total, utilization, power_draw = [
        part.strip() for part in first_line.split(",")
    ]
    return {
        "memory_used_mb": float(memory_used),
        "memory_total_mb": float(memory_total),
        "utilization_percent": float(utilization),
        "power_draw_watts": float(power_draw),
    }


def _process_rss_mb() -> float | None:
    try:
        import psutil

        return psutil.Process().memory_info().rss / (1024 * 1024)
    except Exception:
        return None


def _torch_snapshot() -> dict[str, Any]:
    try:
        import torch

        cuda_available = torch.cuda.is_available()
        return {
            "version": torch.__version__,
            "cuda_available": cuda_available,
            "cuda_version": torch.version.cuda,
            "gpu_name": torch.cuda.get_device_name(0) if cuda_available else None,
            "cuda_memory_allocated_mb": (
                torch.cuda.memory_allocated(0) / (1024 * 1024)
                if cuda_available
                else None
            ),
            "cuda_memory_reserved_mb": (
                torch.cuda.memory_reserved(0) / (1024 * 1024)
                if cuda_available
                else None
            ),
        }
    except Exception as exc:
        return {"error": str(exc)}


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=pathlib.Path)
    parser.add_argument("--file-type")
    parser.add_argument("--repeat-pdf-pages", type=int, default=1)
    parser.add_argument("--pdf-backend")
    parser.add_argument("--device")
    parser.add_argument("--num-threads", type=int)
    parser.add_argument("--batch-size", type=int)
    parser.add_argument("--table-batch-size", type=int)
    parser.add_argument("--queue-max-size", type=int)
    parser.add_argument("--ocr-backend")
    parser.add_argument("--ocr-mode")
    parser.add_argument("--force-full-page-ocr", action=argparse.BooleanOptionalAction)
    parser.add_argument("--ocr-auto-max-pages", type=int)
    parser.add_argument("--ocr-auto-min-chars-per-page", type=int)
    parser.add_argument("--ocr-auto-min-readable-page-ratio", type=float)
    parser.add_argument("--ocr-auto-min-text-area-ratio", type=float)
    parser.add_argument("--ocr-auto-min-text-density", type=float)
    parser.add_argument("--ocr-auto-min-visual-area-ratio", type=float)
    parser.add_argument("--ocr-sparse-fallback-min-chars-per-page", type=int)
    parser.add_argument("--pdf-text-layer-fallback", action=argparse.BooleanOptionalAction)
    parser.add_argument("--pdf-text-layer-fallback-min-chars", type=int)
    parser.add_argument("--pdf-text-layer-fallback-min-ratio", type=float)
    parser.add_argument("--do-ocr", action=argparse.BooleanOptionalAction)
    parser.add_argument("--do-table-structure", action=argparse.BooleanOptionalAction)
    parser.add_argument("--table-mode")
    return parser.parse_args()


async def _run() -> None:
    args = _parse_args()
    input_path = args.input.resolve()
    file_type = args.file_type or CONTENT_TYPE_BY_SUFFIX.get(input_path.suffix.lower())
    if file_type is None:
        raise SystemExit(f"Could not infer file type for {input_path}")

    _set_env("DOCLING_PDF_BACKEND", args.pdf_backend)
    _set_env("DOCLING_DEVICE", args.device)
    _set_env("DOCLING_NUM_THREADS", args.num_threads)
    _set_env("DOCLING_BATCH_SIZE", args.batch_size)
    _set_env("DOCLING_TABLE_BATCH_SIZE", args.table_batch_size)
    _set_env("DOCLING_QUEUE_MAX_SIZE", args.queue_max_size)
    _set_env("DOCLING_OCR_BACKEND", args.ocr_backend)
    _set_env("DOCLING_OCR_MODE", args.ocr_mode)
    _set_env("DOCLING_FORCE_FULL_PAGE_OCR", _bool_env(args.force_full_page_ocr))
    _set_env("DOCLING_OCR_AUTO_MAX_PAGES", args.ocr_auto_max_pages)
    _set_env(
        "DOCLING_OCR_AUTO_MIN_CHARS_PER_PAGE",
        args.ocr_auto_min_chars_per_page,
    )
    _set_env(
        "DOCLING_OCR_AUTO_MIN_READABLE_PAGE_RATIO",
        args.ocr_auto_min_readable_page_ratio,
    )
    _set_env(
        "DOCLING_OCR_AUTO_MIN_TEXT_AREA_RATIO",
        args.ocr_auto_min_text_area_ratio,
    )
    _set_env("DOCLING_OCR_AUTO_MIN_TEXT_DENSITY", args.ocr_auto_min_text_density)
    _set_env(
        "DOCLING_OCR_AUTO_MIN_VISUAL_AREA_RATIO",
        args.ocr_auto_min_visual_area_ratio,
    )
    _set_env(
        "DOCLING_OCR_SPARSE_FALLBACK_MIN_CHARS_PER_PAGE",
        args.ocr_sparse_fallback_min_chars_per_page,
    )
    _set_env(
        "DOCLING_PDF_TEXT_LAYER_FALLBACK_ENABLED",
        _bool_env(args.pdf_text_layer_fallback),
    )
    _set_env(
        "DOCLING_PDF_TEXT_LAYER_FALLBACK_MIN_CHARS",
        args.pdf_text_layer_fallback_min_chars,
    )
    _set_env(
        "DOCLING_PDF_TEXT_LAYER_FALLBACK_MIN_RATIO",
        args.pdf_text_layer_fallback_min_ratio,
    )
    _set_env("DOCLING_DO_OCR", _bool_env(args.do_ocr))
    _set_env("DOCLING_DO_TABLE_STRUCTURE", _bool_env(args.do_table_structure))
    _set_env("DOCLING_TABLE_MODE", args.table_mode)

    # Import after env overrides so pydantic-settings sees the selected profile.
    from app.config import get_settings
    from app.services.ingestion_service import (
        extract_document_content,
        shutdown_ingestion_resources,
    )

    data, generated_pages = _load_input(input_path, args.repeat_pdf_pages)
    settings = get_settings()

    before_gpu = _nvidia_smi_snapshot()
    before_torch = _torch_snapshot()
    before_rss = _process_rss_mb()
    started = time.perf_counter()
    result = await extract_document_content(data, file_type)
    elapsed = time.perf_counter() - started
    after_rss = _process_rss_mb()
    after_torch = _torch_snapshot()
    after_gpu = _nvidia_smi_snapshot()
    shutdown_ingestion_resources()

    page_count = len(result.pages or [])
    output = {
        "input": str(input_path),
        "file_type": file_type,
        "generated_pages": generated_pages,
        "output_pages": page_count,
        "markdown_chars": len(result.markdown),
        "elapsed_seconds": round(elapsed, 3),
        "pages_per_second": round(page_count / elapsed, 3) if page_count else None,
        "settings": {
            "docling_pdf_backend": settings.docling_pdf_backend,
            "docling_device": settings.docling_device,
            "docling_num_threads": settings.docling_num_threads,
            "docling_batch_size": settings.docling_batch_size,
            "docling_table_batch_size": settings.docling_table_batch_size,
            "docling_queue_max_size": settings.docling_queue_max_size,
            "docling_do_ocr": settings.docling_do_ocr,
            "docling_do_table_structure": settings.docling_do_table_structure,
            "docling_table_mode": settings.docling_table_mode,
            "docling_ocr_mode": settings.docling_ocr_mode,
            "docling_force_full_page_ocr": settings.docling_force_full_page_ocr,
            "docling_ocr_auto_max_pages": settings.docling_ocr_auto_max_pages,
            "docling_ocr_auto_min_chars_per_page": (
                settings.docling_ocr_auto_min_chars_per_page
            ),
            "docling_ocr_auto_min_readable_page_ratio": (
                settings.docling_ocr_auto_min_readable_page_ratio
            ),
            "docling_ocr_auto_min_text_area_ratio": (
                settings.docling_ocr_auto_min_text_area_ratio
            ),
            "docling_ocr_auto_min_text_density": (
                settings.docling_ocr_auto_min_text_density
            ),
            "docling_ocr_auto_min_visual_area_ratio": (
                settings.docling_ocr_auto_min_visual_area_ratio
            ),
            "docling_ocr_sparse_fallback_min_chars_per_page": (
                settings.docling_ocr_sparse_fallback_min_chars_per_page
            ),
            "docling_pdf_text_layer_fallback_enabled": (
                settings.docling_pdf_text_layer_fallback_enabled
            ),
            "docling_pdf_text_layer_fallback_min_chars": (
                settings.docling_pdf_text_layer_fallback_min_chars
            ),
            "docling_pdf_text_layer_fallback_min_ratio": (
                settings.docling_pdf_text_layer_fallback_min_ratio
            ),
            "docling_ocr_backend": settings.docling_ocr_backend,
        },
        "rss_mb": {
            "before": round(before_rss, 1) if before_rss is not None else None,
            "after": round(after_rss, 1) if after_rss is not None else None,
        },
        "torch": {
            "before": before_torch,
            "after": after_torch,
        },
        "nvidia_smi": {
            "before": before_gpu,
            "after": after_gpu,
        },
    }
    print(json.dumps(output, indent=2, sort_keys=True))


if __name__ == "__main__":
    asyncio.run(_run())
