import { env } from './config/env.js';
import { createApp } from './app.js';
import { pool } from './db/client.js';
import { logger } from './lib/logger.js';
import { settings } from './modules/settings/settings.service.js';
import { loadTestClock } from './modules/system/system.routes.js';
import { startJobs, stopJobs } from './modules/jobs/jobs.js';

await settings.init();
await loadTestClock();
await startJobs();

const server = createApp().listen(env.PORT, () => {
  logger.info(`Bimayantra API listening on port ${env.PORT} (${env.NODE_ENV})`);
});

const shutdown = (signal: string) => {
  logger.info(`${signal} received, shutting down`);
  server.close(() => {
    void stopJobs()
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
