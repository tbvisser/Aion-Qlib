"""Text extraction from DOCX and PDF files."""
import asyncio
import io
import logging

logger = logging.getLogger(__name__)

_TEXT_CONTENT_TYPES = {
    "application/json",
    "application/sql",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
}


def _is_text_content_type(content_type: str) -> bool:
    return content_type.startswith("text/") or content_type in _TEXT_CONTENT_TYPES


def _extract_text_from_docx_sync(file_bytes: bytes) -> str:
    """Extract plain text from a DOCX file (sync)."""
    from docx import Document
    doc = Document(io.BytesIO(file_bytes))
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    return "\n\n".join(paragraphs)


def _extract_text_from_pdf_sync(file_bytes: bytes) -> str:
    """Extract plain text from a PDF file (sync)."""
    from PyPDF2 import PdfReader
    try:
        reader = PdfReader(io.BytesIO(file_bytes))
    except Exception as e:
        raise ValueError(f"Failed to read PDF (it may be encrypted or corrupted): {e}")
    pages = []
    for page in reader.pages:
        text = page.extract_text()
        if text:
            pages.append(text)
    if not pages:
        raise ValueError("PDF contains no extractable text (may be image-only or encrypted)")
    return "\n\n".join(pages)


async def extract_text_from_docx(file_bytes: bytes) -> str:
    """Extract plain text from a DOCX file."""
    return await asyncio.to_thread(_extract_text_from_docx_sync, file_bytes)


async def extract_text_from_pdf(file_bytes: bytes) -> str:
    """Extract plain text from a PDF file."""
    return await asyncio.to_thread(_extract_text_from_pdf_sync, file_bytes)


async def extract_text(file_bytes: bytes, content_type: str) -> str:
    """Extract text from a file based on content type."""
    if content_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        return await extract_text_from_docx(file_bytes)
    elif content_type == "application/pdf":
        return await extract_text_from_pdf(file_bytes)
    elif _is_text_content_type(content_type):
        return file_bytes.decode("utf-8", errors="replace")
    else:
        raise ValueError(f"Unsupported content type for text extraction: {content_type}")
