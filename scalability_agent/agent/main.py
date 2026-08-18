"""Process entrypoint: ``python -m scalability_agent.agent.main``.

Starts the worker pool, a lease-reaper thread, and a minimal ``/health``
HTTP server (stdlib only -- the service has no other inbound surface, and a
framework would be dead weight for one endpoint). Handles SIGTERM/SIGINT so
``docker stop`` drains cleanly: workers finish their current poll cycle, the
pool closes, and the process exits 0.
"""
from __future__ import annotations

import json
import logging
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import db
from .config import get_settings
from .worker import WorkerPool

log = logging.getLogger(__name__)


class _HealthHandler(BaseHTTPRequestHandler):
    """One endpoint: GET /health reports process and database liveness."""

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        if self.path.split("?")[0] != "/health":
            self.send_error(404)
            return
        db_health = db.health()
        body = json.dumps({"ok": db_health["ok"], "service": "scalability-agent", "db": db_health}).encode()
        self.send_response(200 if db_health["ok"] else 503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        # Health checks fire constantly; keep them out of the job logs.
        pass


def _reaper_loop(stop: threading.Event, interval: float) -> None:
    """Periodically return jobs with expired leases to the queue."""
    while not stop.wait(timeout=interval):
        try:
            reaped = db.reap_expired_leases()
            if reaped:
                log.warning("reaped %d job(s) with expired leases", reaped)
        except Exception:  # noqa: BLE001 - the reaper must never die
            log.exception("lease reaper tick failed")


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    settings = get_settings()
    stop = threading.Event()

    pool = WorkerPool()
    pool.start()

    # Reap often enough that a crashed worker's job is retried well inside a
    # human's patience, rarely enough that the UPDATE is free on an idle queue.
    reaper_interval = max(5.0, settings.agent_lease_seconds / 2)
    reaper = threading.Thread(
        target=_reaper_loop,
        args=(stop, reaper_interval),
        name="lease-reaper",
        daemon=True,
    )
    reaper.start()

    server = ThreadingHTTPServer(("0.0.0.0", settings.agent_port), _HealthHandler)
    httpd = threading.Thread(target=server.serve_forever, name="health-http", daemon=True)
    httpd.start()
    log.info("health endpoint listening on :%d/health", settings.agent_port)

    def _handle_signal(signum: int, _frame: object) -> None:
        log.info("received signal %d; shutting down", signum)
        stop.set()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    while not stop.wait(timeout=1.0):
        pass

    pool.stop()
    server.shutdown()
    server.server_close()
    db.close_pool()
    log.info("scalability agent stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
