import 'dotenv/config';
import { app } from './app';
import { getApiKey } from './auth';
import {
  DUCKDB_RECOVERY_RECHECK_MS,
  probeDuckdbHealth,
  recheckDuckdbHealth,
} from './duckdbBootProbe';
import { DEFAULT_DUCKDB_URL, DUCKDB_URL, duckdbHealth, duckdbUrlReason } from './duckdbClient';
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

if (duckdbUrlReason !== 'ok') {
  // Name the actual mistake. Saying "unset" to an operator who can see the
  // variable set — which a single fromDefault boolean forces — is the same
  // class of misleading boot warning this whole change exists to remove.
  const detail =
    duckdbUrlReason === 'unset'
      ? 'unset or blank'
      : `set to an unusable value (${JSON.stringify(process.env.DUCKDB_SERVICE_URL)}) — ` +
        `it must be an absolute http(s) URL, e.g. http://duckdb-service:8000`;
  log.warn(
    `[startup] DUCKDB_SERVICE_URL ${detail} — falling back to ${DEFAULT_DUCKDB_URL}. ` +
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
    return;
  }
  // Elapsed, not just attempts: attempt count is the unit this probe
  // deliberately stopped budgeting in, since one attempt costs ~6ms against a
  // refused port and a full 2s against a hung one.
  log.warn(
    `⚠ DuckDB service not reachable after ${outcome.attempts} attempts / ` +
      `${outcome.elapsedMs}ms (${DUCKDB_URL}): ${String(outcome.error)}`,
  );

  // Look once more later, so the warning above cannot stand uncorrected in
  // the admin log panel for the rest of the process lifetime when duckdb
  // simply came up late. See recheckDuckdbHealth's docstring.
  const recovered = await recheckDuckdbHealth({ health: duckdbHealth });
  if (recovered) {
    log.info(
      `🗄 DuckDB service recovered ${DUCKDB_RECOVERY_RECHECK_MS / 1000}s after boot: ` +
        `${JSON.stringify(recovered)} — the warning above is stale.`,
    );
  } else {
    log.warn(
      `⚠ DuckDB service still unreachable ${DUCKDB_RECOVERY_RECHECK_MS / 1000}s after boot ` +
        `(${DUCKDB_URL}). No further boot checks — request paths surface live errors.`,
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
