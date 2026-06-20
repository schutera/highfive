import logging
import os
import time

from flask import Flask, g, request
from apscheduler.schedulers.background import BackgroundScheduler

from db.schema import init_db
from routes.admin_weather import admin_weather_bp
from routes.health import health_bp
from routes.logs import logs_bp
from routes.measurements import measurements_bp
from routes.modules import modules_bp
from routes.nests import nests_bp
from routes.progress import progress_bp
from routes.heartbeats import heartbeats_bp
from services.backup import run_backup
from services.log_ring import init_persistence as init_log_persistence
from services.log_ring import install as install_log_ring
from services.log_ring import log_event
from services.silence_watcher import check_silence
from services.weather_worker import run_weather_fetch

# Tee stdout/stderr into the in-memory ring (#171) so the admin server-logs
# endpoint can tail this service's output. Runs before the app serves traffic;
# print() re-resolves sys.stdout per call and Flask/werkzeug log handlers are
# constructed lazily at app.run, so capture is complete. See services/log_ring.py.
install_log_ring()
# Enable on-disk persistence + backfill the ring from prior history when LOG_DIR
# is set (compose sets it; unset = in-memory only). Before the banner so it is
# persisted too. See ADR-023.
init_log_persistence()

# Silence werkzeug's built-in access logger (#181). _access_log_finish below
# already emits one structured access entry per request; werkzeug's own request
# line would otherwise be tee-captured from stderr and mis-tagged `error` (red),
# double-logging every 200. ERROR keeps werkzeug's genuine error/exception
# logging. Must run before the first request — werkzeug only forces INFO when
# the level is still NOTSET.
logging.getLogger("werkzeug").setLevel(logging.ERROR)

# Structured boot banner through the logger (#178) — the analogue to the
# backend's server.ts banner. Runs at import under flask run / gunicorn and
# under `python app.py`, so the structured ingestion path has a real
# production caller (not just the tee fallback). Never log secrets here.
log_event("info", "🗄 duckdb-service starting (DuckDB persistence)")

app = Flask(__name__)


def _status_level(code: int) -> str:
    if code >= 500:
        return "error"
    if code >= 400:
        return "warn"
    return "info"


@app.before_request
def _access_log_start():
    g._access_start = time.perf_counter()


@app.after_request
def _access_log_finish(resp):
    # One structured access entry per request (#178): "method path status ms".
    # path ONLY — never query string, headers, or body — so the X-Admin-Key
    # header and any ?token=/?key= value can't reach the admin-readable /
    # disk-persisted ring. werkzeug's own access request line is silenced at the
    # logger (#181), so this is the only access entry — no duplicate, no false-red.
    start = g.pop("_access_start", None)
    if start is not None:
        ms = (time.perf_counter() - start) * 1000.0
        log_event(
            _status_level(resp.status_code),
            f"{request.method} {request.path} {resp.status_code} {ms:.1f}ms",
        )
    return resp


app.register_blueprint(health_bp)
app.register_blueprint(logs_bp)
app.register_blueprint(modules_bp)
app.register_blueprint(nests_bp)
app.register_blueprint(progress_bp)
app.register_blueprint(heartbeats_bp)
app.register_blueprint(measurements_bp)
app.register_blueprint(admin_weather_bp)

# Dev-only: /firmware.json + /firmware.app.bin proxy to homepage:5173.
# In prod, host-nginx serves these directly from homepage static; this
# blueprint stays unregistered. See routes/dev_ota_proxy.py for the
# rationale and the env-var contract.
if os.getenv("HIGHFIVE_DEV_OTA_PROXY", "false").lower() == "true":
    from routes.dev_ota_proxy import dev_ota_proxy_bp

    app.register_blueprint(dev_ota_proxy_bp)

init_db()

scheduler = BackgroundScheduler()
scheduler.add_job(
    run_backup, "cron", day_of_week="sun", hour=3, minute=0, id="weekly_backup"
)
scheduler.add_job(check_silence, "interval", minutes=15, id="silence_watcher")
# Weather worker (issue #111, ADR-017). Gated separately from the
# blueprint registration: the admin backfill endpoint must remain
# reachable even when the scheduled tick is disabled, so an operator
# can manually trigger a one-shot fetch on a stack where the live
# worker is intentionally off (e.g. throttled CI environments).
if os.getenv("WEATHER_WORKER_ENABLED", "true").lower() == "true":
    scheduler.add_job(run_weather_fetch, "interval", minutes=60, id="weather_worker")
scheduler.start()

if __name__ == "__main__":
    debug = os.getenv("DEBUG", "false").lower() == "true"
    # threaded=True (also Flask's app.run default — pinned explicitly because it
    # is load-bearing): the SSE live tail (`GET /logs/stream`, #178/ADR-023) holds
    # one worker for the stream's whole lifetime, so concurrent request handling is
    # required or an open admin tail would stall all other traffic. A future move
    # to gunicorn must keep per-stream concurrency (threaded/async workers).
    app.run(host="0.0.0.0", port=8000, debug=debug, threaded=True)
