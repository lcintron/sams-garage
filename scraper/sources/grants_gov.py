"""Grants.gov search2 + fetchOpportunity (grant-based SBIR/STTR: NIH, HHS, USDA, DOE, NSF, ED, ...).
PLAN.md section 2.3.

Keyword search is fuzzy (it matches agency-wide BAAs and unrelated NIH programs), so hits are kept
only when their title or number actually names the program.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from ..http import HttpClient
from ..model import (
    Record,
    html_to_text,
    make_id,
    normalize_agency_code,
    normalize_phases,
    normalize_program,
    one_line,
    to_iso_date,
)
from .base import ScrapeOptions, SourceResult, parallel_map

NAME = "grants_gov"
SEARCH_URL = "https://api.grants.gov/v1/api/search2"
DETAIL_URL = "https://api.grants.gov/v1/api/fetchOpportunity"
HUMAN_URL = "https://www.grants.gov/search-results-detail/{id}"
KEYWORDS = ("SBIR", "STTR")
OPP_STATUSES = "forecasted|posted"
ROWS = 100
MAX_PAGES = 50

# Title/number evidence that an opportunity is SBIR/STTR. R41/R42 (STTR) and R43/R44 (SBIR) are the NIH
# activity codes; SB1 is the NIH commercialization readiness code.
_PROGRAM_RE = re.compile(
    r"\bSBIR\b|\bSTTR\b|Small\s+Business\s+Innovation|Small\s+Business\s+Technology\s+Transfer"
    r"|Small\s+Business\s+Transition\s+Grant|\bR4[1-4]\b|\bSB1\b",
    re.IGNORECASE,
)
_STATUS_MAP = {"posted": "open", "forecasted": "forecasted", "closed": "closed", "archived": "closed"}

log = logging.getLogger(__name__)


def is_sbir_sttr(hit: dict[str, Any]) -> bool:
    text = f"{hit.get('title') or ''} {hit.get('number') or ''}"
    return bool(_PROGRAM_RE.search(one_line(text)))


def parse_search(payload: dict[str, Any]) -> tuple[list[dict[str, Any]], int]:
    """search2 response -> (hits, hitCount). Raises when the API reports an error."""
    if payload.get("errorcode") not in (0, None):
        raise RuntimeError(f"search2 error {payload.get('errorcode')}: {payload.get('msg')}")
    data = payload.get("data") or {}
    hits = [hit for hit in data.get("oppHits") or [] if isinstance(hit, dict)]
    return hits, int(data.get("hitCount") or 0)


def infer_program(title: str) -> str | None:
    text = title.upper()
    mentions = []
    if re.search(r"\bR4[34]\b|SBIR|SMALL BUSINESS INNOVATION", text):
        mentions.append("SBIR")
    if re.search(r"\bR4[12]\b|STTR|SMALL BUSINESS TECHNOLOGY TRANSFER", text):
        mentions.append("STTR")
    return normalize_program(mentions)


def infer_phases(title: str) -> list[str]:
    text = title.upper()
    phases: list[str] = []
    if re.search(r"PHASE\s+IIB\b", text):
        phases.append("IIB")
    if re.search(r"PHASE\s+II\b|\bR4[24]\b", text):
        phases.append("II")
    if re.search(r"PHASE\s+I\b|\bR4[13]\b", text):
        phases.append("I")
    if re.search(r"PHASE\s+III\b", text):
        phases.append("III")
    if re.search(r"DIRECT[\s-]+TO[\s-]+PHASE\s+II", text):
        phases.append("DP2")
    return normalize_phases(phases)


def _str_date(section: dict[str, Any], key: str) -> str | None:
    """fetchOpportunity has "xxxDateStr": "2027-04-05-00-00-00" next to the human "xxxDate"."""
    return to_iso_date(section.get(f"{key}Str") or section.get(key))


def build_record(hit: dict[str, Any], detail: dict[str, Any] | None) -> Record:
    """Map a search2 hit (+ optional fetchOpportunity ``data``) to a canonical Record."""
    detail = detail or {}
    synopsis: dict[str, Any] = detail.get("synopsis") or {}
    forecast: dict[str, Any] = detail.get("forecast") or {}
    opp_status = one_line(hit.get("oppStatus")).lower()
    is_forecast = opp_status == "forecasted"
    title = one_line(detail.get("opportunityTitle") or hit.get("title"))
    number = one_line(detail.get("opportunityNumber") or hit.get("number")) or None
    agency, sub_agency = normalize_agency_code(hit.get("agencyCode") or detail.get("owningAgencyCode"))

    listed_open = to_iso_date(hit.get("openDate"))
    listed_close = to_iso_date(hit.get("closeDate"))
    extra: dict[str, Any] = {
        "opportunity_number": number,
        "agency_name": one_line(hit.get("agency")),
        "agency_code": one_line(hit.get("agencyCode")),
        "doc_type": one_line(hit.get("docType")),
        "cfda": [one_line(code) for code in hit.get("cfdaList") or []][:10],
    }
    if is_forecast:
        release_date = listed_open or _str_date(forecast, "postingDate")
        open_date = _str_date(forecast, "estSynopsisPostingDate")
        close_date = listed_close or _str_date(forecast, "estApplicationResponseDate")
        description = html_to_text(forecast.get("forecastDesc"))
        extra["estimated_dates"] = bool(open_date or close_date) and not listed_close
        extra["award_ceiling"] = forecast.get("awardCeilingFormatted") or forecast.get("awardCeiling")
        extra["fiscal_year"] = forecast.get("fiscalYear")
        link = forecast.get("fundingDescLinkUrl")
    else:
        release_date = listed_open or _str_date(synopsis, "postingDate")
        open_date = release_date
        close_date = listed_close or _str_date(synopsis, "responseDate")
        description = html_to_text(synopsis.get("synopsisDesc"))
        extra["award_ceiling"] = synopsis.get("awardCeilingFormatted") or synopsis.get("awardCeiling")
        link = synopsis.get("fundingDescLinkUrl")
    if str(extra.get("award_ceiling") or "").lower() == "none":
        extra.pop("award_ceiling")
    year = forecast.get("fiscalYear") if isinstance(forecast.get("fiscalYear"), int) else None
    if year is None and (close_date or open_date):
        year = int((close_date or open_date or "0")[:4]) or None

    record = Record(
        id=make_id(NAME, hit.get("id")),
        source=NAME,
        links={"grants_gov": HUMAN_URL.format(id=one_line(str(hit.get("id")))), "official": link or None},
        title=title,
        agency=agency,
        sub_agency=sub_agency,
        program=infer_program(title),
        phases=infer_phases(title),
        topic_number=number,
        solicitation_number=number,
        status=_STATUS_MAP.get(opp_status, "unknown"),
        release_date=release_date,
        open_date=open_date,
        close_date=close_date,
        description=description or None,
        keywords=[],
        year=year,
        extra=extra,
    )
    return record.finalize()


def collect_hits(client: HttpClient, limit: int | None) -> tuple[list[dict[str, Any]], bool]:
    """Run each keyword search, page through it, dedupe by id and keep real SBIR/STTR hits."""
    by_id: dict[str, dict[str, Any]] = {}
    complete = True
    for keyword in KEYWORDS:
        seen = 0
        for page in range(MAX_PAGES):
            body = {"keyword": keyword, "oppStatuses": OPP_STATUSES, "rows": ROWS, "startRecordNum": page * ROWS}
            hits, total = parse_search(client.post_json(SEARCH_URL, body))
            seen += len(hits)
            for hit in hits:
                if hit.get("id") and is_sbir_sttr(hit):
                    by_id.setdefault(str(hit["id"]), hit)
            log.info("grants_gov: %s page %d -> %d hits (%d of %d), %d kept", keyword, page, len(hits), seen, total, len(by_id))
            if not hits or seen >= total:
                break
        else:
            complete = False
    hits = [by_id[key] for key in sorted(by_id, key=lambda value: (len(value), value))]
    if limit is not None and len(hits) > limit:
        return hits[:limit], False
    return hits, complete and limit is None


def fetch_detail(client: HttpClient, opportunity_id: str) -> dict[str, Any]:
    payload = client.post_json(DETAIL_URL, {"opportunityId": int(opportunity_id)})
    if payload.get("errorcode") not in (0, None) or not isinstance(payload.get("data"), dict):
        raise RuntimeError(f"fetchOpportunity {opportunity_id}: {payload.get('msg')}")
    return payload["data"]


def scrape(client: HttpClient, options: ScrapeOptions) -> SourceResult:
    try:
        hits, complete = collect_hits(client, options.limit)
    except Exception as exc:  # noqa: BLE001
        log.error("grants_gov: search failed: %s", exc)
        return SourceResult(NAME, ok=False, error=str(exc))

    fetched = parallel_map(lambda hit: fetch_detail(client, str(hit["id"])), hits, options.workers)
    records: list[Record] = []
    partial: set[str] = set()
    failed = 0
    for hit, detail, error in fetched:
        if error is not None:
            failed += 1
            log.warning("grants_gov: fetchOpportunity %s failed, using listing fields: %s", hit.get("id"), error)
        record = build_record(hit, detail)
        if error is not None:
            partial.add(record.id)
        records.append(record)
    log.info("grants_gov: %d opportunities, %d detail failures", len(records), failed)
    return SourceResult(
        NAME,
        ok=True,
        complete=complete,
        records=records,
        partial_ids=partial,
        fetched=len(records),
        failed=failed,
    )
