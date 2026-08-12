from pydantic import BaseModel, Field, field_validator
from datetime import datetime
from enum import Enum
from typing import Any, Literal
from uuid import UUID


class ThreadCreate(BaseModel):
    title: str | None = "New Chat"


class ThreadResponse(BaseModel):
    id: str
    user_id: str
    title: str
    created_at: datetime
    updated_at: datetime


class ThreadUpdate(BaseModel):
    title: str


class PaginatedThreadsResponse(BaseModel):
    """Paginated list of threads."""
    threads: list[ThreadResponse]
    total_count: int
    has_more: bool


class MessageCreate(BaseModel):
    content: str
    deep_mode: bool = False
    harness_mode: str | None = None
    attachment_file_paths: list[str] = Field(default_factory=list, max_length=10)
    # Per-message model override (UI-selected via the composer "Model" menu).
    # Empty/None falls back to the server default (env LLM_MODEL). Only the
    # model *name* is client-controlled — base_url + api_key stay server-side.
    model: str | None = None
    # "Thinking" (reasoning) toggle + effort. Mapped to the active provider's
    # reasoning parameter server-side (see build_reasoning_request).
    thinking: bool = False
    reasoning_effort: Literal["low", "medium", "high"] | None = None

    @field_validator("model")
    @classmethod
    def _clean_model(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            return None
        if len(v) > 200:
            raise ValueError("model name too long (max 200 chars)")
        return v


class CitationSourceModel(BaseModel):
    source_id: str
    source_type: Literal["document", "workspace_file", "web"]
    title: str
    uri: str | None = None
    document_id: str | None = None
    thread_id: str | None = None
    file_path: str | None = None
    content_type: str | None = None
    content_hash: str | None = None


class CitationTargetModel(BaseModel):
    kind: Literal["text_quote", "text_position", "chunk", "selector", "page"] = "text_quote"
    exact: str | None = None
    prefix: str | None = None
    suffix: str | None = None
    start_char: int | None = None
    end_char: int | None = None
    chunk_id: str | None = None
    selector: str | None = None
    page: int | None = None
    bboxes: list[dict[str, Any]] | None = None


class AnswerCitationModel(BaseModel):
    citation_id: str
    answer_id: str
    display_ref: str
    display_number: int
    source: CitationSourceModel
    target: CitationTargetModel
    quote: str | None = None
    status: Literal["verified", "partially_supported", "not_verified", "contradicted", "verification_failed"]
    support_score: float | None = None
    claim_id: str | None = None
    problem: str | None = None


class MessageResponse(BaseModel):
    id: str
    thread_id: str
    user_id: str
    role: str
    content: str
    created_at: datetime
    tool_calls: list[dict[str, Any]] | None = None
    attachments: list[dict[str, Any]] | None = None
    harness_mode: str | None = None
    harness_phases_before: list[int] | None = None
    sequence_number: int | None = None
    citations: list[AnswerCitationModel] | None = None
    verification_mode: Literal["unverified", "semantic-text"] | None = None


class CheckCitationsResponse(BaseModel):
    """Result of an on-demand "Check Citations" grounding pass over one message.

    The citations carry refreshed ``status``/``support_score``/``problem`` so the
    frontend can swap them into the existing citation chips (now in
    ``semantic-text`` / "Checked Citations" mode).
    """
    message_id: str
    verification_mode: Literal["unverified", "semantic-text"] | None = None
    citations: list[AnswerCitationModel]


class DocumentResponse(BaseModel):
    id: str
    user_id: str
    folder_id: str | None = None  # None for unfiled documents
    filename: str
    file_type: str
    file_size: int
    storage_path: str
    status: str
    error_message: str | None = None
    ingestion_stage: str | None = None
    ingestion_progress: int = 0
    ingestion_message: str | None = None
    chunk_count: int = 0
    content_hash: str | None = None
    hierarchical_index: str | None = None
    metadata: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime


class DocumentRenderPage(BaseModel):
    page_no: int
    markdown: str


class DocumentRenderResponse(BaseModel):
    document_id: str
    markdown: str | None = None
    pages: list[DocumentRenderPage] = []
    structure: dict[str, Any] | None = None


class FolderCreate(BaseModel):
    name: str
    parent_id: str | None = None

    @field_validator('name')
    @classmethod
    def name_must_be_valid(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError('Folder name cannot be empty')
        if len(v) > 255:
            raise ValueError('Folder name cannot exceed 255 characters')
        return v


class FolderUpdate(BaseModel):
    name: str

    @field_validator('name')
    @classmethod
    def name_must_be_valid(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError('Folder name cannot be empty')
        if len(v) > 255:
            raise ValueError('Folder name cannot exceed 255 characters')
        return v


class FolderResponse(BaseModel):
    id: str
    user_id: str | None  # None for global folders
    parent_id: str | None  # None for root folders
    name: str
    shared_by: str | None = None  # Original owner ID when shared globally
    created_at: datetime
    updated_at: datetime


class DocumentMove(BaseModel):
    """Request to move a document to a different folder."""
    folder_id: str | None = None  # None = move to root (unfiled)


class BulkDeleteRequest(BaseModel):
    """Request to delete multiple documents at once."""
    document_ids: list[str]


class BulkMoveRequest(BaseModel):
    """Request to move multiple documents to a different folder."""
    document_ids: list[str]
    folder_id: str | None = None  # None = move to root (unfiled)


class BulkActionResponse(BaseModel):
    """Result of a bulk document action.

    - succeeded: IDs that were deleted/moved
    - failed: IDs that were skipped (not found or not owned by the caller)
    """
    succeeded: list[str]
    failed: list[str]


class PaginatedDocumentsResponse(BaseModel):
    """Paginated list of documents."""
    documents: list[DocumentResponse]
    total_count: int
    has_more: bool


class ChunkRangeItem(BaseModel):
    document_id: str
    chunk_ranges: list[list[int]]  # [[start, end], ...]


class ChunkRangeRequest(BaseModel):
    items: list[ChunkRangeItem]


class FolderMove(BaseModel):
    """Request to move a folder to a different parent."""
    parent_id: str | None = None  # None = move to root level


class FolderShareToggle(BaseModel):
    """Request to toggle folder sharing (global/private)."""
    is_global: bool  # True = share with all, False = make private


# --- Skills schemas ---

class SkillCreate(BaseModel):
    """Request to create a new skill."""
    name: str = Field(min_length=1, max_length=64, pattern=r'^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')
    description: str = Field(min_length=20, max_length=1024)
    instructions: str = Field(min_length=1)
    enabled: bool = True
    license: str | None = None
    compatibility: str | None = None
    metadata: dict[str, str] | None = None

    @field_validator('name')
    @classmethod
    def name_no_consecutive_hyphens(cls, v: str) -> str:
        if '--' in v:
            raise ValueError('Name cannot contain consecutive hyphens')
        return v


class SkillUpdate(BaseModel):
    """Request to update an existing skill (partial update)."""
    name: str | None = Field(default=None, min_length=1, max_length=64, pattern=r'^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')
    description: str | None = Field(default=None, min_length=20, max_length=1024)
    instructions: str | None = Field(default=None, min_length=1)
    enabled: bool | None = None
    license: str | None = None
    compatibility: str | None = None
    metadata: dict[str, str] | None = None

    @field_validator('name')
    @classmethod
    def name_no_consecutive_hyphens(cls, v: str | None) -> str | None:
        if v is not None and '--' in v:
            raise ValueError('Name cannot contain consecutive hyphens')
        return v


class SkillResponse(BaseModel):
    """Skill data returned to the client."""
    id: str
    user_id: str | None = None
    name: str
    description: str
    instructions: str
    enabled: bool
    shared_by: str | None = None
    license: str | None = None
    compatibility: str | None = None
    metadata: dict[str, str] | None = None
    source_url: str | None = None
    created_at: datetime
    updated_at: datetime


class SkillShareToggle(BaseModel):
    """Request to toggle skill sharing (global/private)."""
    is_global: bool  # True = share with all, False = make private


class SkillImportResult(BaseModel):
    """Result for a single skill in an import batch."""
    name: str
    success: bool
    skill_id: str | None = None
    error: str | None = None


class SkillImportResponse(BaseModel):
    """Response from the skill import endpoint."""
    imported: int
    failed: int
    results: list[SkillImportResult]


class SkillImportUrlRequest(BaseModel):
    """Request to import a skill from a remote registry (skills.sh / GitHub)."""
    source: str = Field(min_length=1, max_length=2048)


class SkillFileResponse(BaseModel):
    """Skill file metadata returned to the client."""
    id: str
    skill_id: str
    filename: str
    file_size: int
    mime_type: str
    created_at: datetime


class SkillFileContentResponse(BaseModel):
    """Skill file content (text) or download URL (binary)."""
    filename: str
    mime_type: str
    download_url: str
    content: str | None = None  # null for binary files


class SkillFileRename(BaseModel):
    """Rename a skill file (may also move it to a different folder)."""
    filename: str = Field(..., min_length=1, max_length=512)


class SkillFolderCreate(BaseModel):
    """Create an empty folder by uploading a hidden placeholder file."""
    path: str = Field(..., min_length=1, max_length=512)


class SkillFolderRename(BaseModel):
    """Rename a folder by bulk-renaming every file under its path prefix."""
    old_path: str = Field(..., min_length=1, max_length=512)
    new_path: str = Field(..., min_length=1, max_length=512)


# --- Workspace schemas ---

class WorkspaceFileResponse(BaseModel):
    """Workspace file metadata returned to the client."""
    id: str
    thread_id: str
    file_path: str
    size_bytes: int
    content_type: str
    source: str  # 'agent', 'sandbox', 'upload'
    storage_path: str | None = None
    created_at: datetime
    updated_at: datetime


class WorkspaceFileCreate(BaseModel):
    """Request to create or update a workspace file."""
    file_path: str
    content: str | None = None
    content_type: str = "text/plain"
    source: str = "agent"
    size_bytes: int = 0
    storage_path: str | None = None
    execution_id: str | None = None


# --- Todo schemas ---

class TodoItem(BaseModel):
    """A single task in the agent's plan."""
    content: str
    status: Literal["pending", "in_progress", "completed"] = "pending"
    position: int


class WriteTodosRequest(BaseModel):
    """Request to overwrite the entire todo list for a thread."""
    todos: list[TodoItem]


class TodoResponse(BaseModel):
    """Todo data returned to the client (includes DB fields)."""
    id: str
    thread_id: str
    content: str
    status: Literal["pending", "in_progress", "completed"]
    position: int
    created_at: datetime
    updated_at: datetime


# --- Harness schemas ---

class HarnessPhaseStatus(str, Enum):
    pending = "pending"
    running = "running"
    completed = "completed"
    failed = "failed"
    skipped = "skipped"


class HarnessPhaseToolCall(BaseModel):
    """Tool call executed during an agent phase."""
    tool_name: str
    arguments: str
    result: str | None = None

class HarnessPhaseInfo(BaseModel):
    """Phase metadata sent to frontend for display."""
    index: int
    name: str
    description: str
    status: HarnessPhaseStatus
    result_markdown: str | None = None
    tool_calls: list[HarnessPhaseToolCall] = []
    phase_type: str | None = None


class HarnessRunResponse(BaseModel):
    id: str
    thread_id: str
    harness_type: str
    status: str
    current_phase: int
    phases: list[HarnessPhaseInfo]
    created_at: datetime
    updated_at: datetime


class HarnessRunCreate(BaseModel):
    harness_type: str
    input_file_ids: list[UUID] = []
    config: dict = {}


# --- Compaction schemas ---


class CompactionResponse(BaseModel):
    id: str
    thread_id: str
    user_id: str
    summary_text: str
    covers_from_sequence: int
    covers_to_sequence: int
    evicted_message_count: int
    summary_tokens: int
    model_used: str
    previous_compaction_id: str | None = None
    created_at: datetime
