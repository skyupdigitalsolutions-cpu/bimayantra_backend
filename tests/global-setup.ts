// Fresh test database for every run: drop everything, then apply the real migrations.
import { testEnv } from '../vitest.config.js';

export default async function setup(): Promise<void> {
  Object.assign(process.env, testEnv);
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: testEnv.DATABASE_URL });
  await client.connect();
  await client.query('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;');
  await client.end();
  const { runMigrations } = await import('../src/scripts/migrate.js');
  await runMigrations();
  const { pool } = await import('../src/db/client.js');
  await pool.end();
}
