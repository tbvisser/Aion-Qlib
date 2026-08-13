"""One HTTP client for the four Vibe providers.

Kept together because the auth header, the timeout and the failure mode are the
same for all of them, and because a reader wondering "how does the roster reach
the sidecar" should find one answer rather than four.

The header duplicates ``routers/vibe.py``'s ``_auth_headers`` rather than
importing it: a provider reaching into a router for a private helper is the
wrong direction, and this is two lines. If the scheme ever changes, both sites
change -- the sidecar rejects non-loopback callers without it, so a mismatch
fails loudly on the first request rather than silently returning less.
"""
from __future__ import annotations

from typing import Any

import httpx

#: The sidecar builds its skill loader and swarm preset list by scanning the
#: package on first call, which is slow exactly once per sidecar process.
TIMEOUT = httpx.Timeout(60.0, connect=5.0)


def auth_headers(settings: Any) -> dict[str, str]:
    token = settings.vibe_api_token
    return {"Authorization": f"Bearer {token}"} if token else {}


def get_json(settings: Any, path: str, **params: Any) -> Any:
    """GET a sidecar path and return parsed JSON, or raise.

    Raises on a non-JSON body as well as on a bad status. That case is real and
    would otherwise be silent: the sidecar serves its own SPA as a catch-all, so
    a path it does not route answers **200 with `index.html`**. A provider that
    trusted the status code would treat a missing endpoint as an empty
    collection.
    """
    with httpx.Client(timeout=TIMEOUT) as client:
        response = client.get(
            f"{settings.vibe_api_url}/{path}",
            params=params or None,
            headers=auth_headers(settings),
        )
    response.raise_for_status()

    content_type = response.headers.get("content-type", "")
    if not content_type.startswith("application/json"):
        raise RuntimeError(
            f"vibe /{path} answered {content_type or 'no content-type'} rather than JSON -- "
            f"the sidecar serves its SPA for unrouted paths, so this endpoint most likely "
            f"does not exist on the deployed version")
    return response.json()
