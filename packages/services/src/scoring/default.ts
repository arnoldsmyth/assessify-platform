import {
  createAuditLogRepository,
  createQuestionnaireVersionRepository,
  createRespondentRepository,
  createRespondentSessionRepository,
  createResponseRepository,
  createScoringJobRepository,
  DrizzleProductRepository,
  getDbHandle,
} from '@assessify/repositories';
import type { JobQueue } from '@assessify/adapters';

import { createAuditService } from '../audit';
import { getOrderService } from '../orders';
import {
  createScoringService,
  type ScoringService,
  type ScoringServiceAdapters,
} from './scoring-service';

// Module compiles with lib ES2022 (no @types/node in this package); declare
// the bits of `process` the default wiring needs.
declare const process: { env: Record<string, string | undefined> };

/**
 * Adapter instances the composition root supplies. Concrete providers
 * (internal-sync engines, the E2 external wrapper, BullMQ) are constructed by
 * the app — services never import providers (.dependency-cruiser.cjs).
 * The worker passes both; the web submit path only needs `queue` (dispatch
 * never calls an engine).
 */
export interface ScoringServiceComposition {
  queue?: JobQueue;
  adapters?: ScoringServiceAdapters;
}

/**
 * Default composition-root wiring: Drizzle repositories over DATABASE_URL,
 * sharing the process-wide pg pool via getDbHandle, with order transitions
 * driven through the default order service. Call lazily — never at module
 * load.
 */
export function getScoringService(composition: ScoringServiceComposition = {}): ScoringService {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — required for the default scoring service wiring');
  }
  const { db } = getDbHandle(connectionString);
  return createScoringService({
    scoringJobs: createScoringJobRepository(db),
    sessions: createRespondentSessionRepository(connectionString),
    responses: createResponseRepository(connectionString),
    versions: createQuestionnaireVersionRepository(db),
    products: new DrizzleProductRepository(db),
    respondents: createRespondentRepository(db),
    orderService: getOrderService(),
    audit: createAuditService({ auditLogRepository: createAuditLogRepository(db) }),
    ...composition,
  });
}
