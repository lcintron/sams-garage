"""Merge lifecycle and dedupe (PLAN.md section 4)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from scraper.merge import run_merge
from scraper.model import Record, validate
from scraper.sources.base import SourceResult

from .conftest import make_record

DAY1 = datetime(2026, 10, 9, 6, 15, tzinfo=timezone.utc)
DAY1_LATER = datetime(2026, 10, 9, 18, 0, tzinfo=timezone.utc)
DAY2 = datetime(2026, 10, 10, 6, 15, tzinfo=timezone.utc)
DAY3 = datetime(2026, 10, 11, 6, 15, tzinfo=timezone.utc)
DAY4 = datetime(2026, 10, 12, 6, 15, tzinfo=timezone.utc)
DAY5 = datetime(2026, 10, 13, 6, 15, tzinfo=timezone.utc)


class Db:
    """In-memory stand-in for data/: carries records, snapshots and the changelog between runs."""

    def __init__(self) -> None:
        self.records: dict[str, Record] = {}
        self.snapshots: dict[str, dict[str, Record]] = {}
        self.changelog: list[dict[str, Any]] = []

    def run(self, now: datetime, **results: SourceResult) -> list[dict[str, Any]]:
        outcome, self.snapshots = run_merge(self.records, self.snapshots, results, self.changelog, now)
        self.records = outcome.records
        self.changelog.extend(outcome.events)
        for record in self.records.values():
            assert validate(record.to_dict()) == [], record.id
        return outcome.events


def ok(source: str, *records: Record, complete: bool = True, partial: set[str] | None = None) -> SourceResult:
    return SourceResult(source, ok=True, complete=complete, records=list(records), partial_ids=partial or set(), fetched=len(records))


def failed(source: str) -> SourceResult:
    return SourceResult(source, ok=False, error="boom")


def kinds(events: list[dict[str, Any]]) -> list[tuple[str, str]]:
    return [(event["id"], event["event"]) for event in events]


def test_new_record_gets_timestamps_and_new_event():
    db = Db()
    events = db.run(DAY1, dod_dsip=ok("dod_dsip", make_record("dod_dsip", "A1", status="pre_release")))
    record = db.records["dsip:A1"]
    assert kinds(events) == [("dsip:A1", "new")]
    assert events[0]["to"] == "pre_release" and events[0]["at"] == "2026-10-09T06:15:00Z"
    assert record.first_seen == record.last_changed == "2026-10-09T06:15:00Z"
    assert record.last_seen == "2026-10-09"


def test_same_day_rerun_is_byte_identical():
    db = Db()
    db.run(DAY1, dod_dsip=ok("dod_dsip", make_record("dod_dsip", "A1")))
    before = {rid: record.to_dict() for rid, record in db.records.items()}
    events = db.run(DAY1_LATER, dod_dsip=ok("dod_dsip", make_record("dod_dsip", "A1")))
    assert events == []
    assert {rid: record.to_dict() for rid, record in db.records.items()} == before


def test_status_change_updates_last_changed_and_keeps_first_seen():
    db = Db()
    db.run(DAY1, dod_dsip=ok("dod_dsip", make_record("dod_dsip", "A1", status="pre_release")))
    events = db.run(DAY2, dod_dsip=ok("dod_dsip", make_record("dod_dsip", "A1", status="open")))
    assert kinds(events) == [("dsip:A1", "status")]
    assert (events[0]["from"], events[0]["to"]) == ("pre_release", "open")
    record = db.records["dsip:A1"]
    assert record.status == "open"
    assert record.first_seen == "2026-10-09T06:15:00Z"
    assert record.last_changed == "2026-10-10T06:15:00Z"
    assert record.last_seen == "2026-10-10"


def test_content_change_logs_updated_with_fields():
    db = Db()
    db.run(DAY1, dod_dsip=ok("dod_dsip", make_record("dod_dsip", "A1")))
    old_hash = db.records["dsip:A1"].content_hash
    events = db.run(DAY2, dod_dsip=ok("dod_dsip", make_record("dod_dsip", "A1", description="New text.", close_date="2099-02-01")))
    assert kinds(events) == [("dsip:A1", "updated")]
    assert events[0]["fields"] == ["close_date", "description"]
    assert events[0]["from"] == old_hash and events[0]["to"] == db.records["dsip:A1"].content_hash
    assert db.records["dsip:A1"].last_changed == "2026-10-10T06:15:00Z"
    assert db.records["dsip:A1"].first_seen == "2026-10-09T06:15:00Z"


def test_missing_with_passed_close_date_becomes_closed():
    db = Db()
    db.run(DAY1, dod_dsip=ok("dod_dsip", make_record("dod_dsip", "A1", close_date="2026-10-09"), make_record("dod_dsip", "B2")))
    events = db.run(DAY2, dod_dsip=ok("dod_dsip", make_record("dod_dsip", "B2")))
    assert kinds(events) == [("dsip:A1", "status")]
    assert (events[0]["from"], events[0]["to"]) == ("open", "closed")
    record = db.records["dsip:A1"]
    assert record.status == "closed" and record.last_seen == "2026-10-09"
    assert record.last_changed == "2026-10-10T06:15:00Z"
    # Closed records stay in the database and produce no further events.
    assert db.run(DAY3, dod_dsip=ok("dod_dsip", make_record("dod_dsip", "B2"))) == []
    assert db.records["dsip:A1"].status == "closed"


def test_missing_without_close_date_keeps_status_and_logs_once():
    db = Db()
    keep = make_record("grants_gov", "2")
    db.run(DAY1, grants_gov=ok("grants_gov", make_record("grants_gov", "1", status="forecasted", close_date=None), keep))
    events = db.run(DAY2, grants_gov=ok("grants_gov", keep))
    assert kinds(events) == [("grants:1", "missing")]
    assert events[0]["from"] == "forecasted"
    assert db.records["grants:1"].status == "forecasted"
    assert db.run(DAY3, grants_gov=ok("grants_gov", keep)) == []  # not logged again
    # It comes back, then disappears again: a fresh missing event.
    back = db.run(DAY4, grants_gov=ok("grants_gov", make_record("grants_gov", "1", status="forecasted", close_date=None), keep))
    assert back == [] and db.records["grants:1"].last_seen == "2026-10-12"
    assert kinds(db.run(DAY5, grants_gov=ok("grants_gov", keep))) == [("grants:1", "missing")]


def test_failed_source_never_closes_or_misses():
    db = Db()
    db.run(DAY1, dod_dsip=ok("dod_dsip", make_record("dod_dsip", "A1", close_date="2026-10-09"), make_record("dod_dsip", "B2", close_date=None)))
    before = {rid: record.to_dict() for rid, record in db.records.items()}
    assert db.run(DAY3, dod_dsip=failed("dod_dsip")) == []
    # A run that does not include the source at all is treated the same way.
    assert kinds(db.run(DAY3, sbir_gov=ok("sbir_gov", make_record("sbir_gov", "9")))) == [("sbirgov:9", "new")]
    assert {rid: db.records[rid].to_dict() for rid in before} == before
    assert set(db.snapshots["dod_dsip"]) == {"dsip:A1", "dsip:B2"}


def test_incomplete_run_never_closes_or_misses_unfetched_records():
    db = Db()
    db.run(DAY1, dod_dsip=ok("dod_dsip", make_record("dod_dsip", "A1", close_date="2026-10-09"), make_record("dod_dsip", "B2")))
    events = db.run(DAY2, dod_dsip=ok("dod_dsip", make_record("dod_dsip", "B2"), complete=False))
    assert events == []
    assert db.records["dsip:A1"].status == "open"
    assert set(db.snapshots["dod_dsip"]) == {"dsip:A1", "dsip:B2"}  # limited runs never shrink a snapshot


def test_partial_detail_keeps_previous_content():
    db = Db()
    db.run(DAY1, dod_dsip=ok("dod_dsip", make_record("dod_dsip", "A1", description="Full text from details.")))
    listing_only = make_record("dod_dsip", "A1", description=None)
    events = db.run(DAY2, dod_dsip=ok("dod_dsip", listing_only, partial={"dsip:A1"}))
    assert events == []
    assert db.records["dsip:A1"].description == "Full text from details."
    assert db.records["dsip:A1"].last_seen == "2026-10-10"


def test_dedupe_sbir_gov_and_dsip_by_topic_number():
    db = Db()
    dsip = make_record("dod_dsip", "ARM26BX06-NV012", topic_number="ARM26BX06-NV012", sub_agency="ARMY",
                       status="pre_release", description="Short.", keywords=["uas"])
    sbir = make_record("sbir_gov", "13020", topic_number="arm26bx06 nv012", status="pre_release",
                       description="A much richer description from sbir.gov.", links={"sbir_gov": "https://www.sbir.gov/topics/13020", "official": "https://official.test/"})
    grants_other_agency = make_record("grants_gov", "777", topic_number="ARM26BX06-NV012", agency="HHS")
    events = db.run(DAY1, dod_dsip=ok("dod_dsip", dsip), sbir_gov=ok("sbir_gov", sbir), grants_gov=ok("grants_gov", grants_other_agency))
    assert set(db.records) == {"dsip:ARM26BX06-NV012", "grants:777"}
    merged = db.records["dsip:ARM26BX06-NV012"]
    assert merged.source == "dod_dsip"
    assert merged.alt_ids == ["sbirgov:13020"]
    assert merged.links["sbir_gov"] == "https://www.sbir.gov/topics/13020"
    assert merged.links["dod_dsip"] and merged.links["official"] == "https://official.test/"
    assert merged.description == "A much richer description from sbir.gov."
    assert merged.sub_agency == "ARMY"
    assert sorted(kinds(events)) == [("dsip:ARM26BX06-NV012", "new"), ("grants:777", "new")]


def test_dedupe_when_dsip_appears_after_sbir_gov_preserves_first_seen():
    db = Db()
    sbir = make_record("sbir_gov", "13020", topic_number="N252-001", links={"sbir_gov": "https://www.sbir.gov/topics/13020"})
    db.run(DAY1, sbir_gov=ok("sbir_gov", sbir))
    dsip = make_record("dod_dsip", "N252-001", topic_number="N252-001")
    events = db.run(DAY2, sbir_gov=ok("sbir_gov", sbir), dod_dsip=ok("dod_dsip", dsip))
    # The id stays the one already published; the content now comes from DSIP, the preferred source.
    assert set(db.records) == {"sbirgov:13020"}
    record = db.records["sbirgov:13020"]
    assert record.source == "dod_dsip" and record.alt_ids == ["dsip:N252-001"]
    assert record.first_seen == "2026-10-09T06:15:00Z"
    assert all(event["event"] != "new" for event in events)
    # Next day DSIP fails: its stale snapshot and the sbir.gov hit still map onto the same record.
    assert db.run(DAY3, sbir_gov=ok("sbir_gov", sbir), dod_dsip=failed("dod_dsip")) == []
    assert set(db.records) == {"sbirgov:13020"} and db.records["sbirgov:13020"].last_seen == "2026-10-11"


def test_id_stays_when_the_first_source_drops_the_record():
    db = Db()
    dsip = make_record("dod_dsip", "DON27BZ01-NV003", topic_number="DON27BZ01-NV003")
    sbir = make_record("sbir_gov", "13020", topic_number="DON27BZ01-NV003", links={"sbir_gov": "https://www.sbir.gov/topics/13020"})
    other = make_record("dod_dsip", "OTHER-1", topic_number="OTHER-1")
    db.run(DAY1, dod_dsip=ok("dod_dsip", dsip, other), sbir_gov=ok("sbir_gov", sbir))
    assert set(db.records) == {"dsip:DON27BZ01-NV003", "dsip:OTHER-1"}
    # Day 2: DSIP runs fine but no longer lists the topic; sbir.gov still does.
    events = db.run(DAY2, dod_dsip=ok("dod_dsip", other), sbir_gov=ok("sbir_gov", sbir))
    assert set(db.records) == {"dsip:DON27BZ01-NV003", "dsip:OTHER-1"}
    record = db.records["dsip:DON27BZ01-NV003"]
    assert record.source == "sbir_gov" and record.alt_ids == ["sbirgov:13020"]
    assert record.first_seen == "2026-10-09T06:15:00Z" and record.last_seen == "2026-10-10"
    assert all(event["event"] != "new" for event in events)
    # Day 3: DSIP lists it again: same id, content from DSIP again.
    events = db.run(DAY3, dod_dsip=ok("dod_dsip", dsip, other), sbir_gov=ok("sbir_gov", sbir))
    assert set(db.records) == {"dsip:DON27BZ01-NV003", "dsip:OTHER-1"}
    assert db.records["dsip:DON27BZ01-NV003"].source == "dod_dsip"
    assert all(event["event"] != "new" for event in events)


def test_a_kept_id_still_dedupes_a_source_that_appears_later():
    # dsip:X keeps its id while sbir.gov feeds it; a third source listing the same topic joins it.
    db = Db()
    dsip = make_record("dod_dsip", "DON27BZ01-NV003", topic_number="DON27BZ01-NV003")
    sbir = make_record("sbir_gov", "13020", topic_number="DON27BZ01-NV003", links={"sbir_gov": "https://www.sbir.gov/topics/13020"})
    other = make_record("dod_dsip", "OTHER-1", topic_number="OTHER-1")
    db.run(DAY1, dod_dsip=ok("dod_dsip", dsip, other), sbir_gov=ok("sbir_gov", sbir))
    db.run(DAY2, dod_dsip=ok("dod_dsip", other), sbir_gov=ok("sbir_gov", sbir))
    assert db.records["dsip:DON27BZ01-NV003"].source == "sbir_gov"
    grants = make_record("grants_gov", "777", topic_number="DON27BZ01-NV003")
    events = db.run(DAY3, dod_dsip=ok("dod_dsip", other), sbir_gov=ok("sbir_gov", sbir), grants_gov=ok("grants_gov", grants))
    assert set(db.records) == {"dsip:DON27BZ01-NV003", "dsip:OTHER-1"}
    assert db.records["dsip:DON27BZ01-NV003"].alt_ids == ["grants:777", "sbirgov:13020"]
    assert all(event["event"] != "new" for event in events)


def test_two_published_records_that_come_together_keep_the_first_published_id():
    # sbirgov:Y (day 1) and dsip:X (day 2) are separate records with different topic numbers; on day 3 DSIP
    # corrects its topic number to sbir.gov's, and they share a key: the id published first wins.
    db = Db()
    sbir = make_record("sbir_gov", "13020", topic_number="N252-001", links={"sbir_gov": "https://www.sbir.gov/topics/13020"})
    db.run(DAY1, sbir_gov=ok("sbir_gov", sbir))
    dsip = make_record("dod_dsip", "N252-001X", topic_number="N252-999")
    db.run(DAY2, sbir_gov=ok("sbir_gov", sbir), dod_dsip=ok("dod_dsip", dsip))
    assert set(db.records) == {"sbirgov:13020", "dsip:N252-001X"}
    fixed = make_record("dod_dsip", "N252-001X", topic_number="N252-001")
    events = db.run(DAY3, sbir_gov=ok("sbir_gov", sbir), dod_dsip=ok("dod_dsip", fixed))
    assert set(db.records) == {"sbirgov:13020"}
    record = db.records["sbirgov:13020"]
    assert record.source == "dod_dsip" and record.alt_ids == ["dsip:N252-001X"]
    assert record.first_seen == "2026-10-09T06:15:00Z"
    assert all(event["event"] != "new" for event in events)


def test_an_already_rekeyed_record_keeps_its_published_id():
    # Published as sbirgov:13020 after absorbing dsip:X (the old rule): it does not flip back when DSIP returns.
    db = Db()
    sbir = make_record("sbir_gov", "13020", topic_number="DON27BZ01-NV003", links={"sbir_gov": "https://www.sbir.gov/topics/13020"})
    db.run(DAY1, sbir_gov=ok("sbir_gov", sbir))
    db.records["sbirgov:13020"].alt_ids = ["dsip:DON27BZ01-NV003"]
    dsip = make_record("dod_dsip", "DON27BZ01-NV003", topic_number="DON27BZ01-NV003")
    events = db.run(DAY2, dod_dsip=ok("dod_dsip", dsip), sbir_gov=ok("sbir_gov", sbir))
    assert set(db.records) == {"sbirgov:13020"} and db.records["sbirgov:13020"].source == "dod_dsip"
    assert db.records["sbirgov:13020"].alt_ids == ["dsip:DON27BZ01-NV003"]
    assert all(event["event"] != "new" for event in events)


def test_same_source_records_sharing_a_topic_number_are_not_merged():
    db = Db()
    first = make_record("sbir_gov", "1", topic_number="AF-001")
    second = make_record("sbir_gov", "2", topic_number="AF-001")
    dsip = make_record("dod_dsip", "AF-001", topic_number="AF-001")
    db.run(DAY1, sbir_gov=ok("sbir_gov", first, second), dod_dsip=ok("dod_dsip", dsip))
    assert set(db.records) == {"sbirgov:1", "sbirgov:2", "dsip:AF-001"}


def test_output_is_sorted_and_deterministic():
    def build_db() -> dict[str, Any]:
        db = Db()
        db.run(DAY1, dod_dsip=ok("dod_dsip", *[make_record("dod_dsip", f"T{n}") for n in (3, 1, 2)]))
        return {rid: db.records[rid].to_dict() for rid in sorted(db.records)}

    assert build_db() == build_db()
