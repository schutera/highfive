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
