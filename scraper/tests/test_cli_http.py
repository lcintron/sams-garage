"""CLI scrape orchestration (failure handling, exit codes) and HTTP retry behaviour, offline."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
import requests

from scraper import cli
from scraper.http import HttpClient, HttpError, user_agent
from scraper.sources.base import SourceResult

from .conftest import make_record


def _fake_sources(monkeypatch, behaviours):
    """Replace the registry with stub modules whose scrape() returns canned results."""
    stubs = {name: SimpleNamespace(NAME=name, scrape=lambda client, options, fn=fn: fn()) for name, fn in behaviours.items()}
    monkeypatch.setattr(cli, "SOURCES", stubs)


def test_scrape_survives_one_failed_source(tmp_path, monkeypatch, capsys):
    record = make_record("dod_dsip", "A1", close_date="2000-01-01")
    _fake_sources(monkeypatch, {
        "dod_dsip": lambda: SourceResult("dod_dsip", ok=True, complete=True, records=[record], fetched=1),
        "sbir_gov": lambda: SourceResult("sbir_gov", ok=False, error="listing down"),
    })
    assert cli.main(["--data-dir", str(tmp_path), "scrape", "--all"]) == 0
    meta = json.loads((tmp_path / "meta.json").read_text(encoding="utf-8"))
    assert meta["sources"]["sbir_gov"] == {"ran_at": meta["sources"]["sbir_gov"]["ran_at"], "ok": False, "complete": False,
                                           "fetched": 0, "failed": 0, "error": "listing down", "records": 0}
    assert meta["counts"]["total"] == 1 and meta["last_run_events"]["new"] == 1
    assert "scrape: 1 records" in capsys.readouterr().out
    assert cli.main(["--data-dir", str(tmp_path), "validate"]) == 0

    # Next run DSIP fails entirely: its record (close date long past) must not be closed.
    _fake_sources(monkeypatch, {"dod_dsip": lambda: SourceResult("dod_dsip", ok=False, error="timeout")})
    assert cli.main(["--data-dir", str(tmp_path), "scrape", "--all"]) == 1
    row = json.loads((tmp_path / "solicitations.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert row["status"] == "open"


def test_scrape_crash_in_source_is_contained(tmp_path, monkeypatch):
    def explode():
        raise ValueError("parser bug")

    _fake_sources(monkeypatch, {
        "dod_dsip": explode,
        "grants_gov": lambda: SourceResult("grants_gov", ok=True, complete=True, records=[make_record("grants_gov", "1")]),
    })
    assert cli.main(["--data-dir", str(tmp_path), "scrape", "--all"]) == 0
    meta = json.loads((tmp_path / "meta.json").read_text(encoding="utf-8"))
    assert meta["sources"]["dod_dsip"]["ok"] is False and "parser bug" in meta["sources"]["dod_dsip"]["error"]


class _FakeSession:
    def __init__(self, statuses):
        self.statuses = list(statuses)
        self.calls = 0
        self.headers = {}

    def request(self, method, url, timeout=None, **kwargs):
        assert timeout is not None, "every request must carry a timeout"
        self.calls += 1
        status = self.statuses.pop(0)
        if isinstance(status, Exception):
            raise status
        response = requests.Response()
        response.status_code = status
        response._content = b'{"ok": true}'
        response.url = url
        response.request = requests.Request(method, url).prepare()
        return response


def test_http_retries_transient_errors():
    session = _FakeSession([503, requests.ConnectionError("reset"), 200])
    client = HttpClient(retries=3, backoff=0, session=session)
    assert client.get_json("https://example.test/") == {"ok": True}
    assert session.calls == 3


def test_http_does_not_retry_client_errors():
    session = _FakeSession([404, 200])
    client = HttpClient(retries=3, backoff=0, session=session)
    with pytest.raises(HttpError, match="HTTP 404"):
        client.get("https://example.test/")
    assert session.calls == 1


def test_user_agent_identifies_the_project(monkeypatch):
    monkeypatch.setenv("GITHUB_REPOSITORY", "someone/sams-garage")
    assert user_agent().startswith("SAMs-Garage/") and "github.com/someone/sams-garage" in user_agent()
    monkeypatch.delenv("GITHUB_REPOSITORY")
    assert "(+https://github.com/lcintron/sams-garage; SBIR/STTR opportunity index; data refresh bot)" in user_agent()
