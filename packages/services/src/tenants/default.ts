import {
  createCustomDomainRepository,
  DrizzleProductRepository,
  getDbHandle,
} from '@assessify/repositories';

import {
  createTenantResolutionService,
  type TenantResolutionService,
} from './tenant-resolution-service';
import type { TenantHostConfig } from './hostname';

// Module compiles with lib ES2022 (no @types/node in this package); declare
// the bits of `process` the default wiring needs.
declare const process: { env: Record<string, string | undefined> };

let instance: TenantResolutionService | undefined;

/**
 * Default composition-root wiring (same pattern as products/default.ts):
 * Drizzle repositories over DATABASE_URL, sharing the process-wide pg pool
 * via getDbHandle. The host config comes from the caller (the web app's
 * validated env) — the service layer knows nothing about env-var naming.
 *
 * Memoised per process: the first call's host config wins, which also makes
 * the in-process resolution cache request-spanning (the point of it —
 * middleware runs on every request).
 */
export function getTenantResolutionService(hosts: TenantHostConfig): TenantResolutionService {
  if (!instance) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set — required for the default tenant resolution wiring'
      );
    }
    const { db } = getDbHandle(connectionString);
    instance = createTenantResolutionService({
      products: new DrizzleProductRepository(db),
      customDomains: createCustomDomainRepository(db),
      hosts,
    });
  }
  return instance;
}
