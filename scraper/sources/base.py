"""Types shared by every source module.

A source module exposes ``NAME`` and ``scrape(client, options) -> SourceResult`` plus pure parsing
functions (tested against saved fixtures). ``scrape`` must never raise for an expected failure: it
returns ``SourceResult(ok=False, error=...)`` when the source failed entirely, so merge can leave that
source's records untouched (PLAN.md section 4, lifecycle rule 3).
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import date
from typing import Callable, Iterable, TypeVar

from ..model import Record

T = TypeVar("T")
R = TypeVar("R")

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ScrapeOptions:
    """Knobs from the CLI. ``limit`` caps records per source (debug runs); ``today`` is injected for tests."""

    today: date
    limit: int | None = None
    workers: int = 8
    delay: float = 0.2


@dataclass
class SourceResult:
    """What one source produced this run.

    ok        -- False only when the source failed entirely (nothing usable was fetched).
    complete  -- True when ``records`` is everything the source currently lists (no --limit, no aborted
                 paging). Only complete results may mark absent records missing/closed.
    partial_ids -- records built without their detail payload (detail fetch failed); merge keeps the
                 previous content for these instead of churning to listing-only data.
    """

    source: str
    ok: bool
    complete: bool = False
    records: list[Record] = field(default_factory=list)
    partial_ids: set[str] = field(default_factory=set)
    fetched: int = 0
    failed: int = 0
    error: str | None = None


def parallel_map(func: Callable[[T], R], items: Iterable[T], workers: int) -> list[tuple[T, R | None, Exception | None]]:
    """Run ``func`` over ``items`` on a thread pool; returns (item, result, error) in input order."""
    item_list = list(items)
    results: list[tuple[T, R | None, Exception | None]] = [(item, None, None) for item in item_list]
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {pool.submit(func, item): index for index, item in enumerate(item_list)}
        for future in as_completed(futures):
            index = futures[future]
            try:
                results[index] = (item_list[index], future.result(), None)
            except Exception as exc:  # noqa: BLE001 - one bad item must not stop the source
                results[index] = (item_list[index], None, exc)
    return results
