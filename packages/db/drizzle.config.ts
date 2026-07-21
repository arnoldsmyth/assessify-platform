import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  strict: true,
  verbose: true,
  // Only read for commands that connect (migrate/push/studio) — `generate`
  // needs no DB and stays usable with no DATABASE_URL set.
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
