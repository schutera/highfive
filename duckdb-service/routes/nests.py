from flask import Blueprint, jsonify
from db.connection import lock, get_conn

nests_bp = Blueprint("nests", __name__)


@nests_bp.get("/nests")
def get_nests():
    with lock:
        con = get_conn()
        cur = con.execute("SELECT * FROM nest_data")
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        con.close()

    nests = [dict(zip(cols, row)) for row in rows]
    return jsonify(nests=nests), 200
