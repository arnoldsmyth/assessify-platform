import {
  createAuditLogRepository,
  createInMemoryPinAttemptStore,
  createRespondentSessionRepository,
  getDbHandle,
} from '@assessify/repositories';

import { createAuditService } from '../audit';
import { createBcryptPinHasher } from './pin-hasher';
import {
  createRespondentAccessService,
  type RespondentAccessService,
} from './respondent-access-service';

// Module compiles with lib ES2022 (no @types/node in this package); declare
// the bits of `process` the default wiring needs.
declare const process: { env: Record<string, string | undefined> };

let instance: RespondentAccessService | undefined;

/**
 * Default composition-root wiring (same pattern as `getProductService`):
 * Drizzle repositories over DATABASE_URL, bcrypt PIN hashing, and the
 * HMAC signing key from RESPONDENT_SESSION_SECRET — injected here, never
 * hardcoded. Lazy so importing @assessify/services never opens a connection
 * at module load (or during `next build`).
 *
 * Failed-PIN counters use the in-memory store until Valkey is provisioned
 * (spec 05 targets Valkey) — correct per process, not across replicas.
 */
export function getRespondentAccessService(): RespondentAccessService {
  if (!instance) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set — required for the default respondent access service wiring'
      );
    }
    const sessionSigningKey = process.env.RESPONDENT_SESSION_SECRET;
    if (!sessionSigningKey) {
      throw new Error(
        'RESPONDENT_SESSION_SECRET is not set — generate with `openssl rand -base64 32`'
      );
    }
    const { db } = getDbHandle(connectionString);
    instance = createRespondentAccessService({
      sessions: createRespondentSessionRepository(connectionString),
      pinAttempts: createInMemoryPinAttemptStore(),
      audit: createAuditService({ auditLogRepository: createAuditLogRepository(db) }),
      pinHasher: createBcryptPinHasher(),
      config: { sessionSigningKey },
    });
  }
  return instance;
}
