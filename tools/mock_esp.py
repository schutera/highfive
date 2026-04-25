#!/usr/bin/env python3
"""
Mock ESP32-CAM uploader.

Reproduces the wire-level behaviour of the real firmware (ESP32-CAM/client.cpp)
without any hardware. Primary uses:

  1. End-to-end pipeline test fixture (tests/e2e/test_upload_pipeline.py)
  2. Manual debugging when no physical ESP is available — point it at a
     running stack, watch traffic flow

The multipart layout, form-field names, and telemetry JSON shape must stay
in lockstep with:
  - ESP32-CAM/client.cpp::postImage()
  - ESP32-CAM/lib/telemetry/telemetry.cpp::buildTelemetryJson()
  - image-service/app.py /upload handler

If the contract changes, update both sides.

Out of scope: WiFi watchdog, reset-reason persistence, daily-reboot timer.
This is an upload-pipeline simulator, not a full firmware emulator.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from dataclasses import dataclass, field, asdict
from typing import List, Optional

import requests


def _make_fake_image(n_bytes: int = 2048, seed: int = 42) -> bytes:
    """Pseudo-random bytes wrapped in JPEG SOI/EOI markers.

    image-service does not decode — image.save(path) just writes bytes —
    so a deterministic fake of realistic size is enough to assert file
    persistence without committing a binary fixture.
    """
    rng = random.Random(seed)
    return b"\xff\xd8" + bytes(rng.getrandbits(8) for _ in range(n_bytes)) + b"\xff\xd9"


@dataclass
class TelemetrySnapshot:
    """Mirror of hf::TelemetryInputs in lib/telemetry/telemetry.h.

    Field names, types, and JSON serialization match the firmware contract
    pinned by test_image_service_expected_schema_exact.
    """

    fw: str = "1.0.0"
    uptime_s: int = 60
    last_reset_reason: str = "POWERON"
    free_heap: int = 200000
    min_free_heap: int = 180000
    rssi: int = -50
    wifi_reconnects: int = 0
    last_http_codes: List[int] = field(default_factory=list)
    log: str = "[BOOT] mock-esp\n"

    def to_json(self) -> str:
        # separators=(",", ":") matches the firmware's compact form
        return json.dumps(asdict(self), separators=(",", ":"))


@dataclass
class MockEsp:
    """Single mock device. Use as a context manager or call methods directly."""

    upload_url: str
    init_url: Optional[str] = None

    mac: str = "test-mac-aa-bb-cc-dd-ee-ff"
    module_name: str = "Mock Hive"
    latitude: float = 47.8086
    longitude: float = 9.6433
    battery: int = 87
    fw_version: str = "1.0.0"

    image_bytes: bytes = field(default_factory=_make_fake_image)
    telemetry: TelemetrySnapshot = field(default_factory=TelemetrySnapshot)

    timeout_s: float = 30.0

    def register(self) -> requests.Response:
        """POST /new_module on duckdb-service, mirrors initNewModuleOnServer.

        Sends `esp_id` (Pydantic alias for `mac`), `module_name`, lat/lng as
        strings, and `battery_level` as a string — exactly as the firmware
        does in esp_init.cpp.
        """
        if not self.init_url:
            raise ValueError("init_url not configured")

        payload = {
            "esp_id": self.mac,
            "module_name": self.module_name,
            "latitude": str(self.latitude),
            "longitude": str(self.longitude),
            "battery_level": str(self.battery),
        }
        return requests.post(self.init_url, json=payload, timeout=self.timeout_s)

    def upload(self, *, image_bytes: Optional[bytes] = None) -> requests.Response:
        """POST /upload on image-service with mac + battery + logs + image.

        Multipart layout matches client.cpp::postImage(): four named parts
        (mac, battery, logs, image), with `image` as the only file part.
        """
        filename = f"esp_capture_{int(time.time() * 1000)}.jpg"
        files = {
            "image": (filename, image_bytes or self.image_bytes, "image/jpeg"),
        }
        data = {
            "mac": self.mac,
            "battery": str(self.battery),
            "logs": self.telemetry.to_json(),
        }
        return requests.post(
            self.upload_url, files=files, data=data, timeout=self.timeout_s
        )

    def upload_loop(self, cycles: int, interval_s: float) -> List[int]:
        """Run `cycles` uploads `interval_s` apart. Returns response codes.

        Records each code into telemetry.last_http_codes so subsequent
        uploads carry the recent history, the same way the firmware does
        via HttpCodeRing.
        """
        codes: List[int] = []
        for i in range(cycles):
            try:
                resp = self.upload()
                codes.append(resp.status_code)
                self.telemetry.last_http_codes = (
                    self.telemetry.last_http_codes + [resp.status_code]
                )[-8:]  # match HTTP_CODES_LEN in lib/telemetry
                self.telemetry.uptime_s += int(interval_s)
            except requests.RequestException as exc:
                # -2 = connect failed in client.cpp
                codes.append(-2)
                print(f"[mock-esp] cycle {i}: {exc}", file=sys.stderr)
            if i < cycles - 1:
                time.sleep(interval_s)
        return codes


def _parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--upload-url", required=True,
                   help="image-service /upload URL, e.g. http://localhost:8000/upload")
    p.add_argument("--init-url",
                   help="duckdb-service /new_module URL "
                        "(only needed if --register)")
    p.add_argument("--mac", default="test-mac-aa-bb-cc-dd-ee-ff",
                   help="device identifier (default: %(default)s)")
    p.add_argument("--battery", type=int, default=87,
                   help="battery percentage 0-100 (default: %(default)s)")
    p.add_argument("--cycles", type=int, default=1,
                   help="number of upload cycles (default: %(default)s)")
    p.add_argument("--interval", type=float, default=2.0,
                   help="seconds between uploads (default: %(default)s)")
    p.add_argument("--register", action="store_true",
                   help="POST /new_module before the first upload")
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = _parse_args(argv)

    esp = MockEsp(
        upload_url=args.upload_url,
        init_url=args.init_url,
        mac=args.mac,
        battery=args.battery,
    )

    if args.register:
        if not args.init_url:
            print("--register requires --init-url", file=sys.stderr)
            return 2
        try:
            r = esp.register()
            print(f"[register] {r.status_code} {r.text}")
        except requests.RequestException as exc:
            print(f"[register] failed: {exc}", file=sys.stderr)
            return 1

    codes = esp.upload_loop(args.cycles, args.interval)
    print(f"[upload] cycles={args.cycles} codes={codes}")
    return 0 if all(200 <= c < 300 for c in codes) else 1


if __name__ == "__main__":
    sys.exit(main())
