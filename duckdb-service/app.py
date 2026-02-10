import os
import threading
import duckdb
from flask import Flask, jsonify, request

app = Flask(__name__)

DB_PATH = os.getenv("DUCKDB_PATH", "/data/app.duckdb")
lock = threading.Lock()


def get_conn():
    return duckdb.connect(DB_PATH)


# --- DB INIT (läuft beim Start einmal) ---
def init_db():
    with lock:
        con = get_conn()
        con.execute("""
            CREATE TABLE IF NOT EXISTS items (
                id UUID PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT now()
            );
        """)
        con.close()


init_db()
# -----------------------------------------


@app.get("/health")
def health():
    return jsonify(ok=True, db=DB_PATH), 200

# Hier noch Logik 
# @app.post("/query")
# def query():
#     payload = request.get_json(silent=True) or {}
#     sql = payload.get("sql")

#     if not sql:
#         return jsonify(error="Missing sql"), 400

#     try:
#         with lock:
#             con = get_conn()
#             cur = con.execute(sql)
#             cols = [d[0] for d in cur.description] if cur.description else []
#             rows = cur.fetchall() if cur.description else []
#             con.close()

#         return jsonify(columns=cols, rows=rows), 200

    # except Exception as e:
    #     return jsonify(error=str(e)), 400


if __name__ == "__main__":
    debug = os.getenv("DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=8000, debug=debug)