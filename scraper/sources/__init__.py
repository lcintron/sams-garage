"""Source registry. To add a source, write a module with NAME + scrape() (see base.py) and list it here."""

from __future__ import annotations

from types import ModuleType

from . import dod_dsip, grants_gov, sbir_gov

SOURCES: dict[str, ModuleType] = {module.NAME: module for module in (sbir_gov, dod_dsip, grants_gov)}

__all__ = ["SOURCES"]
