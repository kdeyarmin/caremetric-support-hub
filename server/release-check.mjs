import pg from 'pg';
import { databaseConfig, guardPool, untilReachable } from './database-config.mjs';
import { assertAdvertisingRelease } from './advertising-release.mjs';

// Railway runs this in the candidate image before replacing the current deployment.
// It never runs migrations, starts workers, calls an ad provider or reserves money.
let pool;
try {
  pool = guardPool(new pg.Pool({ ...databaseConfig(), max: 1, query_timeout: 10_000 }));
  await untilReachable(() => assertAdvertisingRelease(pool));
  console.log('Advertising database prerequisites verified. No changes made.');
} catch {
  console.error('Release blocked: unable to verify the advertising database prerequisites. Check database connectivity and apply the reviewed creative-validation and atomic-queue migrations before deploying.');
  process.exitCode = 1;
} finally {
  await pool?.end();
}
