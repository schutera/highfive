"""Canonical wire format for module IDs.

The canonical form is exactly 12 lowercase hex characters with no
separators or prefix, e.g. ``"aabbccddeeff"``. Inputs are accepted in any
of the common shapes (uppercase, colon- or dash-separated, surrounding
whitespace) and normalised to the canonical form. Anything that does not
reduce to ``[0-9a-f]{12}`` is rejected.

This is the single source of truth for module ID validation in the
duckdb-service. The ``image-service`` ships an identical copy in its
``services/module_id.py`` — Python has no npm-style workspace mechanism,
and the class is small enough that duplication is the lower-pain option.
"""

from __future__ import annotations

import re

from pydantic import RootModel, field_validator

CANONICAL = re.compile(r"^[0-9a-f]{12}$")


class ModuleId(RootModel[str]):
    """Pydantic root model wrapping the canonical 12-hex-char module ID."""

    @field_validator("root", mode="before")
    @classmethod
    def _canonicalize(cls, v):
        if not isinstance(v, str):
            raise ValueError("ModuleId must be a string")
        c = v.replace(":", "").replace("-", "").strip().lower()
        if not CANONICAL.match(c):
            raise ValueError(f"invalid ModuleId after canonicalization: {v!r} -> {c!r}")
        return c

    def __str__(self) -> str:  # pragma: no cover - trivial
        return self.root
