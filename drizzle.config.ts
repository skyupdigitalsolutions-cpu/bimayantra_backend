import { defineConfig } from 'drizzle-kit';

// `npm run db:generate` turns src/db/schema.ts into a new SQL migration in ./drizzle
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/bimayantra' },
  strict: true,
});
