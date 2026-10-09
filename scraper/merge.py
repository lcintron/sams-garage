"""Fold per-source snapshots into the canonical database: dedupe, status lifecycle, seen dates, changelog.

The rules are PLAN.md section 4 ("Status lifecycle" and "Dedupe"), with one storage decision recorded in
scraper/README.md: ``last_seen`` is a date (YYYY-MM-DD) so re-running a scrape on the same day leaves
the database byte-identical; ``first_seen`` and ``last_changed`` are full UTC timestamps.

Inputs
  previous   -- canonical records from data/solicitations.jsonl before this run
  snapshots  -- per-source records *after* this run (``update_snapshot``): what each source currently
                lists, or its previous snapshot when the source failed / was not run
  reported   -- ids that a source actually returned this run
  settled    -- sources that ran OK *and* complete this run; only they may mark absent records
                missing/closed (rule 3: a failed or partial source never closes anything)
"""

from __future__ import annotations

import copy
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable

from .model import HASH_FIELDS, LINK_KEYS, SOURCE_NAMES, SOURCE_PREFERENCE, Record, utc_timestamp
from .sources.base import SourceResult

# Scalar fields a secondary record may fill when the primary has no value.
_FILLABLE = (
    "title",
    "sub_agency",
    "program",
    "phases",
    "topic_number",
    "solicitation_number",
    "solicitation_title",
    "release_date",
    "open_date",
    "close_date",
    "qa_open_date",
    "qa_close_date",
    "summary",
    "year",
)


@dataclass
class MergeOutcome:
    records: dict[str, Record]
    events: list[dict[str, Any]]
    stats: Counter[str] = field(default_factory=Counter)


def update_snapshot(previous: dict[str, Record], result: SourceResult | None) -> dict[str, Record]:
    """New snapshot for one source given its previous snapshot and this run's result.

    * source not run or failed -> previous snapshot unchanged
    * record built without its detail payload -> previous content kept (status refreshed), so a flaky
      detail endpoint does not churn descriptions in and out
    * incomplete run (--limit) -> previous snapshot updated with what was fetched, nothing dropped
    """
    if result is None or not result.ok:
        return dict(previous)
    fresh: dict[str, Record] = {}
    for record in result.records:
        old = previous.get(record.id)
        if record.id in result.partial_ids and old is not None:
            kept = copy.deepcopy(old)
            kept.status = record.status
            fresh[record.id] = kept.finalize()
        else:
            fresh[record.id] = record
    if result.complete:
        return fresh
    return {**previous, **fresh}


def run_merge(
    previous: dict[str, Record],
    snapshots: dict[str, dict[str, Record]],
    results: dict[str, SourceResult],
    changelog: Iterable[dict[str, Any]],
    now: datetime,
) -> tuple[MergeOutcome, dict[str, dict[str, Record]]]:
    """One scrape run: update every source snapshot from ``results`` then merge. Returns (outcome, snapshots)."""
    new_snapshots = {source: update_snapshot(snapshots.get(source, {}), results.get(source)) for source in SOURCE_NAMES}
    ok = [name for name, result in results.items() if result.ok]
    reported = {record.id for name in ok for record in results[name].records}
    settled = {name for name in ok if results[name].complete}
    return merge(previous, new_snapshots, reported, settled, changelog, now), new_snapshots


def merge(
    previous: dict[str, Record],
    snapshots: dict[str, dict[str, Record]],
    reported: set[str],
    settled: set[str],
    changelog: Iterable[dict[str, Any]],
    now: datetime,
) -> MergeOutcome:
    """Produce the new canonical record set plus the changelog events for this run."""
    clock = _Clock(now)
    missing_since = _latest_missing(changelog)
    snapshot_records = [record for source in SOURCE_NAMES for record in snapshots.get(source, {}).values()]
    groups = _cluster(snapshot_records, list(previous.values()))

    records: dict[str, Record] = {}
    events: list[dict[str, Any]] = []
    for members, priors in groups:
        if members:
            record, record_events = _merge_group(members, priors, reported, clock)
            records[record.id] = record
            events.extend(record_events)
        else:
            for prior in priors:
                record, record_events = _carry(prior, settled, missing_since, clock)
                records[record.id] = record
                events.extend(record_events)

    order = {"new": 0, "status": 1, "updated": 2, "missing": 3}
    events.sort(key=lambda event: (event["id"], order.get(event["event"], 9)))
    return MergeOutcome(records=records, events=events, stats=Counter(event["event"] for event in events))


# --------------------------------------------------------------------------------------------------
# Clustering (dedupe)
# --------------------------------------------------------------------------------------------------


class _DisjointSet:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, node: str) -> str:
        self.parent.setdefault(node, node)
        root = node
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[node] != root:
            self.parent[node], node = root, self.parent[node]
        return root

    def union(self, a: str, b: str) -> None:
        root_a, root_b = self.find(a), self.find(b)
        if root_a != root_b:
            low, high = sorted((root_a, root_b))
            self.parent[high] = low


def _cluster(snapshot_records: list[Record], previous: list[Record]) -> list[tuple[list[Record], list[Record]]]:
    """Group snapshot records and previous canonical records that describe the same opportunity.

    Links: a previous record to each of its alt_ids, and any records sharing a dedupe key
    (agency + normalized topic number). A key only links records when no source has two different
    records with it, so two distinct topics from one source are never folded together.
    """
    ids_by_key: dict[tuple[str, str], dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for record in [*snapshot_records, *previous]:
        key = record.dedupe_key()
        if key:
            ids_by_key[key][record.source].add(record.id)
    mergeable = {key for key, by_source in ids_by_key.items() if all(len(ids) == 1 for ids in by_source.values())}

    sets = _DisjointSet()
    for record in [*snapshot_records, *previous]:
        node = f"id:{record.id}"
        sets.find(node)
        key = record.dedupe_key()
        if key in mergeable:
            sets.union(node, "key:" + "|".join(key))
    for record in previous:
        for alt in record.alt_ids:
            sets.union(f"id:{record.id}", f"id:{alt}")

    grouped: dict[str, tuple[list[Record], list[Record]]] = defaultdict(lambda: ([], []))
    for record in snapshot_records:
        grouped[sets.find(f"id:{record.id}")][0].append(record)
    for record in previous:
        grouped[sets.find(f"id:{record.id}")][1].append(record)
    return [grouped[root] for root in sorted(grouped)]


def combine(members: list[Record], priors: list[Record]) -> Record:
    """Fold a cluster into one record. Primary = most preferred source (dod_dsip > sbir_gov > grants_gov);
    secondaries fill empty fields, contribute links/keywords, and the longest description wins."""
    ordered = sorted(members, key=lambda record: (SOURCE_PREFERENCE[record.source], record.id))
    primary = copy.deepcopy(ordered[0])
    for other in ordered[1:]:
        for name in _FILLABLE:
            if _empty(getattr(primary, name)) and not _empty(getattr(other, name)):
                setattr(primary, name, copy.deepcopy(getattr(other, name)))
        if len(other.description or "") > len(primary.description or ""):
            primary.description = other.description
            if other.summary:
                primary.summary = other.summary
        primary.keywords = [*primary.keywords, *other.keywords]
        primary.technology_areas = [*primary.technology_areas, *other.technology_areas]
        _fill_links(primary, other)
    for prior in priors:
        _fill_links(primary, prior)
    absorbed = {record.id for record in ordered} | {prior.id for prior in priors}
    absorbed |= {alt for prior in priors for alt in prior.alt_ids}
    primary.alt_ids = sorted(absorbed - {primary.id})
    return primary.finalize()


def _fill_links(target: Record, other: Record) -> None:
    for key in LINK_KEYS:
        if not target.links.get(key) and other.links.get(key):
            target.links[key] = other.links[key]


def _empty(value: Any) -> bool:
    return value is None or value == "" or value == []


# --------------------------------------------------------------------------------------------------
# Lifecycle
# --------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Clock:
    now: datetime

    @property
    def timestamp(self) -> str:
        return utc_timestamp(self.now)

    @property
    def today(self) -> str:
        return self.timestamp[:10]


def _merge_group(
    members: list[Record], priors: list[Record], reported: set[str], clock: _Clock
) -> tuple[Record, list[dict[str, Any]]]:
    """Lifecycle for a record some source still lists (rule 1, plus rule 3 for stale snapshots)."""
    record = combine(members, priors)
    prior = _pick_prior(record.id, priors)
    seen_now = [member for member in members if member.id in reported]
    if seen_now:
        best = min(seen_now, key=lambda member: (SOURCE_PREFERENCE[member.source], member.id))
        record.status = best.status
        record.last_seen = clock.today
    elif prior is not None:
        # Only stale snapshots of failed/partial sources: nothing new is known, keep the old state.
        record.status = prior.status
        record.last_seen = prior.last_seen
    else:
        record.last_seen = clock.today
    record.finalize()
    first_seen = sorted(p.first_seen for p in priors if p.first_seen)
    record.first_seen = first_seen[0] if first_seen else clock.timestamp
    return record, _diff_events(record, prior, clock)


def _carry(
    prior: Record, settled: set[str], missing_since: dict[str, str], clock: _Clock
) -> tuple[Record, list[dict[str, Any]]]:
    """Lifecycle for a record no source lists any more (rules 2 and 3)."""
    record = copy.deepcopy(prior)
    contributors = {source for source in SOURCE_NAMES if record.links.get(source)} or {record.source}
    if not contributors <= settled or record.status == "closed":
        return record, []
    if record.close_date and record.close_date < clock.today:
        record.status = "closed"
        record.finalize()
        return record, _diff_events(record, prior, clock)
    last_missing = missing_since.get(record.id, "")
    if last_missing[:10] >= (record.last_seen or ""):
        return record, []  # already logged since it was last seen
    return record, [_event(clock, record.id, "missing", record.status, None)]


def _pick_prior(record_id: str, priors: list[Record]) -> Record | None:
    """The previous record this one continues: same id, else the earliest-seen absorbed record."""
    for prior in priors:
        if prior.id == record_id:
            return prior
    if not priors:
        return None
    return min(priors, key=lambda prior: (prior.first_seen or "", prior.id))


def _diff_events(record: Record, prior: Record | None, clock: _Clock) -> list[dict[str, Any]]:
    """Set last_changed and emit new/status/updated events by comparing with the previous version."""
    if prior is None:
        record.last_changed = clock.timestamp
        return [_event(clock, record.id, "new", None, record.status)]
    if record.content_hash == prior.content_hash:
        record.last_changed = prior.last_changed or clock.timestamp
        return []
    record.last_changed = clock.timestamp
    events: list[dict[str, Any]] = []
    if record.status != prior.status:
        events.append(_event(clock, record.id, "status", prior.status, record.status))
    changed = [name for name in HASH_FIELDS if name != "status" and getattr(record, name) != getattr(prior, name)]
    if changed:
        event = _event(clock, record.id, "updated", prior.content_hash, record.content_hash)
        event["fields"] = changed
        events.append(event)
    return events


def _event(clock: _Clock, record_id: str, kind: str, before: Any, after: Any) -> dict[str, Any]:
    return {"at": clock.timestamp, "id": record_id, "event": kind, "from": before, "to": after}


def _latest_missing(changelog: Iterable[dict[str, Any]]) -> dict[str, str]:
    latest: dict[str, str] = {}
    for event in changelog:
        if event.get("event") == "missing" and event.get("id"):
            latest[event["id"]] = max(latest.get(event["id"], ""), str(event.get("at") or ""))
    return latest
