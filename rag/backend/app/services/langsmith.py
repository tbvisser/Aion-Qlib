"""Unified tracing facade - dispatches to LangSmith, Langfuse, or no-op.

All exports keep the same names and signatures regardless of backend,
so importing files need zero changes.

Exports:
    traceable   - decorator for tracing functions
    trace       - context manager for wrapping a block of code
    is_tracing_enabled  - check if any tracing is active
    get_traced_openai_client       - sync OpenAI client with tracing
    get_traced_async_openai_client - async OpenAI client with tracing
    flush_tracing                  - flush pending trace data
"""
import os
import logging
import functools
import inspect

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

# Suppress noisy OTel context detach errors (cosmetic — happen when async
# generators are cleaned up across different async contexts)
logging.getLogger("opentelemetry.context").setLevel(logging.CRITICAL)


# ---------------------------------------------------------------------------
# Provider resolution
# ---------------------------------------------------------------------------
def _resolve_provider() -> str:
    explicit = (settings.tracing_provider or "").strip().lower()
    if explicit in ("langsmith", "langfuse"):
        return explicit
    # Backward compat: auto-select LangSmith when its key is present
    if settings.langsmith_api_key:
        return "langsmith"
    return "none"


_PROVIDER = _resolve_provider()
logger.info(f"Tracing provider resolved: {_PROVIDER}")


# ===================================================================
# LangSmith
# ===================================================================
if _PROVIDER == "langsmith":
    # Set env vars BEFORE importing langsmith
    os.environ["LANGSMITH_TRACING"] = "true"
    os.environ["LANGSMITH_API_KEY"] = settings.langsmith_api_key
    os.environ["LANGSMITH_PROJECT"] = settings.langsmith_project
    os.environ["LANGSMITH_ENDPOINT"] = "https://api.smith.langchain.com"

    import langsmith  # noqa: E402
    from langsmith.wrappers import wrap_openai  # noqa: E402
    from langsmith.run_helpers import traceable, trace  # noqa: E402, F401
    from openai import OpenAI, AsyncOpenAI  # noqa: E402

    api_key_preview = (
        settings.langsmith_api_key[:8] + "..."
        if len(settings.langsmith_api_key) > 8
        else "***"
    )
    logger.info(f"LangSmith SDK version: {langsmith.__version__}")
    logger.info(f"LangSmith project: {settings.langsmith_project}")
    logger.info(f"LangSmith endpoint: {os.environ.get('LANGSMITH_ENDPOINT')}")
    logger.info(f"LangSmith API key: {api_key_preview}")

    def is_tracing_enabled() -> bool:
        return True

    def get_traced_openai_client(
        base_url: str | None = None, api_key: str | None = None
    ) -> OpenAI:
        client = OpenAI(api_key=api_key, base_url=base_url or None)
        wrapped = wrap_openai(client)
        logger.info(f"OpenAI client wrapped with LangSmith tracing (base_url={base_url})")
        return wrapped

    def get_traced_async_openai_client(
        base_url: str | None = None, api_key: str | None = None
    ) -> AsyncOpenAI:
        client = AsyncOpenAI(api_key=api_key, base_url=base_url or None)
        wrapped = wrap_openai(client)
        logger.info(f"AsyncOpenAI client wrapped with LangSmith tracing (base_url={base_url})")
        return wrapped

    def flush_tracing():
        """LangSmith auto-flushes; nothing to do."""
        pass


# ===================================================================
# Langfuse
# ===================================================================
elif _PROVIDER == "langfuse":
    # Set env vars so the Langfuse SDK auto-initializes correctly
    os.environ["LANGFUSE_PUBLIC_KEY"] = settings.langfuse_public_key
    os.environ["LANGFUSE_SECRET_KEY"] = settings.langfuse_secret_key
    os.environ["LANGFUSE_HOST"] = settings.langfuse_host

    from langfuse import Langfuse, observe, propagate_attributes  # noqa: E402
    from langfuse.openai import (  # noqa: E402
        OpenAI as LfOpenAI,
        AsyncOpenAI as LfAsyncOpenAI,
    )
    from openai import OpenAI, AsyncOpenAI  # noqa: E402

    # Explicit client instance for flush() and manual trace/span creation
    _langfuse = Langfuse()

    logger.info(f"Langfuse tracing enabled (host={settings.langfuse_host})")

    # LangSmith run_type -> Langfuse observation type
    # llm/embedding -> "generation"; everything else maps to its own type
    _RUN_TYPE_MAP = {
        "llm": "generation",
        "embedding": "embedding",
        "chain": "chain",
        "tool": "tool",
        "retriever": "retriever",
    }

    # -- traceable decorator ------------------------------------------------

    def traceable(name=None, run_type="chain", reduce_fn=None, tags=None):
        """Drop-in replacement for langsmith.traceable, backed by Langfuse."""
        lf_type = _RUN_TYPE_MAP.get(run_type, "span")

        def decorator(fn):
            if inspect.isasyncgenfunction(fn):
                # Langfuse @observe has a known bug with async generators,
                # so we wrap them manually using start_as_current_observation
                # which properly sets the context for child spans.
                @functools.wraps(fn)
                async def wrapper(*args, **kwargs):
                    cm = _langfuse.start_as_current_observation(
                        name=name or fn.__name__,
                        as_type=lf_type,
                        metadata={"run_type": run_type, "tags": tags} if tags else {"run_type": run_type},
                    )
                    span = cm.__enter__()
                    events = []
                    span_closed = False
                    try:
                        async for event in fn(*args, **kwargs):
                            events.append(event)
                            yield event
                        if reduce_fn and events:
                            output = reduce_fn(events)
                            span.update(output=output)
                    except GeneratorExit:
                        # Client disconnected or generator abandoned — end span
                        # cleanly BEFORE returning to avoid OTel context errors
                        if reduce_fn and events:
                            try:
                                output = reduce_fn(events)
                                span.update(output=output)
                            except Exception:
                                pass
                        try:
                            cm.__exit__(None, None, None)
                        except (ValueError, Exception):
                            pass
                        span_closed = True
                        return  # Generator is done — clean exit
                    except Exception as e:
                        span.update(output={"error": str(e)}, level="ERROR")
                        raise
                    finally:
                        if not span_closed:
                            try:
                                cm.__exit__(None, None, None)
                            except ValueError:
                                pass  # OTel context token from different async context

                return wrapper
            else:
                # Regular sync/async functions - @observe handles them fine
                observed = observe(name=name, as_type=lf_type)(fn)
                if not tags:
                    return observed
                if inspect.iscoroutinefunction(fn):
                    @functools.wraps(fn)
                    async def wrapper(*args, **kwargs):
                        with propagate_attributes(tags=tags):
                            return await observed(*args, **kwargs)
                    return wrapper

                @functools.wraps(fn)
                def wrapper(*args, **kwargs):
                    with propagate_attributes(tags=tags):
                        return observed(*args, **kwargs)
                return wrapper

        return decorator

    # -- trace() context manager --------------------------------------------

    class _LangfuseTraceContext:
        """Compatibility adapter for LangSmith's trace() context manager.

        Used in chat.py to wrap the entire chat request in a single trace.
        Uses start_as_current_observation so child @observe calls and
        Langfuse OpenAI wrappers nest under this trace.
        """

        def __init__(self, name, run_type, inputs, tag_list):
            self._name = name
            self._inputs = inputs
            self._tags = tag_list or []
            self._cm = None
            self._span = None
            self._tags_cm = None

        async def __aenter__(self):
            self._cm = _langfuse.start_as_current_observation(
                name=self._name,
                as_type="chain",
                input=self._inputs,
            )
            self._span = self._cm.__enter__()
            # Propagate trace-level tags to this span and its children.
            # Langfuse v4 removed client.update_current_trace(); the v4 way to
            # set trace attributes (tags/user_id/session_id/...) is the
            # propagate_attributes() context manager, entered after the span is
            # active so child LLM spans inherit the tags.
            if self._tags:
                self._tags_cm = propagate_attributes(tags=self._tags)
                self._tags_cm.__enter__()
            return self

        @property
        def new_run(self):
            """Matches LangSmith's trace_ctx.new_run interface."""
            return self

        def add_outputs(self, outputs: dict):
            if self._span:
                self._span.update(output=outputs)

        async def __aexit__(self, exc_type, exc_val, exc_tb):
            if self._span and exc_type:
                self._span.update(
                    output={"error": str(exc_val)},
                    level="ERROR",
                )
            if self._tags_cm:
                try:
                    self._tags_cm.__exit__(exc_type, exc_val, exc_tb)
                except (ValueError, Exception):
                    pass  # OTel context token from different async context - harmless
            if self._cm:
                try:
                    self._cm.__exit__(exc_type, exc_val, exc_tb)
                except ValueError:
                    pass  # OTel context token from different async context - harmless

    def trace(name=None, run_type="chain", inputs=None, tags=None):
        return _LangfuseTraceContext(name, run_type, inputs, tags)

    # -- helpers ------------------------------------------------------------

    def is_tracing_enabled() -> bool:
        return True

    def get_traced_openai_client(
        base_url: str | None = None, api_key: str | None = None
    ) -> "LfOpenAI":
        return LfOpenAI(api_key=api_key, base_url=base_url or None)

    def get_traced_async_openai_client(
        base_url: str | None = None, api_key: str | None = None
    ) -> "LfAsyncOpenAI":
        return LfAsyncOpenAI(api_key=api_key, base_url=base_url or None)

    def flush_tracing():
        """Flush pending Langfuse events to the server."""
        _langfuse.flush()


# ===================================================================
# No-op (tracing disabled)
# ===================================================================
else:
    from openai import OpenAI, AsyncOpenAI  # noqa: E402

    logger.warning("Tracing disabled (no provider configured)")

    def traceable(name=None, run_type="chain", reduce_fn=None, tags=None):
        """No-op decorator - returns the original function unmodified."""
        def decorator(fn):
            return fn
        return decorator

    def trace(name=None, run_type="chain", inputs=None, tags=None):
        """Returns None - chat.py already guards with `if trace_ctx:`."""
        return None

    def is_tracing_enabled() -> bool:
        return False

    def get_traced_openai_client(
        base_url: str | None = None, api_key: str | None = None
    ) -> OpenAI:
        return OpenAI(api_key=api_key, base_url=base_url or None)

    def get_traced_async_openai_client(
        base_url: str | None = None, api_key: str | None = None
    ) -> AsyncOpenAI:
        return AsyncOpenAI(api_key=api_key, base_url=base_url or None)

    def flush_tracing():
        pass
