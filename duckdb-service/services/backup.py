import glob
import gzip
import hashlib
import os
import shutil
import time
from datetime import datetime, timezone

from db.connection import DB_PATH, get_conn, lock
from services.discord import send_discord_message

# Mirrors DB_PATH's own env-with-fallback shape (db/connection.py) rather
# than hardcoding an absolute container path, so a non-Docker run doesn't
# try to mkdir /data at the filesystem root.
DEFAULT_BACKUP_DIR = os.path.join(os.path.dirname(DB_PATH) or ".", "backups")
DEFAULT_BACKUP_KEEP = 4

# Extra free space required before the raw copy is attempted, as a
# multiple of the live DB's size. The copy needs headroom ON TOP OF the
# live file (which is already-allocated, not new usage): up to ~1x for
# the raw copy itself, plus the still-growing gzip output, which briefly
# coexists with the raw copy before it's removed. 1.5x rather than a
# tighter bound because gzip's ratio on this file isn't known in advance
# — sufficient as long as gzip beats 2:1, comfortably true for a DB file.
_MIN_FREE_SPACE_FACTOR = 1.5

# An off-host sync unit (production-deployment.md "Backup & Restore") is
# entirely external — the app can't observe whether one is *running*,
# only whether one has touched this file recently. A static "I promise
# it's configured" flag would stay trusted forever after being set once,
# even if the sync silently stopped; a freshness check at least degrades
# to the honest "local-only" warning again if it does. 48h rather than a
# tighter bound so the documented daily sync timer's routine ~24h-old
# heartbeat is never misread as stale.
_OFFHOST_HEARTBEAT_FILENAME = ".offhost_sync_ok"
_OFFHOST_MAX_AGE_S = 48 * 3600


def _backup_dir() -> str:
    # `or` rather than plain getenv-with-default: a BACKUP_DIR= line
    # present-but-blank in an env file (dev's `env_file: .env`, unlike
    # prod's `${VAR:-default}` compose interpolation, passes an empty
    # string straight through) is "unset" in effect, not "use the
    # filesystem root's backups subdir".
    return os.getenv("BACKUP_DIR") or DEFAULT_BACKUP_DIR


def _backup_keep() -> int:
    # A non-integer value (e.g. a blank BACKUP_KEEP= line in an env file,
    # which reaches the container as an empty string, not "unset") falls
    # back to the default with a warning rather than raising every week —
    # see test_run_backup_invalid_keep_env_falls_back_to_default.
    raw = os.getenv("BACKUP_KEEP", str(DEFAULT_BACKUP_KEEP))
    try:
        keep = int(raw)
    except ValueError:
        print(
            f"WARNING: BACKUP_KEEP={raw!r} is not an integer — using default {DEFAULT_BACKUP_KEEP}"
        )
        keep = DEFAULT_BACKUP_KEEP
    # Clamped to >= 1. Only a NEGATIVE value is actually dangerous here —
    # `existing[:-keep]` turns into the POSITIVE slice `existing[:-keep]`
    # with `-keep` positive, which spans (and deletes) the entire retained
    # set once it has fewer than `-keep` entries. Exactly 0 is harmless
    # even unclamped (`existing[:-0] == existing[:0] == []`, a no-op), so
    # this floor is only load-bearing for negative input — see
    # test_run_backup_negative_keep_clamps_to_at_least_one.
    return max(1, keep)


def _has_fresh_offhost_sync(backup_dir: str) -> bool:
    heartbeat_path = os.path.join(backup_dir, _OFFHOST_HEARTBEAT_FILENAME)
    if not os.path.exists(heartbeat_path):
        return False
    return (time.time() - os.path.getmtime(heartbeat_path)) <= _OFFHOST_MAX_AGE_S


def _warn_if_local_only(backup_dir: str, filename: str = "") -> None:
    # Deliberately NOT gated on DISCORD_WEBHOOK_URL. Discord only ever
    # gets a text notification (never the DB file, per ADR-031) — whether
    # it's configured says nothing about whether a backup actually has an
    # off-host copy. An earlier version of this check OR'd the two, which
    # meant the one production configuration this warning most needs to
    # fire in (Discord notifications on, as recommended, but no real
    # off-host sync set up yet) silently never saw it. Caught only by a
    # dedicated test, not by inspection across three review rounds — see
    # test_run_backup_warns_even_when_discord_is_configured.
    if _has_fresh_offhost_sync(backup_dir):
        return
    suffix = f" ({filename})" if filename else ""
    print(
        "WARNING: no fresh off-host sync heartbeat (see"
        f" production-deployment.md 'Backup & Restore') — backups are"
        f" local-only{suffix}"
    )


_warn_if_local_only(_backup_dir())


def _timestamp_filename() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d_%H%M%S")


def _check_free_space(backup_dir: str) -> None:
    # Measured AFTER the CHECKPOINT (caller's responsibility) so this
    # reflects the file's real size post-WAL-flush, not a possibly
    # smaller pre-checkpoint reading.
    needed = os.path.getsize(DB_PATH) * _MIN_FREE_SPACE_FACTOR
    free = shutil.disk_usage(backup_dir).free
    if free < needed:
        raise RuntimeError(
            f"not enough free space in {backup_dir}: need ~{needed / (1024 * 1024):.0f} MB, "
            f"have {free / (1024 * 1024):.0f} MB"
        )


def _checkpoint_and_copy(raw_copy_path: str) -> float:
    """Hold the global write lock only long enough to CHECKPOINT + copy."""
    start = time.monotonic()
    with lock:
        conn = get_conn()
        try:
            conn.execute("CHECKPOINT")
        finally:
            conn.close()
        _check_free_space(os.path.dirname(raw_copy_path))
        shutil.copy2(DB_PATH, raw_copy_path)
    return time.monotonic() - start


def _gzip_and_remove(raw_copy_path: str, dest_gz_path: str) -> None:
    """Gzips ``raw_copy_path`` into ``dest_gz_path`` and removes the raw
    copy. Callers publish under a *retained* name only after this AND the
    sha256 sidecar both succeed — see run_backup's atomic-rename comment.
    """
    with open(raw_copy_path, "rb") as src, gzip.open(dest_gz_path, "wb") as dst:
        shutil.copyfileobj(src, dst)
    os.remove(raw_copy_path)


def _sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _rotate(backup_dir: str, keep: int) -> None:
    keep = max(1, keep)
    # Only files with a matching .sha256 are trusted, retained-set
    # members — one with no sidecar is neither counted toward `keep` nor
    # deleted (see test_rotate_skips_a_gz_file_with_no_sidecar). Under the
    # atomic-publish design in run_backup this shouldn't arise in normal
    # operation (the sidecar is always written before a file reaches this
    # name), but it's cheap insurance against a corrupt/foreign file.
    existing = sorted(
        (
            path
            for path in glob.glob(
                os.path.join(backup_dir, "highfive_backup_*.duckdb.gz")
            )
            if os.path.exists(f"{path}.sha256")
        ),
        key=os.path.getmtime,
    )
    for path in existing[:-keep]:
        os.remove(path)
        os.remove(f"{path}.sha256")


def _cleanup(*paths: str) -> None:
    for path in paths:
        if os.path.exists(path):
            os.remove(path)


def _sweep_stale_tmp_files(backup_dir: str) -> None:
    """Removes leftovers from a prior run that was killed mid-write (OOM,
    container stop, host crash): raw-copy / in-progress-gzip files (which
    never reached their final retained name, so `_rotate`'s
    `*.duckdb.gz` glob never sees them and they'd otherwise leak forever
    at up to ~1x the live DB's size each), plus an orphaned `.sha256`
    sidecar left by a crash between the sidecar write and the atomic
    rename (harmless — `_rotate` never touches a sidecar with no matching
    `.gz` — but would otherwise also leak forever, one tiny file at a
    time). Safe to run unconditionally at the top of a fresh run: nothing
    else is writing to `backup_dir` at this point (single-process
    precondition, see ADR-031's Forbidden section).
    """
    if not os.path.isdir(backup_dir):
        return
    for pattern in (
        ".highfive_backup_*.duckdb.gz.tmp",
        "highfive_backup_*.duckdb.gz.inprogress",
    ):
        for stale in glob.glob(os.path.join(backup_dir, pattern)):
            os.remove(stale)
    for sha_path in glob.glob(
        os.path.join(backup_dir, "highfive_backup_*.duckdb.gz.sha256")
    ):
        if not os.path.exists(sha_path[: -len(".sha256")]):
            os.remove(sha_path)


def run_backup() -> None:
    backup_dir = _backup_dir()
    filename = f"highfive_backup_{_timestamp_filename()}.duckdb.gz"
    raw_copy_path = os.path.join(backup_dir, f".{filename}.tmp")
    gz_path = os.path.join(backup_dir, filename)
    inprogress_gz_path = f"{gz_path}.inprogress"
    sha_path = f"{gz_path}.sha256"

    print(f"Starting backup: {filename}")

    # Stage 1: produce a verified artifact. Any failure here is cleaned
    # up — nothing complete existed yet, so there is nothing to preserve.
    try:
        os.makedirs(backup_dir, exist_ok=True)
        _sweep_stale_tmp_files(backup_dir)

        lock_seconds = _checkpoint_and_copy(raw_copy_path)
        print(f"Backup lock held for {lock_seconds:.2f}s")

        _gzip_and_remove(raw_copy_path, inprogress_gz_path)
        digest = _sha256_of(inprogress_gz_path)
        with open(sha_path, "w") as f:
            f.write(f"{digest}  {filename}\n")
        # Atomic publish, LAST — the file only ever appears at its
        # trusted final name once gzip + sha256 have both fully
        # succeeded. A hard kill (SIGKILL/OOM/host crash, as opposed to a
        # caught Python exception, which the except block below already
        # cleans up) before this point leaves only the .inprogress file
        # and/or a lone .sha256 sidecar — never a truncated file at the
        # name `_rotate` and a restore would trust. See
        # test_run_backup_hard_kill_during_gzip_does_not_corrupt_existing_backups,
        # which reproduces the pre-fix corruption directly.
        os.replace(inprogress_gz_path, gz_path)
    except Exception as exc:
        print(f"Backup failed: {exc}")
        _cleanup(raw_copy_path, inprogress_gz_path, gz_path, sha_path)
        send_discord_message(f"⚠️ Backup FAILED — {filename}: {exc}")
        return

    # Stage 2: rotation + notification. The artifact above is already
    # complete and sha256-verified — a failure here must never delete it.
    try:
        _rotate(backup_dir, _backup_keep())
        size_mb = os.path.getsize(gz_path) / (1024 * 1024)
        send_discord_message(
            f"Backup complete — `{filename}` ({size_mb:.1f} MB, "
            f"lock held {lock_seconds:.2f}s, sha256 `{digest[:12]}…`, "
            f"path `{gz_path}`)"
        )
        _warn_if_local_only(backup_dir, filename)
    except Exception as exc:
        print(f"Backup post-processing failed, artifact kept: {exc}")
        send_discord_message(
            f"⚠️ Backup `{filename}` was saved but post-processing failed: {exc}"
        )
