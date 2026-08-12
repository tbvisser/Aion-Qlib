"""Session manager for persistent sandbox containers."""
import asyncio
import hmac
import logging
import time
import threading
import uuid
from dataclasses import dataclass, field
from typing import Optional

from llm_sandbox import SandboxSession
from llm_sandbox.core.session_base import BaseSession

from app.config import get_settings
from app.services.sandbox_security import get_python_security_policy

logger = logging.getLogger(__name__)


@dataclass
class ManagedSession:
    session: BaseSession
    thread_id: str
    user_id: str
    session_token: str = field(default_factory=lambda: str(uuid.uuid4()))
    created_at: float = field(default_factory=time.time)
    last_used_at: float = field(default_factory=time.time)

    def touch(self):
        self.last_used_at = time.time()

    def is_expired(self, ttl_seconds: int) -> bool:
        return (time.time() - self.last_used_at) > ttl_seconds


class SandboxSessionManager:
    """Manages persistent sandbox sessions keyed by thread_id."""

    def __init__(self):
        self._sessions: dict[str, ManagedSession] = {}
        self._lock = threading.Lock()
        self._cleanup_task: Optional[asyncio.Task] = None
        self._settings = get_settings()

    async def get_or_create_session(
        self, thread_id: str, user_id: str
    ) -> ManagedSession:
        key = thread_id

        with self._lock:
            if key in self._sessions:
                managed = self._sessions[key]
                if managed.user_id != user_id:
                    raise RuntimeError("Thread belongs to a different user")
                managed.touch()
                return managed

        # Create outside the lock (slow operation)
        settings = self._settings
        image = settings.sandbox_container_image
        security_policy = get_python_security_policy()

        # Generate session token for bridge auth
        session_token = str(uuid.uuid4())

        # Build runtime_configs with bridge environment variables
        runtime_configs = None
        if settings.tool_registry_enabled:
            runtime_configs = {
                "environment": {
                    "BRIDGE_URL": "http://host.docker.internal:8001",
                    "BRIDGE_TOKEN": session_token,
                },
            }

        logger.info(f"Creating sandbox session: thread={thread_id}, image={image}")

        loop = asyncio.get_running_loop()
        session = await loop.run_in_executor(
            None, self._create_session, image, security_policy, settings.sandbox_max_execution_time, runtime_configs
        )

        managed = ManagedSession(
            session=session,
            thread_id=thread_id,
            user_id=user_id,
            session_token=session_token,
        )

        # Double-check after lock re-acquisition — no awaits inside lock
        should_close_new = False
        existing_managed = None
        over_limit = False
        with self._lock:
            if key in self._sessions:
                should_close_new = True
                existing_managed = self._sessions[key]
                if existing_managed.user_id != user_id:
                    raise RuntimeError("Thread belongs to a different user")
                existing_managed.touch()
            else:
                user_sessions = sum(
                    1 for s in self._sessions.values() if s.user_id == user_id
                )
                if user_sessions >= settings.sandbox_max_concurrent_sessions:
                    should_close_new = True
                    over_limit = True
                else:
                    self._sessions[key] = managed
                    logger.info(f"Sandbox session created: key={key}, total_sessions={len(self._sessions)}")

        if should_close_new:
            try:
                await loop.run_in_executor(None, session.close)
            except Exception:
                pass
            if over_limit:
                raise RuntimeError(
                    f"Maximum concurrent sandbox sessions ({settings.sandbox_max_concurrent_sessions}) reached. "
                    "Close an existing thread or wait for session timeout."
                )
            return existing_managed

        return managed

    def validate_session_token(self, token: str) -> Optional[ManagedSession]:
        with self._lock:
            for managed in self._sessions.values():
                if hmac.compare_digest(managed.session_token, token):
                    ttl = self._settings.bridge_session_token_ttl_minutes * 60
                    if not managed.is_expired(ttl):
                        managed.touch()
                        return managed
        return None

    def _create_session(self, image: str, security_policy, timeout: int, runtime_configs: dict | None = None) -> BaseSession:
        kwargs: dict = {
            "image": image,
            "lang": "python",
            "verbose": False,
            "security_policy": security_policy,
            "execution_timeout": timeout,
        }
        if runtime_configs:
            kwargs["runtime_configs"] = runtime_configs
        session = SandboxSession(**kwargs)
        session.open()
        return session

    async def close_session(self, thread_id: str):
        key = thread_id
        with self._lock:
            managed = self._sessions.pop(key, None)

        if managed:
            loop = asyncio.get_running_loop()
            try:
                await loop.run_in_executor(None, managed.session.close)
                logger.info(f"Sandbox session closed: key={key}")
            except Exception as e:
                logger.warning(f"Error closing sandbox session {key}: {e}")

    async def cleanup_expired(self):
        ttl_seconds = self._settings.sandbox_session_ttl_minutes * 60
        expired_sessions: list[tuple[str, ManagedSession]] = []

        with self._lock:
            expired_keys = [key for key, m in self._sessions.items() if m.is_expired(ttl_seconds)]
            for key in expired_keys:
                managed = self._sessions.pop(key, None)
                if managed:
                    expired_sessions.append((key, managed))

        for key, managed in expired_sessions:
            if managed:
                loop = asyncio.get_running_loop()
                try:
                    await loop.run_in_executor(None, managed.session.close)
                    logger.info(f"Expired sandbox session cleaned up: key={key}")
                except Exception as e:
                    logger.warning(f"Error cleaning up expired session {key}: {e}")

    async def start_cleanup_loop(self):
        async def _loop():
            while True:
                await asyncio.sleep(60)
                try:
                    await self.cleanup_expired()
                except Exception as e:
                    logger.error(f"Sandbox cleanup error: {e}")

        self._cleanup_task = asyncio.create_task(_loop())
        logger.info("Sandbox session cleanup loop started")

    async def shutdown(self):
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass

        # Close all sessions
        keys = list(self._sessions.keys())
        for key in keys:
            with self._lock:
                managed = self._sessions.pop(key, None)
            if managed:
                loop = asyncio.get_running_loop()
                try:
                    await loop.run_in_executor(None, managed.session.close)
                except Exception:
                    pass
        logger.info("All sandbox sessions shut down")


# Singleton with thread-safe initialization
_manager: Optional[SandboxSessionManager] = None
_manager_lock = threading.Lock()


def get_session_manager() -> SandboxSessionManager:
    global _manager
    if _manager is None:
        with _manager_lock:
            if _manager is None:
                _manager = SandboxSessionManager()
    return _manager
