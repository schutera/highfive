import os
from flask import Flask
from apscheduler.schedulers.background import BackgroundScheduler

from db.schema import init_db
from routes.health import health_bp
from routes.modules import modules_bp
from routes.nests import nests_bp
from routes.progress import progress_bp
from routes.heartbeats import heartbeats_bp
from services.backup import run_backup
from services.silence_watcher import check_silence

app = Flask(__name__)
app.register_blueprint(health_bp)
app.register_blueprint(modules_bp)
app.register_blueprint(nests_bp)
app.register_blueprint(progress_bp)
app.register_blueprint(heartbeats_bp)

init_db()

scheduler = BackgroundScheduler()
scheduler.add_job(run_backup, "cron", day_of_week="sun", hour=3, minute=0, id="weekly_backup")
scheduler.add_job(check_silence, "interval", minutes=15, id="silence_watcher")
scheduler.start()

if __name__ == "__main__":
    debug = os.getenv("DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=8000, debug=debug)
