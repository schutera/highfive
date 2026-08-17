import 'dotenv/config';
import { app } from './app';
import { getApiKey } from './auth';
import { reportDuckdbHealth } from './duckdbBootProbe';
// DUCKDB_URL is safe to log: resolveDuckdbUrl rejects any URL carrying
// userinfo, so the constant can never hold a credential. The raw *env value*
// still can, which is why the warning below redacts it.
import {
  DUCKDB_URL,
  describeDuckdbUrlMisconfig,
  describeError,
  duckdbHealth,
  duckdbUrlReason,
} from './duckdbClient';
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

// Composed in duckdbClient so it can be unit-tested — this message echoes the
// raw env value back and is the last place a credential can reach the ring.
const duckdbUrlWarning = describeDuckdbUrlMisconfig(
  duckdbUrlReason,
  process.env.DUCKDB_SERVICE_URL,
);
if (duckdbUrlWarning) log.warn(duckdbUrlWarning);

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
  // `reportDuckdbHealth` captures all errors internally, so the .catch is for
  // the genuinely-impossible case only; swallowing silently would hide it.
  reportDuckdbHealth({ health: duckdbHealth, log, duckdbUrl: DUCKDB_URL }).catch((err) => {
    log.warn(`⚠ DuckDB boot probe failed unexpectedly: ${describeError(err)}`);
  });
}

bootstrap();
