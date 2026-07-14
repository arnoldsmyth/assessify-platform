import { customType } from 'drizzle-orm/pg-core';

/**
 * Postgres `citext` (case-insensitive text). Requires the citext extension,
 * created in the initial migration.
 */
export const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});
