"""Cross-service contract test for the #166 time-lapse demo seed.

The seeded `nest_detections` rows (db/schema.py) reference snip filenames that
must exist as bundled JPEGs in `image-service/demo_snips/` — image-service copies
them into the shared volume on boot. Nothing else pins that the two stay in
sync, and a drift is invisible until a user taps a snip and the modal serves
broken images. This test seeds a fresh DB and asserts every seeded
`snip_filename` has a matching file on disk (and vice-versa), so editing one
side without the other fails CI. (senior-review P2 on the #166 PR.)
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEMO_SNIP_DIR = _REPO_ROOT / "image-service" / "demo_snips"
_SEED_MODULE = "000000000002"  # Garten 12


# Only the `db.*` modules bind the DUCKDB_PATH at import, so a fresh seeded DB
# needs just those reimported — NOT `services.*`. Purging `services` would swap
# out the `log_ring` singleton that test_logs holds a module-level reference to,
# silently breaking it. Purge db-only, on setup and teardown, so neither this
# test nor a later one inherits a temp-DB-bound `db.connection`.
def _purge_db_modules() -> None:
    for name in [m for m in sys.modules if m == "db" or m.startswith("db.")]:
        sys.modules.pop(name, None)


@pytest.fixture
def seeded_db(tmp_path, monkeypatch):
    """A fresh DuckDB initialised WITH SEED_DATA on (unlike the default fixture)."""
    db_file = tmp_path / "seeded.duckdb"
    monkeypatch.setenv("DUCKDB_PATH", str(db_file))
    monkeypatch.setenv("SEED_DATA", "true")
    monkeypatch.delenv("DISCORD_WEBHOOK_URL", raising=False)
    monkeypatch.setenv("WEATHER_WORKER_ENABLED", "false")
    _purge_db_modules()
    connection = importlib.import_module("db.connection")
    schema = importlib.import_module("db.schema")
    schema.init_db()
    try:
        yield connection
    finally:
        # Drop the temp-DB-bound modules so a later test re-imports cleanly
        # against its own env (mirrors conftest `_purge_service_modules`).
        _purge_db_modules()


def _seeded_snip_filenames(connection) -> list[str]:
    con = connection.get_conn()
    rows = con.execute(
        "SELECT DISTINCT snip_filename FROM nest_detections WHERE module_id = ?",
        (_SEED_MODULE,),
    ).fetchall()
    return sorted(r[0] for r in rows)


def test_seed_creates_a_multi_frame_history(seeded_db):
    # The time-lapse needs >1 frame to be worth scrubbing; pin the demo size.
    assert len(_seeded_snip_filenames(seeded_db)) >= 2


def test_every_seeded_snip_has_a_bundled_jpeg(seeded_db):
    missing = [
        name
        for name in _seeded_snip_filenames(seeded_db)
        if not (_DEMO_SNIP_DIR / name).is_file()
    ]
    assert not missing, (
        f"seeded nest_detections reference snips with no JPEG in "
        f"{_DEMO_SNIP_DIR}: {missing} — add the file or fix the seed"
    )


def test_no_orphan_demo_jpegs(seeded_db):
    """Every bundled demo JPEG is referenced by the seed — no dead assets."""
    seeded = set(_seeded_snip_filenames(seeded_db))
    orphans = [p.name for p in _DEMO_SNIP_DIR.glob("*.jpg") if p.name not in seeded]
    assert not orphans, (
        f"demo JPEGs not referenced by the seed: {orphans} — "
        "remove them or add matching nest_detections rows"
    )
