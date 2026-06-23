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

from services.hole_detection import DetectionResult, Snip
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
        record_image_raises: bool = False,
        record_detections_raises: bool = False,
    ):
        self.progress_count = progress_count
        self.progress_count_raises = progress_count_raises
        self.add_progress_raises = add_progress_raises
        self.heartbeat_raises = heartbeat_raises
        self.record_image_raises = record_image_raises
        self.record_detections_raises = record_detections_raises
        self.progress_count_calls: list[str] = []
        self.add_progress_calls: list[dict] = []
        self.heartbeat_calls: list[tuple[str, int]] = []
        self.record_image_calls: list[tuple[str, str]] = []
        self.record_detections_calls: list[tuple[str, str, list]] = []

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

    def record_image(self, module_id: str, filename: str) -> dict:
        self.record_image_calls.append((module_id, filename))
        if self.record_image_raises:
            raise RequestException("boom")
        return {"message": "Image recorded"}

    def record_detections(
        self, module_id: str, filename: str, detections: list
    ) -> dict:
        self.record_detections_calls.append((module_id, filename, detections))
        if self.record_detections_raises:
            raise RequestException("boom")
        return {"message": "Detections recorded", "inserted": len(detections)}


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


class _FakeDetector:
    """Returns a preconfigured DetectionResult; records the path it saw."""

    def __init__(self, result: DetectionResult):
        self._result = result
        self.detect_calls: list[str] = []

    def detect(self, image_path: str) -> DetectionResult:
        self.detect_calls.append(image_path)
        return self._result


def _sealed_detection() -> DetectionResult:
    """One sealed leafcutter snip with real (tiny) bytes."""
    snip = Snip(
        bee_type="leafcutter_bee",
        nest_index=2,
        bbox=(0.1, 0.2, 0.3, 0.3),
        state="sealed",
        confidence=0.9,
        jpeg=b"\xff\xd8\xff-fake-jpeg",
    )
    return DetectionResult(
        classification={"leafcutter_bee": {"2": 1}},
        snips=[snip],
    )


# --------------------------- detection tests ---------------------------


def test_pipeline_uses_detection_classification_and_persists_snips(tmp_path: Path):
    """When the detector produces a result, its classification flows to
    add_progress (not the stub) and each snip is written + recorded."""
    duckdb = _FakeDuckDB(progress_count=5)
    detector = _FakeDetector(_sealed_detection())
    pipeline = UploadPipeline(
        upload_folder=str(tmp_path),
        duckdb_service=duckdb,
        send_discord=lambda msg: None,
        classify=lambda: {"stub": {"1": 0}},  # must NOT be used
        detector=detector,
        snip_folder=str(tmp_path / "snips"),
    )

    req = UploadRequest(
        mac=TEST_MAC_1, battery=50, image=_FakeImage("cap.jpg"), logs_raw=None
    )
    result = pipeline.run(req)

    # Real detection classification used, stub ignored.
    assert result.classification == {"leafcutter_bee": {"2": 1}}
    assert duckdb.add_progress_calls[0]["classification"] == {
        "leafcutter_bee": {"2": 1}
    }

    # Snip JPEG written to the snip folder with the derived filename.
    snip_path = tmp_path / "snips" / "cap-leafcutter_bee-2.jpg"
    assert snip_path.exists()
    assert snip_path.read_bytes() == b"\xff\xd8\xff-fake-jpeg"

    # Detection row recorded with the canonical DB bee type (not the wire key).
    assert len(duckdb.record_detections_calls) == 1
    mac, filename, rows = duckdb.record_detections_calls[0]
    assert (mac, filename) == (TEST_MAC_1, "cap.jpg")
    assert rows[0]["bee_type"] == "leafcutter"
    assert rows[0]["state"] == "sealed"
    assert rows[0]["snip_filename"] == "cap-leafcutter_bee-2.jpg"


def test_pipeline_falls_back_to_stub_when_detection_empty(tmp_path: Path):
    """An empty DetectionResult (no circles) => stub classification is used and
    no snips/detections are recorded — the dashboard never blanks."""
    duckdb = _FakeDuckDB(progress_count=5)
    detector = _FakeDetector(DetectionResult())  # ok == False
    pipeline = UploadPipeline(
        upload_folder=str(tmp_path),
        duckdb_service=duckdb,
        send_discord=lambda msg: None,
        classify=lambda: {"orchard_bee": {"1": 1}},
        detector=detector,
        snip_folder=str(tmp_path / "snips"),
    )

    req = UploadRequest(
        mac=TEST_MAC_2, battery=50, image=_FakeImage("blank.jpg"), logs_raw=None
    )
    result = pipeline.run(req)

    assert result.classification == {"orchard_bee": {"1": 1}}
    assert duckdb.record_detections_calls == []
    assert not (tmp_path / "snips").exists() or not any((tmp_path / "snips").iterdir())


def test_pipeline_tolerates_record_detections_failure(tmp_path: Path, capsys):
    """A duckdb failure on record_detections logs and never 500s the upload."""
    duckdb = _FakeDuckDB(progress_count=5, record_detections_raises=True)
    detector = _FakeDetector(_sealed_detection())
    pipeline = UploadPipeline(
        upload_folder=str(tmp_path),
        duckdb_service=duckdb,
        send_discord=lambda msg: None,
        classify=lambda: {},
        detector=detector,
        snip_folder=str(tmp_path / "snips"),
    )

    req = UploadRequest(
        mac=TEST_MAC_3, battery=50, image=_FakeImage("cap.jpg"), logs_raw=None
    )
    result = pipeline.run(req)  # must not raise

    assert result.filename == "cap.jpg"
    # Snip still written even though the DB record failed.
    assert (tmp_path / "snips" / "cap-leafcutter_bee-2.jpg").exists()
    assert "[record_detections]" in capsys.readouterr().out


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
    # /record_image fires once per upload with canonical mac + raw filename (#58).
    assert duckdb.record_image_calls == [(TEST_MAC_1, "first.jpg")]

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
    # But image, progress, heartbeat, record_image all happened
    assert (tmp_path / "later.jpg").exists()
    assert len(duckdb.add_progress_calls) == 1
    assert duckdb.heartbeat_calls == [(TEST_MAC_2, 10)]
    assert duckdb.record_image_calls == [(TEST_MAC_2, "later.jpg")]


def test_pipeline_tolerates_duckdb_failures_and_skips_discord(tmp_path: Path):
    """All four duckdb calls raising RequestException => upload still completes,
    Discord skipped (couldn't determine first-upload), no exception bubbles up."""
    duckdb = _FakeDuckDB(
        progress_count_raises=True,
        add_progress_raises=True,
        heartbeat_raises=True,
        record_image_raises=True,
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


def test_pipeline_logs_record_image_failure(tmp_path: Path, capsys):
    """`_record_image_upload` must log on failure — the file is on disk but
    invisible to admin/dashboard until somebody sees the log line.
    Lessons-learned (PR #50): no silent cross-service catches."""
    duckdb = _FakeDuckDB(progress_count=5, record_image_raises=True)
    pipeline = _make_pipeline(tmp_path, duckdb)

    req = UploadRequest(
        mac=TEST_MAC_4, battery=60, image=_FakeImage("orphan.jpg"), logs_raw=None
    )
    pipeline.run(req)  # must not raise

    captured = capsys.readouterr()
    assert "[record_image]" in captured.out
    assert TEST_MAC_4 in captured.out
    assert "orphan.jpg" in captured.out


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
