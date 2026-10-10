"""Shared HTTP client: identifying User-Agent, timeouts, retries with backoff and a polite delay.

Every network call in the scraper goes through ``HttpClient`` so these rules hold everywhere.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any

import requests

from . import __version__

log = logging.getLogger(__name__)

RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
DEFAULT_TIMEOUT = 30.0


def user_agent() -> str:
    """Descriptive UA. In GitHub Actions it names the repository so operators can reach the owner."""
    repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
    contact = f"+https://github.com/{repo}" if repo else "+https://github.com/lcintron/sams-garage"
    return f"SAMs-Garage/{__version__} ({contact}; SBIR/STTR opportunity index; data refresh bot)"


class HttpError(RuntimeError):
    """Raised when a request still fails after all retries."""


class HttpClient:
    """A ``requests.Session`` wrapper that retries transient failures and spaces out requests.

    ``delay`` is the minimum gap between the *starts* of two requests across all threads, so a pool of
    workers cannot hammer a host. Thread-safe.
    """

    def __init__(
        self,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        retries: int = 3,
        backoff: float = 1.5,
        delay: float = 0.0,
        session: requests.Session | None = None,
    ) -> None:
        self.timeout = timeout
        self.retries = max(1, retries)
        self.backoff = backoff
        self.delay = max(0.0, delay)
        self.session = session or requests.Session()
        self.session.headers.update({"User-Agent": user_agent(), "Accept-Language": "en-US,en;q=0.8"})
        self._lock = threading.Lock()
        self._next_slot = 0.0

    def get(self, url: str, *, params: dict[str, Any] | None = None, accept: str | None = None) -> requests.Response:
        headers = {"Accept": accept} if accept else None
        return self._request("GET", url, params=params, headers=headers)

    def get_text(self, url: str, *, params: dict[str, Any] | None = None) -> str:
        response = self.get(url, params=params, accept="text/html,application/xhtml+xml;q=0.9,*/*;q=0.8")
        response.encoding = response.encoding or "utf-8"
        return response.text

    def get_json(self, url: str, *, params: dict[str, Any] | None = None) -> Any:
        return self._json(self.get(url, params=params, accept="application/json"))

    def post_json(self, url: str, payload: dict[str, Any]) -> Any:
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        return self._json(self._request("POST", url, json=payload, headers=headers))

    def _json(self, response: requests.Response) -> Any:
        try:
            return response.json()
        except ValueError as exc:
            raise HttpError(f"{response.request.method} {response.url}: response is not JSON") from exc

    def _wait_turn(self) -> None:
        """Block until this thread may start a request (global spacing of ``delay`` seconds)."""
        if self.delay <= 0:
            return
        with self._lock:
            now = time.monotonic()
            start = max(now, self._next_slot)
            self._next_slot = start + self.delay
        if start > now:
            time.sleep(start - now)

    def _request(self, method: str, url: str, **kwargs: Any) -> requests.Response:
        last_error: str = ""
        attempts = 0
        for attempt in range(1, self.retries + 1):
            attempts = attempt
            self._wait_turn()
            try:
                response = self.session.request(method, url, timeout=self.timeout, **kwargs)
            except requests.RequestException as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                retry_after = None
            else:
                if response.status_code < 400:
                    return response
                last_error = f"HTTP {response.status_code}"
                if response.status_code not in RETRY_STATUSES:
                    break
                retry_after = _retry_after_seconds(response)
            if attempt < self.retries:
                pause = retry_after if retry_after is not None else self.backoff * (2 ** (attempt - 1))
                log.debug("retrying %s %s in %.1fs (%s)", method, url, pause, last_error)
                time.sleep(min(pause, 60.0))
        raise HttpError(f"{method} {url} failed after {attempts} attempt(s): {last_error}")


def _retry_after_seconds(response: requests.Response) -> float | None:
    value = response.headers.get("Retry-After", "")
    try:
        return max(0.0, float(value))
    except ValueError:
        return None
