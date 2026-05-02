import 'dotenv/config';
import { app } from './app';
import { getApiKey } from './auth';
import { duckdbHealth } from './duckdbClient';

const PORT = Number(process.env.PORT) || 3001;

async function bootstrap() {
  try {
    const health = await duckdbHealth();
    console.log('🗄 DuckDB service reachable:', health);
  } catch (err) {
    console.warn('⚠ DuckDB service not reachable:', err);
  }

  app.listen(PORT, () => {
    console.log(`🐝 HighFive Backend API running on http://localhost:${PORT}`);
    console.log(`🔑 Dev API Key: ${getApiKey()}`);
    console.log(`   Use header: X-API-Key: ${getApiKey()}`);
  });
}

bootstrap();
