import { createDb, type DbHandle } from '@assessify/db';

/**
 * Repository-owned connection pooling (appendix-architecture-layers.md §2).
 * One shared pg pool per connection string per process; repositories share
 * the handle instead of opening their own pools.
 */
const handles = new Map<string, DbHandle>();

export function getDbHandle(connectionString: string): DbHandle {
  let handle = handles.get(connectionString);
  if (!handle) {
    handle = createDb(connectionString);
    handles.set(connectionString, handle);
  }
  return handle;
}
