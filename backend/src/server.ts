import 'dotenv/config';
import { app } from './app';
import { getApiKey } from './auth';
import { probeDuckdbHealth } from './duckdbBootProbe';
import { DUCKDB_URL, duckdbHealth, duckdbUrlFromDefault } from './duckdbClient';
import { isProduction } from './env';
import { log } from './log';
import { installLogRing, initLogPersistence, writeStdout } from './logRing';
import { DEFAULT_PORT, resolvePort } from './port';

// Tee stdout/stderr into the in-memory ring so the admin server-logs endpoint
// (#171) can tail the backend's own output. Imports above have no log output;
// all real logging is runtime (below + request handlers), so installing here
// captures it. Idempotent. See logRing.ts / ADR-021.
installLogRing();
// Enable on-disk persistence + backfill the ring from prior history when
// LOG_DIR is set (compose sets it; unset = in-memory only). Must run before
// the boot banners below so they are persisted too. See ADR-023.
initLogPersistence();

const { port: PORT, warned: portUnsetWarning } = resolvePort(process.env.PORT);
if (portUnsetWarning) {
  log.warn(
    `[startup] PORT env var unset or non-numeric — defaulting to ${DEFAULT_PORT}. ` +
      `Set PORT explicitly in production. See docker-compose.yml for the dev convention.`,
  );
}

if (duckdbUrlFromDefault) {
  log.warn(
    `[startup] DUCKDB_SERVICE_URL unset — defaulting to ${DUCKDB_URL}. ` +
      `Set it explicitly in production (pm2: ecosystem.config.js; ` +
      `compose: DUCKDB_SERVICE_URL=http://duckdb-service:8000).`,
  );
}

/**
 * Run the advisory duckdb reachability probe and log its verdict.
 *
 * The loop itself lives in duckdbBootProbe.ts (importable without binding a
 * socket); this wrapper owns the logging side effect. It must never be awaited
 * ahead of `app.listen` — see the call site.
 */
async function reportDuckdbHealth() {
  const outcome = await probeDuckdbHealth({ health: duckdbHealth });
  if (outcome.reachable) {
    log.info(`🗄 DuckDB service reachable: ${JSON.stringify(outcome.health)}`);
  } else {
    log.warn(
      `⚠ DuckDB service not reachable after ${outcome.attempts} attempts ` +
        `(${DUCKDB_URL}): ${String(outcome.error)}`,
    );
  }
}

function bootstrap() {
  app.listen(PORT, () => {
    // Don't say "http://localhost" — the process binds all interfaces and on
    // prod is reached via nginx, so the localhost prefix is misleading in the
    // admin log panel (#178). State the port instead.
    log.info(`🐝 HighFive Backend API listening on port ${PORT} (all interfaces)`);
    // Never print the configured API key in production - it would land
    // in Docker logs, the admin log panel, and (ADR-023) on disk. Dev/test
    // only. `isProduction()` normalises NODE_ENV across casing/whitespace
    // typos so `"Production"` or `"production "` don't accidentally re-enable
    // the print on prod (PR #84 senior-review finding).
    if (!isProduction()) {
      // Write via the saved original stream (bypassing the ring tee) so the
      // dev key reaches the terminal as a developer convenience but is NEVER
      // captured into the admin-readable / (ADR-023) disk-persisted ring —
      // the ring must not hold secrets even in dev. See log.ts SECURITY note.
      writeStdout(`🔑 Dev admin key: ${getApiKey()}\n`);
      writeStdout(`   Admin login: POST /api/admin/login {"password":"<key>"}\n`);
      writeStdout(`   Or machine credential: X-Admin-Key: ${getApiKey()}\n`);
    }
  });

  // Fire-and-forget, and deliberately NOT awaited: the probe is advisory, so
  // gating the bind on it would connection-refuse every route — /api/health
  // included — for the whole retry window whenever duckdb is slow or down.
  // `probeDuckdbHealth` captures all errors into its outcome, so the .catch is
  // for the genuinely-impossible case only; swallowing silently would hide it.
  reportDuckdbHealth().catch((err) => {
    log.warn(`⚠ DuckDB boot probe failed unexpectedly: ${String(err)}`);
  });
}

bootstrap();
