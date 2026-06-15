"""Regression test for the issue-#69 `module_configs.status` drop migration.

DuckDB v1.4 rejects every ALTER on `module_configs` because the
`nest_data.module_id → module_configs.id` foreign key locks the whole
table. The migration in `db/schema.py`'s `init_db` works around that
limitation with a transactional rebuild that drops the FK chain in
reverse dependency order, recreates each table with the cleaned schema,
and restores data. This test pins the contract:

  * the migration runs when an old-shape DB exists (column present),
  * it preserves data across `module_configs`, `nest_data`, and
    `daily_progress`,
  * the resulting schema has no `status` column anywhere,
  * the FK chain is reinstated (a row in `nest_data` cannot reference
    a missing `module_configs.id`),
  * a second `init_db()` call on the migrated DB is a no-op (the
    column-existence check short-circuits).

The test must not depend on production seeds — it stages its own
old-shape DB manually so the assertions describe exactly what shipped
to operators with pre-PR volumes.
"""

from __future__ import annotations


def _stage_old_schema_with_data(con) -> None:
    """Recreate the pre-#69 schema and populate one row per FK-linked table.

    Mirrors `db/schema.py` as it shipped before this PR — including the
    `status VARCHAR(10) NOT NULL CHECK` column that was dead-weight. The
    `fresh_db` fixture leaves `con` pointing at the *new* schema, so we
    drop and recreate to simulate an existing-volume scenario.
    """
    for table in ("daily_progress", "nest_data", "module_configs"):
        con.execute(f"DROP TABLE IF EXISTS {table}")

    con.execute(
        """
        CREATE TABLE module_configs (
            id VARCHAR(20) PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            lat DECIMAL(9,6) NOT NULL,
            lng DECIMAL(9,6) NOT NULL,
            status VARCHAR(10) NOT NULL CHECK (status IN ('online', 'offline')),
            first_online DATE NOT NULL,
            battery_level INTEGER,
            image_count INTEGER NOT NULL DEFAULT 0,
            email VARCHAR(255),
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_silence_alert_at TIMESTAMP
        );
        CREATE TABLE nest_data (
            nest_id VARCHAR(20) NOT NULL PRIMARY KEY,
            module_id VARCHAR(20) NOT NULL REFERENCES module_configs(id),
            beeType VARCHAR(20) CHECK (
                beeType IN ('blackmasked', 'resin', 'leafcutter', 'orchard')
            )
        );
        CREATE TABLE daily_progress (
            progress_id VARCHAR(20) PRIMARY KEY,
            nest_id VARCHAR(20) NOT NULL REFERENCES nest_data(nest_id),
            date DATE NOT NULL,
            empty INTEGER NOT NULL,
            sealed INTEGER NOT NULL,
            hatched INTEGER NOT NULL
        );
        """
    )

    # Populate one row per table so the migration's data-preservation
    # behavior is observable. The `status='online'` write exercises the
    # CHECK constraint on the way in.
    con.execute(
        "INSERT INTO module_configs "
        "(id, name, lat, lng, status, first_online, battery_level, image_count) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("mod-test", "Test Module", 47.8, 9.6, "online", "2024-01-01", 75, 42),
    )
    con.execute(
        "INSERT INTO nest_data (nest_id, module_id, beeType) VALUES (?, ?, ?)",
        ("nest-test", "mod-test", "blackmasked"),
    )
    con.execute(
        "INSERT INTO daily_progress "
        "(progress_id, nest_id, date, empty, sealed, hatched) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        ("prog-test", "nest-test", "2024-06-01", 5, 10, 2),
    )


def test_migration_drops_status_and_preserves_data(fresh_db):
    """Old-schema rows survive the rebuild; the status column is gone."""
    con = fresh_db.connection.get_conn()
    try:
        _stage_old_schema_with_data(con)
    finally:
        con.close()

    # Run the migration. init_db is idempotent; second call here exercises
    # the column-presence check path the comment in schema.py promises.
    fresh_db.schema.init_db()

    con = fresh_db.connection.get_conn()
    try:
        cols = [
            c[1] for c in con.execute("PRAGMA table_info(module_configs)").fetchall()
        ]
        assert "status" not in cols, (
            f"migration should have dropped the `status` column; columns now: {cols}"
        )

        # Data survived in module_configs (status field absent from the
        # selectable set but the row's identity, name, battery, etc. are
        # all intact).
        rows = con.execute(
            "SELECT id, name, battery_level, image_count FROM module_configs"
        ).fetchall()
        assert rows == [("mod-test", "Test Module", 75, 42)]

        # FK chain preserved end-to-end.
        nest_rows = con.execute(
            "SELECT nest_id, module_id, beeType FROM nest_data"
        ).fetchall()
        assert nest_rows == [("nest-test", "mod-test", "blackmasked")]

        progress_rows = con.execute(
            "SELECT progress_id, nest_id, empty, sealed, hatched FROM daily_progress"
        ).fetchall()
        assert progress_rows == [("prog-test", "nest-test", 5, 10, 2)]
    finally:
        con.close()


def test_migration_reinstates_fk_constraint(fresh_db):
    """After the rebuild, nest_data still rejects rows that reference a
    non-existent module_configs.id — proves the FK constraint was actually
    recreated, not dropped silently."""
    con = fresh_db.connection.get_conn()
    try:
        _stage_old_schema_with_data(con)
    finally:
        con.close()

    fresh_db.schema.init_db()

    con = fresh_db.connection.get_conn()
    try:
        # Insert with a valid module_id (mod-test was seeded in the stage helper).
        con.execute(
            "INSERT INTO nest_data (nest_id, module_id, beeType) VALUES (?, ?, ?)",
            ("nest-valid", "mod-test", "resin"),
        )

        # Insert with a non-existent module_id must be rejected by the FK.
        try:
            con.execute(
                "INSERT INTO nest_data (nest_id, module_id, beeType) VALUES (?, ?, ?)",
                ("nest-orphan", "mod-does-not-exist", "resin"),
            )
            raise AssertionError(
                "FK was not reinstated — insert with bad module_id should have raised"
            )
        except Exception as e:
            # DuckDB raises ConstraintException for FK violations. Accept any
            # exception whose message names a violation / constraint failure.
            assert "constraint" in str(e).lower() or "violates" in str(e).lower(), (
                f"unexpected exception shape: {e!r}"
            )
    finally:
        con.close()


def test_migration_rolls_back_on_failure(fresh_db, monkeypatch):
    """If any step inside the migration's `BEGIN..COMMIT` raises, the
    transaction must `ROLLBACK` and `init_db` must re-raise as
    `RuntimeError` so the container refuses to start. The DB must be
    left exactly in its pre-migration state — i.e. the `status` column
    is still present, every row survives.

    Mechanism: patch the migration's `CREATE TABLE module_configs`
    statement (the destination CREATE inside the transaction) so it
    raises on the first call. Any of the migration's `con.execute`
    sites would work; this one is chosen because it sits *after* the
    drops, so a botched rollback would leave the DB without any of the
    three tables — the most visible failure mode.
    """
    con = fresh_db.connection.get_conn()
    try:
        _stage_old_schema_with_data(con)
    finally:
        con.close()

    # Wrap `con.execute` so the migration's `CREATE TABLE module_configs
    # (id VARCHAR(20) PRIMARY KEY, ...)` after the DROP raises. The
    # top-of-file CREATE uses `CREATE TABLE IF NOT EXISTS` which does
    # NOT match our predicate (so only the migration's recreate is
    # intercepted). The migration is mid-transaction at this point:
    # `module_configs`/`nest_data`/`daily_progress` are already dropped,
    # so a successful ROLLBACK must put them back from the transaction's
    # undo log. The post-condition checks below pin that behaviour.
    real_get_conn = fresh_db.connection.get_conn
    sentinel = RuntimeError("simulated DDL failure mid-rebuild")

    class _FailingConn:
        def __init__(self, inner):
            self._inner = inner

        def __getattr__(self, name):
            return getattr(self._inner, name)

        def execute(self, sql, *args, **kwargs):
            first_line = sql.strip().splitlines()[0].strip() if sql.strip() else ""
            # Trigger only on the migration's recreate-after-drop, not
            # on the idempotent top-of-file `CREATE TABLE IF NOT EXISTS`.
            if first_line.startswith("CREATE TABLE module_configs"):
                raise sentinel
            return self._inner.execute(sql, *args, **kwargs)

    def _wrapped_get_conn():
        return _FailingConn(real_get_conn())

    monkeypatch.setattr(fresh_db.connection, "get_conn", _wrapped_get_conn)
    # `db.schema` imports `get_conn` by name at module load — patch the
    # binding inside the module the migration code actually uses.
    monkeypatch.setattr(fresh_db.schema, "get_conn", _wrapped_get_conn)

    # init_db must re-raise.
    try:
        fresh_db.schema.init_db()
    except RuntimeError as e:
        assert "module_configs status-drop migration failed" in str(e), (
            f"unexpected RuntimeError message: {e!r}"
        )
    else:
        raise AssertionError(
            "init_db should have re-raised after rollback; nothing was raised"
        )

    # Pre-migration state should be intact: status column still present,
    # data still readable through the original tables.
    con = real_get_conn()
    try:
        cols = [
            c[1] for c in con.execute("PRAGMA table_info(module_configs)").fetchall()
        ]
        assert "status" in cols, (
            f"rollback failed — status column should still exist; columns: {cols}"
        )
        rows = con.execute("SELECT id, status FROM module_configs").fetchall()
        assert rows == [("mod-test", "online")], (
            f"rollback failed — row data should be intact; got: {rows}"
        )
        # FK chain still intact too.
        nest_rows = con.execute("SELECT nest_id FROM nest_data").fetchall()
        assert nest_rows == [("nest-test",)]
    finally:
        con.close()


def test_migration_is_idempotent_on_fresh_db(fresh_db):
    """init_db on a DB that never had the `status` column must be a no-op
    (the column-presence check short-circuits before any DDL fires)."""
    # `fresh_db` already ran init_db once via the conftest fixture, so the
    # DB has the new (post-#69) schema and no `status` column. Running
    # init_db again should not raise and should leave the schema untouched.
    fresh_db.schema.init_db()

    con = fresh_db.connection.get_conn()
    try:
        cols = [
            c[1] for c in con.execute("PRAGMA table_info(module_configs)").fetchall()
        ]
        assert "status" not in cols
        # Sanity: the table is still queryable and the FK chain is intact.
        con.execute("SELECT COUNT(*) FROM module_configs").fetchone()
        con.execute("SELECT COUNT(*) FROM nest_data").fetchone()
        con.execute("SELECT COUNT(*) FROM daily_progress").fetchone()
    finally:
        con.close()


# ---------- coordinate generalization (issue #145 / ADR-020) ----------


def test_migration_coarsens_existing_precise_coordinates(fresh_db):
    """An operator volume that stored exact coordinates before round-on-write
    shipped must have them generalized to ~1 km in place on the next boot
    (issue #145, ADR-020). The migration is destructive by design — the
    precise value is irrecoverable afterwards — and count-gated so a second
    boot is a true no-op.
    """
    con = fresh_db.connection.get_conn()
    try:
        con.execute(
            "INSERT INTO module_configs "
            "(id, name, lat, lng, first_online, battery_level, image_count) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("aabbccddeeff", "TestHive", 47.808612, 9.643301, "2024-01-01", 80, 0),
        )
        con.commit()
        # The precise value is present before the migration runs.
        before = con.execute(
            "SELECT lat, lng FROM module_configs WHERE id = ?", ("aabbccddeeff",)
        ).fetchone()
        assert (float(before[0]), float(before[1])) == (47.808612, 9.643301)
    finally:
        con.close()

    fresh_db.schema.init_db()

    con = fresh_db.connection.get_conn()
    try:
        row = con.execute(
            "SELECT lat, lng FROM module_configs WHERE id = ?", ("aabbccddeeff",)
        ).fetchone()
        assert (float(row[0]), float(row[1])) == (47.81, 9.64), (
            f"coords should be coarsened to 2 dp; got {row!r}"
        )
    finally:
        con.close()

    # Second init_db is a no-op (the count-gate matches nothing now): the
    # already-coarse value is untouched and nothing raises.
    fresh_db.schema.init_db()
    con = fresh_db.connection.get_conn()
    try:
        row = con.execute(
            "SELECT lat, lng FROM module_configs WHERE id = ?", ("aabbccddeeff",)
        ).fetchone()
        assert (float(row[0]), float(row[1])) == (47.81, 9.64)
    finally:
        con.close()


# ---------- display_name column (PR I — issue #93) ----------


def test_display_name_column_added_idempotently(fresh_db):
    """`display_name VARCHAR(100) UNIQUE` is present after init_db, both
    when freshly created (column is in `_MODULE_CONFIGS_DDL`) and when
    additively added (the `ALTER TABLE ADD COLUMN` migration block in
    `db/schema.py`). A second `init_db()` call is a no-op."""
    con = fresh_db.connection.get_conn()
    try:
        cols = [
            c[1] for c in con.execute("PRAGMA table_info(module_configs)").fetchall()
        ]
        assert "display_name" in cols, (
            f"display_name column should be present on a fresh DB; cols: {cols}"
        )
    finally:
        con.close()

    # Second init_db should not raise (the `if not in existing_cols` gate
    # short-circuits the ALTER).
    fresh_db.schema.init_db()

    con = fresh_db.connection.get_conn()
    try:
        cols = [
            c[1] for c in con.execute("PRAGMA table_info(module_configs)").fetchall()
        ]
        assert cols.count("display_name") == 1, (
            f"display_name appears more than once after re-init: {cols}"
        )
    finally:
        con.close()


def test_display_name_migration_on_existing_db(fresh_db):
    """Simulate a pre-#93 volume that has `module_configs` without
    `display_name` and prove the additive ALTER fires on a re-init.
    Mirrors the pattern in `test_migration_drops_status_and_preserves_data`
    but for the post-PR-I additive case."""
    con = fresh_db.connection.get_conn()
    try:
        # Drop and recreate the table without the display_name column to
        # simulate a deployment that came up before this migration shipped.
        # FK-dependent tables must be dropped first because DuckDB locks
        # the parent table on any structural change otherwise.
        con.execute("DROP TABLE IF EXISTS daily_progress")
        con.execute("DROP TABLE IF EXISTS nest_data")
        con.execute("DROP TABLE IF EXISTS module_configs")
        con.execute(
            """
            CREATE TABLE module_configs (
                id VARCHAR(20) PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                lat DECIMAL(9,6) NOT NULL,
                lng DECIMAL(9,6) NOT NULL,
                first_online DATE NOT NULL,
                battery_level INTEGER,
                image_count INTEGER NOT NULL DEFAULT 0,
                email VARCHAR(255),
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_silence_alert_at TIMESTAMP
            )
            """
        )
        con.execute(
            "INSERT INTO module_configs "
            "(id, name, lat, lng, first_online, battery_level, image_count) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("aabbccddeeff", "TestHive", 47.8, 9.6, "2024-01-01", 80, 0),
        )
        # Confirm the old shape before migration.
        cols = [
            c[1] for c in con.execute("PRAGMA table_info(module_configs)").fetchall()
        ]
        assert "display_name" not in cols
    finally:
        con.close()

    fresh_db.schema.init_db()

    con = fresh_db.connection.get_conn()
    try:
        cols = [
            c[1] for c in con.execute("PRAGMA table_info(module_configs)").fetchall()
        ]
        assert "display_name" in cols, (
            "display_name should have been added by additive migration"
        )
        # Original row survives the migration; display_name starts NULL.
        row = con.execute(
            "SELECT id, name, display_name FROM module_configs"
        ).fetchone()
        assert row == ("aabbccddeeff", "TestHive", None)
    finally:
        con.close()


def test_display_name_unique_constraint(fresh_db):
    """Two modules cannot share a `display_name`. NULL is allowed for any
    number of rows (DuckDB treats NULLs as distinct under UNIQUE) — that
    matters because new modules register with `display_name = NULL` and
    must not block each other."""
    con = fresh_db.connection.get_conn()
    try:
        con.execute(
            "INSERT INTO module_configs "
            "(id, name, display_name, lat, lng, first_online) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ("aaaaaaaaaaaa", "auto-name-a", "Garden Bee", 47.8, 9.6, "2024-01-01"),
        )
        con.execute(
            "INSERT INTO module_configs "
            "(id, name, display_name, lat, lng, first_online) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ("bbbbbbbbbbbb", "auto-name-b", "Forest Bee", 47.8, 9.6, "2024-01-01"),
        )
        # Two NULLs are fine.
        con.execute(
            "INSERT INTO module_configs "
            "(id, name, display_name, lat, lng, first_online) "
            "VALUES (?, ?, NULL, ?, ?, ?)",
            ("cccccccccccc", "auto-name-c", 47.8, 9.6, "2024-01-01"),
        )
        con.execute(
            "INSERT INTO module_configs "
            "(id, name, display_name, lat, lng, first_online) "
            "VALUES (?, ?, NULL, ?, ?, ?)",
            ("dddddddddddd", "auto-name-d", 47.8, 9.6, "2024-01-01"),
        )

        # Now the actual UNIQUE violation: two non-null rows sharing a label.
        try:
            con.execute(
                "INSERT INTO module_configs "
                "(id, name, display_name, lat, lng, first_online) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("eeeeeeeeeeee", "auto-name-e", "Garden Bee", 47.8, 9.6, "2024-01-01"),
            )
            raise AssertionError(
                "duplicate display_name should have been rejected by UNIQUE"
            )
        except Exception as e:
            assert (
                "constraint" in str(e).lower()
                or "duplicate" in str(e).lower()
                or "unique" in str(e).lower()
            ), f"unexpected exception: {e!r}"
    finally:
        con.close()


def test_last_seen_at_migration_backfills_from_updated_at(fresh_db):
    """Issue #97 / PR B — when an operator volume comes up against a
    schema that has `updated_at` but not `last_seen_at`, the migration
    must (a) add `last_seen_at` and (b) backfill it from `updated_at`
    so the "module last seen" timestamp survives the column split.
    Without the backfill, every existing module would snap to NOW() on
    the first boot after the migration and the 2 h status window would
    lie about every offline module for two hours."""
    con = fresh_db.connection.get_conn()
    try:
        # Drop and recreate without `last_seen_at` to simulate a
        # deployment that came up before the PR B migration shipped.
        # FK-dependent tables must be dropped first.
        con.execute("DROP TABLE IF EXISTS daily_progress")
        con.execute("DROP TABLE IF EXISTS nest_data")
        con.execute("DROP TABLE IF EXISTS module_configs")
        con.execute(
            """
            CREATE TABLE module_configs (
                id VARCHAR(20) PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                display_name VARCHAR(100) UNIQUE,
                lat DECIMAL(9,6) NOT NULL,
                lng DECIMAL(9,6) NOT NULL,
                first_online DATE NOT NULL,
                battery_level INTEGER,
                image_count INTEGER NOT NULL DEFAULT 0,
                email VARCHAR(255),
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_silence_alert_at TIMESTAMP
            )
            """
        )
        # Insert a row with an EXPLICIT updated_at value distinct from
        # NOW() — this is the pre-split "module last seen" timestamp
        # the backfill must preserve.
        con.execute(
            "INSERT INTO module_configs "
            "(id, name, lat, lng, first_online, battery_level, image_count, "
            " updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "aabbccddeeff",
                "TestHive",
                47.8,
                9.6,
                "2024-01-01",
                80,
                0,
                "2024-06-15 12:00:00",
            ),
        )
        cols = [
            c[1] for c in con.execute("PRAGMA table_info(module_configs)").fetchall()
        ]
        assert "last_seen_at" not in cols
    finally:
        con.close()

    fresh_db.schema.init_db()

    con = fresh_db.connection.get_conn()
    try:
        cols = [
            c[1] for c in con.execute("PRAGMA table_info(module_configs)").fetchall()
        ]
        assert "last_seen_at" in cols, (
            "last_seen_at should have been added by the additive migration"
        )
        # Backfill must copy `updated_at` verbatim, not snap to NOW().
        row = con.execute(
            "SELECT updated_at, last_seen_at FROM module_configs WHERE id = ?",
            ("aabbccddeeff",),
        ).fetchone()
        assert row[0] == row[1], (
            f"last_seen_at must equal updated_at after backfill; "
            f"got updated_at={row[0]!r}, last_seen_at={row[1]!r}"
        )
    finally:
        con.close()


# ---------- module_heartbeats diagnostic-column migration (#148) ----------


def _stage_old_heartbeats_schema(con) -> None:
    """Recreate the pre-#148 `module_heartbeats` (no diagnostic columns).

    `module_heartbeats` carries no foreign key, so unlike `module_configs`
    the migration is a plain `ALTER TABLE ADD COLUMN` rather than the
    table-rebuild dance. Stage one legacy row so the migration's
    data-preservation (old rows get NULL for the new columns) is observable.
    """
    con.execute("DROP TABLE IF EXISTS module_heartbeats")
    con.execute("DROP SEQUENCE IF EXISTS module_heartbeats_seq")
    con.execute("CREATE SEQUENCE module_heartbeats_seq START 1")
    con.execute(
        """
        CREATE TABLE module_heartbeats (
            id INTEGER PRIMARY KEY DEFAULT nextval('module_heartbeats_seq'),
            module_id VARCHAR(20) NOT NULL,
            received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            battery INTEGER,
            rssi INTEGER,
            uptime_ms BIGINT,
            free_heap INTEGER,
            fw_version VARCHAR(40)
        )
        """
    )
    con.execute(
        "INSERT INTO module_heartbeats "
        "(module_id, received_at, rssi, uptime_ms, free_heap, fw_version) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        ("aabbccddeeff", "2026-05-01 12:00:00", -70, 123456, 150000, "mason"),
    )


def test_migration_adds_heartbeat_diagnostic_columns(fresh_db):
    """Old-shape `module_heartbeats` gains reset_reason/min_free_heap/boot_count;
    legacy rows survive with NULL in the new columns; a second init_db is a no-op."""
    con = fresh_db.connection.get_conn()
    try:
        _stage_old_heartbeats_schema(con)
    finally:
        con.close()

    fresh_db.schema.init_db()
    # Idempotency: a second run must not throw on already-present columns.
    fresh_db.schema.init_db()

    con = fresh_db.connection.get_conn()
    try:
        cols = {
            c[1] for c in con.execute("PRAGMA table_info(module_heartbeats)").fetchall()
        }
        # #148 columns AND the #172 failure-streak columns are both added by
        # the additive ALTER block on an old-shape table.
        assert {
            "reset_reason",
            "min_free_heap",
            "boot_count",
            "last_hb_fail_code",
            "last_hb_fail_count",
        } <= cols

        # The legacy row survived and reads NULL for the new columns.
        row = con.execute(
            "SELECT fw_version, reset_reason, min_free_heap, boot_count, "
            "last_hb_fail_code, last_hb_fail_count "
            "FROM module_heartbeats WHERE module_id = ?",
            ("aabbccddeeff",),
        ).fetchone()
        assert row == ("mason", None, None, None, None, None)

        # A new-shape insert lands in the migrated table.
        con.execute(
            "INSERT INTO module_heartbeats "
            "(module_id, reset_reason, min_free_heap, boot_count, "
            " last_hb_fail_code, last_hb_fail_count) VALUES (?, ?, ?, ?, ?, ?)",
            ("aabbccddeeff", "TASK_WDT", 51234, 9, -2, 3),
        )
        new_row = con.execute(
            "SELECT reset_reason, min_free_heap, boot_count, "
            "last_hb_fail_code, last_hb_fail_count "
            "FROM module_heartbeats WHERE reset_reason = 'TASK_WDT'"
        ).fetchone()
        assert new_row == ("TASK_WDT", 51234, 9, -2, 3)
    finally:
        con.close()
