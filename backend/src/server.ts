import 'dotenv/config';
import { app } from './app';
import { getApiKey } from './auth';
import { duckdbHealth } from './duckdbClient';
import { isProduction } from './env';

const PORT = parseInt(process.env.PORT || '3001', 10);

async function bootstrap() {
  try {
    const health = await duckdbHealth();
    console.log('🗄 DuckDB service reachable:', health);
  } catch (err) {
    console.warn('⚠ DuckDB service not reachable:', err);
  }

  app.listen(PORT, () => {
    console.log(`🐝 HighFive Backend API running on http://localhost:${PORT}`);
    // Never print the configured API key in production - it would land
    // in Docker logs and any aggregator collecting them. Dev/test only.
    // `isProduction()` normalises NODE_ENV across casing/whitespace typos
    // so `"Production"` or `"production "` don't accidentally re-enable
    // the print on prod (PR #84 senior-review finding).
    if (!isProduction()) {
      console.log(`🔑 Dev API Key: ${getApiKey()}`);
      console.log(`   Use header: X-API-Key: ${getApiKey()}`);
    }
  });
}

bootstrap();
