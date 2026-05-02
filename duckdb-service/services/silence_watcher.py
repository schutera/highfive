"""
Silence watcher — periodic check that fires Discord alerts when a module
goes quiet, and a recovery message when it comes back.

Considers any of three liveness signals: module re-registration
(`module_configs.updated_at`), most recent image upload, most recent
heartbeat. Whichever is freshest wins.
"""

from datetime import datetime

from db.connection import lock, get_conn
from services.discord import send_discord_message

# A module is "silent" once nothing has been heard from it for this long.
SILENCE_THRESHOLD_S = 3 * 3600        # 3 hours

# Don't re-fire a silence alert more often than this for the same module.
REALERT_INTERVAL_S = 6 * 3600         # 6 hours


def _fmt_age(seconds: float) -> str:
    if seconds < 3600:
        return f"{seconds / 60:.0f}m"
    if seconds < 86400:
        return f"{seconds / 3600:.1f}h"
    return f"{seconds / 86400:.1f}d"


def check_silence():
    now = datetime.now()
    silence_alerts = []
    recovery_alerts = []

    with lock:
        con = get_conn()
        rows = con.execute(
            """
            SELECT m.id,
                   m.name,
                   m.updated_at,
                   m.last_silence_alert_at,
                   (SELECT MAX(uploaded_at)
                      FROM image_uploads
                     WHERE module_id = m.id) AS last_image_at,
                   (SELECT MAX(received_at)
                      FROM module_heartbeats
                     WHERE module_id = m.id) AS last_hb_at
              FROM module_configs m
            """
        ).fetchall()

        for row in rows:
            mid, name, updated_at, alerted_at, last_image_at, last_hb_at = row

            # lastSeenAt = freshest of the three liveness signals; ignore NULLs.
            candidates = [t for t in (updated_at, last_image_at, last_hb_at) if t is not None]
            if not candidates:
                continue  # never seen — don't alert; setup is in progress.
            last_seen = max(candidates)
            age_s = (now - last_seen).total_seconds()

            if age_s > SILENCE_THRESHOLD_S:
                # Currently silent.
                if alerted_at is None or (now - alerted_at).total_seconds() > REALERT_INTERVAL_S:
                    silence_alerts.append((mid, name, last_seen, age_s))
                    con.execute(
                        "UPDATE module_configs SET last_silence_alert_at = ? WHERE id = ?",
                        [now, mid],
                    )
            else:
                # Currently alive. If we previously raised a silence alert,
                # it has now recovered — fire one recovery message and clear state.
                if alerted_at is not None:
                    downtime_s = (now - alerted_at).total_seconds()
                    recovery_alerts.append((mid, name, downtime_s))
                    con.execute(
                        "UPDATE module_configs SET last_silence_alert_at = NULL WHERE id = ?",
                        [mid],
                    )

    # Send Discord OUTSIDE the DB lock — HTTP can stall.
    for mid, name, last_seen, age_s in silence_alerts:
        send_discord_message(
            f"🔴 **{name} is down** — silent for {_fmt_age(age_s)}\n"
            f"   id: `{mid}` · last seen: `{last_seen.isoformat(timespec='seconds')}`"
        )
    for mid, name, downtime_s in recovery_alerts:
        send_discord_message(
            f"🟢 **{name} is back** — recovered after {_fmt_age(downtime_s)}\n"
            f"   id: `{mid}`"
        )

    if silence_alerts or recovery_alerts:
        print(
            f"[silence_watcher] alerts sent: {len(silence_alerts)} silent, "
            f"{len(recovery_alerts)} recovered"
        )
