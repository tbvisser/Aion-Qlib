"""Unit tests for ingestion resource guardrails."""

import asyncio
from types import SimpleNamespace
import threading
import time

import pytest

from app.services import ingestion_service
from app.services.document_render import DocumentRenderExtraction


def _settings(**overrides):
    data = {
        "ingestion_max_concurrent_documents": 4,
        "ingestion_process_isolation_enabled": True,
        "docling_max_concurrent_conversions": 2,
        "docling_device": "auto",
        "docling_num_threads": 2,
        "docling_batch_size": 1,
        "docling_table_batch_size": 4,
        "docling_queue_max_size": 8,
        "docling_do_ocr": True,
        "docling_do_table_structure": True,
        "docling_table_mode": "accurate",
        "docling_ocr_mode": "auto",
        "docling_force_full_page_ocr": False,
        "docling_ocr_auto_max_pages": 50,
        "docling_ocr_auto_min_chars_per_page": 60,
        "docling_ocr_auto_min_readable_page_ratio": 0.8,
        "docling_ocr_auto_min_text_area_ratio": 0.01,
        "docling_ocr_auto_min_text_density": 40.0,
        "docling_ocr_auto_min_visual_area_ratio": 0.2,
        "docling_ocr_backend": "auto",
        "docling_pdf_backend": "docling_parse",
        "docling_max_pages_per_chunk": 50,
        "docling_max_parallel_page_chunks_per_document": 1,
        "docling_ocr_blank_fallback_enabled": True,
        "docling_ocr_blank_fallback_scale": 3.0,
        "docling_ocr_sparse_fallback_min_chars_per_page": 120,
        "docling_pdf_text_layer_fallback_enabled": True,
        "docling_pdf_text_layer_fallback_min_chars": 200,
        "docling_pdf_text_layer_fallback_min_ratio": 0.5,
        "docling_converter_recycle_after": 1,
        "docling_max_page_pixels": 40_000_000,
        "docling_max_image_pixels": 80_000_000,
    }
    data.update(overrides)
    return SimpleNamespace(**data)


@pytest.fixture(autouse=True)
def reset_ingestion_resources():
    ingestion_service.shutdown_ingestion_resources()
    ingestion_service._ingestion_semaphore = None
    ingestion_service._ingestion_semaphore_limit = None
    ingestion_service._ingestion_semaphore_loop = None
    ingestion_service._docling_semaphore = None
    ingestion_service._docling_semaphore_limit = None
    ingestion_service._docling_semaphore_loop = None

    yield

    ingestion_service.shutdown_ingestion_resources()
    ingestion_service._ingestion_semaphore = None
    ingestion_service._ingestion_semaphore_limit = None
    ingestion_service._ingestion_semaphore_loop = None
    ingestion_service._docling_semaphore = None
    ingestion_service._docling_semaphore_limit = None
    ingestion_service._docling_semaphore_loop = None


def test_docling_pipeline_options_use_resource_settings(monkeypatch):
    monkeypatch.setattr(
        ingestion_service,
        "get_settings",
        lambda: _settings(
            docling_num_threads=3,
            docling_device="cuda",
            docling_batch_size=2,
            docling_table_batch_size=4,
            docling_queue_max_size=5,
            docling_do_ocr=True,
            docling_do_table_structure=False,
            docling_table_mode="fast",
            docling_force_full_page_ocr=True,
            docling_ocr_backend="torch",
        ),
    )

    options = ingestion_service._build_docling_pipeline_options()

    assert options.accelerator_options.num_threads == 3
    assert options.accelerator_options.device == "cuda"
    assert options.do_ocr is True
    assert options.do_table_structure is False
    assert options.ocr_options.backend == "torch"
    assert options.ocr_options.force_full_page_ocr is True
    assert (
        options.table_structure_options.mode
        == ingestion_service.TableFormerMode.FAST
    )
    assert options.ocr_batch_size == 2
    assert options.layout_batch_size == 2
    assert options.table_batch_size == 4
    assert options.queue_max_size == 5


def test_isolated_ingestion_keeps_configured_document_limit(monkeypatch):
    monkeypatch.delenv(ingestion_service.INGESTION_CHILD_ENV, raising=False)
    monkeypatch.setattr(
        ingestion_service,
        "get_settings",
        lambda: _settings(
            ingestion_max_concurrent_documents=8,
            docling_max_concurrent_conversions=2,
            ingestion_process_isolation_enabled=True,
        ),
    )

    assert ingestion_service._get_ingestion_limit() == 8


def test_docling_pipeline_options_do_not_load_rapidocr_when_ocr_disabled(monkeypatch):
    monkeypatch.setattr(
        ingestion_service,
        "get_settings",
        lambda: _settings(
            docling_do_ocr=True,
            docling_ocr_backend="torch",
        ),
    )

    options = ingestion_service._build_docling_pipeline_options(do_ocr=False)

    assert options.do_ocr is False
    assert type(options.ocr_options).__name__ == "OcrAutoOptions"


def test_docling_pipeline_options_can_force_full_page_ocr(monkeypatch):
    monkeypatch.setattr(
        ingestion_service,
        "get_settings",
        lambda: _settings(
            docling_do_ocr=True,
            docling_force_full_page_ocr=False,
            docling_ocr_backend="torch",
        ),
    )

    options = ingestion_service._build_docling_pipeline_options(
        do_ocr=True,
        force_full_page_ocr=True,
    )

    assert options.do_ocr is True
    assert options.ocr_options.force_full_page_ocr is True


def test_pdf_converter_uses_threaded_standard_pipeline(monkeypatch):
    monkeypatch.setattr(ingestion_service, "get_settings", lambda: _settings())

    converter = ingestion_service._build_document_converter()
    pdf_options = converter.format_to_options[ingestion_service.InputFormat.PDF]

    assert pdf_options.pipeline_cls is ingestion_service.ThreadedStandardPdfPipeline
    assert pdf_options.backend is ingestion_service.DoclingParseDocumentBackend
    assert pdf_options.backend_options is None


def test_pdf_converter_can_use_threaded_docling_parse_backend(monkeypatch):
    monkeypatch.setattr(
        ingestion_service,
        "get_settings",
        lambda: _settings(
            docling_num_threads=6,
            docling_pdf_backend="threaded_docling_parse",
        ),
    )

    converter = ingestion_service._build_document_converter()
    pdf_options = converter.format_to_options[ingestion_service.InputFormat.PDF]

    assert pdf_options.backend is ingestion_service.ThreadedDoclingParseDocumentBackend
    assert pdf_options.backend_options.parser_threads == 6


def test_docling_ocr_auto_skips_readable_pdf(monkeypatch):
    monkeypatch.setattr(
        ingestion_service,
        "get_settings",
        lambda: _settings(docling_ocr_mode="auto"),
    )
    monkeypatch.setattr(
        ingestion_service,
        "_analyze_pdf_text_layer",
        lambda _path: ingestion_service.PdfTextPreflight(
            page_count=10,
            sampled_pages=10,
            readable_pages=10,
            total_text_chars=5000,
            total_non_ws_chars=4200,
        ),
    )

    assert (
        ingestion_service._resolve_docling_do_ocr(
            "sample.pdf",
            "application/pdf",
        )
        is False
    )


def test_docling_ocr_auto_enables_ocr_for_scanned_pdf(monkeypatch):
    monkeypatch.setattr(
        ingestion_service,
        "get_settings",
        lambda: _settings(docling_ocr_mode="auto"),
    )
    monkeypatch.setattr(
        ingestion_service,
        "_analyze_pdf_text_layer",
        lambda _path: ingestion_service.PdfTextPreflight(
            page_count=10,
            sampled_pages=10,
            readable_pages=1,
            total_text_chars=20,
            total_non_ws_chars=12,
        ),
    )

    assert (
        ingestion_service._resolve_docling_do_ocr(
            "scan.pdf",
            "application/pdf",
        )
        is True
    )


def test_docling_ocr_auto_forces_ocr_for_sparse_visual_pdf(monkeypatch):
    monkeypatch.setattr(
        ingestion_service,
        "get_settings",
        lambda: _settings(docling_ocr_mode="auto"),
    )
    monkeypatch.setattr(
        ingestion_service,
        "_analyze_pdf_text_layer",
        lambda _path: ingestion_service.PdfTextPreflight(
            page_count=1,
            sampled_pages=1,
            readable_pages=0,
            total_text_chars=42,
            total_non_ws_chars=38,
            total_text_area_ratio=0.002,
            total_text_density=8.0,
            visual_pages=1,
            sparse_visual_pages=1,
        ),
    )

    decision = ingestion_service._resolve_docling_ocr_decision(
        "whirlpool.pdf",
        "application/pdf",
    )

    assert decision.do_ocr is True
    assert decision.force_full_page_ocr is True


def test_pdf_page_machine_readability_uses_visual_density(monkeypatch):
    monkeypatch.setattr(
        ingestion_service,
        "get_settings",
        lambda: _settings(
            docling_ocr_auto_min_chars_per_page=10,
            docling_ocr_auto_min_text_area_ratio=0.01,
            docling_ocr_auto_min_text_density=40.0,
            docling_ocr_auto_min_visual_area_ratio=0.2,
        ),
    )

    assert (
        ingestion_service._is_pdf_page_machine_readable(
            non_ws_chars=40,
            text_area_ratio=0.002,
            text_density=8.0,
            visual_area_ratio=0.8,
        )
        is False
    )
    assert (
        ingestion_service._is_pdf_page_machine_readable(
            non_ws_chars=40,
            text_area_ratio=0.002,
            text_density=8.0,
            visual_area_ratio=0.0,
        )
        is True
    )
    assert (
        ingestion_service._is_pdf_page_machine_readable(
            non_ws_chars=0,
            text_area_ratio=0.0,
            text_density=0.0,
            visual_area_ratio=0.0,
        )
        is True
    )
    assert (
        ingestion_service._is_pdf_page_machine_readable(
            non_ws_chars=0,
            text_area_ratio=0.0,
            text_density=0.0,
            visual_area_ratio=0.8,
        )
        is False
    )


def test_docling_ocr_mode_never_disables_ocr(monkeypatch):
    monkeypatch.setattr(
        ingestion_service,
        "get_settings",
        lambda: _settings(docling_ocr_mode="never"),
    )

    assert (
        ingestion_service._resolve_docling_do_ocr(
            "scan.pdf",
            "application/pdf",
        )
        is False
    )


def test_docling_ocr_auto_keeps_ocr_for_images(monkeypatch):
    monkeypatch.setattr(
        ingestion_service,
        "get_settings",
        lambda: _settings(docling_ocr_mode="auto"),
    )

    assert (
        ingestion_service._resolve_docling_do_ocr(
            "scan.png",
            "image/png",
        )
        is True
    )


def test_ingestion_progress_update_clamps_and_sets_payload():
    class Query:
        def __init__(self):
            self.payload = None
            self.document_id = None

        def update(self, payload):
            self.payload = payload
            return self

        def eq(self, key, value):
            assert key == "id"
            self.document_id = value
            return self

        def execute(self):
            return SimpleNamespace(data=[self.payload])

    class Supabase:
        def __init__(self):
            self.query = Query()

        def table(self, name):
            assert name == "documents"
            return self.query

    supabase = Supabase()

    ingestion_service._update_ingestion_progress(
        supabase,
        "doc-1",
        status="processing",
        stage="extracting",
        progress=140,
        message="Extracting text",
        extra={"error_message": None},
    )

    assert supabase.query.document_id == "doc-1"
    assert supabase.query.payload == {
        "status": "processing",
        "ingestion_stage": "extracting",
        "ingestion_progress": 100,
        "ingestion_message": "Extracting text",
        "error_message": None,
    }


@pytest.mark.asyncio
async def test_docling_conversions_obey_configured_concurrency(monkeypatch):
    monkeypatch.setattr(
        ingestion_service,
        "get_settings",
        lambda: _settings(
            docling_max_concurrent_conversions=2,
            ingestion_process_isolation_enabled=False,
        ),
    )

    active = 0
    max_active = 0
    lock = threading.Lock()

    def fake_convert(
        _path: str,
        do_ocr: bool | None = None,
        force_full_page_ocr: bool | None = None,
        page_range=None,
    ):
        nonlocal active, max_active
        with lock:
            active += 1
            max_active = max(max_active, active)
        time.sleep(0.05)
        with lock:
            active -= 1
        return SimpleNamespace(document=object())

    monkeypatch.setattr(ingestion_service, "_convert_with_docling", fake_convert)
    monkeypatch.setattr(
        ingestion_service,
        "build_docling_render",
        lambda _document: DocumentRenderExtraction(
            markdown="ok",
            pages=[],
            structure=None,
            layout=None,
        ),
    )

    results = await asyncio.gather(
        *[
            ingestion_service.extract_document_content(
                b"%PDF-1.7\n",
                "application/pdf",
            )
            for _ in range(4)
        ]
    )

    assert [result.markdown for result in results] == ["ok", "ok", "ok", "ok"]
    assert max_active == 2


def _chunk_extraction(page_nos, *, markdown_prefix, with_layout=True):
    pages = [{"page_no": pn, "markdown": f"{markdown_prefix}{pn}"} for pn in page_nos]
    nodes = []
    for pn in page_nos:
        nodes.append(
            {
                "id": f"page-{pn}",
                "kind": "page",
                "title": f"Page {pn}",
                "level": 1,
                "page_no": pn,
            }
        )
        nodes.append(
            {
                "id": f"section-{pn}",
                "kind": "section",
                "title": f"Sec {pn}",
                "level": 2,
                "page_no": pn,
            }
        )
    layout = None
    if with_layout:
        layout = {
            "version": 1,
            "source": "docling",
            "coordinate_system": "pdf_points",
            "pages": [{"page_no": pn, "width": 612, "height": 792} for pn in page_nos],
            "text_items": [
                {
                    "id": f"text-{pn}",
                    "page_no": pn,
                    "text": f"t{pn}",
                    "label": "text",
                    "bbox": {"l": 0, "t": 0, "r": 10, "b": 10},
                    "prov": [
                        {
                            "page_no": pn,
                            "bbox": {"l": 0, "t": 0, "r": 10, "b": 10},
                            "text": f"t{pn}",
                        }
                    ],
                }
                for pn in page_nos
            ],
        }
    return DocumentRenderExtraction(
        markdown="\n\n".join(p["markdown"] for p in pages),
        pages=pages,
        structure={"version": 1, "source": "docling", "nodes": nodes},
        layout=layout,
    )


def test_merge_render_extractions_normalizes_chunk_pages():
    chunk_a = _chunk_extraction([1, 2], markdown_prefix="A")
    chunk_b = _chunk_extraction([1, 2], markdown_prefix="B")

    merged = ingestion_service._merge_render_extractions([(1, chunk_a), (3, chunk_b)])

    assert [p["page_no"] for p in merged.pages] == [1, 2, 3, 4]
    assert [p["page_no"] for p in merged.layout["pages"]] == [1, 2, 3, 4]
    assert [it["page_no"] for it in merged.layout["text_items"]] == [1, 2, 3, 4]
    assert [it["prov"][0]["page_no"] for it in merged.layout["text_items"]] == [1, 2, 3, 4]
    page_ids = [n["id"] for n in merged.structure["nodes"] if n["kind"] == "page"]
    assert page_ids == ["page-1", "page-2", "page-3", "page-4"]
    assert merged.markdown == "A1\n\nA2\n\nB1\n\nB2"


@pytest.mark.asyncio
async def test_pdf_page_chunks_parallelize_within_document(monkeypatch):
    monkeypatch.setattr(
        ingestion_service,
        "get_settings",
        lambda: _settings(
            docling_max_concurrent_conversions=2,
            docling_max_pages_per_chunk=2,
            docling_max_parallel_page_chunks_per_document=2,
            ingestion_process_isolation_enabled=False,
        ),
    )

    active = 0
    max_active = 0
    calls = []
    lock = threading.Lock()

    def fake_convert(
        _path: str,
        do_ocr: bool | None = None,
        force_full_page_ocr: bool | None = None,
        page_range=None,
    ):
        nonlocal active, max_active
        calls.append(page_range)
        with lock:
            active += 1
            max_active = max(max_active, active)
        time.sleep(0.05)
        with lock:
            active -= 1
        return SimpleNamespace(document=page_range)

    def fake_render(document):
        start, end = document
        page_count = end - start + 1
        return _chunk_extraction(
            list(range(1, page_count + 1)),
            markdown_prefix=f"P{start}_",
        )

    monkeypatch.setattr(ingestion_service, "_convert_with_docling", fake_convert)
    monkeypatch.setattr(ingestion_service, "build_docling_render", fake_render)

    result = await ingestion_service._run_docling_conversion(
        "x.pdf",
        "application/pdf",
        do_ocr=False,
        page_count=5,
    )

    assert sorted(calls) == [(1, 2), (3, 4), (5, 5)]
    assert max_active == 2
    assert [p["page_no"] for p in result.pages] == [1, 2, 3, 4, 5]


@pytest.mark.asyncio
async def test_blank_docling_pdf_uses_rapidocr_fallback(monkeypatch):
    monkeypatch.setattr(ingestion_service, "get_settings", lambda: _settings())
    monkeypatch.setattr(ingestion_service, "_get_pdf_page_count", lambda _path: 1)
    monkeypatch.setattr(
        ingestion_service,
        "_resolve_docling_ocr_decision",
        lambda *_args: ingestion_service.DoclingOcrDecision(
            do_ocr=True,
            force_full_page_ocr=True,
            preflight=ingestion_service.PdfTextPreflight(
                page_count=1,
                sampled_pages=1,
                readable_pages=0,
                total_text_chars=0,
                total_non_ws_chars=0,
                visual_pages=1,
            ),
        ),
    )

    async def fake_docling(*_args, **_kwargs):
        return DocumentRenderExtraction(markdown="", pages=[], structure=None, layout=None)

    async def fake_fallback(_path):
        return DocumentRenderExtraction(
            markdown="OWNER'S MANUAL",
            pages=[{"page_no": 1, "markdown": "OWNER'S MANUAL"}],
            structure={
                "version": 1,
                "source": "rapidocr_fallback",
                "nodes": [
                    {
                        "id": "page-1",
                        "kind": "page",
                        "title": "Page 1",
                        "level": 1,
                        "page_no": 1,
                    }
                ],
            },
            layout={
                "version": 1,
                "source": "rapidocr_fallback",
                "coordinate_system": "pdf_points",
                "pages": [{"page_no": 1, "width": 100, "height": 200}],
                "text_items": [],
            },
        )

    monkeypatch.setattr(ingestion_service, "_run_docling_conversion", fake_docling)
    monkeypatch.setattr(ingestion_service, "_run_rapidocr_blank_fallback", fake_fallback)

    result = await ingestion_service.extract_document_content(
        b"%PDF-1.7\n",
        "application/pdf",
    )

    assert result.markdown == "OWNER'S MANUAL"
    assert result.layout["source"] == "rapidocr_fallback"


@pytest.mark.asyncio
async def test_machine_readable_pdf_uses_rapidocr_when_docling_underextracts(monkeypatch):
    monkeypatch.setattr(ingestion_service, "get_settings", lambda: _settings())
    monkeypatch.setattr(ingestion_service, "_get_pdf_page_count", lambda _path: 1)
    monkeypatch.setattr(
        ingestion_service,
        "_resolve_docling_ocr_decision",
        lambda *_args: ingestion_service.DoclingOcrDecision(
            do_ocr=False,
            force_full_page_ocr=False,
            preflight=ingestion_service.PdfTextPreflight(
                page_count=1,
                sampled_pages=1,
                readable_pages=1,
                total_text_chars=3834,
                total_non_ws_chars=3046,
                total_text_area_ratio=0.18,
                total_text_density=628.0,
                visual_pages=1,
            ),
        ),
    )

    async def fake_docling(*_args, **_kwargs):
        return DocumentRenderExtraction(
            markdown="## Counter Depth, Side by Side Refrigerator\n\n<!-- image -->",
            pages=[{"page_no": 1, "markdown": "Counter Depth, Side by Side Refrigerator"}],
            structure={"version": 1, "source": "docling", "nodes": []},
            layout={"version": 1, "source": "docling", "pages": [], "text_items": []},
        )

    async def fake_text_layer(_path):
        return DocumentRenderExtraction(
            markdown=(
                "Counter Depth, Side by Side Refrigerator\n\n"
                "Product model numbers\nElectrical requirements\n"
                "Cabinet opening dimensions\nDoor swing dimensions\n"
                + "installation details " * 200
            ),
            pages=[{"page_no": 1, "markdown": "full embedded text"}],
            structure={"version": 1, "source": "pdf_text_layer", "nodes": []},
            layout={
                "version": 1,
                "source": "pdf_text_layer",
                "coordinate_system": "pdf_points",
                "pages": [{"page_no": 1, "width": 612, "height": 792}],
                "text_items": [],
            },
        )

    async def fake_ocr(_path):
        return DocumentRenderExtraction(
            markdown=(
                "## Counter Depth, Side by Side Refrigerator\n\n"
                "## PRODUCT DIMENSIONS\n"
                "## CABINET OPENING DIMENSIONS\n"
                "Electrical requirements\nDoor swing dimensions\n"
                + "installation details " * 200
            ),
            pages=[{"page_no": 1, "markdown": "full ocr text"}],
            structure={
                "version": 1,
                "source": "rapidocr_fallback",
                "nodes": [
                    {
                        "id": "page-1",
                        "kind": "page",
                        "title": "Page 1",
                        "level": 1,
                        "page_no": 1,
                    },
                    {
                        "id": "section-1",
                        "kind": "section",
                        "title": "PRODUCT DIMENSIONS",
                        "level": 2,
                        "page_no": 1,
                    },
                ],
            },
            layout={
                "version": 1,
                "source": "rapidocr_fallback",
                "coordinate_system": "pdf_points",
                "pages": [{"page_no": 1, "width": 612, "height": 792}],
                "text_items": [{"id": "ocr-1", "page_no": 1, "text": "PRODUCT DIMENSIONS"}],
            },
        )

    monkeypatch.setattr(ingestion_service, "_run_docling_conversion", fake_docling)
    monkeypatch.setattr(ingestion_service, "_run_rapidocr_blank_fallback", fake_ocr)
    monkeypatch.setattr(ingestion_service, "_run_pdf_text_layer_fallback", fake_text_layer)

    result = await ingestion_service.extract_document_content(
        b"%PDF-1.7\n",
        "application/pdf",
    )

    assert "CABINET OPENING DIMENSIONS" in result.markdown
    assert result.layout["source"] == "rapidocr_fallback"
    assert result.layout["text_items"]
    assert any(
        node.get("title") == "PRODUCT DIMENSIONS"
        for node in result.structure["nodes"]
    )


@pytest.mark.asyncio
async def test_machine_readable_pdf_uses_text_layer_when_rapidocr_is_too_sparse(monkeypatch):
    monkeypatch.setattr(ingestion_service, "get_settings", lambda: _settings())
    monkeypatch.setattr(ingestion_service, "_get_pdf_page_count", lambda _path: 1)
    monkeypatch.setattr(
        ingestion_service,
        "_resolve_docling_ocr_decision",
        lambda *_args: ingestion_service.DoclingOcrDecision(
            do_ocr=False,
            force_full_page_ocr=False,
            preflight=ingestion_service.PdfTextPreflight(
                page_count=1,
                sampled_pages=1,
                readable_pages=1,
                total_text_chars=3834,
                total_non_ws_chars=3046,
                total_text_area_ratio=0.18,
                total_text_density=628.0,
                visual_pages=1,
            ),
        ),
    )

    async def fake_docling(*_args, **_kwargs):
        return DocumentRenderExtraction(
            markdown="## Counter Depth, Side by Side Refrigerator\n\n<!-- image -->",
            pages=[{"page_no": 1, "markdown": "Counter Depth, Side by Side Refrigerator"}],
            structure={"version": 1, "source": "docling", "nodes": []},
            layout={"version": 1, "source": "docling", "pages": [], "text_items": []},
        )

    async def fake_ocr(_path):
        return DocumentRenderExtraction(
            markdown="Counter Depth Refrigerator",
            pages=[{"page_no": 1, "markdown": "Counter Depth Refrigerator"}],
            structure={"version": 1, "source": "rapidocr_fallback", "nodes": []},
            layout={
                "version": 1,
                "source": "rapidocr_fallback",
                "coordinate_system": "pdf_points",
                "pages": [{"page_no": 1, "width": 612, "height": 792}],
                "text_items": [],
            },
        )

    async def fake_text_layer(_path):
        return DocumentRenderExtraction(
            markdown=(
                "## Counter Depth, Side by Side Refrigerator\n\n"
                "## PRODUCT DIMENSIONS\n"
                "## CABINET OPENING DIMENSIONS\n"
                + "installation details " * 200
            ),
            pages=[{"page_no": 1, "markdown": "full embedded text"}],
            structure={"version": 1, "source": "pdf_text_layer", "nodes": []},
            layout={
                "version": 1,
                "source": "pdf_text_layer",
                "coordinate_system": "pdf_points",
                "pages": [{"page_no": 1, "width": 612, "height": 792}],
                "text_items": [],
            },
        )

    monkeypatch.setattr(ingestion_service, "_run_docling_conversion", fake_docling)
    monkeypatch.setattr(ingestion_service, "_run_rapidocr_blank_fallback", fake_ocr)
    monkeypatch.setattr(ingestion_service, "_run_pdf_text_layer_fallback", fake_text_layer)

    result = await ingestion_service.extract_document_content(
        b"%PDF-1.7\n",
        "application/pdf",
    )

    assert "CABINET OPENING DIMENSIONS" in result.markdown
    assert result.layout["source"] == "pdf_text_layer"


@pytest.mark.asyncio
async def test_sparse_visual_docling_pdf_uses_rapidocr_fallback(monkeypatch):
    monkeypatch.setattr(ingestion_service, "get_settings", lambda: _settings())
    monkeypatch.setattr(ingestion_service, "_get_pdf_page_count", lambda _path: 1)
    monkeypatch.setattr(
        ingestion_service,
        "_resolve_docling_ocr_decision",
        lambda *_args: ingestion_service.DoclingOcrDecision(
            do_ocr=True,
            force_full_page_ocr=True,
            preflight=ingestion_service.PdfTextPreflight(
                page_count=1,
                sampled_pages=1,
                readable_pages=0,
                total_text_chars=42,
                total_non_ws_chars=38,
                total_text_area_ratio=0.002,
                total_text_density=8.0,
                visual_pages=1,
                sparse_visual_pages=1,
            ),
        ),
    )

    async def fake_docling(*_args, **_kwargs):
        return DocumentRenderExtraction(
            markdown="Counter Depth, Side by Side Refrigerator\n\n<!-- image -->",
            pages=[{"page_no": 1, "markdown": "Counter Depth, Side by Side Refrigerator"}],
            structure=None,
            layout=None,
        )

    async def fake_fallback(_path):
        return DocumentRenderExtraction(
            markdown=(
                "Counter Depth, Side by Side Refrigerator\n\n"
                "Product model numbers, electrical requirements, water supply, "
                "cabinet opening dimensions, door swing dimensions."
            ),
            pages=[{"page_no": 1, "markdown": "full ocr text"}],
            structure={"version": 1, "source": "rapidocr_fallback", "nodes": []},
            layout={
                "version": 1,
                "source": "rapidocr_fallback",
                "coordinate_system": "pdf_points",
                "pages": [{"page_no": 1, "width": 100, "height": 200}],
                "text_items": [],
            },
        )

    monkeypatch.setattr(ingestion_service, "_run_docling_conversion", fake_docling)
    monkeypatch.setattr(ingestion_service, "_run_rapidocr_blank_fallback", fake_fallback)

    result = await ingestion_service.extract_document_content(
        b"%PDF-1.7\n",
        "application/pdf",
    )

    assert "cabinet opening dimensions" in result.markdown
    assert result.layout["source"] == "rapidocr_fallback"


def test_merge_render_extractions_preserves_absolute_pages():
    # Docling kept absolute page numbers in page_range mode (detected offset 0).
    chunk_a = _chunk_extraction([1, 2], markdown_prefix="A")
    chunk_b = _chunk_extraction([3, 4], markdown_prefix="B")
    merged = ingestion_service._merge_render_extractions([(1, chunk_a), (3, chunk_b)])
    assert [p["page_no"] for p in merged.pages] == [1, 2, 3, 4]
    assert [it["page_no"] for it in merged.layout["text_items"]] == [1, 2, 3, 4]


def _write_pdf(tmp_path, *, width, height, pages=1):
    try:
        from pypdf import PdfWriter
    except ImportError:
        from PyPDF2 import PdfWriter
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=width, height=height)
    out = tmp_path / "sample.pdf"
    with open(out, "wb") as fh:
        writer.write(fh)
    return str(out)


def test_preflight_pdf_returns_page_count(monkeypatch, tmp_path):
    monkeypatch.setattr(ingestion_service, "get_settings", lambda: _settings())
    path = _write_pdf(tmp_path, width=612, height=792, pages=3)
    assert ingestion_service._preflight_pdf(path) == 3


def test_preflight_pdf_rejects_oversized_page(monkeypatch, tmp_path):
    monkeypatch.setattr(ingestion_service, "get_settings", lambda: _settings())
    # 100k x 100k points -> vastly more than docling_max_page_pixels at 216 DPI
    path = _write_pdf(tmp_path, width=100_000, height=100_000, pages=1)
    with pytest.raises(ValueError, match="too large"):
        ingestion_service._preflight_pdf(path)


def test_preflight_pdf_fails_open_on_unparseable(monkeypatch, tmp_path):
    monkeypatch.setattr(ingestion_service, "get_settings", lambda: _settings())
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"not really a pdf")
    assert ingestion_service._preflight_pdf(str(bad)) is None
