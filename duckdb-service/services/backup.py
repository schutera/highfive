import gzip
import shutil
import tempfile
from datetime import datetime

from db.connection import DB_PATH, lock
from services.discord import send_discord_file, send_discord_message


def run_backup():
    timestamp = datetime.now().strftime("%Y-%m-%d_%H%M")
    filename = f"highfive_backup_{timestamp}.duckdb.gz"
    print(f"Starting weekly backup: {filename}")

    try:
        with tempfile.TemporaryDirectory() as tmp_dir:
            gz_path = f"{tmp_dir}/{filename}"

            with lock:
                with open(DB_PATH, "rb") as src, gzip.open(gz_path, "wb") as dst:
                    shutil.copyfileobj(src, dst)

            success = send_discord_file(
                gz_path,
                f"**Weekly Backup** — `{filename}`",
            )

            if success:
                print(f"Backup sent to Discord: {filename}")
            else:
                send_discord_message(f"⚠️ Weekly backup failed to upload: {filename}")

    except Exception as e:
        print(f"Backup failed: {e}")
        send_discord_message(f"⚠️ Weekly backup error: {e}")
