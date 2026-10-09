"""Parser tests for each source against saved live responses."""

from __future__ import annotations

import json
from datetime import date
from urllib.parse import parse_qs, urlparse

from scraper.model import validate
from scraper.sources import dod_dsip, grants_gov, sbir_gov

from .conftest import fixture_json, fixture_text

TODAY = date(2026, 10, 9)


# --------------------------------------------------------------------------------------------------
# sbir.gov
# --------------------------------------------------------------------------------------------------


def test_sbir_listing_page():
    topics, has_next, total = sbir_gov.parse_listing(fixture_text("sbir_listing.html"))
    assert len(topics) == 10
    assert has_next is True
    assert total == 352
    topic = next(t for t in topics if t.native_id == "13023")
    assert topic.url == "https://www.sbir.gov/topics/13023"
    assert topic.title == "Counter-Unmanned Aerial Systems Rapid Maturation"
    assert topic.status == "Open"
    assert (topic.release_date, topic.open_date, topic.close_date) == ("October 7, 2026", "October 28, 2026", "November 25, 2026")
    assert topic.tags == ["SBIR", "BOTH"]
    assert topic.agency == "DOD"
    assert topic.summary and topic.summary.startswith("Inexpensive, highly maneuverable")


def test_sbir_detail_page():
    detail = sbir_gov.parse_detail(fixture_text("sbir_detail.html"))
    assert detail["title"] == "Counter-Unmanned Aerial Systems Rapid Maturation"
    assert detail["status"] == "Open"
    assert (detail["agency"], detail["sub_agency"]) == ("DOW", "OSD")
    assert detail["year"] == "2027"
    assert detail["topic_number"] == "OSW27BZ01-NV001"
    assert detail["solicitation_number"] == "27.BZ"
    assert detail["release_schedule"]["close_date"] == "November 25, 2026"
    assert detail["official_solicitation_url"] == "https://www.dodsbirsttr.mil/topics-app/"
    # Paragraph breaks in the white-space:pre description survive.
    assert "UAS remains.\n\nThis topic seeks" in detail["description"]
    # The sbir.gov boilerplate NOTE is never carried into extra.
    assert "note" not in detail["extra_fields"]


def test_sbir_record():
    topics, _, _ = sbir_gov.parse_listing(fixture_text("sbir_listing.html"))
    listing = next(t for t in topics if t.native_id == "13023")
    record = sbir_gov.build_record(listing, sbir_gov.parse_detail(fixture_text("sbir_detail.html")), TODAY)
    assert record.id == "sbirgov:13023"
    assert record.agency == "DOD" and record.sub_agency == "OSD"
    assert record.program == "SBIR" and record.phases == ["I", "II"]
    assert (record.release_date, record.open_date, record.close_date) == ("2026-10-07", "2026-10-28", "2026-11-25")
    assert record.status == "pre_release"  # listed "Open" but opens in the future
    assert record.year == 2027
    assert record.links["sbir_gov"] == "https://www.sbir.gov/topics/13023"
    assert record.extra == {"funding_agency": "DOW"}
    # sbir.gov tags NSF topics ["BOTH", "BOTH"]: open to both programs.
    nsf = sbir_gov.ListingTopic(url="https://www.sbir.gov/topics/1012287", title="Building and Infrastructure",
                                status="Open", summary=None, release_date="May 22, 2026", open_date="May 22, 2026",
                                close_date="July 7, 2027", tags=["BOTH", "BOTH"], agency="NSF")
    nsf_record = sbir_gov.build_record(nsf, None, TODAY)
    assert nsf_record.program == "SBIR/STTR" and nsf_record.phases == ["I", "II"]
    assert record.summary and len(record.summary) <= 400
    # Once the open date passes the same listing reads as open.
    assert sbir_gov.build_record(listing, None, date(2026, 10, 28)).status == "open"


def test_sbir_listing_only_record_is_valid_shape():
    topics, _, _ = sbir_gov.parse_listing(fixture_text("sbir_listing.html"))
    record = sbir_gov.build_record(topics[0], None, TODAY)
    assert record.title and record.agency == "DOD"
    assert record.description is None
    assert record.summary and record.summary.startswith("Fouling on the TDR sensor")


# --------------------------------------------------------------------------------------------------
# DoD DSIP
# --------------------------------------------------------------------------------------------------


def test_dsip_search_url_is_get_with_search_param():
    url = dod_dsip.search_url(2)
    query = parse_qs(urlparse(url).query)
    assert query["size"] == ["100"] and query["page"] == ["2"]
    param = json.loads(query["searchParam"][0])
    assert param["topicReleaseStatus"] == [591, 592]
    assert param["sortBy"] == "finalTopicCode,asc"


def test_dsip_parse_search_and_phases():
    topics, total = dod_dsip.parse_search(fixture_json("dsip_search.json"))
    assert total == 4 and len(topics) == 4
    first = topics[0]
    assert dod_dsip.parse_phases(first["phaseHierarchy"]) == ["II", "DP2", "SPII"]
    assert dod_dsip.parse_phases('{"config": [{"phase": "1", "displayValue": "I", "hasConfiguration": "Y"}, '
                                 '{"phase": "2S", "displayValue": "SPII", "hasConfiguration": "N"}]}') == ["I"]
    assert dod_dsip.parse_phases("not json") == []


def test_dsip_record_with_details():
    topics, _ = dod_dsip.parse_search(fixture_json("dsip_search.json"))
    details = fixture_json("dsip_details.json")
    topic = next(t for t in topics if t["topicId"] == details["topicId"])
    record = dod_dsip.build_record(topic, details)
    assert record.id == "dsip:ARM26BX03-DP007"
    assert record.source == "dod_dsip" and record.agency == "DOD" and record.sub_agency == "ARMY"
    assert record.status == "pre_release"
    assert record.program == "SBIR"
    assert record.solicitation_number == "26.BX" and record.solicitation_title == "DoW SBIR 2026 CSO"
    # Epoch milliseconds -> ISO dates (US Eastern).
    assert (record.release_date, record.open_date, record.close_date) == ("2026-06-03", "2026-11-25", "2026-12-23")
    assert (record.qa_open_date, record.qa_close_date) == ("2026-06-03", "2026-12-09")
    assert record.year == 2026
    assert record.description.startswith("Objective:\nThe U.S. Army is seeking")
    assert "\n\nPhase I:\n" in record.description and "<p>" not in record.description
    assert record.summary.startswith("The U.S. Army is seeking")
    # keywords are the topic's own keywords only; technology/focus areas stay in their own fields.
    assert record.keywords[:2] == ["xtech", "autonomy"] and len(record.keywords) == 11
    assert "sensors" not in record.keywords and "Sensors" in record.technology_areas
    assert "Quantum Science" in record.extra["focus_areas"]
    assert all(k == k.lower() for k in record.keywords)
    assert record.links["dod_dsip"] == "https://www.dodsbirsttr.mil/topics-app/"
    assert record.links["official"].endswith("/download/PDF")
    assert record.extra["topic_id"] == details["topicId"]
    assert len(json.dumps(record.extra)) < 2048


def test_dsip_record_without_details_and_open_status():
    topics, _ = dod_dsip.parse_search(fixture_json("dsip_search.json"))
    topic = next(t for t in topics if t["topicStatus"] == "Open")
    record = dod_dsip.build_record(topic, None)
    assert record.status == "open"
    assert record.description is None and record.title


# --------------------------------------------------------------------------------------------------
# Grants.gov
# --------------------------------------------------------------------------------------------------


def _hits():
    hits, total = grants_gov.parse_search(fixture_json("grants_search.json"))
    return hits, total


def test_grants_search_filter():
    hits, total = _hits()
    assert total == 28 and len(hits) == 28
    kept = {hit["number"] for hit in hits if grants_gov.is_sbir_sttr(hit)}
    assert {"PA-27-100", "PA-27-102", "HHS-2027-ACL-NIDILRR-BISA-0308", "USDA-NIFA-SBIR-012221"} <= kept
    # Fuzzy keyword matches without SBIR/STTR in title or number are dropped.
    assert not kept & {"PD-98-1331", "HR001126S0015", "FA8651-22-S0021", "PAR-27-032"}


def test_grants_posted_record_with_detail():
    hits, _ = _hits()
    hit = next(h for h in hits if h["id"] == "359671")
    record = grants_gov.build_record(hit, fixture_json("grants_detail_posted.json")["data"])
    assert record.id == "grants:359671"
    assert (record.agency, record.sub_agency) == ("HHS", "NIH")
    assert record.status == "open"
    assert record.program == "SBIR" and record.phases == ["I", "II"]
    assert record.topic_number == "PA-27-100"
    assert (record.open_date, record.close_date) == ("2026-05-28", "2027-04-05")
    assert record.description.startswith("The Small Business Innovation Research (SBIR) program")
    assert record.links["grants_gov"] == "https://www.grants.gov/search-results-detail/359671"


def test_grants_forecast_record_with_detail():
    hits, _ = _hits()
    hit = next(h for h in hits if h["id"] == "363966")
    record = grants_gov.build_record(hit, fixture_json("grants_detail_forecast.json")["data"])
    assert record.status == "forecasted"
    assert (record.agency, record.sub_agency) == ("HHS", "ACL")
    assert record.phases == ["I"]
    assert (record.release_date, record.open_date, record.close_date) == ("2026-09-25", "2026-10-16", "2026-12-16")
    assert record.extra["estimated_dates"] is True
    assert record.year == 2027
    assert record.links["official"] == "https://www.acl.gov/grants/applying-grants"


def test_grants_listing_only_fallback_and_entities():
    hits, _ = _hits()
    hit = next(h for h in hits if h["number"] == "TEMP-30794")
    record = grants_gov.build_record(hit, None)
    assert "&rsquo;" not in record.title and "\u2019" in record.title
    assert record.status == "forecasted" and record.description is None
    sttr = grants_gov.build_record(next(h for h in hits if h["number"] == "PA-27-102"), None)
    assert sttr.program == "STTR" and sttr.phases == ["I", "II"]


def test_every_fixture_record_passes_schema_once_lifecycle_is_set():
    topics, _ = dod_dsip.parse_search(fixture_json("dsip_search.json"))
    records = [dod_dsip.build_record(topic, None) for topic in topics]
    hits, _ = _hits()
    records += [grants_gov.build_record(hit, None) for hit in hits if grants_gov.is_sbir_sttr(hit)]
    listing, _, _ = sbir_gov.parse_listing(fixture_text("sbir_listing.html"))
    records += [sbir_gov.build_record(topic, None, TODAY) for topic in listing]
    for record in records:
        record.first_seen = record.last_changed = "2026-10-09T06:15:00Z"
        record.last_seen = "2026-10-09"
        assert validate(record.to_dict()) == [], record.id


def _listing_html(ids: list[int], page: int, last_page: int, total: int) -> str:
    hits = "".join(
        f'<h3><a href="/topics/{n}">Topic {n}</a></h3>'
        f'<p><span class="bg-green">Open</span><b>Release Date:</b> October 7, 2026'
        f'<span><b>Open Date:</b> October 7, 2026</span><span><b>Close Date:</b> November 25, 2026</span></p>'
        f'<div><p class="measure-6">Summary {n}</p></div>'
        for n in ids
    )
    pager = f'<a href="?status=Open&page={page + 1}" title="Go to next page">Next</a>' if page < last_page else ""
    return f'<main><p>Showing 1-2 of {total} results</p><div id="search-results-hits">{hits}</div>{pager}</main>'


class _UnstableListing:
    """Two pages of two topics each over three topics; the first walk returns a duplicate instead of topic 3."""

    def __init__(self) -> None:
        self.walks = 0

    def get_text(self, url: str, params=None) -> str:
        page = int(parse_qs(urlparse(url).query)["page"][0])
        if page == 0:
            self.walks += 1
            return _listing_html([1, 2], 0, 1, 3)
        return _listing_html([2] if self.walks == 1 else [3], 1, 1, 3)


def test_sbir_listing_rewalks_until_total_is_collected():
    client = _UnstableListing()
    topics, complete = sbir_gov.collect_listing(client, limit=None)  # type: ignore[arg-type]
    assert [topic.native_id for topic in topics] == ["1", "2", "3"]
    assert complete is True and client.walks == 2


def test_sbir_listing_limit_marks_incomplete():
    topics, complete = sbir_gov.collect_listing(_UnstableListing(), limit=2)  # type: ignore[arg-type]
    assert len(topics) == 2 and complete is False


# --------------------------------------------------------------------------------------------------
# NSF description enrichment (seedfund.nsf.gov topic pages)
# --------------------------------------------------------------------------------------------------

from scraper.sources import nsf_enrich  # noqa: E402


def _nsf_topics():
    return [
        nsf_enrich.parse_topic_page(fixture_text("nsf_topic_advanced_materials.html"), "https://seedfund.nsf.gov/topics/advanced-materials/"),
        nsf_enrich.parse_topic_page(fixture_text("nsf_topic_distributed_ledger.html"), "https://seedfund.nsf.gov/topics/distributed-ledger/"),
    ]


def _nsf_record(native: str, topic_number: str, title: str, **overrides):
    listing = sbir_gov.ListingTopic(url=f"https://www.sbir.gov/topics/{native}", title=title, status="Open", summary=None,
                                    release_date="May 22, 2026", open_date="May 22, 2026", close_date="July 7, 2027",
                                    tags=["BOTH", "BOTH"], agency="NSF")
    record = sbir_gov.build_record(listing, {"topic_number": topic_number, "agency": "NSF"}, TODAY)
    for key, value in overrides.items():
        setattr(record, key, value)
    return record.finalize()


def test_nsf_sitemap_and_topic_pages():
    urls = nsf_enrich.topic_urls(fixture_text("nsf_sitemap.xml"))
    assert urls == ["https://seedfund.nsf.gov/topics/advanced-materials/", "https://seedfund.nsf.gov/topics/distributed-ledger/",
                    "https://seedfund.nsf.gov/topics/robotics/"]
    materials, ledger = _nsf_topics()
    assert (materials.code, materials.name) == ("AM", "Advanced Materials")
    assert materials.description.startswith("The Advanced Materials topic addresses")
    assert "AM1" not in materials.description  # the subtopic list is not part of the description
    assert (ledger.code, ledger.name) == (None, "Distributed Ledger")  # heading is empty; name from <title>
    assert ledger.description.startswith("The Distributed Ledger topic area covers")


def test_nsf_enrich_matches_by_code_and_parent_name():
    records = [
        _nsf_record("1", "AM3", "Metals and Ceramics"),
        _nsf_record("2", "DL", "Distributed Ledger"),
        _nsf_record("3", "DL4", "Supply Chain"),
        _nsf_record("4", "QT1", "Quantum Sensing"),  # no page in this fixture set
        _nsf_record("5", "AM1", "Already described", description="Own text."),
    ]
    enriched, filled = nsf_enrich.enrich(records, _nsf_topics())
    assert filled == 3
    by_id = {record.id: record for record in enriched}
    metals = by_id["sbirgov:1"]
    assert metals.description.startswith("NSF technology topic: Advanced Materials (AM)\n\nThe Advanced Materials topic")
    assert metals.summary.startswith("The Advanced Materials topic addresses")
    assert metals.extra["description_source"] == "https://seedfund.nsf.gov/topics/advanced-materials/"
    assert metals.id == "sbirgov:1" and metals.source == "sbir_gov" and metals.program == "SBIR/STTR"
    assert by_id["sbirgov:3"].description.startswith("NSF technology topic: Distributed Ledger\n\n")
    assert by_id["sbirgov:4"].description is None
    assert by_id["sbirgov:5"].description == "Own text."
    for record in enriched:
        record.first_seen = record.last_changed = "2026-10-09T06:15:00Z"
        record.last_seen = "2026-10-09"
        assert validate(record.to_dict()) == []


class _DeadClient:
    def get_text(self, url, params=None):
        raise RuntimeError("seedfund.nsf.gov is down")


def test_nsf_enrichment_failure_keeps_records():
    records = [_nsf_record("1", "AM3", "Metals and Ceramics")]
    assert nsf_enrich.enrich_nsf(_DeadClient(), records, workers=2) == records  # type: ignore[arg-type]
