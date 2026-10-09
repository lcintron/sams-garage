"""Reading and writing the committed database under data/ (JSONL sorted by id, LF line endings)."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Iterable

from .model import Record, SOURCE_NAMES

SOLICITATIONS = "solicitations.jsonl"
CHANGELOG = "changelog.jsonl"
META = "meta.json"
SOURCES_DIR = "sources"


class DataDir:
    """Paths and I/O for one data directory (``data/`` by default)."""

    def __init__(self, root: str | os.PathLike[str]) -> None:
        self.root = Path(root)

    @property
    def solicitations(self) -> Path:
        return self.root / SOLICITATIONS

    @property
    def changelog(self) -> Path:
        return self.root / CHANGELOG

    @property
    def meta(self) -> Path:
        return self.root / META

    def snapshot(self, source: str) -> Path:
        return self.root / SOURCES_DIR / f"{source}.jsonl"

    def load_records(self) -> dict[str, Record]:
        return {row["id"]: Record.from_dict(row) for row in read_jsonl(self.solicitations)}

    def load_snapshots(self) -> dict[str, dict[str, Record]]:
        return {
            source: {row["id"]: Record.from_dict(row) for row in read_jsonl(self.snapshot(source))}
            for source in SOURCE_NAMES
        }

    def load_changelog(self) -> list[dict[str, Any]]:
        return read_jsonl(self.changelog)

    def load_meta(self) -> dict[str, Any]:
        return read_json(self.meta, default={})

    def save_records(self, records: Iterable[Record]) -> None:
        write_jsonl(self.solicitations, (record.to_dict() for record in sorted(records, key=lambda r: r.id)))

    def save_snapshot(self, source: str, records: Iterable[Record]) -> None:
        write_jsonl(self.snapshot(source), (record.to_dict() for record in sorted(records, key=lambda r: r.id)))

    def append_changelog(self, events: list[dict[str, Any]]) -> None:
        if not events:
            return
        self.changelog.parent.mkdir(parents=True, exist_ok=True)
        with self.changelog.open("a", encoding="utf-8", newline="\n") as handle:
            for event in events:
                handle.write(dumps_line(event) + "\n")

    def save_meta(self, meta: dict[str, Any]) -> None:
        write_json(self.meta, meta)


def dumps_line(value: Any) -> str:
    """One compact JSON line; key order is the caller's (Record.to_dict keeps schema order)."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError as exc:
                raise ValueError(f"{path}:{number}: invalid JSON ({exc})") from exc
    return rows


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    write_text_atomic(path, "".join(dumps_line(row) + "\n" for row in rows))


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, value: Any, *, compact: bool = False) -> None:
    if compact:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    else:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2)
    write_text_atomic(path, text + "\n")


def write_text_atomic(path: Path, text: str) -> None:
    """Write UTF-8 text with LF endings via a temp file + rename so readers never see half a file."""
    write_bytes_atomic(path, text.encode("utf-8"))


def write_bytes_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(handle, "wb") as temp:
            temp.write(data)
        os.replace(temp_name, path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise
