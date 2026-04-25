import os
import requests

class DuckDBService:
    def __init__(self, base_url: str | None = None, timeout: float = 5.0):
        self.base_url = (base_url or os.getenv("DUCKDB_SERVICE_URL") or "http://duckdb-service:8000").rstrip("/")
        self.timeout = timeout

    def health(self) -> dict:
        r = requests.get(f"{self.base_url}/health", timeout=self.timeout)
        r.raise_for_status()
        return r.json()

    def query(self, sql: str) -> dict:
        # Internal use only. Prefer specific endpoints over raw SQL for public access.
        r = requests.post(
            f"{self.base_url}/query",
            json={"sql": sql},
            timeout=self.timeout,
        )
        r.raise_for_status()
        return r.json()

    def get_progress_count(self, module_id: str) -> int:
        """Return the number of daily_progress rows for a module.

        Used by image-service to detect a module's first upload.
        """
        r = requests.get(
            f"{self.base_url}/modules/{module_id}/progress_count",
            timeout=self.timeout,
        )
        r.raise_for_status()
        return int(r.json().get("count", 0))

    def add_progress_for_module(self, payload: dict) -> dict:
        """POST classification results for a module to duckdb-service."""
        r = requests.post(
            f"{self.base_url}/add_progress_for_module",
            json=payload,
            timeout=self.timeout,
        )
        r.raise_for_status()
        return r.json()

    def heartbeat(self, module_id: str, battery: int) -> bool:
        """Record a module heartbeat (battery + first_online + image_count++).

        Returns True on 2xx, False on 404 (unknown module). Raises on other
        non-success statuses.
        """
        r = requests.post(
            f"{self.base_url}/modules/{module_id}/heartbeat",
            json={"battery": battery},
            timeout=self.timeout,
        )
        if r.status_code == 404:
            return False
        r.raise_for_status()
        return True
