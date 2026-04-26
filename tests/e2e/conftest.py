"""
Pytest fixtures for the end-to-end pipeline tests.

The `stack` fixture (session-scoped) brings up the four-service docker
compose defined in docker-compose.test.yml, polls each service's health
endpoint until the whole thing is reachable, yields the per-service URLs
to the tests, and tears the stack down on session exit.

Set E2E_REUSE_STACK=1 to skip boot/teardown — useful when iterating on
test code locally and you've already run `docker compose -f
docker-compose.test.yml -p highfive-e2e up -d` by hand.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Dict

import pytest
import requests

REPO_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILE = Path(__file__).parent / "docker-compose.test.yml"
PROJECT_NAME = "highfive-e2e"

# Make tools/mock_esp.py importable from the test files
sys.path.insert(0, str(REPO_ROOT))


# Host ports defined in docker-compose.test.yml
STACK_URLS: Dict[str, str] = {
    "duckdb": "http://localhost:9002",
    "image_service": "http://localhost:9000",
    "backend": "http://localhost:4002",
}

# Each service must answer 200 on these paths before tests start
HEALTH_PATHS: Dict[str, str] = {
    "duckdb": "/health",
    "image_service": "/health",
    "backend": "/api/health",
}


def _compose(*args: str) -> subprocess.CompletedProcess:
    cmd = [
        "docker", "compose",
        "-f", str(COMPOSE_FILE),
        "-p", PROJECT_NAME,
        *args,
    ]
    return subprocess.run(cmd, cwd=str(COMPOSE_FILE.parent), check=False)


def _wait_for_health(timeout_s: int = 180) -> None:
    """Poll each service's health endpoint until all return 200, or raise."""
    deadline = time.time() + timeout_s
    healthy: set = set()
    last_errors: Dict[str, str] = {}

    print(f"\n[e2e] waiting for services to become healthy "
          f"(timeout {timeout_s}s)...", flush=True)

    while time.time() < deadline:
        for name, base in STACK_URLS.items():
            if name in healthy:
                continue
            url = f"{base}{HEALTH_PATHS[name]}"
            try:
                r = requests.get(url, timeout=2)
                if r.status_code == 200:
                    healthy.add(name)
                    print(f"[e2e]   {name} healthy ({url})", flush=True)
                else:
                    last_errors[name] = f"HTTP {r.status_code}"
            except requests.RequestException as exc:
                last_errors[name] = type(exc).__name__
        if len(healthy) == len(STACK_URLS):
            return
        time.sleep(2)

    not_healthy = set(STACK_URLS) - healthy
    raise RuntimeError(
        f"stack did not become healthy in {timeout_s}s. "
        f"Healthy: {sorted(healthy)}. "
        f"Not healthy: {sorted(not_healthy)}. "
        f"Last errors: {last_errors}"
    )


@pytest.fixture(scope="session")
def stack() -> Dict[str, str]:
    """Boot the e2e stack, wait for health, yield URLs, then tear down."""
    reuse = os.getenv("E2E_REUSE_STACK") == "1"

    if not reuse:
        print("\n[e2e] booting stack via docker compose...", flush=True)
        result = _compose("up", "-d", "--build")
        if result.returncode != 0:
            raise RuntimeError(
                "docker compose up failed (returncode "
                f"{result.returncode}). See output above."
            )

    try:
        _wait_for_health()
        yield STACK_URLS
    finally:
        if not reuse:
            print("\n[e2e] tearing down stack...", flush=True)
            _compose("down", "-v")


@pytest.fixture
def mock_esp(stack):
    """Per-test MockEsp instance with a unique MAC, pointed at the stack."""
    from tools.mock_esp import MockEsp

    return MockEsp(
        upload_url=f"{stack['image_service']}/upload",
        init_url=f"{stack['duckdb']}/new_module",
        # Canonical 12-char lowercase hex per the 2B ModuleId contract.
        # uuid4().hex is already lowercase hex; first 12 chars produce a
        # well-formed canonical MAC that won't collide between test runs.
        mac=uuid.uuid4().hex[:12],
        module_name=f"E2E Mock {uuid.uuid4().hex[:6]}",
    )
