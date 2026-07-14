import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema';

export * as schema from './schema';
export * from './schema';

/** Typed Drizzle client over the full Assessify schema. */
export type Database = NodePgDatabase<typeof schema>;

export interface CreateDbOptions {
  /** Max pool size (pg default: 10). */
  max?: number;
}

export interface DbHandle {
  db: Database;
  /** Underlying pool — call `pool.end()` on shutdown. */
  pool: Pool;
}

/**
 * Create a typed Drizzle client from a Postgres connection string.
 * Only `packages/repositories` (and migration tooling) should call this;
 * nothing outside `packages/db` imports drizzle directly.
 */
export function createDb(connectionString: string, options: CreateDbOptions = {}): DbHandle {
  const pool = new Pool({ connectionString, max: options.max });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
