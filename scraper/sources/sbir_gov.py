"""sbir.gov topics (all agencies, aggregated). PLAN.md section 2.1.

Ported from the original ``scrape_sbir_topics.py``: the listing/detail parsing below is that script's
logic turned into pure functions, adapted to produce canonical ``Record``s. Only ``status=Open`` is
scraped (sbir.gov lists DoD pre-release topics as "Open" with a future open date; those become
``pre_release`` here so they match DSIP).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any
from urllib.parse import parse_qs, urljoin, urlparse

from bs4 import BeautifulSoup
from bs4.element import Tag

from ..http import HttpClient
from ..model import (
    Record,
    clean_text,
    html_to_text,
    make_id,
    normalize_agency,
    normalize_program,
    one_line,
    snake_case_label,
    to_iso_date,
)
from .base import ScrapeOptions, SourceResult, parallel_map
from .nsf_enrich import enrich_nsf

NAME = "sbir_gov"
BASE_URL = "https://www.sbir.gov"
TOPICS_URL = f"{BASE_URL}/topics"
MAX_PAGES = 200  # safety stop; 10 topics per page
MAX_PASSES = 6  # listing re-walks to defeat the unstable sort (see collect_listing)

log = logging.getLogger(__name__)

# Labels the detail page shows that already map to Record fields (or are boilerplate) -> not kept in extra.
_KNOWN_LABELS = {
    "note",
    "year",
    "topic_number",
    "solicitation_number",
    "release_date",
    "open_date",
    "due_date_s",
    "due_dates",
    "close_date",
    "solicitation_status",
}


@dataclass(frozen=True)
class ListingTopic:
    """One hit on a listing page."""

    url: str
    title: str
    status: str | None
    summary: str | None
    release_date: str | None
    open_date: str | None
    close_date: str | None
    tags: list[str] = field(default_factory=list)
    agency: str | None = None

    @property
    def native_id(self) -> str:
        return self.url.rstrip("/").rsplit("/", 1)[-1]


# --------------------------------------------------------------------------------------------------
# Listing
# --------------------------------------------------------------------------------------------------


def listing_url(page: int, status: str = "Open") -> str:
    return f"{TOPICS_URL}?status={status}&page={page}"


def parse_listing(markup: str) -> tuple[list[ListingTopic], bool, int | None]:
    """Parse one listing page -> (topics, has_next_page, total result count if shown)."""
    soup = BeautifulSoup(markup, "html.parser")
    results = soup.find(id="search-results-hits") or soup
    topics: list[ListingTopic] = []
    for heading in results.find_all("h3"):
        link = heading.find("a", href=re.compile(r"^/topics/\d+"))
        if not link:
            continue
        schedule = heading.find_next_sibling("p")
        status = _first_badge_text(schedule)
        if status and status.casefold() == "closed":
            continue
        content = schedule.find_next_sibling("div") if schedule else None
        seal = content.find("img", alt=re.compile(r"Seal of the Agency", re.IGNORECASE)) if content else None
        topics.append(
            ListingTopic(
                url=urljoin(BASE_URL, link["href"]),
                title=clean_text(link.get_text(" ", strip=True)),
                status=status,
                summary=_listing_summary(content),
                release_date=_date_after_label(schedule, "Release Date"),
                open_date=_date_after_label(schedule, "Open Date"),
                close_date=_date_after_label(schedule, "Close Date"),
                tags=_tags(content),
                agency=_seal_agency(seal),
            )
        )
    return topics, _has_next_page(soup), _total_results(soup)


def _has_next_page(soup: BeautifulSoup) -> bool:
    current = _current_page(soup)
    for link in soup.find_all("a", href=True):
        href = str(link["href"])
        if "page=" not in href:
            continue
        text = clean_text(link.get_text(" ", strip=True)).casefold()
        title = clean_text(link.get("title", "")).casefold()
        if text in {"next", "next page", ">"} or "next" in title:
            return True
        query = parse_qs(urlparse(href).query)
        if any(value.isdigit() and int(value) > current for value in query.get("page", [])):
            return True
    return False


def _current_page(soup: BeautifulSoup) -> int:
    marker = soup.find(string=re.compile(r"Current page", re.IGNORECASE))
    link = marker.find_parent("a") if marker else None
    if isinstance(link, Tag) and link.get("href"):
        pages = parse_qs(urlparse(str(link["href"])).query).get("page", [])
        if pages and pages[0].isdigit():
            return int(pages[0])
    return 0


def _total_results(soup: BeautifulSoup) -> int | None:
    match = re.search(r"Showing\s+\d+\s*-\s*\d+\s+of\s+([\d,]+)\s+results", soup.get_text(" ", strip=True))
    return int(match.group(1).replace(",", "")) if match else None


def _first_badge_text(root: Tag | None) -> str | None:
    if not root:
        return None
    badge = root.find("span") or root.find(class_=re.compile(r"\bbg-green\b|\bbg-base\b"))
    return clean_text(badge.get_text(" ", strip=True)) if badge else None


def _date_after_label(root: Tag | None, label: str) -> str | None:
    if not root:
        return None
    text = clean_text(root.get_text(" ", strip=True))
    match = re.search(
        rf"{re.escape(label)}:\s*(.*?)(?=\s+(?:Release Date|Open Date|Close Date):|$)",
        text,
        flags=re.IGNORECASE,
    )
    return clean_text(match.group(1)) if match else None


def _listing_summary(root: Tag | None) -> str | None:
    if not root:
        return None
    for paragraph in root.find_all("p"):
        if "usa-sr-only" in paragraph.get("class", []):
            continue
        text = clean_text(paragraph.get_text(" ", strip=True))
        if text and text.lower() != "tagged as:":
            return text
    return None


def _tags(root: Tag | None) -> list[str]:
    if not root:
        return []
    tags: list[str] = []
    sr_only = root.find(string=re.compile(r"Tagged as:", re.IGNORECASE))
    parent = sr_only.parent if sr_only is not None else None
    container = parent.parent if isinstance(parent, Tag) and isinstance(parent.parent, Tag) else None
    if container:
        for tag in container.find_all("p"):
            if "usa-sr-only" in tag.get("class", []):
                continue
            text = clean_text(tag.get_text(" ", strip=True))
            if text and text.casefold() not in {t.casefold() for t in tags}:
                tags.append(text)
    return tags


def _seal_agency(seal: Tag | None) -> str | None:
    if not seal:
        return None
    match = re.search(r"Seal of the Agency:\s*(.+)$", str(seal.get("alt", "")), re.IGNORECASE)
    return clean_text(match.group(1)) if match else None


# --------------------------------------------------------------------------------------------------
# Detail
# --------------------------------------------------------------------------------------------------


def parse_detail(markup: str) -> dict[str, Any]:
    """Parse a topic detail page into a flat dict of raw strings (dates still human-formatted)."""
    soup = BeautifulSoup(markup, "html.parser")
    main = soup.find("main") or soup
    agency_lines = _funding_agency_lines(main)
    data: dict[str, Any] = {
        "title": _detail_title(main),
        "status": _status(main),
        "agency": agency_lines[0] if agency_lines else None,
        "sub_agency": agency_lines[1] if len(agency_lines) > 1 else None,
        "year": _labeled_value(main, "Year"),
        "topic_number": _labeled_value(main, "Topic Number"),
        "solicitation_number": _labeled_value(main, "Solicitation Number"),
        "release_schedule": _release_schedule(main),
        "official_solicitation_url": _official_solicitation_url(main),
        "tags": _tags(main),
        "description": _description(main),
    }
    data["extra_fields"] = _extra_labeled_fields(main, data)
    return data


def _detail_title(root: Tag) -> str | None:
    for heading in root.find_all(["h1", "h2"]):
        text = clean_text(heading.get_text(" ", strip=True))
        if text and text not in {"Topic", "Release Schedule", "Description"}:
            return text
    return None


def _funding_agency_lines(root: Tag) -> list[str]:
    heading = root.find(lambda tag: tag.name in {"h2", "h3", "h4"} and clean_text(tag.get_text()) == "Funding Agency")
    if not heading:
        return []
    lines: list[str] = []
    for paragraph in heading.find_next_siblings("p"):
        text = clean_text(paragraph.get_text(" ", strip=True))
        if text:
            lines.append(text)
    if not lines:  # fall back to the original script's behaviour: the next <p> anywhere
        paragraph = heading.find_next("p")
        if paragraph:
            lines.append(clean_text(paragraph.get_text(" ", strip=True)))
    return lines


def _status(root: Tag) -> str | None:
    text = clean_text(root.get_text(" ", strip=True))
    match = re.search(r"Solicitation Status:\s*(Open|Closed|Future|Upcoming)", text, re.IGNORECASE)
    if match:
        return match.group(1)
    label = root.find(string=re.compile(r"Solicitation Status:", re.IGNORECASE))
    parent = label.parent if label is not None and isinstance(label.parent, Tag) else None
    return _first_badge_text(parent)


def _labeled_value(root: Tag, label: str) -> str | None:
    strong = root.find("strong", string=re.compile(rf"^\s*{re.escape(label)}:\s*$", re.IGNORECASE))
    if strong and strong.parent:
        value = clean_text(strong.parent.get_text(" ", strip=True))
        return clean_text(re.sub(rf"^{re.escape(label)}:\s*", "", value, flags=re.IGNORECASE)) or None
    text = clean_text(root.get_text(" ", strip=True))
    match = re.search(rf"{re.escape(label)}:\s*([^|]+?)(?:\s{{2,}}|$)", text, re.IGNORECASE)
    return clean_text(match.group(1)) if match else None


def _section_after_heading(root: Tag, heading_text: str) -> Tag | None:
    heading = root.find(
        lambda tag: tag.name in {"h2", "h3"} and heading_text.casefold() in clean_text(tag.get_text()).casefold()
    )
    if not heading:
        return None
    section = heading.find_parent("section")
    return section if isinstance(section, Tag) else None


def _release_schedule(root: Tag) -> dict[str, str]:
    schedule: dict[str, str] = {}
    section = _section_after_heading(root, "Release Schedule")
    if not section:
        return schedule
    for label in section.find_all("strong"):
        label_text = clean_text(label.get_text(" ", strip=True))
        key = snake_case_label(label_text)
        if key == "due_date_s":
            key = "due_dates"
        parent_text = clean_text(label.parent.get_text("\n", strip=True)) if label.parent else ""
        value = one_line(parent_text.replace(label_text, "", 1))
        if key and value:
            schedule[key] = value
    return schedule


def _official_solicitation_url(root: Tag) -> str | None:
    link = root.find("a", string=re.compile(r"View Official Solicitation", re.IGNORECASE))
    return urljoin(BASE_URL, str(link["href"])) if link and link.get("href") else None


def _description(root: Tag) -> str | None:
    """Description text. sbir.gov wraps it in a ``pre-form-wrapped`` (white-space: pre) container."""
    section = _section_after_heading(root, "Description")
    scope = section or root
    wrapper = scope.find(class_=re.compile(r"\bpre-form-wrapped\b"))
    if wrapper:
        return html_to_text(wrapper.decode_contents(), preserve_newlines=True) or None
    if section:
        text = html_to_text(section.decode_contents())
        return re.sub(r"^\s*Description\s*", "", text) or None
    return None


def _extra_labeled_fields(root: Tag, known: dict[str, Any]) -> dict[str, str]:
    known_values = {clean_text(str(value)) for value in known.values() if isinstance(value, str)}
    found: dict[str, str] = {}
    for strong in root.find_all("strong"):
        label = clean_text(strong.get_text(" ", strip=True)).rstrip(":")
        if not label or len(label) > 80:
            continue
        key = snake_case_label(label)
        if key in _KNOWN_LABELS:
            continue
        parent = strong.parent
        if not isinstance(parent, Tag):
            continue
        parent_text = clean_text(parent.get_text(" ", strip=True))
        value = clean_text(re.sub(rf"^{re.escape(label)}:?\s*", "", parent_text, flags=re.IGNORECASE))
        if value and value not in known_values and value != label:
            found[key] = value
    return found


# --------------------------------------------------------------------------------------------------
# Record
# --------------------------------------------------------------------------------------------------


def normalize_status(raw: str | None, open_date: str | None, today: date) -> str:
    """sbir.gov status -> canonical status. "Open" with a future open date is DoD-style pre-release."""
    value = (raw or "").strip().casefold()
    if value == "open":
        return "pre_release" if open_date and open_date > today.isoformat() else "open"
    if value in {"future", "upcoming"}:
        return "pre_release"
    if value == "closed":
        return "closed"
    return "unknown"


def build_record(listing: ListingTopic, detail: dict[str, Any] | None, today: date) -> Record:
    """Combine a listing hit and (optionally) its parsed detail page into a canonical Record."""
    detail = detail or {}
    schedule: dict[str, str] = detail.get("release_schedule") or {}
    release_date = to_iso_date(schedule.get("release_date") or listing.release_date)
    open_date = to_iso_date(schedule.get("open_date") or listing.open_date)
    close_date = to_iso_date(schedule.get("close_date") or listing.close_date or schedule.get("due_dates"))
    agency, implied_sub = normalize_agency(detail.get("agency") or listing.agency)
    sub_agency = one_line(detail.get("sub_agency")).upper() or implied_sub
    tags: list[str] = detail.get("tags") or listing.tags
    year_text = one_line(detail.get("year"))

    extra: dict[str, Any] = dict(detail.get("extra_fields") or {})
    due_dates = schedule.get("due_dates")
    if due_dates and to_iso_date(due_dates) != close_date:
        extra["due_dates"] = due_dates
    raw_agency = one_line(detail.get("agency") or listing.agency)
    if raw_agency and raw_agency.upper() != agency:
        extra["funding_agency"] = raw_agency

    summary = listing.summary if listing.summary and len(listing.summary) >= 40 else None
    record = Record(
        id=make_id(NAME, listing.native_id),
        source=NAME,
        links={"sbir_gov": listing.url, "official": detail.get("official_solicitation_url")},
        title=detail.get("title") or listing.title,
        agency=agency,
        sub_agency=sub_agency,
        program=normalize_program(tags),
        phases=tags,
        topic_number=one_line(detail.get("topic_number")) or None,
        solicitation_number=one_line(detail.get("solicitation_number")) or None,
        status=normalize_status(detail.get("status") or listing.status, open_date, today),
        release_date=release_date,
        open_date=open_date,
        close_date=close_date,
        summary=summary if not detail.get("description") else None,
        description=detail.get("description"),
        keywords=[],  # sbir.gov tags are program/phase labels, already captured in program/phases
        year=int(year_text) if year_text.isdigit() else None,
        extra=extra,
    )
    return record.finalize()


# --------------------------------------------------------------------------------------------------
# Scrape
# --------------------------------------------------------------------------------------------------


def collect_listing(client: HttpClient, limit: int | None) -> tuple[list[ListingTopic], bool]:
    """Walk the listing until every advertised result is collected. Returns (topics, complete).

    sbir.gov has no stable sort: hundreds of topics share the same dates (all NSF topics, for one), so
    the database orders ties differently on every request and a single walk over the pages returns
    duplicates and misses ~5% of topics. We therefore re-walk the listing (up to MAX_PASSES times)
    until the number of unique topics reaches the "Showing x-y of N results" total. If it never does,
    the result is marked incomplete so merge will not treat the stragglers as missing.
    """
    seen: dict[str, ListingTopic] = {}
    total: int | None = None
    for attempt in range(1, MAX_PASSES + 1):
        for page in range(MAX_PAGES):
            page_topics, has_next, page_total = parse_listing(client.get_text(listing_url(page)))
            total = page_total if page_total is not None else total
            for topic in page_topics:
                seen.setdefault(topic.url, topic)
            if limit is not None and len(seen) >= limit:
                return list(seen.values())[:limit], False
            if not page_topics or not has_next:
                break
        log.info("sbir_gov: listing pass %d -> %d unique topics of %s", attempt, len(seen), total)
        if total is None or len(seen) >= total:
            return list(seen.values()), True
    log.warning("sbir_gov: listing reported %s results but only %d were collected", total, len(seen))
    return list(seen.values()), False


def scrape(client: HttpClient, options: ScrapeOptions) -> SourceResult:
    try:
        listing, complete = collect_listing(client, options.limit)
    except Exception as exc:  # noqa: BLE001 - a dead listing means the whole source failed
        log.error("sbir_gov: listing failed: %s", exc)
        return SourceResult(NAME, ok=False, error=str(exc))
    if not listing:
        return SourceResult(NAME, ok=False, error="listing returned no topics")

    details = parallel_map(lambda topic: parse_detail(client.get_text(topic.url)), listing, options.workers)
    records: list[Record] = []
    partial: set[str] = set()
    failed = 0
    for topic, detail, error in details:
        if error is not None:
            failed += 1
            log.warning("sbir_gov: detail %s failed: %s", topic.url, error)
        record = build_record(topic, detail, options.today)
        if error is not None:
            partial.add(record.id)
        records.append(record)
    log.info("sbir_gov: %d topics, %d detail failures", len(records), failed)
    records = enrich_nsf(client, records, options.workers)  # best effort; never raises
    return SourceResult(
        NAME,
        ok=True,
        complete=complete and options.limit is None,
        records=records,
        partial_ids=partial,
        fetched=len(records),
        failed=failed,
    )
