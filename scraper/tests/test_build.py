"""Site artifact build: contents, determinism, SQLite schema."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from scraper.build import build, id_safe
from scraper.merge import run_merge
from scraper.sources.base import SourceResult
from scraper.store import DataDir

from .conftest import make_record

NOW = datetime(2026, 10, 9, 6, 15, tzinfo=timezone.utc)


def _seed(data_dir: Path) -> None:
    """Write a small database through the real merge + store code paths."""
    data = DataDir(data_dir)
    records = [
        make_record("dod_dsip", "ARM26-001", topic_number="ARM26-001", sub_agency="ARMY",
                    keywords=["UAS", "Acoustic", *[f"kw{n}" for n in range(20)]],
                    technology_areas=["Sensors"], extra={"focus_areas": ["Quantum Science"]},
                    description="Long description. " * 400, close_date="2026-10-15"),
        make_record("sbir_gov", "13020", topic_number="ARM26-001", links={"sbir_gov": "https://www.sbir.gov/topics/13020"}),
        make_record("grants_gov", "359671", agency="HHS", sub_agency="NIH", status="forecasted", close_date=None),
    ]
    results = {
        "dod_dsip": SourceResult("dod_dsip", ok=True, complete=True, records=[records[0]]),
        "sbir_gov": SourceResult("sbir_gov", ok=True, complete=True, records=[records[1]]),
        "grants_gov": SourceResult("grants_gov", ok=True, complete=True, records=[records[2]]),
    }
    outcome, snapshots = run_merge({}, {}, results, [], NOW)
    for source, snapshot in snapshots.items():
        data.save_snapshot(source, snapshot.values())
    data.save_records(outcome.records.values())
    data.append_changelog(outcome.events)
    data.save_meta({"last_run": "2026-10-09T06:15:00Z", "sources": {}, "counts": {}})


def _tree(root: Path) -> dict[str, bytes]:
    return {str(path.relative_to(root)): path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file()}


def test_build_is_byte_identical_for_the_same_data(tmp_path):
    _seed(tmp_path / "data")
    build(tmp_path / "data", tmp_path / "out1", build_time=NOW)
    build(tmp_path / "data", tmp_path / "out2", build_time=NOW)
    assert _tree(tmp_path / "out1") == _tree(tmp_path / "out2")
    # Only meta.json's build_time depends on the clock.
    build(tmp_path / "data", tmp_path / "out3", build_time=datetime(2030, 1, 1, tzinfo=timezone.utc))
    first, third = _tree(tmp_path / "out1"), _tree(tmp_path / "out3")
    assert {name for name in first if first[name] != third[name]} == {"meta.json"}


def test_build_artifacts(tmp_path):
    _seed(tmp_path / "data")
    sizes = build(tmp_path / "data", tmp_path / "site", build_time=NOW)
    out = tmp_path / "site"
    assert set(sizes) == {"catalog.json", "search-index.json", "agencies.json", "meta.json", "solicitations.sqlite"}

    catalog = json.loads((out / "catalog.json").read_text(encoding="utf-8"))
    assert [entry["id"] for entry in catalog] == ["dsip:ARM26-001", "grants:359671"]
    assert all(not {"description", "extra", "content_hash"} & set(entry) for entry in catalog)
    assert len(catalog[0]["keywords"]) == 15 and catalog[0]["keywords"][:2] == ["uas", "acoustic"]
    assert catalog[0]["alt_ids"] == ["sbirgov:13020"]
    assert len(catalog[0]["summary"]) <= 240

    index = json.loads((out / "search-index.json").read_text(encoding="utf-8"))
    assert set(index[0]) == {"id", "title", "summary", "keywords", "topic_number", "solicitation_number",
                             "agency", "sub_agency", "description", "technology_areas"}
    assert index[0]["keywords"].startswith("uas acoustic kw0") and index[0]["keywords"].endswith("kw19")
    assert index[0]["technology_areas"] == "Sensors Quantum Science"
    assert len(index[0]["description"]) == 4000

    detail = json.loads((out / "records" / f"{id_safe('dsip:ARM26-001')}.json").read_text(encoding="utf-8"))
    assert detail["description"].startswith("Long description.")
    assert len(detail["keywords"]) == 22 and detail["content_hash"]
    assert [event["event"] for event in detail["changelog"]] == ["new"]
    assert sorted(path.name for path in (out / "records").iterdir()) == ["dsip__ARM26-001.json", "grants__359671.json"]

    meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
    assert meta["build_time"] == "2026-10-09T06:15:00Z" and len(meta["data_version"]) == 16
    assert meta["counts"]["total"] == 2 and meta["counts"]["by_status"] == {"open": 1, "forecasted": 1}

    agencies = json.loads((out / "agencies.json").read_text(encoding="utf-8"))
    assert [agency["code"] for agency in agencies] == ["DOD", "HHS"]
    assert agencies[0]["sub_agencies"] == [{"code": "ARMY", "name": "Army", "count": 1}]


def test_records_dir_drops_stale_files(tmp_path):
    _seed(tmp_path / "data")
    stale = tmp_path / "site" / "records" / "dsip__GONE.json"
    stale.parent.mkdir(parents=True)
    stale.write_text("{}", encoding="utf-8")
    build(tmp_path / "data", tmp_path / "site", build_time=NOW)
    assert not stale.exists()


def test_sqlite_schema_and_views(tmp_path):
    _seed(tmp_path / "data")
    build(tmp_path / "data", tmp_path / "site", build_time=NOW)
    connection = sqlite3.connect(tmp_path / "site" / "solicitations.sqlite")
    try:
        objects = dict(connection.execute("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"))
        assert {"solicitations": "table", "keywords": "table", "changelog": "table", "open_now": "view", "closing_soon": "view"}.items() <= objects.items()
        assert connection.execute("SELECT count(*) FROM solicitations").fetchone() == (2,)
        assert connection.execute("SELECT id FROM open_now").fetchall() == [("dsip:ARM26-001",)]
        assert connection.execute("SELECT count(*) FROM keywords WHERE keyword IN ('acoustic', 'uas')").fetchone() == (2,)
        row = connection.execute("SELECT url_sbir_gov, json_array_length(alt_ids) FROM solicitations WHERE id = 'dsip:ARM26-001'").fetchone()
        assert row == ("https://www.sbir.gov/topics/13020", 1)
        assert connection.execute("SELECT count(*) FROM changelog WHERE event = 'new'").fetchone() == (2,)
    finally:
        connection.close()
