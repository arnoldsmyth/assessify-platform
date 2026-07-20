import { customDomains, type Database } from '@assessify/db';
import { and, eq } from 'drizzle-orm';

/**
 * Custom-domain data access (spec 11 — white-label domains, spec 04
 * `custom_domains`). F1 (tenant resolution) only needs the active-hostname
 * lookup; F2 (domain lifecycle / DO provisioning) extends this port with
 * create/verify/status operations without touching the resolution path.
 */

export interface ActiveCustomDomain {
  hostname: string;
  productId: string;
  /** Set when the domain is client-specific (client branding overlay, spec 11 phase 2). */
  clientId: string | null;
}

export interface CustomDomainRepository {
  /**
   * The hostname → product mapping used by tenant resolution. Only domains
   * with status 'active' resolve — pending/verifying/failed/disabled hosts
   * are indistinguishable from unknown hosts on the serving path.
   */
  findActiveByHostname(hostname: string): Promise<ActiveCustomDomain | null>;
}

export function createCustomDomainRepository(db: Database): CustomDomainRepository {
  return {
    async findActiveByHostname(hostname) {
      const rows = await db
        .select({
          hostname: customDomains.hostname,
          productId: customDomains.productId,
          clientId: customDomains.clientId,
        })
        .from(customDomains)
        .where(and(eq(customDomains.hostname, hostname), eq(customDomains.status, 'active')))
        .limit(1);
      const row = rows[0];
      return row ?? null;
    },
  };
}
