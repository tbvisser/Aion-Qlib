from contextlib import asynccontextmanager
import logging
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import traceback

# --- Logging setup ---
# Configured BEFORE any `app.*` import so even import-time logs (e.g. the tracing
# provider resolution in app.services.langsmith) are captured.
# Capture the WHOLE `app.*` logger tree (not a brittle per-module allowlist) so any
# module's logs are recorded — a swallowed error in e.g. metadata/ingestion must
# leave a trace somewhere. Detailed DEBUG goes to backend/debug-pipeline.log; INFO+
# also goes to stderr so it lands in logs/backend.log alongside uvicorn output.
_log_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_debug_log_path = os.path.join(_log_dir, "debug-pipeline.log")

_log_formatter = logging.Formatter(
    "%(asctime)s [%(name)s] %(levelname)s  %(message)s",
    datefmt="%H:%M:%S",
)

_file_handler = logging.FileHandler(_debug_log_path, mode="w", encoding="utf-8")
_file_handler.setLevel(logging.DEBUG)
_file_handler.setFormatter(_log_formatter)

_stream_handler = logging.StreamHandler()  # stderr -> logs/backend.log
_stream_handler.setLevel(logging.INFO)
_stream_handler.setFormatter(_log_formatter)

# Attach handlers once to the shared `app` ancestor; every `app.*` module propagates
# up to it. propagate=False stops records reaching the root/uvicorn config and being
# emitted twice. Guard against duplicate handlers on accidental re-import.
_app_logger = logging.getLogger("app")
_app_logger.setLevel(logging.DEBUG)
if not _app_logger.handlers:
    _app_logger.addHandler(_file_handler)
    _app_logger.addHandler(_stream_handler)
_app_logger.propagate = False

logger = logging.getLogger(__name__)

from app.config import get_settings  # noqa: E402
from app.routers import auth, threads, chat, documents, folders, skills, sandbox, bridge, workspace, harness, citations  # noqa: E402
from app.routers import settings as settings_router  # noqa: E402

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup — warm up Presidio so first request isn't slow
    if settings.pii_redaction_enabled:
        logger.info("Warming up Presidio AnalyzerEngine...")
        from app.services.redaction_service import get_analyzer_engine
        get_analyzer_engine()
        logger.info("Presidio AnalyzerEngine ready")
    else:
        logger.info("PII redaction disabled, skipping Presidio warmup")
    # Register native tools in unified registry when enabled
    if settings.tool_registry_enabled:
        from app.services.llm_service import register_native_tools
        register_native_tools()
        logger.info("Tool registry initialized")

    # Connect to MCP servers when configured
    if settings.tool_registry_enabled and settings.mcp_servers:
        from app.services.mcp_client import get_mcp_client_manager
        mcp_manager = get_mcp_client_manager()
        await mcp_manager.initialize(settings.mcp_servers)
        logger.info("MCP client manager initialized")

    # Start sandbox session cleanup loop if enabled
    if settings.sandbox_enabled:
        from app.services.sandbox_session_manager import get_session_manager
        await get_session_manager().start_cleanup_loop()
        logger.info("Sandbox session manager started")
    yield
    # Shutdown sandbox sessions
    if settings.sandbox_enabled:
        from app.services.sandbox_session_manager import get_session_manager
        await get_session_manager().shutdown()
    from app.services.ingestion_service import shutdown_ingestion_resources
    shutdown_ingestion_resources()
    # Shutdown MCP connections
    if settings.tool_registry_enabled and settings.mcp_servers:
        from app.services.mcp_client import get_mcp_client_manager
        await get_mcp_client_manager().shutdown()
    # Flush any pending tracing data on shutdown
    from app.services.langsmith import flush_tracing
    flush_tracing()


app = FastAPI(
    title="AI Agent Platform API",
    description="Backend API for the Full Stack AI Agent Platform",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    """Set baseline security headers on every response."""
    response = await call_next(request)
    # Stop browsers MIME-sniffing responses into executable types — defends the
    # API origin against an uploaded file being interpreted as HTML/JS.
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    return response


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Catch all unhandled exceptions and return proper JSON response with CORS headers."""
    print(f"Unhandled exception: {exc}")
    traceback.print_exc()

    # Get the origin from the request to return proper CORS headers
    origin = request.headers.get("origin", "")
    headers = {}
    if origin in settings.cors_origins or "*" in settings.cors_origins:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"

    return JSONResponse(
        status_code=500,
        content={"detail": f"Internal server error: {str(exc)}"},
        headers=headers
    )


@app.get("/health")
async def health_check():
    return {"status": "ok"}


@app.get("/settings/public")
async def public_settings():
    return {"context_window": settings.llm_context_window}


# Include routers
app.include_router(auth.router)
app.include_router(threads.router)
app.include_router(chat.router)
app.include_router(documents.router)
app.include_router(folders.router)
app.include_router(skills.router)
app.include_router(sandbox.router)
app.include_router(bridge.router)
app.include_router(settings_router.router)
app.include_router(workspace.router)
app.include_router(harness.router)
app.include_router(citations.router)
