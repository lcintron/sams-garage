"""Build the static site data (PLAN.md section 5) from the committed database.

    data/solicitations.jsonl + changelog.jsonl + meta.json  ->  site/data/
        meta.json              build time, data version, last run, per-source status, counts
        catalog.json           compact records (no description/extra/content_hash; summary trimmed,
                               keywords capped at 15) -- the list view
        records/<id-safe>.json full record + its changelog events (id-safe = id with ":" -> "__")
        search-index.json      documents for MiniSearch (see below)
        solicitations.sqlite   SQLite DB for the SQL console (stdlib sqlite3)
        agencies.json          agency / sub-agency display names and counts for the filter panel

search-index.json is a plain array of documents, not MiniSearch's serialized index: producing
MiniSearch's internal format from Python would couple us to its private layout. The site builds the
MiniSearch index client-side from these documents (fast for a few thousand), joining on ``id`` with the
catalog. Fields: id, title, summary, keywords (space-joined), technology_areas (technology areas plus
DSIP focus areas, space-joined), topic_number, solicitation_number, agency, sub_agency, description
(first 4,000 chars).

catalog.json drops description, extra and content_hash and caps keywords at 15 to stay small; the
full record (all keywords, hash, extra) is in records/<id-safe>.json.

Every output except meta.json's ``build_time`` is a pure function of data/, so two builds of the same
data are byte-identical (the deploy only changes when the data does). ``build_time`` honours
SOURCE_DATE_EPOCH for fully reproducible builds.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import sqlite3
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .model import AGENCY_NAMES, STATUSES, SUB_AGENCY_NAMES, Record, truncate_words, utc_timestamp
from .store import DataDir, dumps_line, write_bytes_atomic

log = logging.getLogger(__name__)

SCHEMA_VERSION = 1
# The site data format (the files under site/data and their shapes) that the app reads. Bump it with any change an
# installed app could not read; apps that know an older format keep their data and ask for an update
# (site/js/data.js DATA_FORMAT, electron/protocol.js DATA_FORMAT).
SITE_FORMAT = 1
CATALOG_SUMMARY_MAX = 240
CATALOG_KEYWORDS_MAX = 15
INDEX_DESCRIPTION_MAX = 4000


def id_safe(record_id: str) -> str:
    """File name for a record: ids are already [A-Za-z0-9._-] apart from the ':' separator."""
    return record_id.replace(":", "__")


def _json_bytes(value: Any, *, pretty: bool = False) -> bytes:
    if pretty:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    else:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return text.encode("utf-8")


def build(data_dir: str | os.PathLike[str], out_dir: str | os.PathLike[str], build_time: datetime | None = None) -> dict[str, int]:
    """Write every artifact into ``out_dir``; returns {relative file name: size in bytes} for the main files."""
    data = DataDir(data_dir)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    records = sorted(data.load_records().values(), key=lambda record: record.id)
    changelog = data.load_changelog()
    meta_in = data.load_meta()

    events_by_id = _events_by_record(records, changelog)
    files: dict[str, bytes] = {
        "catalog.json": _json_bytes([catalog_entry(record) for record in records]),
        "search-index.json": _json_bytes([search_document(record) for record in records]),
        "agencies.json": _json_bytes(agencies(records), pretty=True),
    }
    version = data_version(records, changelog)
    files["meta.json"] = _json_bytes(site_meta(records, meta_in, version, build_time), pretty=True)
    for name, payload in files.items():
        write_bytes_atomic(out / name, payload)

    _write_records(out / "records", records, events_by_id)
    write_bytes_atomic(out / "solicitations.sqlite", sqlite_bytes(records, changelog, meta_in))

    sizes = {name: (out / name).stat().st_size for name in [*files, "solicitations.sqlite"]}
    log.info("build: %d records -> %s (%s)", len(records), out, ", ".join(f"{k} {v:,} B" for k, v in sizes.items()))
    return sizes


# --------------------------------------------------------------------------------------------------
# JSON artifacts
# --------------------------------------------------------------------------------------------------


def catalog_entry(record: Record) -> dict[str, Any]:
    entry = record.to_dict()
    entry.pop("description")
    entry.pop("extra")
    entry.pop("content_hash")
    entry["keywords"] = entry["keywords"][:CATALOG_KEYWORDS_MAX]
    if entry["summary"]:
        entry["summary"] = truncate_words(entry["summary"], CATALOG_SUMMARY_MAX)
    return entry


def search_document(record: Record) -> dict[str, Any]:
    return {
        "id": record.id,
        "title": record.title,
        "summary": record.summary or "",
        "keywords": " ".join(record.keywords),
        "technology_areas": " ".join([*record.technology_areas, *_focus_areas(record)]),
        "topic_number": record.topic_number or "",
        "solicitation_number": record.solicitation_number or "",
        "agency": record.agency,
        "sub_agency": record.sub_agency or "",
        "description": (record.description or "")[:INDEX_DESCRIPTION_MAX],
    }


def _focus_areas(record: Record) -> list[str]:
    areas = record.extra.get("focus_areas")
    return [str(area) for area in areas] if isinstance(areas, list) else []


def agencies(records: list[Record]) -> list[dict[str, Any]]:
    """[{code, name, count, by_status, sub_agencies: [{code, name, count}]}] sorted by code."""
    totals: Counter[str] = Counter()
    statuses: dict[str, Counter[str]] = defaultdict(Counter)
    subs: dict[str, Counter[str]] = defaultdict(Counter)
    for record in records:
        totals[record.agency] += 1
        statuses[record.agency][record.status] += 1
        if record.sub_agency:
            subs[record.agency][record.sub_agency] += 1
    return [
        {
            "code": code,
            "name": AGENCY_NAMES.get(code, code),
            "count": totals[code],
            "by_status": {status: statuses[code][status] for status in STATUSES if statuses[code][status]},
            "sub_agencies": [
                {"code": sub, "name": SUB_AGENCY_NAMES.get(sub, sub), "count": count}
                for sub, count in sorted(subs[code].items())
            ],
        }
        for code in sorted(totals)
    ]


def counts(records: list[Record]) -> dict[str, Any]:
    by_status = Counter(record.status for record in records)
    by_agency = Counter(record.agency for record in records)
    by_source = Counter(record.source for record in records)
    return {
        "total": len(records),
        "by_status": {status: by_status[status] for status in STATUSES if by_status[status]},
        "by_agency": dict(sorted(by_agency.items())),
        "by_source": dict(sorted(by_source.items())),
    }


def data_version(records: list[Record], changelog: list[dict[str, Any]]) -> str:
    """Short content hash of the database; the site refetches catalog/index when it changes."""
    digest = hashlib.sha1()
    for record in records:
        digest.update(dumps_line(record.to_dict()).encode("utf-8"))
    digest.update(str(len(changelog)).encode("ascii"))
    return digest.hexdigest()[:16]


def site_meta(records: list[Record], meta_in: dict[str, Any], version: str, build_time: datetime | None) -> dict[str, Any]:
    return {
        "format": SITE_FORMAT,
        "schema_version": SCHEMA_VERSION,
        "build_time": utc_timestamp(build_time or _default_build_time()),
        "data_version": version,
        "last_run": meta_in.get("last_run"),
        "sources": meta_in.get("sources", {}),
        "counts": counts(records),
    }


def _default_build_time() -> datetime:
    epoch = os.environ.get("SOURCE_DATE_EPOCH", "").strip()
    if epoch.isdigit():
        return datetime.fromtimestamp(int(epoch), tz=timezone.utc)
    return datetime.now(timezone.utc)


def _events_by_record(records: list[Record], changelog: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Changelog events per canonical id, including events logged under ids it later absorbed."""
    owner: dict[str, str] = {}
    for record in records:
        owner[record.id] = record.id
        for alt in record.alt_ids:
            owner.setdefault(alt, record.id)
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for event in changelog:
        target = owner.get(str(event.get("id")))
        if target:
            grouped[target].append(event)
    return grouped


def _write_records(directory: Path, records: list[Record], events_by_id: dict[str, list[dict[str, Any]]]) -> None:
    """Rewrite records/ from scratch so files for vanished ids never linger."""
    staging = Path(tempfile.mkdtemp(prefix=".records.", dir=directory.parent))
    try:
        for record in records:
            payload = record.to_dict()
            payload["changelog"] = events_by_id.get(record.id, [])
            (staging / f"{id_safe(record.id)}.json").write_bytes(_json_bytes(payload))
        if directory.exists():
            shutil.rmtree(directory)
        staging.rename(directory)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


# --------------------------------------------------------------------------------------------------
# SQLite
# --------------------------------------------------------------------------------------------------

SQL_SCHEMA = """
CREATE TABLE solicitations (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    agency TEXT NOT NULL,
    sub_agency TEXT,
    program TEXT,
    phases TEXT NOT NULL,            -- JSON array, e.g. ["I","II"]
    topic_number TEXT,
    solicitation_number TEXT,
    solicitation_title TEXT,
    status TEXT NOT NULL,            -- open | pre_release | forecasted | closed | unknown
    release_date TEXT,
    open_date TEXT,
    close_date TEXT,
    qa_open_date TEXT,
    qa_close_date TEXT,
    summary TEXT,
    description TEXT,
    keywords TEXT NOT NULL,          -- JSON array of lowercase keywords (also in the keywords table)
    technology_areas TEXT NOT NULL,  -- JSON array
    year INTEGER,
    first_seen TEXT,
    last_seen TEXT,
    last_changed TEXT,
    content_hash TEXT,
    url_dod_dsip TEXT,
    url_sbir_gov TEXT,
    url_grants_gov TEXT,
    url_official TEXT,
    alt_ids TEXT NOT NULL,           -- JSON array
    extra TEXT NOT NULL              -- JSON object
);
CREATE TABLE keywords (
    id TEXT NOT NULL REFERENCES solicitations(id),
    keyword TEXT NOT NULL,
    PRIMARY KEY (id, keyword)
) WITHOUT ROWID;
CREATE TABLE changelog (
    at TEXT NOT NULL,
    id TEXT NOT NULL,
    event TEXT NOT NULL,             -- new | status | updated | missing
    from_value TEXT,
    to_value TEXT,
    fields TEXT                      -- JSON array of changed fields for "updated"
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
CREATE INDEX solicitations_status ON solicitations(status);
CREATE INDEX solicitations_agency ON solicitations(agency, sub_agency);
CREATE INDEX solicitations_close ON solicitations(close_date);
CREATE INDEX keywords_keyword ON keywords(keyword);
CREATE INDEX changelog_id ON changelog(id);
CREATE VIEW open_now AS
    SELECT * FROM solicitations WHERE status = 'open' ORDER BY close_date, id;
CREATE VIEW closing_soon AS
    SELECT * FROM solicitations
    WHERE status = 'open' AND close_date BETWEEN date('now') AND date('now', '+14 days')
    ORDER BY close_date, id;
"""

_COLUMNS = (
    "id", "source", "title", "agency", "sub_agency", "program", "phases", "topic_number",
    "solicitation_number", "solicitation_title", "status", "release_date", "open_date", "close_date",
    "qa_open_date", "qa_close_date", "summary", "description", "keywords", "technology_areas", "year",
    "first_seen", "last_seen", "last_changed", "content_hash", "url_dod_dsip", "url_sbir_gov",
    "url_grants_gov", "url_official", "alt_ids", "extra",
)  # fmt: skip


def _sql_row(record: Record) -> tuple[Any, ...]:
    data = record.to_dict()
    for name in ("phases", "keywords", "technology_areas", "alt_ids"):
        data[name] = json.dumps(data[name], ensure_ascii=False)
    data["extra"] = json.dumps(data["extra"], ensure_ascii=False, sort_keys=True)
    for key, url in record.links.items():
        data[f"url_{key}"] = url
    return tuple(data[column] for column in _COLUMNS)


def sqlite_bytes(records: list[Record], changelog: list[dict[str, Any]], meta_in: dict[str, Any]) -> bytes:
    """Build the SQLite database in a temp file and return its bytes (deterministic for equal input)."""
    handle, temp_name = tempfile.mkstemp(suffix=".sqlite")
    os.close(handle)
    Path(temp_name).unlink()
    try:
        connection = sqlite3.connect(temp_name)
        try:
            connection.executescript(SQL_SCHEMA)
            placeholders = ",".join("?" for _ in _COLUMNS)
            connection.executemany(
                f"INSERT INTO solicitations ({','.join(_COLUMNS)}) VALUES ({placeholders})",
                [_sql_row(record) for record in records],
            )
            connection.executemany(
                "INSERT OR IGNORE INTO keywords (id, keyword) VALUES (?, ?)",
                [(record.id, keyword) for record in records for keyword in record.keywords],
            )
            connection.executemany(
                "INSERT INTO changelog (at, id, event, from_value, to_value, fields) VALUES (?, ?, ?, ?, ?, ?)",
                [
                    (
                        event.get("at"),
                        event.get("id"),
                        event.get("event"),
                        _sql_text(event.get("from")),
                        _sql_text(event.get("to")),
                        json.dumps(event["fields"]) if event.get("fields") else None,
                    )
                    for event in changelog
                ],
            )
            connection.executemany(
                "INSERT INTO meta (key, value) VALUES (?, ?)",
                [
                    ("schema_version", str(SCHEMA_VERSION)),
                    ("last_run", str(meta_in.get("last_run") or "")),
                    ("record_count", str(len(records))),
                ],
            )
            connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            connection.commit()
            connection.execute("VACUUM")
        finally:
            connection.close()
        return Path(temp_name).read_bytes()
    finally:
        Path(temp_name).unlink(missing_ok=True)


def _sql_text(value: Any) -> str | None:
    if value is None or isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)
