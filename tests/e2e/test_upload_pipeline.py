"""
End-to-end pipeline test.

Drives the four-service stack with a mock ESP and asserts that each link
of the upload chain holds:

  mock_esp  →  image-service /upload  →  filesystem (image + .log.json)
                                      →  duckdb-service /add_progress_for_module
                                      →  duckdb-service module row update

Plus the read-back paths:

  duckdb-service /modules               returns the module with updated counts
  image-service  /modules/<mac>/logs    returns the telemetry sidecar
  backend        /api/modules/:id/logs  proxies the above behind admin auth

This is the single test that, once green, certifies "the pipeline works
end to end without an ESP". Runs in <30s on a warm Docker daemon.

Each test gets its own MAC (via the mock_esp fixture) so the session-
shared DB volume does not cause cross-test interference.
"""

from __future__ import annotations

import requests


# Matches HIGHFIVE_API_KEY in docker-compose.test.yml. The admin gate on
# /api/modules/:id/logs reuses this same secret per the v1.0.0 design.
TEST_API_KEY = "hf_test_key"


# --- preflight ------------------------------------------------------------

def test_all_services_healthy(stack):
    """Sanity check the conftest fixture got the stack ready."""
    assert requests.get(f"{stack['duckdb']}/health").status_code == 200
    assert requests.get(f"{stack['image_service']}/health").status_code == 200
    assert requests.get(f"{stack['backend']}/api/health").status_code == 200


# --- module registration --------------------------------------------------

def test_new_module_registers_and_appears_in_listing(stack, mock_esp):
    r = mock_esp.register()
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == mock_esp.mac

    listing = requests.get(f"{stack['duckdb']}/modules").json()
    ids = [m["id"] for m in listing["modules"]]
    assert mock_esp.mac in ids, f"registered MAC {mock_esp.mac} not in {ids}"


# --- the upload pipeline --------------------------------------------------

def test_upload_lands_image_then_writes_sidecar_and_updates_db(stack, mock_esp):
    # 1. Register (mirrors firmware boot sequence)
    r = mock_esp.register()
    assert r.status_code == 200, r.text

    # 2. Upload one image with telemetry
    mock_esp.telemetry.uptime_s = 12345
    mock_esp.telemetry.last_reset_reason = "POWERON"
    mock_esp.telemetry.log = "[BOOT] e2e test\n[CAM] capture ok\n"
    r = mock_esp.upload()
    assert r.status_code == 200, r.text

    upload_body = r.json()
    assert upload_body["mac"] == mock_esp.mac
    assert upload_body["battery"] == mock_esp.battery
    assert "classification" in upload_body, "stub classifier output missing"

    # 3. duckdb-service should reflect: image_count incremented,
    #    battery_level updated to what we sent.
    listing = requests.get(f"{stack['duckdb']}/modules").json()
    module = next(
        (m for m in listing["modules"] if m["id"] == mock_esp.mac), None
    )
    assert module is not None, "module disappeared from DB after upload"
    assert module["image_count"] >= 1, (
        f"image_count not incremented: {module['image_count']}"
    )
    assert int(module["battery_level"]) == mock_esp.battery

    # 4. image-service must have written a .log.json sidecar that
    #    round-trips the telemetry fields the firmware sent.
    r = requests.get(
        f"{stack['image_service']}/modules/{mock_esp.mac}/logs?limit=10"
    )
    assert r.status_code == 200, r.text
    sidecars = r.json()
    assert len(sidecars) >= 1, "no telemetry sidecar found"

    latest = sidecars[0]
    assert latest["_mac"] == mock_esp.mac
    assert latest["fw"] == mock_esp.telemetry.fw
    assert latest["last_reset_reason"] == "POWERON"
    assert latest["uptime_s"] == 12345
    assert "log" in latest and "[BOOT] e2e test" in latest["log"]


# --- admin proxy through backend ------------------------------------------

def test_backend_admin_logs_endpoint_proxies_correctly(stack, mock_esp):
    mock_esp.register()
    assert mock_esp.upload().status_code == 200

    headers = {"X-API-Key": TEST_API_KEY, "X-Admin-Key": TEST_API_KEY}
    r = requests.get(
        f"{stack['backend']}/api/modules/{mock_esp.mac}/logs?limit=5",
        headers=headers,
    )
    assert r.status_code == 200, r.text
    proxied = r.json()
    assert isinstance(proxied, list)
    assert len(proxied) >= 1
    assert proxied[0]["_mac"] == mock_esp.mac


def test_backend_admin_logs_rejects_missing_admin_key(stack, mock_esp):
    """API key alone is not enough — admin gate is a separate header."""
    mock_esp.register()

    r = requests.get(
        f"{stack['backend']}/api/modules/{mock_esp.mac}/logs",
        headers={"X-API-Key": TEST_API_KEY},  # no X-Admin-Key
    )
    assert r.status_code == 403, r.text


# --- multi-cycle behavior -------------------------------------------------

def test_upload_loop_three_cycles_all_succeed(stack, mock_esp):
    mock_esp.register()
    codes = mock_esp.upload_loop(cycles=3, interval_s=0.2)
    assert all(200 <= c < 300 for c in codes), f"got codes={codes}"
    assert len(mock_esp.telemetry.last_http_codes) == 3
    assert mock_esp.telemetry.last_http_codes == codes
