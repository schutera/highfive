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
        # Hinweis: Nur intern verwenden. Für public besser spezifische Endpoints statt Roh-SQL.
        r = requests.post(
            f"{self.base_url}/query",
            json={"sql": sql},
            timeout=self.timeout,
        )
        r.raise_for_status()
        return r.json()