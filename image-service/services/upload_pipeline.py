"""Upload pipeline for image-service.

Encapsulates the multi-step `/upload` workflow (first-upload detection,
image persistence, sidecar persistence, classification, progress + heartbeat
recording, optional Discord notification) behind a class with injected
collaborators. The pipeline is deliberately Flask-free: callers parse the
HTTP request, build an `UploadRequest`, and consume an `UploadResult`.

Behavior is preserved exactly from the original inline `/upload` handler:
- Failure tolerance: the first-upload check, progress POST, and heartbeat
  POST all silently swallow `requests.RequestException`.
- Sidecar shape: written via `LogSidecarEnvelope` (unchanged).
- Discord message format: identical to the original.
- Filenames written to the upload volume are unchanged.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from requests import RequestException

from services.sidecar import LogSidecarEnvelope

# Type-only hint for the werkzeug FileStorage. Importing werkzeug here is
# acceptable per the brief — werkzeug is the file-upload abstraction Flask
# already pulls in, and it's not a Flask import. We keep it as `Any` at
# runtime to avoid a hard dependency in pure-unit tests.
FileStorage = Any


@dataclass
class UploadRequest:
    """Inputs for one /upload invocation, decoupled from Flask types."""

    mac: str
    battery: int
    image: FileStorage  # werkzeug FileStorage (has .filename and .save(path))
    logs_raw: str | None


@dataclass
class UploadResult:
    """Outputs of one /upload invocation."""

    filename: str
    classification: dict


class UploadPipeline:
    """Orchestrates the steps of a single image upload.

    Collaborators are injected so the pipeline can be unit-tested without
    Flask, the network, or a real filesystem layout. The pipeline owns no
    Flask types and does not import Flask.
    """

    def __init__(
        self,
        *,
        upload_folder: str,
        duckdb_service,
        send_discord: Callable[[str], None],
        classify: Callable[[], dict],
    ):
        self.upload_folder = upload_folder
        self.duckdb_service = duckdb_service
        self.send_discord = send_discord
        self.classify = classify

    def run(self, req: UploadRequest) -> UploadResult:
        is_first = self._check_first_upload(req.mac)
        file_path = self._persist_image(req)
        self._persist_sidecar(req, file_path)
        classification = self.classify()
        self._record_progress(req.mac, classification)
        self._record_heartbeat(req.mac, req.battery)
        if is_first:
            self._notify_first_sighting(req.mac, req.battery, req.image.filename)
        return UploadResult(filename=req.image.filename, classification=classification)

    # ------------------------------------------------------------------
    # Steps
    # ------------------------------------------------------------------

    def _check_first_upload(self, mac: str) -> bool:
        """Return True iff duckdb-service reports zero progress rows for `mac`.

        Tolerates transient duckdb-service failures: if we can't determine the
        count, assume "not first" so we don't spam Discord on flaky network.
        """
        try:
            count = self.duckdb_service.get_progress_count(mac)
            return count == 0
        except RequestException:
            return False

    def _persist_image(self, req: UploadRequest) -> str:
        """Save the uploaded image to the upload folder. Returns the file path."""
        file_path = os.path.join(self.upload_folder, req.image.filename)
        req.image.save(file_path)
        return file_path

    def _persist_sidecar(self, req: UploadRequest, file_path: str) -> None:
        """Write optional ESP telemetry beside the image as a typed envelope.

        On-disk shape: {"mac", "received_at", "image", "payload": {...}}.
        Malformed JSON is preserved as `{"raw": ..., "parse_error": True}`
        inside `payload` so the sidecar is always valid JSON.
        """
        if not req.logs_raw:
            return
        try:
            payload = json.loads(req.logs_raw)
            if not isinstance(payload, dict):
                payload = {"raw": req.logs_raw, "parse_error": True}
        except ValueError:
            payload = {"raw": req.logs_raw, "parse_error": True}
        envelope = LogSidecarEnvelope(
            mac=req.mac,
            received_at=LogSidecarEnvelope.now_iso(),
            image=req.image.filename,
            payload=payload,
        )
        try:
            with open(file_path + ".log.json", "w", encoding="utf-8") as f:
                f.write(envelope.to_json_string())
        except OSError as exc:
            print(f"[logs] failed to write sidecar for {req.image.filename}: {exc}")

    def _record_progress(self, mac: str, classification: dict) -> None:
        """POST classification results to duckdb-service. Silently tolerates failures.

        Wire field is the canonical ``module_id``; duckdb-service still
        accepts the legacy ``modul_id`` typo via Pydantic ``AliasChoices``
        for one release as the deprecation window.
        """
        payload = {"module_id": mac, "classification": classification}
        try:
            self.duckdb_service.add_progress_for_module(payload)
        except RequestException:
            pass

    def _record_heartbeat(self, mac: str, battery: int) -> None:
        """Update module battery + online status. Silently tolerates failures."""
        try:
            self.duckdb_service.heartbeat(mac, battery)
        except RequestException:
            pass

    def _notify_first_sighting(self, mac: str, battery: int, filename: str) -> None:
        """Send the first-upload Discord ping. Format preserved character-for-character."""
        self.send_discord(
            f"📸 **First image received!**\n"
            f"Module **{mac}** just sent its first photo.\n"
            f"**Battery:** {battery}%\n"
            f"**File:** {filename}"
        )
