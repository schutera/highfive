#!/usr/bin/env python3
"""One-shot backfill of hole-detection snips over existing uploads (#165).

Re-runs the *exact* image-service detection pipeline against every image already
in `image_uploads`, so modules deployed before this feature light up with real
per-nest snips + sealed values without waiting for their next upload.

This is a manual dev/ops utility (not in the `/upload` hot path). It must run
where the upload volume is mounted and the services are reachable — typically
inside the `image-service` container or a shell with `IMAGE_STORE_PATH` pointing
at the same volume:

    docker compose exec image-service python /app/../scripts/backfill_detections.py
    # or, from a dev checkout with the volume mounted:
    IMAGE_STORE_PATH=/data/images DUCKDB_SERVICE_URL=http://localhost:8002 \
        python scripts/backfill_detections.py [--module <mac>] [--dry-run]

Idempotency: detection rows accrue per upload (full history is intentional —
phase-3 time-lapse, #166), so re-running appends a fresh detection set per
image. Snip JPEGs are overwritten in place (deterministic filenames). Pass
`--module` to limit to one MAC.
"""

from __future__ import annotations

import argparse
import os
import sys

import requests

# Reuse the real image-service code so there is exactly one detection +
# persistence path. The repo layout puts image-service beside scripts/.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_REPO_ROOT, "image-service"))

from services.duckdb import DuckDBService  # noqa: E402
from services.hole_detection import HoleDetector  # noqa: E402
from services.upload_pipeline import UploadPipeline  # noqa: E402


def _list_uploads(duckdb_url: str, module: str | None) -> list[dict]:
    params = {"module_id": module} if module else {}
    resp = requests.get(f"{duckdb_url.rstrip('/')}/image_uploads", params=params, timeout=30)
    resp.raise_for_status()
    return resp.json().get("images", [])


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill hole-detection snips (#165)")
    parser.add_argument("--module", help="Limit to one module MAC (canonical 12-hex)")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Detect and report, but write no snips / DB rows",
    )
    args = parser.parse_args()

    upload_folder = os.getenv("IMAGE_STORE_PATH", "/data/images")
    duckdb_url = os.getenv("DUCKDB_SERVICE_URL", "http://duckdb-service:8000")
    snip_folder = os.path.join(upload_folder, "snips")

    duckdb_service = DuckDBService(base_url=duckdb_url)
    pipeline = UploadPipeline(
        upload_folder=upload_folder,
        duckdb_service=duckdb_service,
        send_discord=lambda _msg: None,
        classify=dict,  # unused: only detection-derived classification is written
        detector=HoleDetector(),
        snip_folder=snip_folder,
    )

    uploads = _list_uploads(duckdb_url, args.module)
    print(f"Found {len(uploads)} upload(s) to process from {duckdb_url}")

    processed = skipped = failed = 0
    for up in uploads:
        mac = up.get("module_id")
        filename = up.get("filename")
        if not mac or not filename:
            skipped += 1
            continue
        path = os.path.join(upload_folder, filename)
        if not os.path.isfile(path):
            print(f"  skip {filename}: file not found at {path}")
            skipped += 1
            continue

        detection = pipeline._detect(path)
        if not detection.ok:
            print(f"  skip {filename}: detection found nothing")
            skipped += 1
            continue

        sealed = sum(1 for s in detection.snips if s.state == "sealed")
        print(
            f"  {filename} ({mac}): {len(detection.snips)} snips, "
            f"{sealed} sealed / {len(detection.snips) - sealed} empty"
        )
        if args.dry_run:
            processed += 1
            continue

        try:
            pipeline._record_progress(mac, detection.classification)
            pipeline._persist_and_record_snips(mac, filename, detection)
            processed += 1
        except Exception as exc:  # noqa: BLE001 - report and continue the batch
            print(f"  FAILED {filename}: {exc!r}")
            failed += 1

    print(
        f"\nDone. processed={processed} skipped={skipped} failed={failed}"
        + (" (dry-run — nothing written)" if args.dry_run else "")
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
