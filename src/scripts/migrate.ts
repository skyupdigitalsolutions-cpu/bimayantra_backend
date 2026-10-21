// Apply database migrations (drizzle/ folder). Safe to run on every deploy.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from '../db/client.js';

// src/scripts → ../../drizzle (development); dist/scripts → ../drizzle (after npm run build)
const candidates = ['../../drizzle', '../drizzle'].map((p) => fileURLToPath(new URL(p, import.meta.url)));
const migrationsFolder = candidates.find((p) => existsSync(p));
if (!migrationsFolder) throw new Error('Migrations folder not found');

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder! });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runMigrations();
  console.log('Database migrations applied.');
  await pool.end();
}
