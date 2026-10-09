"""Fill descriptions for NSF topics, which sbir.gov lists without any description text.

NSF ("America's Seed Fund") publishes one static page per technology topic at
``https://seedfund.nsf.gov/topics/<slug>/`` (discovered through ``/sitemap.xml``; the old ``/topics/``
index now 404s). Each page has the topic name and code, e.g. "Advanced Materials (AM)", a description
of the topic, and the list of subtopic codes and names. Subtopic pages with their own descriptions
don't exist, so every NSF record gets its parent topic's description. For example, "AM3 Metals and
Ceramics" gets the Advanced Materials text, under a header naming that topic.

Records are matched by the letters of their topic number ("AM3" -> "AM", "AV1" -> "AV/VR/MR"). A few
pages omit the code ("Distributed Ledger"), so the fallback match is the topic name: sbir.gov also
lists each parent topic as its own record (topic number "DL", title "Distributed Ledger").

This step is best-effort. ``enrich_nsf`` never raises; if seedfund.nsf.gov is unreachable the NSF
records are returned unchanged.
"""

from __future__ import annotations

import copy
import logging
import re
from dataclasses import dataclass
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from ..http import HttpClient
from ..model import Record, html_to_text, make_summary, one_line
from .base import parallel_map

BASE_URL = "https://seedfund.nsf.gov"
SITEMAP_URL = f"{BASE_URL}/sitemap.xml"
_TOPIC_PATH = re.compile(r"^/topics/[a-z0-9-]+/$")
_NAME_CODE = re.compile(r"^(?P<name>.+?)\s*\((?P<code>[A-Z]+(?:\s*/\s*[A-Z]+)*)\s*\)$")
_TOPIC_CODE = re.compile(r"^(?P<code>[A-Z]+(?:/[A-Z]+)*)\d*$")

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class NsfTopic:
    code: str | None  # "AM", "AV/VR/MR"; None when the page does not state it
    name: str  # "Advanced Materials"
    url: str
    description: str


def topic_urls(sitemap_xml: str) -> list[str]:
    """Absolute URLs of the per-topic pages listed in the sitemap (its <loc>s are site-relative)."""
    urls: set[str] = set()
    for loc in re.findall(r"<loc>\s*([^<]+?)\s*</loc>", sitemap_xml):
        path = re.sub(r"^https?://[^/]+", "", loc.strip())
        if _TOPIC_PATH.match(path):
            urls.add(urljoin(BASE_URL, path))
    return sorted(urls)


def parse_topic_page(markup: str, url: str) -> NsfTopic | None:
    """Topic name, code and description from one topic page (None when it has no description)."""
    soup = BeautifulSoup(markup, "html.parser")
    content = soup.select_one(".tech-topic-content")
    if content is None:
        return None
    heading = content.find("h2")
    label = one_line(heading.get_text(" ", strip=True)) if heading else ""
    if not label:  # some pages leave the heading empty; the <title> still names the topic
        title = one_line(soup.title.get_text(" ", strip=True)) if soup.title else ""
        label = re.sub(r"\s*(Grant)?\s*(–|-)\s*Apply Today$", "", title.split("|")[0].strip()).strip()
    match = _NAME_CODE.match(label)
    name, code = (match.group("name"), re.sub(r"\s+", "", match.group("code"))) if match else (label, None)

    parts: list[str] = []
    for node in heading.find_next_siblings() if heading else content.find_all(recursive=False):
        if node.name == "h3" and "sub-topic" in node.get_text(" ", strip=True).casefold():
            break
        if "subhead" in (node.get("class") or []):
            continue
        parts.append(str(node))
    description = html_to_text("".join(parts))
    if not name or not description:
        return None
    return NsfTopic(code=code, name=name, url=url, description=description)


def fetch_topics(client: HttpClient, workers: int) -> list[NsfTopic]:
    """Fetch and parse every topic page. Individual page failures are logged and skipped."""
    urls = topic_urls(client.get_text(SITEMAP_URL))
    topics: list[NsfTopic] = []
    for url, markup, error in parallel_map(client.get_text, urls, workers):
        if error is not None:
            log.warning("nsf: topic page %s failed: %s", url, error)
            continue
        topic = parse_topic_page(markup or "", url)
        if topic:
            topics.append(topic)
    log.info("nsf: %d topic descriptions from %d pages", len(topics), len(urls))
    return topics


def _name_key(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", (value or "").casefold())


def _record_code(record: Record) -> str | None:
    match = _TOPIC_CODE.match(one_line(record.topic_number).upper().replace(" ", ""))
    return match.group("code") if match else None


def enrich(records: list[Record], topics: list[NsfTopic]) -> tuple[list[Record], int]:
    """Return (records, number filled). Only NSF records without a description are changed."""
    by_code: dict[str, NsfTopic] = {}
    by_name: dict[str, NsfTopic] = {}
    for topic in topics:
        if topic.code:
            by_code.setdefault(topic.code, topic)
            by_code.setdefault(topic.code.split("/")[0], topic)
        by_name.setdefault(_name_key(topic.name), topic)
    # sbir.gov lists each parent topic as a record whose topic number is the bare code ("DL").
    parent_names = {
        code: record.title
        for record in records
        if record.agency == "NSF" and (code := _record_code(record)) and code == one_line(record.topic_number).upper()
    }

    result: list[Record] = []
    filled = 0
    for record in records:
        code = _record_code(record) if record.agency == "NSF" and not record.description else None
        topic = None
        if code:
            topic = by_code.get(code) or by_code.get(code.split("/")[0]) or by_name.get(_name_key(parent_names.get(code)))
        if topic is None:
            result.append(record)
            continue
        enriched = copy.deepcopy(record)
        heading = f"NSF technology topic: {topic.name}" + (f" ({topic.code})" if topic.code else "")
        enriched.description = f"{heading}\n\n{topic.description}"
        enriched.summary = make_summary(topic.description)
        enriched.extra = {**enriched.extra, "description_source": topic.url}
        result.append(enriched.finalize())
        filled += 1
    return result, filled


def enrich_nsf(client: HttpClient, records: list[Record], workers: int) -> list[Record]:
    """Best-effort wrapper used by the sbir_gov source: never raises, never drops records."""
    if not any(record.agency == "NSF" and not record.description for record in records):
        return records
    try:
        topics = fetch_topics(client, workers)
    except Exception as exc:  # noqa: BLE001 - enrichment must never fail the source
        log.warning("nsf: enrichment skipped, seedfund.nsf.gov unavailable: %s", exc)
        return records
    enriched, filled = enrich(records, topics)
    log.info("nsf: filled %d NSF descriptions", filled)
    return enriched
