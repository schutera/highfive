"""Step-level tests for `UploadPipeline`.

These tests construct the pipeline directly with fake collaborators —
no Flask, no real network, no real `DuckDBService` — to verify the
pipeline's internal orchestration. The HTTP-boundary tests in
`test_upload.py` cover end-to-end behavior.

Note: the pipeline itself does not validate ``mac``; canonicalization
happens at the HTTP boundary in ``app.py``. These tests therefore feed
already-canonical ``ModuleId`` strings to mirror the production flow.
"""

from __future__ import annotations

import json
from pathlib import Path

from requests import RequestException

from services.upload_pipeline import UploadPipeline, UploadRequest

# Canonical 12-hex-char ModuleId fixtures.
TEST_MAC_1 = "aabbccddeeff"
TEST_MAC_2 = "ccddeeff0011"
TEST_MAC_3 = "112233445566"
TEST_MAC_4 = "778899aabbcc"


# --------------------------- fakes ---------------------------


class _FakeImage:
    """Stand-in for werkzeug FileStorage. Has `filename` and `save(path)`."""

    def __init__(self, filename: str, payload: bytes = b"\x00fake-bytes"):
        self.filename = filename
        self._payload = payload

    def save(self, path: str) -> None:
        with open(path, "wb") as f:
            f.write(self._payload)


class _FakeDuckDB:
    """Records calls; lets tests configure return values + exceptions."""

    def __init__(
        self,
        *,
        progress_count: int = 0,
        progress_count_raises: bool = False,
        add_progress_raises: bool = False,
        heartbeat_raises: bool = False,
    ):
        self.progress_count = progress_count
        self.progress_count_raises = progress_count_raises
        self.add_progress_raises = add_progress_raises
        self.heartbeat_raises = heartbeat_raises
        self.progress_count_calls: list[str] = []
        self.add_progress_calls: list[dict] = []
        self.heartbeat_calls: list[tuple[str, int]] = []

    def get_progress_count(self, mac: str) -> int:
        self.progress_count_calls.append(mac)
        if self.progress_count_raises:
            raise RequestException("boom")
        return self.progress_count

    def add_progress_for_module(self, payload: dict) -> dict:
        self.add_progress_calls.append(payload)
        if self.add_progress_raises:
            raise RequestException("boom")
        return {"ok": True}

    def heartbeat(self, mac: str, battery: int) -> bool:
        self.heartbeat_calls.append((mac, battery))
        if self.heartbeat_raises:
            raise RequestException("boom")
        return True


def _make_pipeline(
    upload_dir: Path,
    duckdb: _FakeDuckDB,
    discord_sink: list[str] | None = None,
    classification: dict | None = None,
) -> UploadPipeline:
    sink = discord_sink if discord_sink is not None else []
    cls = classification if classification is not None else {"species": {"1": 1}}
    return UploadPipeline(
        upload_folder=str(upload_dir),
        duckdb_service=duckdb,
        send_discord=lambda msg: sink.append(msg),
        classify=lambda: cls,
    )


# --------------------------- tests ---------------------------


def test_pipeline_first_upload_runs_all_steps_and_pings_discord(tmp_path: Path):
    """progress_count == 0 => Discord fires; image + sidecar persisted; both DB calls made."""
    duckdb = _FakeDuckDB(progress_count=0)
    discord: list[str] = []
    pipeline = _make_pipeline(
        tmp_path,
        duckdb,
        discord_sink=discord,
        classification={"orchard_bee": {"1": 1, "2": 0}},
    )

    img = _FakeImage("first.jpg")
    req = UploadRequest(
        mac=TEST_MAC_1,
        battery=88,
        image=img,
        logs_raw=json.dumps({"rssi": -50}),
    )

    result = pipeline.run(req)

    assert result.filename == "first.jpg"
    assert result.classification == {"orchard_bee": {"1": 1, "2": 0}}

    # Image landed on disk
    assert (tmp_path / "first.jpg").exists()

    # Sidecar landed on disk in envelope shape
    sidecar_path = tmp_path / "first.jpg.log.json"
    assert sidecar_path.exists()
    sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
    assert sidecar["mac"] == TEST_MAC_1
    assert sidecar["image"] == "first.jpg"
    assert sidecar["payload"] == {"rssi": -50}

    # DuckDB collaborators called once each
    assert duckdb.progress_count_calls == [TEST_MAC_1]
    assert len(duckdb.add_progress_calls) == 1
    # Wire field is now canonical ``module_id`` (was the legacy ``modul_id`` typo).
    assert duckdb.add_progress_calls[0]["module_id"] == TEST_MAC_1
    assert duckdb.add_progress_calls[0]["classification"] == {
        "orchard_bee": {"1": 1, "2": 0}
    }
    assert duckdb.heartbeat_calls == [(TEST_MAC_1, 88)]

    # Discord fired with the exact message format
    assert len(discord) == 1
    msg = discord[0]
    assert msg.startswith("📸 **First image received!**\n")
    assert f"Module **{TEST_MAC_1}** just sent its first photo." in msg
    assert "**Battery:** 88%" in msg
    assert "**File:** first.jpg" in msg


def test_pipeline_non_first_upload_skips_discord(tmp_path: Path):
    """progress_count > 0 => Discord stays silent, but everything else still runs."""
    duckdb = _FakeDuckDB(progress_count=42)
    discord: list[str] = []
    pipeline = _make_pipeline(tmp_path, duckdb, discord_sink=discord)

    req = UploadRequest(
        mac=TEST_MAC_2, battery=10, image=_FakeImage("later.jpg"), logs_raw=None
    )
    pipeline.run(req)

    assert discord == []
    # No sidecar when logs_raw is None
    assert not (tmp_path / "later.jpg.log.json").exists()
    # But image, progress, heartbeat all happened
    assert (tmp_path / "later.jpg").exists()
    assert len(duckdb.add_progress_calls) == 1
    assert duckdb.heartbeat_calls == [(TEST_MAC_2, 10)]


def test_pipeline_tolerates_duckdb_failures_and_skips_discord(tmp_path: Path):
    """All three duckdb calls raising RequestException => upload still completes,
    Discord skipped (couldn't determine first-upload), no exception bubbles up."""
    duckdb = _FakeDuckDB(
        progress_count_raises=True,
        add_progress_raises=True,
        heartbeat_raises=True,
    )
    discord: list[str] = []
    pipeline = _make_pipeline(tmp_path, duckdb, discord_sink=discord)

    req = UploadRequest(
        mac=TEST_MAC_3, battery=50, image=_FakeImage("flaky.jpg"), logs_raw=None
    )
    # Must not raise
    result = pipeline.run(req)

    assert result.filename == "flaky.jpg"
    # Discord did NOT fire (first-upload check failed => assume not first)
    assert discord == []
    # Image still persisted despite all DB failures
    assert (tmp_path / "flaky.jpg").exists()


def test_pipeline_malformed_logs_writes_parse_error_sidecar(tmp_path: Path):
    """Malformed JSON in logs_raw => sidecar written with parse_error marker."""
    duckdb = _FakeDuckDB(progress_count=5)
    pipeline = _make_pipeline(tmp_path, duckdb)

    req = UploadRequest(
        mac=TEST_MAC_4,
        battery=70,
        image=_FakeImage("bad.jpg"),
        logs_raw="not json {{",
    )
    pipeline.run(req)

    sidecar = json.loads((tmp_path / "bad.jpg.log.json").read_text(encoding="utf-8"))
    assert sidecar["payload"]["parse_error"] is True
    assert sidecar["payload"]["raw"] == "not json {{"
    assert sidecar["mac"] == TEST_MAC_4
    assert sidecar["image"] == "bad.jpg"
