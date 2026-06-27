import 'dotenv/config';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from './app';
import { getApiKey } from './auth';
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

// The API and duckdb-service are started together (pm2/compose), so a single
// health probe at boot races the service binding its port: it logs a
// misleading "not reachable" that then sits at the top of the admin log panel
// (#171) for the whole process lifetime. Retry briefly before deciding. The
// check is advisory — we start serving regardless of the result.
const DUCKDB_HEALTH_BOOT_RETRIES = 10;
const DUCKDB_HEALTH_BOOT_RETRY_DELAY_MS = 500;

async function bootstrap() {
  let health: { ok: boolean; db?: string } | undefined;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= DUCKDB_HEALTH_BOOT_RETRIES; attempt++) {
    try {
      health = await duckdbHealth();
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < DUCKDB_HEALTH_BOOT_RETRIES) {
        await delay(DUCKDB_HEALTH_BOOT_RETRY_DELAY_MS);
      }
    }
  }
  if (health) {
    log.info(`🗄 DuckDB service reachable: ${JSON.stringify(health)}`);
  } else {
    log.warn(
      `⚠ DuckDB service not reachable after ${DUCKDB_HEALTH_BOOT_RETRIES} attempts ` +
        `(${DUCKDB_URL}): ${String(lastErr)}`,
    );
  }

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
}

bootstrap();
