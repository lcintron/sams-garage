"""Canonical record schema (PLAN.md section 4) plus the normalization helpers every source uses.

A ``Record`` is one SBIR/STTR opportunity. Sources build Records from their own payloads with the
helpers below, ``merge`` folds them into the canonical database, and ``validate`` checks a stored
record against the contract the site relies on.
"""

from __future__ import annotations

import hashlib
import html
import json
import re
from dataclasses import dataclass, field, fields
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable

from bs4 import BeautifulSoup
from bs4.element import NavigableString, Tag

# Source names in preference order: the first one present in a dedupe cluster becomes the primary.
SOURCE_NAMES: tuple[str, ...] = ("dod_dsip", "sbir_gov", "grants_gov")
SOURCE_PREFERENCE: dict[str, int] = {name: rank for rank, name in enumerate(SOURCE_NAMES)}
ID_PREFIXES: dict[str, str] = {"sbir_gov": "sbirgov", "dod_dsip": "dsip", "grants_gov": "grants"}

STATUSES: tuple[str, ...] = ("open", "pre_release", "forecasted", "closed", "unknown")
PROGRAMS: tuple[str, ...] = ("SBIR", "STTR", "SBIR/STTR")
PHASE_ORDER: tuple[str, ...] = ("I", "II", "IIB", "III", "DP2", "SPII")
LINK_KEYS: tuple[str, ...] = ("dod_dsip", "sbir_gov", "grants_gov", "official")

SUMMARY_MAX = 400
EXTRA_MAX_BYTES = 2048
EXTRA_VALUE_MAX = 300
KEYWORD_MAX_LEN = 80
KEYWORDS_MAX = 60

ID_RE = re.compile(r"^(sbirgov|dsip|grants):[A-Za-z0-9._-]+$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

# Fields whose change counts as a content change (PLAN.md: "sha1 of title|status|dates|description|keywords").
HASH_FIELDS: tuple[str, ...] = (
    "title",
    "status",
    "release_date",
    "open_date",
    "close_date",
    "qa_open_date",
    "qa_close_date",
    "description",
    "keywords",
)

# --------------------------------------------------------------------------------------------------
# Agencies
# --------------------------------------------------------------------------------------------------

AGENCY_NAMES: dict[str, str] = {
    "DOD": "Department of Defense",
    "HHS": "Department of Health and Human Services",
    "NSF": "National Science Foundation",
    "DOE": "Department of Energy",
    "NASA": "National Aeronautics and Space Administration",
    "USDA": "Department of Agriculture",
    "DHS": "Department of Homeland Security",
    "DOT": "Department of Transportation",
    "EPA": "Environmental Protection Agency",
    "ED": "Department of Education",
    "DOC": "Department of Commerce",
    "OTHER": "Other agencies",
}

SUB_AGENCY_NAMES: dict[str, str] = {
    "ARMY": "Army",
    "NAVY": "Navy",
    "USAF": "Air Force",
    "AF": "Air Force",
    "AFRL": "Air Force Research Laboratory",
    "USSF": "Space Force",
    "SF": "Space Force",
    "DARPA": "Defense Advanced Research Projects Agency",
    "MDA": "Missile Defense Agency",
    "SOCOM": "Special Operations Command",
    "DHA": "Defense Health Agency",
    "DTRA": "Defense Threat Reduction Agency",
    "DLA": "Defense Logistics Agency",
    "OSD": "Office of the Secretary of Defense",
    "CBD": "Chemical and Biological Defense",
    "NGA": "National Geospatial-Intelligence Agency",
    "NGIA": "National Geospatial-Intelligence Agency",
    "DMEA": "Defense Microelectronics Activity",
    "SDA": "Space Development Agency",
    "DTIC": "Defense Technical Information Center",
    "DCSA": "Defense Counterintelligence and Security Agency",
    "NIH": "National Institutes of Health",
    "CDC": "Centers for Disease Control and Prevention",
    "FDA": "Food and Drug Administration",
    "ACL": "Administration for Community Living",
    "NIFA": "National Institute of Food and Agriculture",
    "NIST": "National Institute of Standards and Technology",
    "NOAA": "National Oceanic and Atmospheric Administration",
    "FHWA": "Federal Highway Administration",
    "FAA": "Federal Aviation Administration",
    "S&T": "Science and Technology Directorate",
    "CWMD": "Countering Weapons of Mass Destruction Office",
}

# Free-text agency names and abbreviations (sbir.gov "Funding Agency", grants.gov top codes) -> (agency, implied sub-agency).
_AGENCY_ALIASES: dict[str, tuple[str, str | None]] = {
    "DOD": ("DOD", None),
    "DOW": ("DOD", None),  # sbir.gov now labels DoD topics "DOW" (Department of War)
    "DEPARTMENT OF DEFENSE": ("DOD", None),
    "DEPARTMENT OF WAR": ("DOD", None),
    "HHS": ("HHS", None),
    "DEPARTMENT OF HEALTH AND HUMAN SERVICES": ("HHS", None),
    "NIH": ("HHS", "NIH"),
    "NATIONAL INSTITUTES OF HEALTH": ("HHS", "NIH"),
    "CDC": ("HHS", "CDC"),
    "FDA": ("HHS", "FDA"),
    "NSF": ("NSF", None),
    "NATIONAL SCIENCE FOUNDATION": ("NSF", None),
    "DOE": ("DOE", None),
    "DEPARTMENT OF ENERGY": ("DOE", None),
    "NASA": ("NASA", None),
    "NATIONAL AERONAUTICS AND SPACE ADMINISTRATION": ("NASA", None),
    "USDA": ("USDA", None),
    "DEPARTMENT OF AGRICULTURE": ("USDA", None),
    "DHS": ("DHS", None),
    "DEPARTMENT OF HOMELAND SECURITY": ("DHS", None),
    "DOT": ("DOT", None),
    "DEPARTMENT OF TRANSPORTATION": ("DOT", None),
    "EPA": ("EPA", None),
    "ENVIRONMENTAL PROTECTION AGENCY": ("EPA", None),
    "ED": ("ED", None),
    "DEPARTMENT OF EDUCATION": ("ED", None),
    "DOC": ("DOC", None),
    "DEPARTMENT OF COMMERCE": ("DOC", None),
    "NIST": ("DOC", "NIST"),
    "NOAA": ("DOC", "NOAA"),
}


def normalize_agency(raw: str | None) -> tuple[str, str | None]:
    """Map a free-text agency name or abbreviation to (canonical agency code, implied sub-agency)."""
    if not raw:
        return "OTHER", None
    key = clean_text(raw).upper().replace("U.S. ", "").strip()
    key = re.sub(r"\s*\(.*?\)\s*", " ", key).strip()
    if key in _AGENCY_ALIASES:
        return _AGENCY_ALIASES[key]
    return "OTHER", clean_text(raw) or None


def normalize_agency_code(code: str | None) -> tuple[str, str | None]:
    """Map a grants.gov agency code ("HHS-NIH11", "DOD-AFRL-RW", "NSF") to (agency, sub-agency)."""
    if not code:
        return "OTHER", None
    parts = [part for part in clean_text(code).upper().split("-") if part]
    if not parts:
        return "OTHER", None
    agency, implied_sub = normalize_agency(parts[0])
    if agency == "OTHER":
        return "OTHER", "-".join(parts)
    sub = re.sub(r"\d+$", "", parts[1]) if len(parts) > 1 else implied_sub
    return agency, (sub or implied_sub)


# --------------------------------------------------------------------------------------------------
# Text helpers
# --------------------------------------------------------------------------------------------------


def clean_text(value: str | None) -> str:
    """Collapse horizontal whitespace, unescape stray HTML entities, strip. Newlines are kept."""
    if value is None:
        return ""
    text = html.unescape(str(value)).replace("\xa0", " ").replace("​", "")
    return re.sub(r"[ \t\r\f\v]+", " ", text).strip()


def one_line(value: str | None) -> str:
    """Collapse all whitespace (including newlines) to single spaces."""
    return re.sub(r"\s+", " ", clean_text(value)).strip()


def normalize_paragraphs(text: str) -> str:
    """Strip every line, drop leading/trailing blank lines and collapse runs of blank lines to one."""
    lines = [re.sub(r"[ \t\r\f\v]+", " ", line).strip() for line in text.replace("\r\n", "\n").split("\n")]
    out: list[str] = []
    for line in lines:
        if not line and (not out or not out[-1]):
            continue
        out.append(line)
    while out and not out[-1]:
        out.pop()
    return "\n".join(out)


_BLOCK_TAGS = ("p", "div", "section", "article", "h1", "h2", "h3", "h4", "h5", "h6", "table", "ul", "ol", "blockquote", "pre")
_LINE_TAGS = ("li", "tr", "br", "dt", "dd")


def html_to_text(markup: str | Tag | None, preserve_newlines: bool = False) -> str:
    """Convert an HTML fragment to plain text with paragraphs separated by blank lines.

    ``preserve_newlines`` keeps newlines that appear inside text nodes (sbir.gov wraps plain text in a
    ``white-space: pre`` container); otherwise whitespace inside text collapses like a browser would.
    """
    if markup is None:
        return ""
    soup = BeautifulSoup(str(markup), "html.parser")
    for node in list(soup.find_all(string=True)):
        if type(node) is not NavigableString:  # comments, doctypes, processing instructions
            node.extract()
            continue
        text = html.unescape(str(node)).replace("\xa0", " ")
        if not preserve_newlines:
            text = re.sub(r"\s+", " ", text)
        node.replace_with(text)
    for tag in soup.find_all(["script", "style"]):
        tag.decompose()
    for tag in soup.find_all(_LINE_TAGS):
        if tag.name == "li":
            tag.insert_before("\n• ")
        elif tag.name == "br":
            tag.replace_with("\n")
        else:
            tag.insert_before("\n")
    for tag in soup.find_all(_BLOCK_TAGS):
        tag.insert_before("\n\n")
        tag.insert_after("\n\n")
    return normalize_paragraphs(soup.get_text(""))


# Sentence boundary: ., ! or ? then whitespace then an uppercase letter/digit/quote, but not after
# initialisms like "U.S." or "e.g.".
_SENTENCE_BREAK = re.compile(r"(?<=[.!?])(?<![A-Z]\.[A-Z]\.)(?<!e\.g\.)(?<!i\.e\.)\s+(?=[A-Z0-9\"'(])")


def make_summary(text: str | None, limit: int = SUMMARY_MAX) -> str | None:
    """First whole sentences of ``text`` that fit in ``limit`` chars; falls back to a word-boundary cut."""
    flat = one_line(text)
    if not flat:
        return None
    if len(flat) <= limit:
        return flat
    sentences = _SENTENCE_BREAK.split(flat)
    summary = ""
    for sentence in sentences:
        candidate = f"{summary} {sentence}".strip()
        if len(candidate) > limit:
            break
        summary = candidate
    if summary:
        return summary
    return truncate_words(flat, limit)


def truncate_words(text: str, limit: int) -> str:
    """Cut ``text`` to at most ``limit`` chars at a word boundary, appending an ellipsis."""
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    if " " in cut:
        cut = cut[: cut.rfind(" ")]
    return cut.rstrip(" ,;:-") + "…"


def snake_case_label(value: str) -> str:
    """"Due Date(s)" -> "due_date_s" (used for sbir.gov field labels)."""
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", value.casefold())).strip("_")


def dedupe(values: Iterable[str]) -> list[str]:
    """Order-preserving case-insensitive dedupe of non-empty strings."""
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        key = value.casefold()
        if value and key not in seen:
            seen.add(key)
            result.append(value)
    return result


def normalize_keywords(values: Iterable[str | None]) -> list[str]:
    """Lowercase, trim, dedupe and bound a keyword list (order preserved: most relevant first)."""
    cleaned: list[str] = []
    for value in values:
        text = one_line(value).lower().strip(" .;,")
        if text and len(text) <= KEYWORD_MAX_LEN:
            cleaned.append(text)
    return dedupe(cleaned)[:KEYWORDS_MAX]


def split_keywords(raw: str | None) -> list[str]:
    """Split a "a; b, c" keyword string. Semicolons win when present (DSIP uses them)."""
    text = one_line(raw)
    if not text:
        return []
    separator = ";" if ";" in text else ","
    return [part.strip() for part in text.split(separator) if part.strip()]


def normalize_phases(values: Iterable[str | None]) -> list[str]:
    """Normalize phase labels from any source to I, II, IIB, III, DP2, SPII (ordered, deduped)."""
    found: set[str] = set()
    for value in values:
        label = one_line(value).upper().replace("PHASE", "").strip()
        label = {
            "1": "I",
            "2": "II",
            "3": "III",
            "D2": "DP2",
            "D2PII": "DP2",
            "DP2": "DP2",
            "DIRECT TO II": "DP2",
            "DIRECT TO PHASE II": "DP2",
            "2S": "SPII",
            "SPII": "SPII",
            "2B": "IIB",
            "IIB": "IIB",
        }.get(label, label)
        if label == "BOTH":
            found.update(("I", "II"))
        elif label in PHASE_ORDER:
            found.add(label)
    return [phase for phase in PHASE_ORDER if phase in found]


def normalize_program(values: Iterable[str | None]) -> str | None:
    """Collapse program mentions to SBIR, STTR or SBIR/STTR.

    sbir.gov tags a topic open to both programs with a bare "BOTH" (NSF topics read ["BOTH", "BOTH"]).
    "BOTH" is also its phase tag (["SBIR", "BOTH"] = SBIR, Phases I and II), so it only means both
    programs when no explicit SBIR/STTR tag is present.
    """
    seen: set[str] = set()
    both = False
    for value in values:
        text = one_line(value).upper()
        if "SBIR" in text:
            seen.add("SBIR")
        if "STTR" in text:
            seen.add("STTR")
        both = both or text == "BOTH"
    if both and not seen:
        seen = {"SBIR", "STTR"}
    if seen == {"SBIR", "STTR"}:
        return "SBIR/STTR"
    return next(iter(seen)) if seen else None


def native_id(value: Any) -> str:
    """Make a source's native id safe for record ids and file names ([A-Za-z0-9._-])."""
    return re.sub(r"[^A-Za-z0-9._-]+", "-", one_line(str(value))).strip("-")


def make_id(source: str, native: Any) -> str:
    return f"{ID_PREFIXES[source]}:{native_id(native)}"


def norm_topic_number(value: str | None) -> str | None:
    """Dedupe key form of a topic number: case-insensitive, spaces and dashes removed."""
    key = re.sub(r"[\s\-_]+", "", one_line(value)).upper()
    if len(key) < 4 or key in {"NONE", "NULL", "TBD", "N/A"}:
        return None
    return key


# --------------------------------------------------------------------------------------------------
# Dates
# --------------------------------------------------------------------------------------------------

_EASTERN_FALLBACK = timezone(timedelta(hours=-5))


def _eastern() -> timezone | Any:
    """US Eastern time zone (federal deadlines are stated in ET); fixed UTC-5 if tzdata is missing."""
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo("America/New_York")
    except Exception:  # noqa: BLE001 - zoneinfo raises several types when tzdata is absent
        return _EASTERN_FALLBACK


_DATE_FORMATS = ("%B %d, %Y", "%b %d, %Y", "%m/%d/%Y", "%Y-%m-%d", "%b %d %Y", "%B %d %Y", "%d %B %Y")


def to_iso_date(value: Any) -> str | None:
    """Parse epoch milliseconds or a human date string into ``YYYY-MM-DD`` (None when unparseable)."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return datetime.fromtimestamp(value / 1000, tz=timezone.utc).astimezone(_eastern()).date().isoformat()
    text = one_line(str(value))
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", text)
    if match:
        return _safe_date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    # "Apr 05, 2027 12:00:00 AM EDT" -> keep the date part only.
    text = re.sub(r"\s+\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?\s*[A-Z]{2,4}$", "", text, flags=re.IGNORECASE)
    text = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", text)
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _safe_date(year: int, month: int, day: int) -> str | None:
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def utc_timestamp(moment: datetime) -> str:
    """ISO-8601 UTC timestamp with second precision: ``2026-10-09T06:15:00Z``."""
    return moment.astimezone(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------------------------------
# Record
# --------------------------------------------------------------------------------------------------


def empty_links() -> dict[str, str | None]:
    return {key: None for key in LINK_KEYS}


@dataclass
class Record:
    """One opportunity. Field order here is the key order written to the JSONL files."""

    id: str
    source: str
    links: dict[str, str | None] = field(default_factory=empty_links)
    alt_ids: list[str] = field(default_factory=list)
    title: str = ""
    agency: str = "OTHER"
    sub_agency: str | None = None
    program: str | None = None
    phases: list[str] = field(default_factory=list)
    topic_number: str | None = None
    solicitation_number: str | None = None
    solicitation_title: str | None = None
    status: str = "unknown"
    release_date: str | None = None
    open_date: str | None = None
    close_date: str | None = None
    qa_open_date: str | None = None
    qa_close_date: str | None = None
    summary: str | None = None
    description: str | None = None
    keywords: list[str] = field(default_factory=list)
    technology_areas: list[str] = field(default_factory=list)
    year: int | None = None
    first_seen: str | None = None
    last_seen: str | None = None
    last_changed: str | None = None
    content_hash: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def finalize(self) -> "Record":
        """Normalize derived fields in place (summary, lists, extra bound, content hash) and return self."""
        self.title = one_line(self.title)
        self.description = normalize_paragraphs(self.description or "") or None
        self.summary = make_summary(self.summary or self.description)
        self.keywords = normalize_keywords(self.keywords)
        self.technology_areas = dedupe(one_line(area) for area in self.technology_areas if one_line(area))
        self.phases = normalize_phases(self.phases)
        self.links = {key: (self.links.get(key) or None) for key in LINK_KEYS}
        self.alt_ids = sorted(set(self.alt_ids) - {self.id})
        self.extra = bound_extra(self.extra)
        self.content_hash = content_hash(self)
        return self

    def dedupe_key(self) -> tuple[str, str] | None:
        topic = norm_topic_number(self.topic_number)
        return (self.agency, topic) if topic else None

    def to_dict(self) -> dict[str, Any]:
        """Ordered plain dict (links in LINK_KEYS order, extra keys sorted) ready for JSON."""
        data: dict[str, Any] = {}
        for item in fields(self):
            value = getattr(self, item.name)
            if item.name == "links":
                value = {key: value.get(key) for key in LINK_KEYS}
            elif item.name == "extra":
                value = {key: value[key] for key in sorted(value)}
            elif isinstance(value, list):
                value = list(value)
            data[item.name] = value
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Record":
        known = {item.name for item in fields(cls)}
        kwargs = {key: value for key, value in data.items() if key in known}
        record = cls(**kwargs)
        record.links = {key: (record.links or {}).get(key) for key in LINK_KEYS}
        return record


def content_hash(record: Record) -> str:
    """sha1 over the fields that define "content changed" (see HASH_FIELDS)."""
    payload = [getattr(record, name) for name in HASH_FIELDS]
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha1(encoded.encode("utf-8")).hexdigest()


def bound_extra(extra: dict[str, Any] | None, max_bytes: int = EXTRA_MAX_BYTES) -> dict[str, Any]:
    """Drop empty values, cap long strings and drop trailing keys until ``extra`` serializes under max_bytes."""
    result: dict[str, Any] = {}
    for key in sorted(extra or {}):
        value = (extra or {})[key]
        if value is None or value == "" or value == [] or value == {}:
            continue
        if isinstance(value, str):
            value = truncate_words(one_line(value), EXTRA_VALUE_MAX)
        result[key] = value
    while result and _json_size(result) >= max_bytes:
        largest = max(result, key=lambda name: (_json_size(result[name]), name))
        del result[largest]
    return result


def _json_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8"))


# --------------------------------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------------------------------

_FIELD_NAMES = tuple(item.name for item in fields(Record))
_NULLABLE_STR = (
    "sub_agency",
    "program",
    "topic_number",
    "solicitation_number",
    "solicitation_title",
    "summary",
    "description",
)
_DATE_FIELDS = ("release_date", "open_date", "close_date", "qa_open_date", "qa_close_date")


def validate(data: dict[str, Any]) -> list[str]:
    """Return a list of human-readable problems with one stored canonical record (empty = valid)."""
    problems: list[str] = []
    rid = data.get("id", "?")

    def bad(message: str) -> None:
        problems.append(f"{rid}: {message}")

    missing = [name for name in _FIELD_NAMES if name not in data]
    unknown = [name for name in data if name not in _FIELD_NAMES]
    if missing:
        bad(f"missing keys {missing}")
    if unknown:
        bad(f"unknown keys {unknown}")
    if missing:
        return problems

    # The id's prefix names the source that first published the record; "source" is where its content comes
    # from now. They differ once a record outlives its first source or a better one appears (ids are stable).
    if not isinstance(rid, str) or not ID_RE.match(rid):
        bad("id must look like '<sbirgov|dsip|grants>:<native id>'")
    if data["source"] not in SOURCE_NAMES:
        bad(f"unknown source {data['source']!r}")
    links = data["links"]
    if not isinstance(links, dict) or set(links) != set(LINK_KEYS):
        bad(f"links must have exactly {list(LINK_KEYS)}")
    elif not links.get(data["source"]):
        bad("links has no URL for the primary source")
    if not isinstance(data["alt_ids"], list) or any(not ID_RE.match(str(alt)) for alt in data["alt_ids"]):
        bad("alt_ids must be a list of record ids")
    if not isinstance(data["title"], str) or not data["title"].strip():
        bad("title is empty")
    if data["agency"] not in AGENCY_NAMES:
        bad(f"unknown agency {data['agency']!r}")
    if data["program"] is not None and data["program"] not in PROGRAMS:
        bad(f"bad program {data['program']!r}")
    if not isinstance(data["phases"], list) or any(phase not in PHASE_ORDER for phase in data["phases"]):
        bad(f"bad phases {data['phases']!r}")
    if data["status"] not in STATUSES:
        bad(f"bad status {data['status']!r}")
    for name in _NULLABLE_STR:
        if data[name] is not None and not isinstance(data[name], str):
            bad(f"{name} must be a string or null")
    for name in _DATE_FIELDS:
        if data[name] is not None and not (isinstance(data[name], str) and DATE_RE.match(data[name])):
            bad(f"{name} must be YYYY-MM-DD or null")
    if data["summary"] is not None and len(data["summary"]) > SUMMARY_MAX:
        bad("summary longer than 400 chars")
    keywords = data["keywords"]
    if not isinstance(keywords, list) or any(not isinstance(k, str) or k != k.lower() for k in keywords):
        bad("keywords must be lowercase strings")
    elif len({k for k in keywords}) != len(keywords):
        bad("keywords contain duplicates")
    if not isinstance(data["technology_areas"], list):
        bad("technology_areas must be a list")
    if data["year"] is not None and not isinstance(data["year"], int):
        bad("year must be an integer or null")
    for name in ("first_seen", "last_changed"):
        if not (isinstance(data[name], str) and TIMESTAMP_RE.match(data[name])):
            bad(f"{name} must be an ISO-8601 UTC timestamp")
    if not (isinstance(data["last_seen"], str) and DATE_RE.match(data["last_seen"])):
        bad("last_seen must be YYYY-MM-DD")
    if not isinstance(data["extra"], dict):
        bad("extra must be an object")
    elif _json_size(data["extra"]) >= EXTRA_MAX_BYTES:
        bad("extra is 2 KB or larger")
    if not problems and content_hash(Record.from_dict(data)) != data["content_hash"]:
        bad("content_hash does not match the record content")
    return problems
