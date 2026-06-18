import 'dotenv/config';
import { app } from './app';
import { getApiKey } from './auth';
import { duckdbHealth } from './duckdbClient';
import { isProduction } from './env';
import { log } from './log';
import { installLogRing } from './logRing';
import { DEFAULT_PORT, resolvePort } from './port';

// Tee stdout/stderr into the in-memory ring so the admin server-logs endpoint
// (#171) can tail the backend's own output. Imports above have no log output;
// all real logging is runtime (below + request handlers), so installing here
// captures it. Idempotent. See logRing.ts / ADR-021.
installLogRing();

const { port: PORT, warned: portUnsetWarning } = resolvePort(process.env.PORT);
if (portUnsetWarning) {
  log.warn(
    `[startup] PORT env var unset or non-numeric — defaulting to ${DEFAULT_PORT}. ` +
      `Set PORT explicitly in production. See docker-compose.yml for the dev convention.`,
  );
}

async function bootstrap() {
  try {
    const health = await duckdbHealth();
    log.info(`🗄 DuckDB service reachable: ${JSON.stringify(health)}`);
  } catch (err) {
    log.warn(`⚠ DuckDB service not reachable: ${String(err)}`);
  }

  app.listen(PORT, () => {
    // Don't say "http://localhost" — the process binds all interfaces and on
    // prod is reached via nginx, so the localhost prefix is misleading in the
    // admin log panel (#178). State the port instead.
    log.info(`🐝 HighFive Backend API listening on port ${PORT} (all interfaces)`);
    // Never print the configured API key in production - it would land
    // in Docker logs, the admin log panel, and (ADR-022) on disk. Dev/test
    // only. `isProduction()` normalises NODE_ENV across casing/whitespace
    // typos so `"Production"` or `"production "` don't accidentally re-enable
    // the print on prod (PR #84 senior-review finding).
    if (!isProduction()) {
      log.info(`🔑 Dev admin key: ${getApiKey()}`);
      log.info(`   Admin login: POST /api/admin/login {"password":"<key>"}`);
      log.info(`   Or machine credential: X-Admin-Key: ${getApiKey()}`);
    }
  });
}

bootstrap();
