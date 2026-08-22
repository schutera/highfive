"""Tests for the retained backup job (issue #232).

Covers: retained + rotated file under ``BACKUP_DIR``, sha256 sidecar,
``CHECKPOINT`` + free-space check issued (in order) before the raw copy
(pinned by call-order, not by WAL-file timing — DuckDB 1.4.4
auto-checkpoints on last-connection-close, so a "leave the WAL dirty"
fixture is not portable across platforms; verified empirically against
this DuckDB version before choosing this approach), lock released before
the (slow) gzip step, a disk-space pre-flight (existence + exact 1.5x
boundary), the gz artifact published atomically (never a truncated file
at the trusted final name, even under a simulated hard kill), Discord
used only for a text notification (never the DB file), the local-only
warning (at both import time and post-run) gated on a fresh off-host
sync heartbeat file, ``BACKUP_KEEP`` clamped to at least 1 for the value
that can actually cause harm (negative, not zero — see the comment on
that test), and cleanup that only ever removes an *unfinished* artifact
— never a completed one.
"""

from __future__ import annotations

import gzip
import hashlib
import os
import sys
import time
import types

import duckdb
import pytest


def _seed_rows(fresh_db):
    con = fresh_db.connection.get_conn()
    try:
        con.execute(
            "INSERT INTO module_configs (id, name, lat, lng, first_online, "
            "image_count) VALUES ('aabbccddeeff', 'Seed', 47.8, 9.6, "
            "'2024-01-01', 0)"
        )
        con.execute(
            "INSERT INTO nest_data (nest_id, module_id, beeType) "
            "VALUES ('n1', 'aabbccddeeff', 'resin')"
        )
        con.commit()
    finally:
        con.close()


def _configure(monkeypatch, tmp_path, keep=4):
    backup_dir = tmp_path / "backups"
    monkeypatch.setenv("BACKUP_DIR", str(backup_dir))
    monkeypatch.setenv("BACKUP_KEEP", str(keep))
    return backup_dir


def _decompress(gz_path, dest_path):
    with gzip.open(gz_path, "rb") as src, open(dest_path, "wb") as dst:
        dst.write(src.read())


def _gz_files(backup_dir):
    return sorted(f for f in os.listdir(backup_dir) if f.endswith(".duckdb.gz"))


def test_run_backup_creates_restorable_gzip_with_matching_sha256(
    fresh_db, monkeypatch, tmp_path
):
    _configure(monkeypatch, tmp_path)
    _seed_rows(fresh_db)

    fresh_db.backup.run_backup()

    gz_files = _gz_files(tmp_path / "backups")
    assert len(gz_files) == 1
    gz_path = tmp_path / "backups" / gz_files[0]

    restored_path = tmp_path / "restored.duckdb"
    _decompress(gz_path, restored_path)
    conn = duckdb.connect(str(restored_path), read_only=True)
    try:
        assert conn.execute("SELECT COUNT(*) FROM module_configs").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM nest_data").fetchone()[0] == 1
    finally:
        conn.close()

    sha_path = tmp_path / "backups" / f"{gz_files[0]}.sha256"
    assert sha_path.exists()
    expected_digest = hashlib.sha256(gz_path.read_bytes()).hexdigest()
    assert expected_digest in sha_path.read_text()


def test_run_backup_checkpoints_and_checks_space_before_copying(
    fresh_db, monkeypatch, tmp_path
):
    """Pins two ADR-031 invariants in one call-order assertion: CHECKPOINT
    must run before the free-space check, which must run before the raw
    file copy — not skipped, not reordered.

    A held-open second connection would prove the CHECKPOINT ordering via
    WAL timing on Linux, but DuckDB 1.4.4 auto-checkpoints as soon as the
    *last* connection to a file closes (verified empirically), and an
    open connection blocks a same-process file copy outright on Windows
    — neither leaves a portable way to observe "WAL had pending data".
    Pinning the call order directly is deterministic on every platform.
    Note this pins *that the calls happen, in order* — not that CHECKPOINT
    flushes anything in THIS test's fixture, where (per the same
    auto-checkpoint-on-close behavior) there is usually nothing pending in
    the WAL to flush by the time ``run_backup`` runs at all.
    """
    _configure(monkeypatch, tmp_path)
    _seed_rows(fresh_db)

    events = []
    real_get_conn = fresh_db.backup.get_conn

    class _SpyConn:
        """Thin proxy — DuckDBPyConnection's own attributes are read-only,
        so its bound ``execute`` can't be monkeypatched directly."""

        def __init__(self, real_conn):
            self._real = real_conn

        def execute(self, sql, *args, **kwargs):
            if "CHECKPOINT" in sql.upper():
                events.append("checkpoint")
            return self._real.execute(sql, *args, **kwargs)

        def close(self):
            return self._real.close()

    def _spying_get_conn():
        return _SpyConn(real_get_conn())

    real_check_free_space = fresh_db.backup._check_free_space

    def _spying_check_free_space(*args, **kwargs):
        events.append("free_space_check")
        return real_check_free_space(*args, **kwargs)

    real_copy2 = fresh_db.backup.shutil.copy2

    def _spying_copy2(*args, **kwargs):
        events.append("copy")
        return real_copy2(*args, **kwargs)

    monkeypatch.setattr(fresh_db.backup, "get_conn", _spying_get_conn)
    monkeypatch.setattr(fresh_db.backup, "_check_free_space", _spying_check_free_space)
    monkeypatch.setattr(fresh_db.backup.shutil, "copy2", _spying_copy2)

    fresh_db.backup.run_backup()

    assert events == ["checkpoint", "free_space_check", "copy"]


def test_run_backup_rotates_to_keep_newest_n(fresh_db, monkeypatch, tmp_path):
    backup_dir = _configure(monkeypatch, tmp_path, keep=2)
    _seed_rows(fresh_db)

    for stamp in ("2026-01-01_000000", "2026-01-02_000000", "2026-01-03_000000"):
        monkeypatch.setattr(fresh_db.backup, "_timestamp_filename", lambda s=stamp: s)
        fresh_db.backup.run_backup()

    assert _gz_files(backup_dir) == [
        "highfive_backup_2026-01-02_000000.duckdb.gz",
        "highfive_backup_2026-01-03_000000.duckdb.gz",
    ]
    sha_files = sorted(f for f in os.listdir(backup_dir) if f.endswith(".sha256"))
    assert len(sha_files) == 2


def test_rotate_orders_by_mtime_not_filename(fresh_db, monkeypatch, tmp_path):
    """The rotate-newest-N logic must survive a case where filename order
    and mtime order disagree — a fixture that creates files in strict
    chronological (and thus also alphabetical) order can't distinguish a
    filename-sort implementation from an mtime-sort one, so this
    deliberately reverses them."""
    backup_dir = tmp_path / "backups"
    backup_dir.mkdir()
    names = [
        "highfive_backup_2026-01-01_000000.duckdb.gz",
        "highfive_backup_2026-01-02_000000.duckdb.gz",
        "highfive_backup_2026-01-03_000000.duckdb.gz",
    ]
    for name in names:
        (backup_dir / name).write_bytes(b"x")
        (backup_dir / f"{name}.sha256").write_text("deadbeef  x\n")

    # Alphabetically-first file gets the NEWEST mtime; alphabetically-last
    # gets the OLDEST — the exact opposite of chronological-by-name.
    now = time.time()
    os.utime(backup_dir / names[0], (now, now))
    os.utime(backup_dir / names[1], (now - 20, now - 20))
    os.utime(backup_dir / names[2], (now - 40, now - 40))

    fresh_db.backup._rotate(str(backup_dir), keep=2)

    remaining = sorted(
        f.name for f in backup_dir.iterdir() if f.name.endswith(".duckdb.gz")
    )
    # By mtime the two newest are names[0] and names[1] — a filename-sort
    # implementation would instead have kept names[1] and names[2].
    assert remaining == sorted([names[0], names[1]])


def test_rotate_skips_a_gz_file_with_no_sidecar(fresh_db, monkeypatch, tmp_path):
    """A *.duckdb.gz with no matching .sha256 is treated as untrusted, not
    as part of the rotated set — it must be neither counted toward `keep`
    nor deleted. Under the current atomic-publish design this shouldn't
    arise from normal operation (the sidecar is always written before the
    file reaches its final name), but it's cheap insurance against a
    corrupt/foreign file landing in BACKUP_DIR some other way."""
    backup_dir = tmp_path / "backups"
    backup_dir.mkdir()
    orphan = "highfive_backup_2026-01-01_000000.duckdb.gz"
    (backup_dir / orphan).write_bytes(b"x")  # no .sha256 for this one

    for stamp in ("2026-01-02_000000", "2026-01-03_000000"):
        name = f"highfive_backup_{stamp}.duckdb.gz"
        (backup_dir / name).write_bytes(b"x")
        (backup_dir / f"{name}.sha256").write_text("deadbeef  x\n")

    fresh_db.backup._rotate(str(backup_dir), keep=1)

    remaining = sorted(
        f.name for f in backup_dir.iterdir() if f.name.endswith(".duckdb.gz")
    )
    # The orphan survives untouched; of the two sidecar'd files, only the
    # newest (01-03) is kept.
    assert remaining == sorted([orphan, "highfive_backup_2026-01-03_000000.duckdb.gz"])


def test_run_backup_blank_backup_dir_env_falls_back_to_default(fresh_db, monkeypatch):
    """A present-but-empty BACKUP_DIR (e.g. a blank line in a dev
    env_file, which passes an empty string through rather than leaving
    the var unset) must fall back to DEFAULT_BACKUP_DIR, not resolve to
    an empty path."""
    monkeypatch.setenv("BACKUP_DIR", "")
    _seed_rows(fresh_db)

    fresh_db.backup.run_backup()

    assert len(_gz_files(fresh_db.backup.DEFAULT_BACKUP_DIR)) == 1


def test_run_backup_invalid_keep_env_falls_back_to_default(
    fresh_db, monkeypatch, tmp_path
):
    """Asserts rotation actually still enforces DEFAULT_BACKUP_KEEP — not
    merely that run_backup() survives an invalid env value. Stage 2's own
    exception handler already keeps a just-made artifact on ANY
    post-processing failure, so a weaker "one backup still exists" check
    would pass even if BACKUP_KEEP parsing raised on every single run and
    rotation silently never ran again (backups piling up unbounded)."""
    backup_dir = _configure(monkeypatch, tmp_path)
    monkeypatch.setenv("BACKUP_KEEP", "not-a-number")
    _seed_rows(fresh_db)

    stamps = [f"2026-01-0{n}_000000" for n in range(1, 6)]
    for stamp in stamps:
        monkeypatch.setattr(fresh_db.backup, "_timestamp_filename", lambda s=stamp: s)
        fresh_db.backup.run_backup()

    assert len(_gz_files(backup_dir)) == fresh_db.backup.DEFAULT_BACKUP_KEEP


def test_run_backup_negative_keep_clamps_to_at_least_one(
    fresh_db, monkeypatch, tmp_path
):
    """BACKUP_KEEP=0 (not tested here) is harmless even with NO clamp at
    all: Python's ``existing[:-0] == existing[:0] == []`` always deletes
    nothing, whatever `keep` is clamped to. A NEGATIVE value is the one
    that actually needs the clamp — ``existing[:-keep]`` for keep=-3
    becomes the POSITIVE slice ``existing[:3]``, which spans (and deletes)
    the entire retained set once it has fewer than 3 entries. Verified by
    removing both `max(1, keep)` clamps and confirming this fails."""
    backup_dir = _configure(monkeypatch, tmp_path, keep=-3)
    _seed_rows(fresh_db)

    fresh_db.backup.run_backup()

    assert len(_gz_files(backup_dir)) == 1


def test_run_backup_never_sends_db_file_to_discord(fresh_db, monkeypatch, tmp_path):
    """Restores the REAL ``send_discord_message`` (fresh_db's fixture spies
    it out by default for every test) so this test observes the actual
    ``requests.post`` call shape, instead of a spy that would pass even if
    ``run_backup`` called something else entirely.
    """
    _configure(monkeypatch, tmp_path)
    monkeypatch.setattr(
        fresh_db.discord, "DISCORD_WEBHOOK_URL", "https://discord.example/webhook"
    )
    monkeypatch.setattr(
        fresh_db.backup, "send_discord_message", fresh_db.real_send_discord_message
    )
    _seed_rows(fresh_db)

    calls = []

    def _spying_post(url, **kwargs):
        calls.append(kwargs)
        return types.SimpleNamespace(raise_for_status=lambda: None)

    monkeypatch.setattr(fresh_db.discord.requests, "post", _spying_post)

    fresh_db.backup.run_backup()

    assert len(calls) == 1
    assert "files" not in calls[0]
    assert "json" in calls[0]
    assert "highfive_backup_" in calls[0]["json"]["content"]


def test_backup_module_warns_at_import_when_no_sink_configured(
    monkeypatch, capsys, tmp_path
):
    """Pins the boot-time half of the acceptance criterion directly, via
    its own fresh import of both `db.connection` and `services.backup` —
    NOT just `services.backup`. Without also purging `db.connection` and
    controlling `DUCKDB_PATH`, `DEFAULT_BACKUP_DIR` would resolve from
    whatever `db.connection` generation happens to already be cached in
    sys.modules (e.g. a previous test's `tmp_path`), which could
    coincidentally already contain a fresh `.offhost_sync_ok` heartbeat
    and make this assertion pass or fail depending on test order — this
    was in fact order-dependent before this fix (confirmed by running it
    directly after the "fresh heartbeat" test above)."""
    monkeypatch.delenv("DISCORD_WEBHOOK_URL", raising=False)
    monkeypatch.delenv("BACKUP_DIR", raising=False)
    monkeypatch.setenv("DUCKDB_PATH", str(tmp_path / "test.duckdb"))
    sys.modules.pop("services.backup", None)
    sys.modules.pop("db.connection", None)
    capsys.readouterr()

    import services.backup  # noqa: F401 -- import side effect is what's tested

    captured = capsys.readouterr()
    assert "local-only" in captured.out


def test_run_backup_warns_when_no_sink_configured(
    fresh_db, monkeypatch, tmp_path, capsys
):
    _configure(monkeypatch, tmp_path)
    _seed_rows(fresh_db)
    # Discard setup/import-time output (services/backup.py prints its own
    # "local-only" warning once at module-import time, pinned separately
    # above) so this assertion can only pass because of what run_backup()
    # itself printed — not by accident of fixture/import ordering.
    capsys.readouterr()

    fresh_db.backup.run_backup()

    captured = capsys.readouterr()
    assert "local-only" in captured.out


def test_run_backup_does_not_warn_when_offhost_heartbeat_is_fresh(
    fresh_db, monkeypatch, tmp_path, capsys
):
    backup_dir = _configure(monkeypatch, tmp_path)
    _seed_rows(fresh_db)

    backup_dir.mkdir(parents=True, exist_ok=True)
    heartbeat = backup_dir / ".offhost_sync_ok"
    heartbeat.write_text("ok")
    capsys.readouterr()

    fresh_db.backup.run_backup()

    captured = capsys.readouterr()
    assert "local-only" not in captured.out


def test_run_backup_does_not_warn_when_offhost_heartbeat_is_a_day_old(
    fresh_db, monkeypatch, tmp_path, capsys
):
    """The documented off-host sync unit runs `OnCalendar=daily` — a
    heartbeat that's routinely ~24h old right before the timer's next run
    must NOT be read as stale, or every deployment would see a false
    "local-only" warning daily despite a working sync."""
    backup_dir = _configure(monkeypatch, tmp_path)
    _seed_rows(fresh_db)

    backup_dir.mkdir(parents=True, exist_ok=True)
    heartbeat = backup_dir / ".offhost_sync_ok"
    heartbeat.write_text("ok")
    a_day_old = time.time() - (25 * 3600)
    os.utime(heartbeat, (a_day_old, a_day_old))
    capsys.readouterr()

    fresh_db.backup.run_backup()

    captured = capsys.readouterr()
    assert "local-only" not in captured.out


def test_run_backup_warns_when_offhost_heartbeat_is_stale(
    fresh_db, monkeypatch, tmp_path, capsys
):
    backup_dir = _configure(monkeypatch, tmp_path)
    _seed_rows(fresh_db)

    backup_dir.mkdir(parents=True, exist_ok=True)
    heartbeat = backup_dir / ".offhost_sync_ok"
    heartbeat.write_text("ok")
    stale = time.time() - (49 * 3600)  # just past the 48h freshness window
    os.utime(heartbeat, (stale, stale))
    capsys.readouterr()

    fresh_db.backup.run_backup()

    captured = capsys.readouterr()
    assert "local-only" in captured.out


def test_run_backup_warns_even_when_discord_is_configured(
    fresh_db, monkeypatch, tmp_path, capsys
):
    """Discord only ever gets a text notification (never the DB file, per
    ADR-031) — it configured says nothing about off-host redundancy. An
    earlier version of this check treated a configured DISCORD_WEBHOOK_URL
    as equivalent to a real off-host copy and skipped the warning, which
    silently defeated it in exactly the production configuration
    docker-compose.prod.yml and .env.production.example recommend
    (Discord notifications on, no off-host sync set up yet)."""
    _configure(monkeypatch, tmp_path)
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "https://discord.example/webhook")
    _seed_rows(fresh_db)
    capsys.readouterr()

    fresh_db.backup.run_backup()

    captured = capsys.readouterr()
    assert "local-only" in captured.out


def test_run_backup_releases_lock_before_gzip(fresh_db, monkeypatch, tmp_path):
    _configure(monkeypatch, tmp_path)
    _seed_rows(fresh_db)

    real_gzip_open = fresh_db.backup.gzip.open
    acquired = []

    def _spying_gzip_open(*args, **kwargs):
        got = fresh_db.backup.lock.acquire(blocking=False)
        acquired.append(got)
        if got:
            fresh_db.backup.lock.release()
        return real_gzip_open(*args, **kwargs)

    monkeypatch.setattr(fresh_db.backup.gzip, "open", _spying_gzip_open)

    fresh_db.backup.run_backup()

    assert acquired == [True]


def test_run_backup_holds_lock_during_copy(fresh_db, monkeypatch, tmp_path):
    """The mirror of test_run_backup_releases_lock_before_gzip above: that
    test only proves the lock is FREE by the time gzip runs, which is
    equally true whether the lock was ever held at all. This proves the
    other half of #232's thesis — the lock genuinely IS held for the
    checkpoint+copy step, not merely released afterward. Confirmed to
    fail if `with lock:` in `_checkpoint_and_copy` is removed entirely."""
    _configure(monkeypatch, tmp_path)
    _seed_rows(fresh_db)

    real_copy2 = fresh_db.backup.shutil.copy2
    acquired = []

    def _spying_copy2(*args, **kwargs):
        got = fresh_db.backup.lock.acquire(blocking=False)
        acquired.append(got)
        if got:
            fresh_db.backup.lock.release()
        return real_copy2(*args, **kwargs)

    monkeypatch.setattr(fresh_db.backup.shutil, "copy2", _spying_copy2)

    fresh_db.backup.run_backup()

    assert acquired == [False]


def test_run_backup_gzips_the_copy_not_the_live_db(fresh_db, monkeypatch, tmp_path):
    """The whole point of #232 is: hold the lock only for CHECKPOINT +
    copy, then gzip the now-static copy OUTSIDE the lock. If a refactor
    made the gzip step read DB_PATH directly instead of the copy, a write
    to the live DB in the gap between the copy and the gzip would leak
    into the retained artifact — reintroducing (just outside the lock
    instead of inside it) the exact "backs up the live file, not a
    consistent snapshot" defect #232 was filed over."""
    _configure(monkeypatch, tmp_path)
    _seed_rows(fresh_db)

    real_gzip_and_remove = fresh_db.backup._gzip_and_remove

    def _mutate_live_db_then_gzip(raw_copy_path, dest_gz_path):
        con = fresh_db.connection.get_conn()
        try:
            con.execute(
                "INSERT INTO module_configs (id, name, lat, lng, "
                "first_online, image_count) VALUES ('ffffffffffff', "
                "'Injected after copy', 1.0, 1.0, '2024-01-01', 0)"
            )
            con.commit()
        finally:
            con.close()
        return real_gzip_and_remove(raw_copy_path, dest_gz_path)

    monkeypatch.setattr(fresh_db.backup, "_gzip_and_remove", _mutate_live_db_then_gzip)

    fresh_db.backup.run_backup()

    gz_files = _gz_files(tmp_path / "backups")
    restored_path = tmp_path / "restored.duckdb"
    _decompress(tmp_path / "backups" / gz_files[0], restored_path)
    conn = duckdb.connect(str(restored_path), read_only=True)
    try:
        injected_count = conn.execute(
            "SELECT COUNT(*) FROM module_configs WHERE id = 'ffffffffffff'"
        ).fetchone()[0]
    finally:
        conn.close()

    assert injected_count == 0


def test_run_backup_leaves_exactly_the_gz_and_sidecar_on_success(
    fresh_db, monkeypatch, tmp_path
):
    """A weaker "at least one .duckdb.gz exists" check would miss a
    leftover raw copy / in-progress file that `_gzip_and_remove` or
    `run_backup` failed to clean up on the success path."""
    backup_dir = _configure(monkeypatch, tmp_path)
    _seed_rows(fresh_db)

    fresh_db.backup.run_backup()

    gz_files = _gz_files(backup_dir)
    assert len(gz_files) == 1
    assert sorted(os.listdir(backup_dir)) == sorted(
        [gz_files[0], f"{gz_files[0]}.sha256"]
    )


def test_run_backup_failure_after_copy_removes_the_raw_copy(
    fresh_db, monkeypatch, tmp_path
):
    """Distinct from test_run_backup_failure_before_artifact_leaves_no_partial_file
    (which fails BEFORE the raw copy exists at all, via a failing
    shutil.copy2) — this fails AFTER the copy succeeds, so the raw copy
    genuinely exists on disk when stage 1's except handler runs, and only
    a `_cleanup` call that actually includes `raw_copy_path` removes it."""
    backup_dir = _configure(monkeypatch, tmp_path)
    _seed_rows(fresh_db)

    def _raise(*args, **kwargs):
        raise OSError("gzip exploded")

    monkeypatch.setattr(fresh_db.backup, "_gzip_and_remove", _raise)

    fresh_db.backup.run_backup()

    assert os.listdir(backup_dir) == []


def test_run_backup_failure_during_publish_removes_inprogress_and_sidecar(
    fresh_db, monkeypatch, tmp_path
):
    """Fails at the os.replace step, i.e. AFTER gzip + sha256 sidecar
    write both succeed — so both the .inprogress gz and the .sha256
    sidecar genuinely exist on disk when the except handler runs, and
    only a `_cleanup` call that includes both paths removes them."""
    backup_dir = _configure(monkeypatch, tmp_path)
    _seed_rows(fresh_db)

    def _raise(*args, **kwargs):
        raise OSError("rename exploded")

    monkeypatch.setattr(fresh_db.backup.os, "replace", _raise)

    fresh_db.backup.run_backup()

    assert os.listdir(backup_dir) == []


def test_run_backup_publishes_gz_atomically_at_the_end(fresh_db, monkeypatch, tmp_path):
    """The final .duckdb.gz name must not exist until gzip + sha256 are
    both complete — a hard kill mid-write must never leave a truncated
    file at the name `_rotate` trusts and a restore would pick. Reproduced
    against the pre-fix code during review: a hard-kill simulation left a
    corrupt file at the final name that survived rotation and evicted a
    good generation."""
    _configure(monkeypatch, tmp_path)
    _seed_rows(fresh_db)

    observed = {}
    real_replace = fresh_db.backup.os.replace

    def _spying_replace(src, dst):
        observed["final_exists_before_replace"] = os.path.exists(dst)
        observed["inprogress_exists_before_replace"] = os.path.exists(src)
        observed["sidecar_exists_before_replace"] = os.path.exists(f"{dst}.sha256")
        return real_replace(src, dst)

    monkeypatch.setattr(fresh_db.backup.os, "replace", _spying_replace)

    fresh_db.backup.run_backup()

    assert observed["final_exists_before_replace"] is False
    assert observed["inprogress_exists_before_replace"] is True
    assert observed["sidecar_exists_before_replace"] is True


def test_run_backup_hard_kill_during_gzip_does_not_corrupt_existing_backups(
    fresh_db, monkeypatch, tmp_path
):
    """Distinct, monkeypatched timestamps for the two runs are essential
    here, not cosmetic: two run_backup() calls within the same wall-clock
    second would collide on the same final filename, and gzip.open(path,
    "wb") truncates on open — so a same-name collision can make even a
    byte-content check misleadingly pass (open+truncate+immediate-crash
    still yields a valid-but-EMPTY gzip stream, which still "reads" fine).
    Distinct names close that hole; the byte-identical check below closes
    the other one a bare "still parses as a gzip stream" check would miss.
    """
    backup_dir = _configure(monkeypatch, tmp_path, keep=2)
    _seed_rows(fresh_db)

    monkeypatch.setattr(
        fresh_db.backup, "_timestamp_filename", lambda: "2026-01-01_000000"
    )
    fresh_db.backup.run_backup()
    good = _gz_files(backup_dir)
    assert len(good) == 1
    good_gz_path = backup_dir / good[0]
    good_bytes_before = good_gz_path.read_bytes()

    monkeypatch.setattr(
        fresh_db.backup, "_timestamp_filename", lambda: "2026-01-02_000000"
    )

    # SystemExit (not Exception) models a hard kill: stage 1's own
    # `except Exception` does NOT catch it, so no cleanup code runs at
    # all afterward — exactly what a SIGKILL/OOM/host-crash looks like,
    # unlike a caught Python exception which the except handler already
    # cleans up regardless of this fix.
    def _simulate_hard_kill(*args, **kwargs):
        raise SystemExit("simulated hard kill mid-gzip")

    monkeypatch.setattr(fresh_db.backup.shutil, "copyfileobj", _simulate_hard_kill)

    with pytest.raises(SystemExit):
        fresh_db.backup.run_backup()

    assert _gz_files(backup_dir) == good
    assert good_gz_path.read_bytes() == good_bytes_before


def test_run_backup_sweeps_stale_tmp_files_from_a_prior_crash(
    fresh_db, monkeypatch, tmp_path
):
    backup_dir = _configure(monkeypatch, tmp_path)
    _seed_rows(fresh_db)
    backup_dir.mkdir(parents=True, exist_ok=True)

    stale_raw = backup_dir / ".highfive_backup_2026-01-01_000000.duckdb.gz.tmp"
    stale_inprogress = (
        backup_dir / "highfive_backup_2026-01-01_000000.duckdb.gz.inprogress"
    )
    stale_raw.write_bytes(b"leftover raw copy from a killed run")
    stale_inprogress.write_bytes(b"leftover partial gzip from a killed run")

    fresh_db.backup.run_backup()

    assert not stale_raw.exists()
    assert not stale_inprogress.exists()
    assert len(_gz_files(backup_dir)) == 1


def test_run_backup_sweeps_an_orphan_sidecar_with_no_matching_gz(
    fresh_db, monkeypatch, tmp_path
):
    """A .sha256 with no matching .duckdb.gz (left by a crash between the
    sidecar write and the atomic rename) is invisible to both `_rotate`
    (globs *.duckdb.gz) and the raw-copy/in-progress sweep above — it
    would otherwise leak forever, one small file at a time."""
    backup_dir = _configure(monkeypatch, tmp_path)
    _seed_rows(fresh_db)
    backup_dir.mkdir(parents=True, exist_ok=True)

    orphan_sha = backup_dir / "highfive_backup_2026-01-01_000000.duckdb.gz.sha256"
    orphan_sha.write_text("deadbeef  highfive_backup_2026-01-01_000000.duckdb.gz\n")

    fresh_db.backup.run_backup()

    assert not orphan_sha.exists()
    assert len(_gz_files(backup_dir)) == 1


def test_cleanup_removes_all_given_existing_paths(tmp_path, fresh_db):
    a = tmp_path / "a"
    sidecar = tmp_path / "a.sha256"
    a.write_text("x")
    sidecar.write_text("y")
    missing = tmp_path / "does-not-exist"

    fresh_db.backup._cleanup(str(a), str(sidecar), str(missing))

    assert not a.exists()
    assert not sidecar.exists()


def test_run_backup_aborts_when_insufficient_free_space(
    fresh_db, monkeypatch, tmp_path
):
    backup_dir = _configure(monkeypatch, tmp_path)
    _seed_rows(fresh_db)

    monkeypatch.setattr(
        fresh_db.backup.shutil,
        "disk_usage",
        lambda path: types.SimpleNamespace(total=0, used=0, free=1),
    )

    fresh_db.backup.run_backup()

    # backup_dir always exists by this point (os.makedirs runs before the
    # free-space check) — assert the real postcondition, not a clause
    # that's vacuously true regardless of what run_backup() actually did.
    assert _gz_files(backup_dir) == []
    assert len(fresh_db.discord_calls) == 1
    assert "space" in fresh_db.discord_calls[0].lower()


def _patch_db_size(fresh_db, monkeypatch, fake_size):
    real_getsize = fresh_db.backup.os.path.getsize

    def _fake_getsize(path):
        if path == fresh_db.backup.DB_PATH:
            return fake_size
        return real_getsize(path)

    monkeypatch.setattr(fresh_db.backup.os.path, "getsize", _fake_getsize)


def test_run_backup_free_space_factor_is_pinned_at_1_5x(
    fresh_db, monkeypatch, tmp_path
):
    """Pins the LITERAL constant (1.5), not just "whatever
    _MIN_FREE_SPACE_FACTOR currently is" — reading the factor back from
    the module under test (as the boundary tests below do, to verify the
    </>= comparison logic itself) would pass unchanged even if someone
    quietly changed the constant to something far too small."""
    assert fresh_db.backup._MIN_FREE_SPACE_FACTOR == 1.5


def test_run_backup_aborts_exactly_below_free_space_threshold(
    fresh_db, monkeypatch, tmp_path
):
    backup_dir = _configure(monkeypatch, tmp_path)
    _seed_rows(fresh_db)

    _patch_db_size(fresh_db, monkeypatch, fake_size=1000)
    needed = int(1000 * fresh_db.backup._MIN_FREE_SPACE_FACTOR)
    monkeypatch.setattr(
        fresh_db.backup.shutil,
        "disk_usage",
        lambda path: types.SimpleNamespace(total=0, used=0, free=needed - 1),
    )

    fresh_db.backup.run_backup()

    assert _gz_files(backup_dir) == []


def test_run_backup_succeeds_exactly_above_free_space_threshold(
    fresh_db, monkeypatch, tmp_path
):
    backup_dir = _configure(monkeypatch, tmp_path)
    _seed_rows(fresh_db)

    _patch_db_size(fresh_db, monkeypatch, fake_size=1000)
    needed = int(1000 * fresh_db.backup._MIN_FREE_SPACE_FACTOR)
    monkeypatch.setattr(
        fresh_db.backup.shutil,
        "disk_usage",
        lambda path: types.SimpleNamespace(total=0, used=0, free=needed + 1),
    )

    fresh_db.backup.run_backup()

    assert len(_gz_files(backup_dir)) == 1


def test_run_backup_failure_before_artifact_leaves_no_partial_file(
    fresh_db, monkeypatch, tmp_path
):
    backup_dir = _configure(monkeypatch, tmp_path)
    _seed_rows(fresh_db)

    def _raise(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(fresh_db.backup.shutil, "copy2", _raise)

    fresh_db.backup.run_backup()

    assert os.listdir(backup_dir) == []
    assert len(fresh_db.discord_calls) == 1
    assert "disk full" in fresh_db.discord_calls[0]


def test_run_backup_failure_during_rotation_keeps_the_completed_artifact(
    fresh_db, monkeypatch, tmp_path
):
    backup_dir = _configure(monkeypatch, tmp_path)
    _seed_rows(fresh_db)

    def _raise(*args, **kwargs):
        raise OSError("rotation exploded")

    monkeypatch.setattr(fresh_db.backup, "_rotate", _raise)

    fresh_db.backup.run_backup()

    # The gz + sidecar were already written and verified before rotation
    # ran — a rotation failure must never delete a completed backup.
    gz_files = _gz_files(backup_dir)
    assert len(gz_files) == 1
    assert (backup_dir / f"{gz_files[0]}.sha256").exists()
    assert len(fresh_db.discord_calls) == 1
    assert "rotation exploded" in fresh_db.discord_calls[0]
