"""Tests for the #166 demo-snip seed copy (image-service startup).

`_seed_demo_snips()` copies the bundled demo crops into the shared SNIP_FOLDER
on boot so the per-nest time-lapse has frames to scrub on a seeded dev/CI stack.
Gated on SEED_DATA, jpg-only, idempotent, and never fatal.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest


def _import_app(monkeypatch: pytest.MonkeyPatch, upload_dir: Path, seed: str | None):
    monkeypatch.setenv("IMAGE_STORE_PATH", str(upload_dir))
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "")
    if seed is None:
        monkeypatch.delenv("SEED_DATA", raising=False)
    else:
        monkeypatch.setenv("SEED_DATA", seed)
    if "app" in sys.modules:
        del sys.modules["app"]
    return importlib.import_module("app")


def _snip_jpgs(upload_dir: Path) -> list[str]:
    snips = upload_dir / "snips"
    return sorted(p.name for p in snips.glob("*.jpg"))


def test_seeds_demo_snips_when_seed_data_true(tmp_path, monkeypatch):
    upload = tmp_path / "images"
    upload.mkdir()
    _import_app(monkeypatch, upload, "true")
    names = _snip_jpgs(upload)
    # The five bundled progression frames land in the snip folder...
    assert len(names) == 5
    assert all(n.startswith("demo-garten12-leaf1-") for n in names)
    # ...and the README / generator never leak into the served volume.
    assert not (upload / "snips" / "README.md").exists()
    assert not (upload / "snips" / "generate.py").exists()


def test_does_not_seed_when_seed_data_absent(tmp_path, monkeypatch):
    upload = tmp_path / "images"
    upload.mkdir()
    _import_app(monkeypatch, upload, None)
    assert _snip_jpgs(upload) == []


def test_seed_is_idempotent_and_preserves_existing(tmp_path, monkeypatch):
    upload = tmp_path / "images"
    (upload / "snips").mkdir(parents=True)
    # A pre-existing real snip must survive re-seeding untouched.
    existing = upload / "snips" / "real-capture-orchard-1.jpg"
    existing.write_bytes(b"\xff\xd8\xff real")
    _import_app(monkeypatch, upload, "true")
    _import_app(monkeypatch, upload, "true")  # second boot — no duplicates/crash
    names = _snip_jpgs(upload)
    assert "real-capture-orchard-1.jpg" in names
    assert existing.read_bytes() == b"\xff\xd8\xff real"
    # 5 demo + 1 real, exactly once each.
    assert len(names) == 6
