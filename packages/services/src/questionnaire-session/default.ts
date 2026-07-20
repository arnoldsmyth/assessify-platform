import {
  createAuditLogRepository,
  createQuestionnaireVersionRepository,
  createRespondentSessionRepository,
  createResponseRepository,
  getDbHandle,
} from '@assessify/repositories';

import { createAuditService } from '../audit';
import { getRespondentAccessService } from '../respondent-access';
import {
  createQuestionnaireSessionService,
  type QuestionnaireSessionService,
} from './questionnaire-session-service';

// Module compiles with lib ES2022 (no @types/node in this package); declare
// the bits of `process` the default wiring needs.
declare const process: { env: Record<string, string | undefined> };

let instance: QuestionnaireSessionService | undefined;

/**
 * Default composition-root wiring (same pattern as
 * `getRespondentAccessService`): Drizzle repositories over DATABASE_URL, the
 * C1 access service as the cookie-validation seam, and the default
 * everything-visible branching evaluator (C5 swaps the real `showIf`
 * evaluator in here). Lazy so importing @assessify/services never opens a
 * connection at module load (or during `next build`).
 */
export function getQuestionnaireSessionService(): QuestionnaireSessionService {
  if (!instance) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set — required for the default questionnaire session service wiring'
      );
    }
    const { db } = getDbHandle(connectionString);
    instance = createQuestionnaireSessionService({
      access: getRespondentAccessService(),
      sessions: createRespondentSessionRepository(connectionString),
      versions: createQuestionnaireVersionRepository(db),
      responses: createResponseRepository(connectionString),
      audit: createAuditService({ auditLogRepository: createAuditLogRepository(db) }),
    });
  }
  return instance;
}
