import os

from db.connection import lock, get_conn


def init_db():
    with lock:
        con = get_conn()
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS module_configs (
                id VARCHAR(20) PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                lat DECIMAL(9,6) NOT NULL,
                lng DECIMAL(9,6) NOT NULL,
                status VARCHAR(10) NOT NULL CHECK (status IN ('online', 'offline')),
                first_online DATE NOT NULL,
                battery_level INTEGER,
                image_count INTEGER NOT NULL DEFAULT 0,
                email VARCHAR(255)
            );

            CREATE TABLE IF NOT EXISTS nest_data (
                nest_id VARCHAR(20) NOT NULL PRIMARY KEY,
                module_id VARCHAR(20) NOT NULL REFERENCES module_configs(id),
                beeType VARCHAR(20) CHECK (beeType IN ('blackmasked', 'resin', 'leafcutter', 'orchard'))
            );

            CREATE TABLE IF NOT EXISTS daily_progress (
                progress_id VARCHAR(20) PRIMARY KEY,
                nest_id VARCHAR(20) NOT NULL REFERENCES nest_data(nest_id),
                date DATE NOT NULL,
                empty INTEGER NOT NULL,
                sealed INTEGER NOT NULL,
                hatched INTEGER NOT NULL
            );

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
            """
        )

        # Add email column to existing databases
        try:
            con.execute("ALTER TABLE module_configs ADD COLUMN email VARCHAR(255)")
        except Exception:
            pass  # column already exists

        if os.getenv("SEED_DATA", "").lower() == "true":
            row_count = con.execute("SELECT COUNT(*) FROM module_configs").fetchone()[0]
            if row_count == 0:
                con.execute(
                    """
                    INSERT INTO module_configs (id, name, lat, lng, status, first_online, image_count) VALUES
                    ('hive-001', 'Elias123',    47.8086, 9.6433, 'online',  '2023-04-15', 142),
                    ('hive-002', 'Garten 12',   47.8100, 9.6450, 'offline', '2023-05-20', 87),
                    ('hive-003', 'Waldrand',    47.7819, 9.6107, 'online',  '2024-03-10', 53),
                    ('hive-004', 'Schussental', 47.7850, 9.6200, 'online',  '2024-06-01', 24),
                    ('hive-005', 'Bergblick',   47.8050, 9.6350, 'online',  '2025-02-14', 3);

                    INSERT INTO nest_data (nest_id, module_id, beeType) VALUES
                    ('nest-001', 'hive-001', 'blackmasked'),
                    ('nest-002', 'hive-001', 'blackmasked'),
                    ('nest-003', 'hive-001', 'blackmasked'),
                    ('nest-004', 'hive-001', 'blackmasked'),
                    ('nest-005', 'hive-001', 'resin'),
                    ('nest-006', 'hive-001', 'resin'),
                    ('nest-007', 'hive-001', 'resin'),
                    ('nest-008', 'hive-001', 'resin'),
                    ('nest-009', 'hive-002', 'leafcutter'),
                    ('nest-010', 'hive-002', 'leafcutter'),
                    ('nest-011', 'hive-002', 'leafcutter'),
                    ('nest-012', 'hive-002', 'leafcutter'),
                    ('nest-013', 'hive-003', 'orchard'),
                    ('nest-014', 'hive-003', 'orchard'),
                    ('nest-015', 'hive-003', 'orchard'),
                    ('nest-016', 'hive-003', 'orchard'),
                    ('nest-017', 'hive-004', 'blackmasked'),
                    ('nest-018', 'hive-004', 'blackmasked'),
                    ('nest-019', 'hive-004', 'blackmasked'),
                    ('nest-020', 'hive-004', 'blackmasked');

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
