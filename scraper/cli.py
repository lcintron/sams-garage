"""Command line: ``python -m scraper {scrape,build,status,validate}`` (PLAN.md section 8).

Progress logs go to stderr; each command prints a one-line summary to stdout.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .build import build, counts
from .http import HttpClient
from .merge import run_merge
from .model import ID_RE, SOURCE_NAMES, utc_timestamp, validate
from .sources import SOURCES
from .sources.base import ScrapeOptions, SourceResult
from .store import DataDir, read_jsonl

log = logging.getLogger("scraper")

DEFAULT_DATA_DIR = "data"
DEFAULT_OUT_DIR = os.path.join("site", "data")


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    return int(args.handler(args))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m scraper", description="SAM's Garage data pipeline.")
    parser.add_argument("--data-dir", default=DEFAULT_DATA_DIR, help="database directory (default: data)")
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    commands = parser.add_subparsers(dest="command", required=True)

    scrape = commands.add_parser("scrape", help="fetch sources and update data/")
    which = scrape.add_mutually_exclusive_group(required=True)
    which.add_argument("--all", action="store_true", help="scrape every source")
    which.add_argument("--source", action="append", choices=list(SOURCES), help="scrape one source (repeatable)")
    scrape.add_argument("--limit", type=_positive_int, default=None, help="cap records per source (debug)")
    scrape.add_argument("--workers", type=_positive_int, default=8, help="parallel detail fetches (default 8)")
    scrape.add_argument("--delay", type=float, default=0.2, help="seconds between request starts (default 0.2)")
    scrape.add_argument("--timeout", type=float, default=30.0, help="per-request timeout in seconds")
    scrape.set_defaults(handler=cmd_scrape)

    build_cmd = commands.add_parser("build", help="build site data artifacts from data/")
    build_cmd.add_argument("--out", default=DEFAULT_OUT_DIR, help="output directory (default: site/data)")
    build_cmd.set_defaults(handler=cmd_build)

    commands.add_parser("status", help="summarize data/meta.json").set_defaults(handler=cmd_status)
    commands.add_parser("validate", help="schema-check data/").set_defaults(handler=cmd_validate)
    return parser


def _positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be >= 1")
    return number


# --------------------------------------------------------------------------------------------------
# scrape
# --------------------------------------------------------------------------------------------------


def cmd_scrape(args: argparse.Namespace) -> int:
    data = DataDir(args.data_dir)
    selected = list(SOURCES) if args.all else list(dict.fromkeys(args.source))
    now = datetime.now(timezone.utc)
    options = ScrapeOptions(today=now.date(), limit=args.limit, workers=min(args.workers, 8), delay=max(0.0, args.delay))

    results: dict[str, SourceResult] = {}
    ran_at: dict[str, str] = {}
    for name in selected:
        log.info("%s: starting", name)
        client = HttpClient(timeout=args.timeout, delay=options.delay)
        ran_at[name] = utc_timestamp(datetime.now(timezone.utc))
        try:
            results[name] = SOURCES[name].scrape(client, options)
        except Exception as exc:  # noqa: BLE001 - a bug in one source must not lose the others' data
            log.exception("%s: crashed", name)
            results[name] = SourceResult(name, ok=False, error=f"{type(exc).__name__}: {exc}")
        finally:
            client.session.close()

    ok = [name for name in selected if results[name].ok]
    for name in selected:
        if not results[name].ok:
            _warn(f"source {name} failed: {results[name].error}")

    previous = data.load_records()
    outcome, new_snapshots = run_merge(previous, data.load_snapshots(), results, data.load_changelog(), now)

    if ok:
        for name in ok:
            data.save_snapshot(name, new_snapshots[name].values())
        data.save_records(outcome.records.values())
        data.append_changelog(outcome.events)
    meta = _scrape_meta(data.load_meta(), results, ran_at, new_snapshots, list(outcome.records.values()) if ok else list(previous.values()), outcome.stats if ok else Counter(), now)
    data.save_meta(meta)

    summary = meta["counts"]["by_status"]
    print(
        f"scrape: {meta['counts']['total']} records ("
        + ", ".join(f"{status} {count}" for status, count in summary.items())
        + f"); events: {_format_counter(outcome.stats) if ok else 'none'}; sources ok: "
        + (", ".join(f"{name}({results[name].fetched})" for name in ok) or "none")
        + ("; failed: " + ", ".join(name for name in selected if name not in ok) if len(ok) < len(selected) else "")
    )
    return 0 if ok else 1


def _scrape_meta(
    previous_meta: dict[str, Any],
    results: dict[str, SourceResult],
    ran_at: dict[str, str],
    snapshots: dict[str, dict[str, Any]],
    records: list[Any],
    stats: Counter[str],
    now: datetime,
) -> dict[str, Any]:
    sources: dict[str, Any] = dict(previous_meta.get("sources") or {})
    for name, result in results.items():
        sources[name] = {
            "ran_at": ran_at[name],
            "ok": result.ok,
            "complete": result.complete,
            "fetched": result.fetched,
            "failed": result.failed,
            "error": result.error,
            "records": len(snapshots.get(name, {})),
        }
    all_counts = counts(sorted(records, key=lambda record: record.id))
    return {
        "last_run": utc_timestamp(now),
        "sources": {name: sources[name] for name in sorted(sources)},
        "counts": {key: all_counts[key] for key in ("total", "by_status", "by_agency")},
        "last_run_events": {kind: stats.get(kind, 0) for kind in ("new", "status", "updated", "missing")},
    }


def _warn(message: str) -> None:
    log.warning(message)
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::warning::{message}", flush=True)


def _format_counter(counter: Counter[str]) -> str:
    return ", ".join(f"{kind} {count}" for kind, count in sorted(counter.items())) or "none"


# --------------------------------------------------------------------------------------------------
# build / status / validate
# --------------------------------------------------------------------------------------------------


def cmd_build(args: argparse.Namespace) -> int:
    sizes = build(args.data_dir, args.out)
    print(f"build: wrote {args.out} (" + ", ".join(f"{name} {size:,} B" for name, size in sizes.items()) + ")")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    meta = DataDir(args.data_dir).load_meta()
    if not meta:
        print(f"status: no {Path(args.data_dir) / 'meta.json'} yet; run `python -m scraper scrape --all`")
        return 1
    lines = [f"last run: {meta.get('last_run')}"]
    for name, info in (meta.get("sources") or {}).items():
        state = "ok" if info.get("ok") else "FAILED"
        detail = f"fetched {info.get('fetched')}, detail failures {info.get('failed')}, snapshot {info.get('records')}"
        if not info.get("complete") and info.get("ok"):
            detail += ", partial"
        if info.get("error"):
            detail += f", error: {info['error']}"
        lines.append(f"  {name:<11} {state:<6} at {info.get('ran_at')}  ({detail})")
    totals = meta.get("counts") or {}
    lines.append(f"records: {totals.get('total', 0)}")
    lines.append("  by status: " + ", ".join(f"{k} {v}" for k, v in (totals.get("by_status") or {}).items()))
    lines.append("  by agency: " + ", ".join(f"{k} {v}" for k, v in (totals.get("by_agency") or {}).items()))
    events = meta.get("last_run_events") or {}
    lines.append("last run events: " + ", ".join(f"{k} {v}" for k, v in events.items()))
    print("\n".join(lines))
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    data = DataDir(args.data_dir)
    problems: list[str] = []
    rows = read_jsonl(data.solicitations)
    if not rows:
        problems.append(f"{data.solicitations}: no records")
    ids = [str(row.get("id")) for row in rows]
    if ids != sorted(ids):
        problems.append(f"{data.solicitations}: not sorted by id")
    duplicates = [rid for rid, count in Counter(ids).items() if count > 1]
    if duplicates:
        problems.append(f"{data.solicitations}: duplicate ids {duplicates[:5]}")
    for row in rows:
        problems.extend(validate(row))
    for source in SOURCE_NAMES:
        snapshot_ids = [str(row.get("id")) for row in read_jsonl(data.snapshot(source))]
        if snapshot_ids != sorted(set(snapshot_ids)):
            problems.append(f"{data.snapshot(source)}: not sorted/unique by id")
    for number, event in enumerate(read_jsonl(data.changelog), start=1):
        if set(event) - {"fields"} != {"at", "id", "event", "from", "to"} or not ID_RE.match(str(event.get("id"))):
            problems.append(f"{data.changelog}:{number}: malformed event")
        elif event["event"] not in {"new", "status", "updated", "missing"}:
            problems.append(f"{data.changelog}:{number}: unknown event {event['event']!r}")
    for problem in problems[:200]:
        print(problem, file=sys.stderr)
    if problems:
        print(f"validate: {len(problems)} problem(s) in {len(rows)} records")
        return 1
    print(f"validate: {len(rows)} records OK")
    return 0
