"""Unit tests for Story 2.1: Workspace Pydantic Models.

Tests validate:
- AC5: Backend Pydantic models for workspace files
"""

from datetime import datetime

import pytest

pytestmark = pytest.mark.unit


# ===========================================================================
# P0 -- AC5: WorkspaceFileResponse Model
# ===========================================================================


def test_workspace_file_response_has_required_fields():
    """[2.1-UNIT-001] WorkspaceFileResponse model has all required fields."""
    from app.models.schemas import WorkspaceFileResponse

    data = {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "thread_id": "660e8400-e29b-41d4-a716-446655440000",
        "file_path": "notes/research.md",
        "content_type": "text/markdown",
        "source": "agent",
        "size_bytes": 1024,
        "created_at": "2026-03-11T00:00:00Z",
        "updated_at": "2026-03-11T00:00:00Z",
    }

    model = WorkspaceFileResponse(**data)
    assert model.id == data["id"]
    assert model.thread_id == data["thread_id"]
    assert model.file_path == data["file_path"]
    assert model.content_type == data["content_type"]
    assert model.source == data["source"]
    assert model.size_bytes == data["size_bytes"]
    assert isinstance(model.created_at, datetime)
    assert isinstance(model.updated_at, datetime)


def test_workspace_file_response_serialization():
    """[2.1-UNIT-001] WorkspaceFileResponse serializes correctly."""
    from app.models.schemas import WorkspaceFileResponse

    data = {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "thread_id": "660e8400-e29b-41d4-a716-446655440000",
        "file_path": "data/results.csv",
        "content_type": "text/csv",
        "source": "sandbox",
        "size_bytes": 2048,
        "created_at": "2026-03-11T12:00:00Z",
        "updated_at": "2026-03-11T12:30:00Z",
    }

    model = WorkspaceFileResponse(**data)
    serialized = model.model_dump()
    assert "id" in serialized
    assert "thread_id" in serialized
    assert "file_path" in serialized
    assert "content_type" in serialized
    assert "source" in serialized
    assert "size_bytes" in serialized
    assert "created_at" in serialized
    assert "updated_at" in serialized


# ===========================================================================
# P0 -- AC5: WorkspaceFileCreate Model
# ===========================================================================


def test_workspace_file_create_has_required_fields():
    """[2.1-UNIT-002] WorkspaceFileCreate model has all required fields."""
    from app.models.schemas import WorkspaceFileCreate

    data = {
        "file_path": "notes/new-file.md",
        "content": "# Hello World",
        "content_type": "text/markdown",
        "source": "agent",
        "size_bytes": 15,
    }

    model = WorkspaceFileCreate(**data)
    assert model.file_path == data["file_path"]
    assert model.content == data["content"]
    assert model.content_type == data["content_type"]
    assert model.source == data["source"]
    assert model.size_bytes == data["size_bytes"]


def test_workspace_file_create_optional_fields_default_none():
    """[2.1-UNIT-003] WorkspaceFileCreate optional fields default to None."""
    from app.models.schemas import WorkspaceFileCreate

    # Minimal required fields only
    data = {
        "file_path": "notes/minimal.md",
        "content_type": "text/markdown",
        "source": "agent",
        "size_bytes": 0,
    }

    model = WorkspaceFileCreate(**data)
    assert model.content is None, "content should default to None"
    assert model.storage_path is None, "storage_path should default to None"
    assert model.execution_id is None, "execution_id should default to None"


def test_workspace_file_create_with_all_optional_fields():
    """[2.1-UNIT-003] WorkspaceFileCreate accepts all optional fields."""
    from app.models.schemas import WorkspaceFileCreate

    data = {
        "file_path": "deliverables/report.pptx",
        "content": None,
        "storage_path": "user1/thread1/deliverables/report.pptx",
        "content_type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "source": "sandbox",
        "execution_id": "770e8400-e29b-41d4-a716-446655440000",
        "size_bytes": 51200,
    }

    model = WorkspaceFileCreate(**data)
    assert model.storage_path == data["storage_path"]
    assert model.execution_id == data["execution_id"]
    assert model.content is None


def test_workspace_file_create_source_values():
    """[2.1-UNIT-003] WorkspaceFileCreate accepts valid source values."""
    from app.models.schemas import WorkspaceFileCreate

    for source in ["agent", "sandbox", "upload"]:
        model = WorkspaceFileCreate(
            file_path=f"test/{source}.txt",
            content_type="text/plain",
            source=source,
            size_bytes=10,
        )
        assert model.source == source
