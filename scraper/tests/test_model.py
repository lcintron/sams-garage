"""Normalization helpers and schema validation."""

from __future__ import annotations

import json

from scraper.model import (
    Record,
    bound_extra,
    html_to_text,
    make_summary,
    normalize_agency,
    normalize_agency_code,
    normalize_keywords,
    normalize_phases,
    normalize_program,
    norm_topic_number,
    to_iso_date,
    validate,
)

from .conftest import make_record


def test_to_iso_date_formats():
    assert to_iso_date("October 7, 2026") == "2026-10-07"
    assert to_iso_date("Oct 7, 2026") == "2026-10-07"
    assert to_iso_date("06/16/2025") == "2025-06-16"
    assert to_iso_date("Apr 05, 2027 12:00:00 AM EDT") == "2027-04-05"
    assert to_iso_date("2027-04-05-00-00-00") == "2027-04-05"
    assert to_iso_date(1798045200000) == "2026-12-23"  # 16:00 UTC -> 11:00 ET same day
    assert to_iso_date("") is None and to_iso_date(None) is None and to_iso_date("TBD") is None


def test_agency_normalization():
    assert normalize_agency("DOW") == ("DOD", None)
    assert normalize_agency("Department of Defense") == ("DOD", None)
    assert normalize_agency("NIH") == ("HHS", "NIH")
    assert normalize_agency("Bureau of Something") == ("OTHER", "Bureau of Something")
    assert normalize_agency_code("HHS-NIH11") == ("HHS", "NIH")
    assert normalize_agency_code("USDA-NIFA") == ("USDA", "NIFA")
    assert normalize_agency_code("DOD-AFRL-RW") == ("DOD", "AFRL")
    assert normalize_agency_code("NSF") == ("NSF", None)
    assert normalize_agency_code("DOI-FWS") == ("OTHER", "DOI-FWS")


def test_phase_keyword_and_topic_normalization():
    assert normalize_phases(["Phase II", "BOTH", "D2PII", "2S"]) == ["I", "II", "DP2", "SPII"]
    assert normalize_keywords(["UAS", "uas ", " Acoustic;", "", "x" * 200]) == ["uas", "acoustic"]
    assert norm_topic_number("arm26bx06 - nv012") == norm_topic_number("ARM26BX06-NV012") == "ARM26BX06NV012"
    assert norm_topic_number("TBD") is None and norm_topic_number(None) is None


def test_program_normalization():
    assert normalize_program(["SBIR", "BOTH"]) == "SBIR"  # "BOTH" here is the phase tag
    assert normalize_program(["STTR", "Phase I"]) == "STTR"
    assert normalize_program(["BOTH", "BOTH"]) == "SBIR/STTR"
    assert normalize_program(["SBIR/STTR Commercialization"]) == "SBIR/STTR"
    assert normalize_program(["Phase I"]) is None


def test_html_to_text_paragraphs_and_lists():
    text = html_to_text("<p>One &amp; <b>two</b>\n three.</p><ul><li>a</li><li>b</li></ul><p>Last</p>")
    assert text == "One & two three.\n\n• a\n• b\n\nLast"


def test_summary_respects_sentences_and_limit():
    text = "The U.S. Army needs things. " * 40
    summary = make_summary(text)
    assert len(summary) <= 400 and summary.endswith("things.") and summary.startswith("The U.S. Army needs")
    assert make_summary("x" * 1000).endswith("…")


def test_bound_extra_stays_under_2kb():
    extra = bound_extra({"big": ["y" * 500] * 10, "small": "ok", "empty": "", "long": "z " * 400})
    assert "empty" not in extra and extra["small"] == "ok"
    assert len(json.dumps(extra, separators=(",", ":"))) < 2048
    assert len(extra["long"]) <= 300


def test_validate_accepts_complete_record_and_flags_problems():
    record = make_record("dod_dsip", "A1", topic_number="A1")
    record.first_seen = record.last_changed = "2026-10-09T06:15:00Z"
    record.last_seen = "2026-10-09"
    data = record.to_dict()
    assert validate(data) == []

    broken = dict(data, status="weird", last_seen="2026-10-09T06:15:00Z", agency="XYZ")
    problems = " ".join(validate(broken))
    assert "bad status" in problems and "last_seen" in problems and "unknown agency" in problems

    tampered = dict(data, title="Changed title")
    assert any("content_hash" in problem for problem in validate(tampered))

    missing = {key: value for key, value in data.items() if key != "extra"}
    assert any("missing keys" in problem for problem in validate(missing))


def test_record_round_trip_keeps_key_order():
    record = make_record("grants_gov", "123", extra={"b": 1, "a": 2})
    data = record.to_dict()
    assert list(data)[:3] == ["id", "source", "links"]
    assert list(data["links"]) == ["dod_dsip", "sbir_gov", "grants_gov", "official"]
    assert list(data["extra"]) == ["a", "b"]
    assert Record.from_dict(data).to_dict() == data
