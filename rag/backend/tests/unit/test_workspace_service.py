"""Unit tests for Story 2.2: workspace_service path validation and content type inference.

Tests validate:
- AC5: _validate_file_path rejects invalid paths
- AC6: _infer_content_type returns correct MIME types
"""

import pytest

pytestmark = pytest.mark.unit


class _Result:
    def __init__(self, data):
        self.data = data


class _WorkspaceFilesQuery:
    def __init__(self, db: "_FakeSupabase"):
        self.db = db

    def select(self, _columns):
        return self

    def eq(self, _column, _value):
        return self

    def execute(self):
        return _Result(self.db.rows)


class _Storage:
    def __init__(self, downloads: dict[str, bytes] | None = None):
        self.downloads = downloads or {}

    def from_(self, _bucket):
        return self

    def download(self, path):
        return self.downloads[path]


class _FakeSupabase:
    def __init__(self, rows, downloads: dict[str, bytes] | None = None):
        self.rows = rows
        self.storage = _Storage(downloads)

    def table(self, name: str):
        assert name == "workspace_files"
        return _WorkspaceFilesQuery(self)


async def _owns_thread(_thread_id, _user_id):
    return True


# ===========================================================================
# P0 -- AC5: File Path Validation
# ===========================================================================


def test_validate_file_path_valid_simple():
    """[2.2-UNIT-001] Simple relative path passes validation."""
    from app.services.workspace_service import _validate_file_path

    _validate_file_path("notes/research.md")  # Should not raise


def test_validate_file_path_valid_nested():
    """[2.2-UNIT-001] Nested relative path passes validation."""
    from app.services.workspace_service import _validate_file_path

    _validate_file_path("data/exports/2026/results.csv")  # Should not raise


def test_validate_file_path_valid_single_file():
    """[2.2-UNIT-001] Single filename passes validation."""
    from app.services.workspace_service import _validate_file_path

    _validate_file_path("readme.txt")  # Should not raise


def test_validate_file_path_rejects_path_traversal():
    """[2.2-UNIT-002] Path traversal (..) is rejected."""
    from app.services.workspace_service import _validate_file_path

    with pytest.raises(ValueError, match="path traversal"):
        _validate_file_path("../etc/passwd")


def test_validate_file_path_rejects_embedded_traversal():
    """[2.2-UNIT-002] Embedded path traversal is rejected."""
    from app.services.workspace_service import _validate_file_path

    with pytest.raises(ValueError, match="path traversal"):
        _validate_file_path("notes/../secret/key.txt")


def test_validate_file_path_rejects_backslashes():
    """[2.2-UNIT-003] Backslashes are rejected."""
    from app.services.workspace_service import _validate_file_path

    with pytest.raises(ValueError, match="backslash"):
        _validate_file_path("notes\\research.md")


def test_validate_file_path_rejects_leading_slash():
    """[2.2-UNIT-004] Leading slash is rejected."""
    from app.services.workspace_service import _validate_file_path

    with pytest.raises(ValueError, match="relative"):
        _validate_file_path("/notes/research.md")


def test_validate_file_path_rejects_long_path():
    """[2.2-UNIT-005] Paths exceeding 500 characters are rejected."""
    from app.services.workspace_service import _validate_file_path

    long_path = "a" * 501
    with pytest.raises(ValueError, match="500 characters"):
        _validate_file_path(long_path)


def test_validate_file_path_accepts_max_length():
    """[2.2-UNIT-005] Path exactly 500 characters passes validation."""
    from app.services.workspace_service import _validate_file_path

    path_500 = "a" * 500
    _validate_file_path(path_500)  # Should not raise


def test_validate_file_path_rejects_empty():
    """[2.2-UNIT-006] Empty path is rejected."""
    from app.services.workspace_service import _validate_file_path

    with pytest.raises(ValueError, match="empty"):
        _validate_file_path("")


# ===========================================================================
# P0 -- AC6: Content Type Inference
# ===========================================================================


def test_infer_content_type_markdown():
    """[2.2-UNIT-007] .md files return text/markdown."""
    from app.services.workspace_service import _infer_content_type

    assert _infer_content_type("notes/research.md") == "text/markdown"


def test_infer_content_type_csv():
    """[2.2-UNIT-007] .csv files return text/csv."""
    from app.services.workspace_service import _infer_content_type

    assert _infer_content_type("data/results.csv") == "text/csv"


def test_infer_content_type_json():
    """[2.2-UNIT-007] .json files return application/json."""
    from app.services.workspace_service import _infer_content_type

    assert _infer_content_type("data/config.json") == "application/json"


def test_infer_content_type_txt():
    """[2.2-UNIT-007] .txt files return text/plain."""
    from app.services.workspace_service import _infer_content_type

    assert _infer_content_type("notes/readme.txt") == "text/plain"


def test_infer_content_type_unknown():
    """[2.2-UNIT-008] Unknown extensions default to text/plain."""
    from app.services.workspace_service import _infer_content_type

    assert _infer_content_type("data/output.xyz") == "text/plain"


def test_infer_content_type_python():
    """[2.2-UNIT-007] .py files return text/x-python."""
    from app.services.workspace_service import _infer_content_type

    result = _infer_content_type("scripts/analysis.py")
    assert result == "text/x-python"


@pytest.mark.asyncio
async def test_read_file_applies_line_range(monkeypatch):
    from app.services import workspace_service

    fake = _FakeSupabase([
        {
            "content": "line 1\nline 2\nline 3\nline 4",
            "storage_path": None,
            "content_type": "text/plain",
        }
    ])
    monkeypatch.setattr(workspace_service, "get_supabase_client", lambda: fake)
    monkeypatch.setattr(workspace_service, "verify_thread_ownership", _owns_thread)

    content = await workspace_service.read_file(
        "thread-1",
        "notes/example.txt",
        "user-1",
        start_line=2,
        end_line=3,
    )

    assert content == "line 2\nline 3"


@pytest.mark.asyncio
async def test_read_file_extracts_stored_pdf_before_line_range(monkeypatch):
    from app.services import text_extraction, workspace_service

    fake = _FakeSupabase(
        [
            {
                "content": "preview only",
                "storage_path": "thread-1/paper.pdf",
                "content_type": "application/pdf",
            }
        ],
        downloads={"thread-1/paper.pdf": b"%PDF-1.7"},
    )

    async def fake_extract_text(_file_bytes, _content_type):
        return "title\x00\nabstract\nmethod\nresults"

    monkeypatch.setattr(workspace_service, "get_supabase_client", lambda: fake)
    monkeypatch.setattr(workspace_service, "verify_thread_ownership", _owns_thread)
    monkeypatch.setattr(text_extraction, "extract_text", fake_extract_text)

    content = await workspace_service.read_file(
        "thread-1",
        "uploads/paper.pdf",
        "user-1",
        start_line="1",
        end_line="3",
    )

    assert content == "title\nabstract\nmethod"
    assert "\x00" not in content
