import os
import threading
import duckdb

DB_PATH = os.getenv("DUCKDB_PATH", "./data/app.duckdb")
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

lock = threading.Lock()


def get_conn():
    return duckdb.connect(DB_PATH)
