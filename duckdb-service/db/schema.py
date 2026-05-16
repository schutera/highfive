import os

from db.connection import lock, get_conn


# Single source of truth for the three FK-chained table DDLs. Referenced by
# both the top-of-`init_db` `CREATE TABLE IF NOT EXISTS` block (for fresh
# DBs) and the issue-#69 migration's recreate-after-drop block (for
# existing DBs whose `module_configs.status` column must be retired). The
# dedup is load-bearing: a future column edit that only touched one site
# would silently break the other deploy path. Column lists in
# `_MODULE_CONFIGS_COLUMNS` are also referenced from the migration's
# explicit `INSERT ... SELECT ...` so ordinal drift can't corrupt data.
_MODULE_CONFIGS_DDL = """
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

# `name` stores the firmware-reported value (mutable on every UPSERT, no
# UNIQUE — same-batch firmware can collide and `add_module` auto-suffixes
# to disambiguate). `display_name` is an admin-settable override with a
# UNIQUE constraint so two modules cannot share a label; the read path
# coalesces `display_name ?? name` at the client. See ADR-011 and #93.
_MODULE_CONFIGS_COLUMNS = (
    "id, name, display_name, lat, lng, first_online, battery_level, "
    "image_count, email, updated_at, last_silence_alert_at"
)

_NEST_DATA_DDL = """
    CREATE TABLE nest_data (
        nest_id VARCHAR(20) NOT NULL PRIMARY KEY,
        module_id VARCHAR(20) NOT NULL REFERENCES module_configs(id),
        beeType VARCHAR(20) CHECK (
            beeType IN ('blackmasked', 'resin', 'leafcutter', 'orchard')
        )
    )
"""

_NEST_DATA_COLUMNS = "nest_id, module_id, beeType"

_DAILY_PROGRESS_DDL = """
    CREATE TABLE daily_progress (
        progress_id VARCHAR(20) PRIMARY KEY,
        nest_id VARCHAR(20) NOT NULL REFERENCES nest_data(nest_id),
        date DATE NOT NULL,
        empty INTEGER NOT NULL,
        sealed INTEGER NOT NULL,
        hatched INTEGER NOT NULL
    )
"""

_DAILY_PROGRESS_COLUMNS = "progress_id, nest_id, date, empty, sealed, hatched"


def init_db():
    with lock:
        con = get_conn()

        # FK-chained tables share their DDL with the issue-#69 migration
        # block below — derive the idempotent `IF NOT EXISTS` form from
        # the same constant so a future column edit on one site can't
        # silently break the other deploy path.
        for ddl in (_MODULE_CONFIGS_DDL, _NEST_DATA_DDL, _DAILY_PROGRESS_DDL):
            con.execute(ddl.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS", 1))

        con.execute(
            """
            CREATE SEQUENCE IF NOT EXISTS image_uploads_seq START 1;
            CREATE TABLE IF NOT EXISTS image_uploads (
                id INTEGER PRIMARY KEY DEFAULT nextval('image_uploads_seq'),
                module_id VARCHAR(20) NOT NULL,
                filename VARCHAR(255) NOT NULL,
                uploaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_nest_module ON nest_data(module_id);
            CREATE INDEX IF NOT EXISTS idx_progress_nest ON daily_progress(nest_id);
            CREATE INDEX IF NOT EXISTS idx_progress_date ON daily_progress(date);
            CREATE INDEX IF NOT EXISTS idx_image_module ON image_uploads(module_id);

            CREATE SEQUENCE IF NOT EXISTS module_heartbeats_seq START 1;
            CREATE TABLE IF NOT EXISTS module_heartbeats (
                id INTEGER PRIMARY KEY DEFAULT nextval('module_heartbeats_seq'),
                module_id VARCHAR(20) NOT NULL,
                received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                battery INTEGER,
                rssi INTEGER,
                uptime_ms BIGINT,
                free_heap INTEGER,
                fw_version VARCHAR(40)
            );
            CREATE INDEX IF NOT EXISTS idx_heartbeat_module ON module_heartbeats(module_id);
            CREATE INDEX IF NOT EXISTS idx_heartbeat_received ON module_heartbeats(received_at);
            """
        )

        # Additive column migrations for older DBs (gated on
        # `PRAGMA table_info` rather than try/except so a healthy fresh
        # boot does not throw three exceptions through the duckdb stack
        # only to swallow them). The columns already exist on fresh DBs
        # because `_MODULE_CONFIGS_DDL` declares them; the gates make
        # this block a clean no-op there.
        existing_cols = {
            c[1] for c in con.execute("PRAGMA table_info(module_configs)").fetchall()
        }
        if "email" not in existing_cols:
            con.execute("ALTER TABLE module_configs ADD COLUMN email VARCHAR(255)")
        if "updated_at" not in existing_cols:
            con.execute(
                "ALTER TABLE module_configs ADD COLUMN updated_at TIMESTAMP "
                "DEFAULT CURRENT_TIMESTAMP"
            )
        # Track Discord-silence-alert state so we don't spam the channel.
        # Set to NOW() when a silence alert fires, cleared on recovery alert.
        if "last_silence_alert_at" not in existing_cols:
            con.execute(
                "ALTER TABLE module_configs ADD COLUMN last_silence_alert_at TIMESTAMP"
            )
        # Admin-settable display-name override for module labelling. The
        # firmware-reported `name` keeps churning on every registration,
        # but the operator's chosen label persists here under a UNIQUE
        # constraint so two modules cannot share a display label. See
        # ADR-011 and issue #93.
        #
        # DuckDB 1.4 rejects `ADD COLUMN ... UNIQUE` in a single ALTER
        # (Parser Error: "Adding columns with constraints not yet
        # supported"), so the additive migration splits into ADD COLUMN
        # + CREATE UNIQUE INDEX. Fresh-DB DDL keeps the inline UNIQUE
        # (CREATE TABLE does support it). Both paths end up enforcing
        # the same invariant; the index is named so the constraint is
        # introspectable on operator volumes that arrived via this
        # migration rather than a fresh CREATE.
        if "display_name" not in existing_cols:
            con.execute(
                "ALTER TABLE module_configs ADD COLUMN display_name VARCHAR(100)"
            )
            con.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_module_configs_display_name "
                "ON module_configs(display_name)"
            )

        # Migration: drop the dead-weight `status` column from existing DBs
        # (issue #69). DuckDB v1.4 rejects every ALTER on `module_configs`
        # (DROP COLUMN, DROP CONSTRAINT, ALTER COLUMN SET DEFAULT) with
        # `DependencyException Cannot alter entry "module_configs"` because
        # `nest_data.module_id → module_configs.id` is a foreign key that
        # locks the whole table for any ALTER, regardless of which column
        # is targeted. Workaround is a transactional table-rebuild: copy
        # data to temp tables, drop the FK chain in dependency order
        # (`daily_progress` → `nest_data` → `module_configs`), recreate
        # each table with the cleaned schema, restore data. A column-
        # existence check makes this a one-shot no-op for already-migrated
        # DBs and for fresh DBs (which never had the column).
        try:
            cols = con.execute("PRAGMA table_info(module_configs)").fetchall()
            if any(c[1] == "status" for c in cols):
                con.execute("BEGIN")
                try:
                    # Stage all dependent + target table data in TEMP tables.
                    # The column-list is spelled out everywhere so a future
                    # column reorder on either side surfaces as a SQL error,
                    # not silent data misplacement.
                    con.execute(
                        f"CREATE TEMP TABLE _mig_nest_data AS "
                        f"SELECT {_NEST_DATA_COLUMNS} FROM nest_data"
                    )
                    con.execute(
                        f"CREATE TEMP TABLE _mig_daily_progress AS "
                        f"SELECT {_DAILY_PROGRESS_COLUMNS} FROM daily_progress"
                    )
                    con.execute(
                        f"CREATE TEMP TABLE _mig_module_configs AS "
                        f"SELECT {_MODULE_CONFIGS_COLUMNS} FROM module_configs"
                    )

                    # Drop the FK chain in reverse dependency order.
                    con.execute("DROP TABLE daily_progress")
                    con.execute("DROP TABLE nest_data")
                    con.execute("DROP TABLE module_configs")

                    # Recreate with the cleaned DDL — shares the constants
                    # used at the top of `init_db` so the two deploy paths
                    # (fresh vs migrated) cannot drift apart.
                    con.execute(_MODULE_CONFIGS_DDL)
                    con.execute(
                        f"INSERT INTO module_configs ({_MODULE_CONFIGS_COLUMNS}) "
                        f"SELECT {_MODULE_CONFIGS_COLUMNS} FROM _mig_module_configs"
                    )

                    con.execute(_NEST_DATA_DDL)
                    con.execute(
                        f"INSERT INTO nest_data ({_NEST_DATA_COLUMNS}) "
                        f"SELECT {_NEST_DATA_COLUMNS} FROM _mig_nest_data"
                    )

                    con.execute(_DAILY_PROGRESS_DDL)
                    con.execute(
                        f"INSERT INTO daily_progress ({_DAILY_PROGRESS_COLUMNS}) "
                        f"SELECT {_DAILY_PROGRESS_COLUMNS} FROM _mig_daily_progress"
                    )

                    # Re-create the indexes the CREATE block above declared.
                    con.execute(
                        "CREATE INDEX IF NOT EXISTS idx_nest_module ON nest_data(module_id)"
                    )
                    con.execute(
                        "CREATE INDEX IF NOT EXISTS idx_progress_nest "
                        "ON daily_progress(nest_id)"
                    )
                    con.execute(
                        "CREATE INDEX IF NOT EXISTS idx_progress_date "
                        "ON daily_progress(date)"
                    )

                    con.execute("COMMIT")
                    print(
                        "✅ Migrated module_configs schema "
                        "(dropped dead-weight `status` column, issue #69)"
                    )
                except Exception:
                    con.execute("ROLLBACK")
                    raise  # surface; better to refuse to serve than mid-migrate.
        except Exception as e:
            # Re-raise so the container fails to start rather than running
            # against a half-migrated DB. CHECK constraint failures on the
            # subsequent add_module INSERT would be a much harder symptom
            # to root-cause than a refusal-to-start.
            raise RuntimeError(
                f"module_configs status-drop migration failed: {e!r}. "
                "DB state is unchanged (transaction rolled back). Restore from "
                "a backup before re-running."
            ) from e

        if os.getenv("SEED_DATA", "").lower() == "true":
            row_count = con.execute("SELECT COUNT(*) FROM module_configs").fetchone()[0]
            if row_count == 0:
                # Seed module IDs use the canonical 12-hex-char ModuleId
                # form. The pattern ``00000000000N`` is deliberately
                # recognisable as test/seed data — it's a valid canonical
                # ModuleId but cannot collide with a real ESP32 base MAC,
                # which always has manufacturer OUI bytes set.
                con.execute(
                    """
                    INSERT INTO module_configs (id, name, lat, lng, first_online, image_count) VALUES
                    ('000000000001', 'Elias123',    47.8086, 9.6433, '2023-04-15', 142),
                    ('000000000002', 'Garten 12',   47.8100, 9.6450, '2023-05-20', 87),
                    ('000000000003', 'Waldrand',    47.7819, 9.6107, '2024-03-10', 53),
                    ('000000000004', 'Schussental', 47.7850, 9.6200, '2024-06-01', 24),
                    ('000000000005', 'Bergblick',   47.8050, 9.6350, '2025-02-14', 3);

                    INSERT INTO nest_data (nest_id, module_id, beeType) VALUES
                    ('nest-001', '000000000001', 'blackmasked'),
                    ('nest-002', '000000000001', 'blackmasked'),
                    ('nest-003', '000000000001', 'blackmasked'),
                    ('nest-004', '000000000001', 'blackmasked'),
                    ('nest-005', '000000000001', 'resin'),
                    ('nest-006', '000000000001', 'resin'),
                    ('nest-007', '000000000001', 'resin'),
                    ('nest-008', '000000000001', 'resin'),
                    ('nest-009', '000000000002', 'leafcutter'),
                    ('nest-010', '000000000002', 'leafcutter'),
                    ('nest-011', '000000000002', 'leafcutter'),
                    ('nest-012', '000000000002', 'leafcutter'),
                    ('nest-013', '000000000003', 'orchard'),
                    ('nest-014', '000000000003', 'orchard'),
                    ('nest-015', '000000000003', 'orchard'),
                    ('nest-016', '000000000003', 'orchard'),
                    ('nest-017', '000000000004', 'blackmasked'),
                    ('nest-018', '000000000004', 'blackmasked'),
                    ('nest-019', '000000000004', 'blackmasked'),
                    ('nest-020', '000000000004', 'blackmasked');

                    INSERT INTO daily_progress (progress_id, nest_id, date, empty, sealed, hatched) VALUES
                    ('prog-001', 'nest-001', '2024-06-01', 5, 45, 15),
                    ('prog-002', 'nest-002', '2024-06-01', 3, 72, 12),
                    ('prog-003', 'nest-003', '2024-06-01', 8, 30, 20),
                    ('prog-004', 'nest-004', '2024-06-01', 2, 58, 18),
                    ('prog-005', 'nest-005', '2024-06-01', 6, 85, 14),
                    ('prog-006', 'nest-006', '2024-06-01', 4, 40, 16),
                    ('prog-007', 'nest-007', '2024-06-01', 2, 65, 13),
                    ('prog-008', 'nest-008', '2024-06-01', 1, 92, 10),
                    ('prog-009', 'nest-009', '2024-06-01', 7, 55, 22),
                    ('prog-010', 'nest-010', '2024-06-01', 3, 38, 8),
                    ('prog-011', 'nest-011', '2024-06-01', 5, 70, 19),
                    ('prog-012', 'nest-012', '2024-06-01', 2, 48, 15),
                    ('prog-013', 'nest-013', '2024-06-01', 4, 60, 25),
                    ('prog-014', 'nest-014', '2024-06-01', 6, 33, 11),
                    ('prog-015', 'nest-015', '2024-06-01', 1, 78, 30),
                    ('prog-016', 'nest-016', '2024-06-01', 3, 50, 17),
                    ('prog-017', 'nest-017', '2024-06-01', 8, 25, 5),
                    ('prog-018', 'nest-018', '2024-06-01', 5, 42, 9),
                    ('prog-019', 'nest-019', '2024-06-01', 2, 67, 14),
                    ('prog-020', 'nest-020', '2024-06-01', 4, 53, 7);
                    """
                )
                print("✅ Seed data inserted")

        con.close()
