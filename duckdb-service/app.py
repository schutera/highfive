import os
from flask import Flask

from db.schema import init_db
from routes.health import health_bp
from routes.modules import modules_bp
from routes.nests import nests_bp
from routes.progress import progress_bp

app = Flask(__name__)
app.register_blueprint(health_bp)
app.register_blueprint(modules_bp)
app.register_blueprint(nests_bp)
app.register_blueprint(progress_bp)

init_db()

if __name__ == "__main__":
    debug = os.getenv("DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=8000, debug=debug)
