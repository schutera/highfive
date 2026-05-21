#!/usr/bin/env python3
"""
Seed UI-test-specific fixtures on top of duckdb-service's SEED_DATA.

The Playwright specs assert against two things that the default seed does
NOT cover:

  1. A Null-Island module ``(0,0)`` so dashboard-side-list.spec.ts can
     verify the "Location pending" pill renders for it. The five baseline
     seed modules are all at real lat/lng around the lake; without this
     row, the side-list pending-module path is unreachable.

  2. A telemetry-bearing upload from a known MAC so
     dashboard-telemetry.spec.ts can assert TelemetryRow renders literal
     values (uptime, heap, rssi, fw, reset reason) rather than the silent
     ``—`` placeholders that the chapter-11 envelope-drift regression
     produced. Drives one /upload via tools/mock_esp.py so we exercise
     the exact same code path the firmware does, including the sidecar
     write.

Idempotent: re-running against an already-seeded stack is a no-op for the
Null-Island row (UPSERT) and just adds another sidecar entry for the
telemetry case. The spec asserts on `logs[0]` (latest entry) AND on
DOM text via `toContainText`; with N identical entries the DOM renders
N TelemetryRows, each containing all the literal values, so the
`toContainText` check still matches. The spec does NOT pin "exactly
one entry" - it pins "at least one entry contains the expected values".
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import requests

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))

from tools.mock_esp import MockEsp, TelemetrySnapshot

# Host ports from docker-compose.ui.yml. Match the e2e stack's +1000
# offsets exactly; the only addition is the homepage on :6173 which this
# script does not need to touch.
DUCKDB_URL = "http://localhost:9002"
IMAGE_SERVICE_URL = "http://localhost:9000"
BACKEND_URL = "http://localhost:4002"
HOMEPAGE_URL = "http://localhost:6173"

# Canonical 12-char lowercase hex MACs. The "ff..." prefix is a
# recognisable UI-fixture marker that won't collide with the seed-data
# pattern ("00...") or the e2e mock-esp default ("ee...").
NULL_ISLAND_MAC = "ff0000000001"
TELEMETRY_MAC = "ff1111111111"


def wait_for_stack(timeout_s: int = 180) -> None:
    """Poll every service we depend on until they all answer 200."""
    targets = {
        "duckdb": f"{DUCKDB_URL}/health",
        "image_service": f"{IMAGE_SERVICE_URL}/health",
        "backend": f"{BACKEND_URL}/api/health",
        "homepage": HOMEPAGE_URL,
    }
    deadline = time.time() + timeout_s
    healthy: set[str] = set()
    last_errors: dict[str, str] = {}

    print(f"[ui-seed] waiting for stack (timeout {timeout_s}s)...", flush=True)
    while time.time() < deadline:
        for name, url in targets.items():
            if name in healthy:
                continue
            try:
                r = requests.get(url, timeout=2)
                # nginx returns 200 for /, services return 200 for /health.
                if r.status_code == 200:
                    healthy.add(name)
                    print(f"[ui-seed]   {name} healthy ({url})", flush=True)
                else:
                    last_errors[name] = f"HTTP {r.status_code}"
            except requests.RequestException as exc:
                last_errors[name] = type(exc).__name__
        if len(healthy) == len(targets):
            return
        time.sleep(2)

    raise RuntimeError(
        f"stack did not become healthy in {timeout_s}s. "
        f"Healthy: {sorted(healthy)}. "
        f"Not healthy: {sorted(set(targets) - healthy)}. "
        f"Last errors: {last_errors}"
    )


def seed_null_island_module() -> None:
    """Register a module at (0, 0) so the side-list shows the pending pill.

    add_module's UPSERT is idempotent on `id` so re-runs are safe. We pass
    lat/lng/battery as strings to mirror what the firmware actually sends
    (matches MockEsp.register() in tools/mock_esp.py).
    """
    payload = {
        "esp_id": NULL_ISLAND_MAC,
        "module_name": "UI Test Null Island",
        "latitude": "0",
        "longitude": "0",
        "battery_level": "42",
    }
    r = requests.post(f"{DUCKDB_URL}/new_module", json=payload, timeout=10)
    r.raise_for_status()
    print(f"[ui-seed] registered Null-Island module {NULL_ISLAND_MAC}", flush=True)


def seed_telemetry_upload() -> None:
    """Drive one /upload with a fully-populated telemetry payload.

    The spec asserts on these literal values - keep the snapshot in sync
    with dashboard-telemetry.spec.ts.
    """
    telemetry = TelemetrySnapshot(
        fw="ui-test-1.2.3",
        uptime_s=3601,  # >1h so formatUptime renders 'h m', distinct shape
        last_reset_reason="UI_TEST_RESET",
        free_heap=204800,  # exactly 200 KB after rounding
        rssi=-42,
        wifi_reconnects=2,
        last_http_codes=[200, 200, 200],
        log="[BOOT] ui-fixture\n[CAM] frame captured\n",
    )
    esp = MockEsp(
        upload_url=f"{IMAGE_SERVICE_URL}/upload",
        init_url=f"{DUCKDB_URL}/new_module",
        mac=TELEMETRY_MAC,
        module_name="UI Test Telemetry",
        telemetry=telemetry,
    )

    r = esp.register()
    r.raise_for_status()
    print(f"[ui-seed] registered telemetry-bearing module {TELEMETRY_MAC}", flush=True)

    r = esp.upload()
    r.raise_for_status()
    print(f"[ui-seed] uploaded one image + sidecar for {TELEMETRY_MAC}", flush=True)


def main() -> int:
    wait_for_stack()
    seed_null_island_module()
    seed_telemetry_upload()
    print("[ui-seed] done", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
