"""DoD SBIR/STTR Innovation Portal (DSIP, dodsbirsttr.mil). PLAN.md section 2.2.

Search is a GET with a URL-encoded JSON ``searchParam`` (POST returns a generic error). We fetch the
Open (591) and Pre-Release (592) topics in pages of 100, then ``/details`` for each topic.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any
from urllib.parse import quote

from ..http import HttpClient
from ..model import (
    Record,
    html_to_text,
    make_id,
    normalize_keywords,
    normalize_phases,
    normalize_program,
    one_line,
    split_keywords,
    to_iso_date,
)
from .base import ScrapeOptions, SourceResult, parallel_map

NAME = "dod_dsip"
API_BASE = "https://www.dodsbirsttr.mil/topics/api/public/topics"
APP_URL = "https://www.dodsbirsttr.mil/topics-app/"
PAGE_SIZE = 100
MAX_PAGES = 100

STATUS_OPEN = 591
STATUS_PRE_RELEASE = 592
STATUS_CLOSED = 593  # never fetched in the daily run (no historical backfill)

_STATUS_MAP = {"open": "open", "pre-release": "pre_release", "prerelease": "pre_release", "closed": "closed"}

log = logging.getLogger(__name__)


def search_url(page: int, statuses: tuple[int, ...] = (STATUS_OPEN, STATUS_PRE_RELEASE)) -> str:
    param = {
        "searchText": None,
        "components": None,
        "programYear": None,
        "solicitationCycleNames": None,
        "releaseNumbers": [],
        "topicReleaseStatus": list(statuses),
        "modernizationPriorities": [],
        "sortBy": "finalTopicCode,asc",
        "technologyAreaIds": [],
        "component": None,
        "program": None,
    }
    encoded = quote(json.dumps(param, separators=(",", ":")), safe="")
    return f"{API_BASE}/search?searchParam={encoded}&size={PAGE_SIZE}&page={page}"


def details_url(topic_id: str) -> str:
    return f"{API_BASE}/{quote(topic_id, safe='')}/details"


def pdf_url(topic_id: str) -> str:
    return f"{API_BASE}/{quote(topic_id, safe='')}/download/PDF"


def human_url(topic_code: str) -> str:
    """The DSIP topics app is an SPA with no per-topic deep link (``?searchText=`` is ignored and
    ``/topic-details/<id>`` 404s), so every topic links to the app root; ``links.official`` holds the
    topic's own PDF."""
    return APP_URL


def parse_search(payload: dict[str, Any]) -> tuple[list[dict[str, Any]], int]:
    """Search response -> (topic dicts, total)."""
    data = payload.get("data") or []
    return [item for item in data if isinstance(item, dict)], int(payload.get("total") or 0)


def parse_phases(phase_hierarchy: str | None) -> list[str]:
    """``phaseHierarchy`` is a JSON string: {"config": [{"phase": "1", "displayValue": "I", "hasConfiguration": "Y"}, ...]}."""
    if not phase_hierarchy:
        return []
    try:
        config = json.loads(phase_hierarchy).get("config") or []
    except (ValueError, AttributeError):
        return []
    phases = [
        item.get("displayValue") or item.get("phase")
        for item in config
        if isinstance(item, dict) and str(item.get("hasConfiguration", "Y")).upper() == "Y"
    ]
    return normalize_phases(phases)


def parse_year(topic: dict[str, Any]) -> int | None:
    match = re.search(r"(20\d{2})", str(topic.get("cycleName") or ""))
    if match:
        return int(match.group(1))
    match = re.match(r"^(\d{2})\.", str(topic.get("solicitationNumber") or ""))
    return 2000 + int(match.group(1)) if match else None


def build_description(details: dict[str, Any]) -> str | None:
    """Objective, description and per-phase guidance as plain-text sections."""
    sections = [
        ("Objective", details.get("objective")),
        ("Description", details.get("description")),
        ("Phase I", details.get("phase1Description")),
        ("Phase II", details.get("phase2Description")),
        ("Phase III Dual Use Applications", details.get("phase3Description")),
    ]
    parts = [f"{label}:\n{text}" for label, raw in sections if (text := html_to_text(raw))]
    references = [html_to_text(ref.get("referenceTitle")) for ref in details.get("referenceDocuments") or [] if isinstance(ref, dict)]
    references = [ref for ref in references if ref]
    if references:
        parts.append("References:\n" + "\n".join(f"• {ref}" for ref in references))
    return "\n\n".join(parts) or None


def _tpocs(topic: dict[str, Any]) -> list[dict[str, str]]:
    contacts: list[dict[str, str]] = []
    for manager in topic.get("topicManagers") or []:
        if not isinstance(manager, dict) or manager.get("assignmentType") != "TPOC":
            continue
        contact = {"name": one_line(manager.get("name"))}
        if str(manager.get("emailDisplay", "")).upper() == "Y" and manager.get("email"):
            contact["email"] = one_line(manager.get("email"))
        if contact["name"]:
            contacts.append(contact)
    return contacts[:3]


def build_record(topic: dict[str, Any], details: dict[str, Any] | None) -> Record:
    """Map one search hit (+ its /details payload when available) to a canonical Record."""
    details = details or {}
    code = one_line(topic.get("topicCode"))
    topic_id = one_line(topic.get("topicId"))
    status = _STATUS_MAP.get(one_line(topic.get("topicStatus")).casefold(), "unknown")
    technology_areas = [one_line(area) for area in details.get("technologyAreas") or [] if one_line(area)]
    focus_areas = [one_line(area) for area in details.get("focusAreas") or [] if one_line(area)]
    keywords = split_keywords(details.get("keywords"))  # tech/focus areas live in their own fields

    extra: dict[str, Any] = {
        "topic_id": topic_id,
        "cycle_name": topic.get("cycleName"),
        "release_number": topic.get("releaseNumber"),
        "command": topic.get("command"),
        "cmmc_level": topic.get("cmmcLevel") or details.get("cmmcLevel"),
        "itar": details.get("itar"),
        "focus_areas": focus_areas[:12],
        "tpoc": _tpocs(topic),
    }
    record = Record(
        id=make_id(NAME, code),
        source=NAME,
        links={"dod_dsip": human_url(code), "official": pdf_url(topic_id) if topic_id else None},
        title=one_line(topic.get("topicTitle")),
        agency="DOD",
        sub_agency=one_line(topic.get("component")).upper() or None,
        program=normalize_program([topic.get("program")]),
        phases=parse_phases(topic.get("phaseHierarchy")),
        topic_number=code or None,
        solicitation_number=one_line(topic.get("solicitationNumber")) or None,
        solicitation_title=one_line(topic.get("solicitationTitle")) or None,
        status=status,
        release_date=to_iso_date(topic.get("topicPreReleaseStartDate")),
        open_date=to_iso_date(topic.get("topicStartDate")),
        close_date=to_iso_date(topic.get("topicEndDate")),
        qa_open_date=to_iso_date(topic.get("topicQAStartDate")),
        qa_close_date=to_iso_date(topic.get("topicQAEndDate")),
        summary=html_to_text(details.get("objective")) or None,
        description=build_description(details),
        keywords=normalize_keywords(keywords),
        technology_areas=technology_areas,
        year=parse_year(topic),
        extra=extra,
    )
    return record.finalize()


def collect_topics(client: HttpClient, limit: int | None) -> tuple[list[dict[str, Any]], bool]:
    """Page through search results. Returns (topics, complete)."""
    topics: list[dict[str, Any]] = []
    seen: set[str] = set()
    total = 0
    for page in range(MAX_PAGES):
        page_topics, total = parse_search(client.get_json(search_url(page)))
        new = [t for t in page_topics if t.get("topicCode") and t["topicCode"] not in seen]
        for topic in new:
            seen.add(topic["topicCode"])
            topics.append(topic)
        log.info("dod_dsip: search page %d -> %d topics (%d of %d)", page, len(new), len(topics), total)
        if limit is not None and len(topics) >= limit:
            return topics[:limit], False
        if not page_topics or len(topics) >= total:
            break
    return topics, len(topics) >= total


def scrape(client: HttpClient, options: ScrapeOptions) -> SourceResult:
    try:
        topics, complete = collect_topics(client, options.limit)
    except Exception as exc:  # noqa: BLE001
        log.error("dod_dsip: search failed: %s", exc)
        return SourceResult(NAME, ok=False, error=str(exc))
    if not topics:
        return SourceResult(NAME, ok=False, error="search returned no topics")

    fetched = parallel_map(lambda topic: client.get_json(details_url(topic["topicId"])), topics, options.workers)
    records: list[Record] = []
    partial: set[str] = set()
    failed = 0
    for topic, details, error in fetched:
        if error is not None or not isinstance(details, dict):
            failed += 1
            log.warning("dod_dsip: details for %s failed: %s", topic.get("topicCode"), error)
            details = None
        record = build_record(topic, details)
        if details is None:
            partial.add(record.id)
        records.append(record)
    log.info("dod_dsip: %d topics, %d detail failures", len(records), failed)
    return SourceResult(
        NAME,
        ok=True,
        complete=complete and options.limit is None,
        records=records,
        partial_ids=partial,
        fetched=len(records),
        failed=failed,
    )
