"""
Silence watcher — periodic check that fires Discord alerts when a module
goes quiet, and a recovery message when it comes back.

Considers any of three liveness signals: module re-registration
(`module_configs.last_seen_at`), most recent image upload, most recent
heartbeat. Whichever is freshest wins. (Pre-#97 split this read
`module_configs.updated_at`; that column is now row-metadata only —
see chapter 11 "updated_at semantic overload".)
"""

from datetime import datetime

from db.repository import query_all, write_transaction
from services.discord import send_discord_message

# A module is "silent" once nothing has been heard from it for this long.
SILENCE_THRESHOLD_S = 3 * 3600  # 3 hours

# Don't re-fire a silence alert more often than this for the same module.
REALERT_INTERVAL_S = 6 * 3600  # 6 hours


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

    # Read via `query_all` (for #246) — no bare `get_conn()` outside
    # `db/repository.py`, and the connection is closed instead of left
    # for GC. State updates go through one `write_transaction()` below;
    # the read and the writes no longer share a single lock hold, which
    # is safe because APScheduler runs this job on one thread
    # (`max_instances=1` default) and the decision inputs are
    # recomputed from the DB on every tick.
    rows = query_all(
        """
            SELECT m.id,
                   m.name,
                   m.last_seen_at,
                   m.last_silence_alert_at,
                   (SELECT MAX(uploaded_at)
                      FROM image_uploads
                     WHERE module_id = m.id) AS last_image_at,
                   (SELECT MAX(received_at)
                      FROM module_heartbeats
                     WHERE module_id = m.id) AS last_hb_at
              FROM module_configs m
        """
    )

    updates = []
    for row in rows:
        mid = row["id"]
        name = row["name"]
        last_seen_at = row["last_seen_at"]
        alerted_at = row["last_silence_alert_at"]
        last_image_at = row["last_image_at"]
        last_hb_at = row["last_hb_at"]

        # lastSeenAt = freshest of the three liveness signals; ignore NULLs.
        candidates = [
            t for t in (last_seen_at, last_image_at, last_hb_at) if t is not None
        ]
        if not candidates:
            continue  # never seen — don't alert; setup is in progress.
        last_seen = max(candidates)
        age_s = (now - last_seen).total_seconds()

        if age_s > SILENCE_THRESHOLD_S:
            # Currently silent.
            if (
                alerted_at is None
                or (now - alerted_at).total_seconds() > REALERT_INTERVAL_S
            ):
                silence_alerts.append((mid, name, last_seen, age_s))
                updates.append(
                    (
                        "UPDATE module_configs SET last_silence_alert_at = ? WHERE id = ?",
                        [now, mid],
                    )
                )
        else:
            # Currently alive. If we previously raised a silence alert,
            # it has now recovered — fire one recovery message and clear state.
            if alerted_at is not None:
                downtime_s = (now - alerted_at).total_seconds()
                recovery_alerts.append((mid, name, downtime_s))
                updates.append(
                    (
                        "UPDATE module_configs SET last_silence_alert_at = NULL WHERE id = ?",
                        [mid],
                    )
                )

    if updates:
        with write_transaction() as con:
            for sql, params in updates:
                con.execute(sql, params)

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
