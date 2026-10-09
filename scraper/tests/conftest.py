"""Shared helpers for the scraper tests. Fixtures under fixtures/ were saved from live responses on
2026-10-09 (DSIP search trimmed to 4 topics, grants.gov session tokens redacted, scripts stripped
from the sbir.gov HTML)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from scraper.model import Record, make_id

FIXTURES = Path(__file__).parent / "fixtures"


def fixture_text(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def fixture_json(name: str) -> Any:
    return json.loads(fixture_text(name))


def make_record(source: str, native: str, **overrides: Any) -> Record:
    """A finalized snapshot-style record (lifecycle fields unset) for merge tests."""
    link_key = source
    url = f"https://example.test/{source}/{native}"
    fields: dict[str, Any] = {
        "id": make_id(source, native),
        "source": source,
        "links": {link_key: url},
        "title": f"Topic {native}",
        "agency": "DOD",
        "status": "open",
        "topic_number": None,
        "close_date": "2099-01-01",
        "description": f"Description of {native}.",
    }
    fields.update(overrides)
    return Record(**fields).finalize()


@pytest.fixture
def fixture_loader():
    return {"text": fixture_text, "json": fixture_json}
