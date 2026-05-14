"""Dev-only OTA artifact proxy.

In production, host-nginx fronts homepage and the API services on the
same hostname and routes `/firmware.json` + `/firmware.app.bin` to the
homepage static (see docs/07-deployment-view/production-deployment.md).
The ESP firmware's `httpOtaCheckAndApply` derives the OTA host from
the module's `INIT_URL` config, which in production resolves to that
single nginx vhost — so the OTA paths reach homepage's static files.

In dev (`docker-compose.yml`), each service has its own host:port; no
nginx is in front. `INIT_URL` points at duckdb-service:8002 (where
`/new_module` and `/modules` live), so `/firmware.json` and
`/firmware.app.bin` requests from the module land here too. Without
intervention they 404 and the OTA flow is untestable in dev.

This blueprint adds dev-only passthrough to homepage:5173 (the Vite
dev server, which serves `homepage/public/firmware.*` at the root).
It is gated by `HIGHFIVE_DEV_OTA_PROXY=true` (set in `docker-compose.yml`)
so production deploys do NOT register these routes — keeping
duckdb-service's prod surface area unchanged and avoiding ambiguity
about who owns the OTA artifact in prod (nginx does).
"""

import os

import requests
from flask import Blueprint, Response, stream_with_context

dev_ota_proxy_bp = Blueprint("dev_ota_proxy", __name__)

HOMEPAGE_DEV_URL = os.getenv("HOMEPAGE_DEV_URL", "http://homepage:5173")


@dev_ota_proxy_bp.get("/firmware.json")
def firmware_json():
    upstream = requests.get(f"{HOMEPAGE_DEV_URL}/firmware.json", timeout=5)
    return Response(
        upstream.content,
        status=upstream.status_code,
        content_type=upstream.headers.get("Content-Type", "application/json"),
    )


@dev_ota_proxy_bp.get("/firmware.app.bin")
def firmware_app_bin():
    upstream = requests.get(
        f"{HOMEPAGE_DEV_URL}/firmware.app.bin", timeout=30, stream=True
    )
    return Response(
        stream_with_context(upstream.iter_content(chunk_size=8192)),
        status=upstream.status_code,
        content_type=upstream.headers.get("Content-Type", "application/octet-stream"),
        headers={
            "Content-Length": upstream.headers.get("Content-Length", ""),
        },
    )
