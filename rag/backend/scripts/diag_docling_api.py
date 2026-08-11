"""Diagnostic: page counts of sample PDFs + Docling 2.87 API surface check."""
import glob
import os

import pypdfium2 as pdfium

DOWNLOADS = r"C:\Users\Owner\Downloads"

print("=== Sample PDF stats ===")
total_pages = 0
for path in sorted(glob.glob(os.path.join(DOWNLOADS, "*.pdf"))):
    try:
        pdf = pdfium.PdfDocument(path)
        n = len(pdf)
        pdf.close()
    except Exception as exc:  # noqa: BLE001
        n = -1
        print("  ERR", exc)
    size_mb = os.path.getsize(path) / 1024**2
    total_pages += max(0, n)
    print(f"  {n:>4} pages | {size_mb:6.2f} MB | {os.path.basename(path)}")
print(f"  TOTAL pages: {total_pages}")

print("\n=== Docling API surface (2.87) ===")


def probe(modpath, names):
    try:
        mod = __import__(modpath, fromlist=names)
    except Exception as exc:  # noqa: BLE001
        print(f"  import {modpath} FAILED: {exc}")
        return
    for name in names:
        print(f"  {modpath}.{name}: {'OK' if hasattr(mod, name) else 'MISSING'}")


probe(
    "docling.datamodel.pipeline_options",
    [
        "PdfPipelineOptions",
        "ThreadedPdfPipelineOptions",
        "TableStructureOptions",
        "TableFormerMode",
        "EasyOcrOptions",
        "RapidOcrOptions",
        "TesseractOcrOptions",
        "OcrMacOptions",
        "LayoutOptions",
        "smolvlm_picture_description",
    ],
)
probe(
    "docling.datamodel.accelerator_options",
    ["AcceleratorOptions", "AcceleratorDevice"],
)
probe("docling.datamodel.settings", ["settings"])

# Inspect default field values that matter for tuning
print("\n=== Default PdfPipelineOptions fields ===")
try:
    from docling.datamodel.pipeline_options import PdfPipelineOptions, TableFormerMode

    opts = PdfPipelineOptions()
    for f in [
        "do_ocr",
        "do_table_structure",
        "generate_page_images",
        "generate_picture_images",
        "images_scale",
        "do_cell_matching",
    ]:
        print(f"  {f}:", getattr(opts, f, "<n/a>"))
    print("  table_structure_options:", opts.table_structure_options)
    print("  TableFormerMode values:", [m.name for m in TableFormerMode])
except Exception as exc:  # noqa: BLE001
    print("  probe failed:", exc)

print("\n=== Default ThreadedPdfPipelineOptions fields ===")
try:
    from docling.datamodel.pipeline_options import ThreadedPdfPipelineOptions

    topts = ThreadedPdfPipelineOptions()
    for f in [
        "layout_batch_size",
        "ocr_batch_size",
        "table_batch_size",
        "batch_size",
        "queue_max_size",
        "batch_timeout_seconds",
    ]:
        print(f"  {f}:", getattr(topts, f, "<n/a>"))
except Exception as exc:  # noqa: BLE001
    print("  probe failed:", exc)

print("\n=== Default OCR engine factory ===")
try:
    from docling.models.factories import get_ocr_factory

    fac = get_ocr_factory(allow_external_plugins=False)
    print("  registered OCR engines:", sorted(fac.registered_kind))
except Exception as exc:  # noqa: BLE001
    print("  ocr factory probe failed:", exc)
