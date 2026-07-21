import { getQuestionnaireSessionService, getScoringService } from '@assessify/services';
import type { QuestionnaireSessionService } from '@assessify/services';

import { getJobQueue } from './queue';

/**
 * Web composition root for the questionnaire session service (asy-u4y).
 *
 * `getQuestionnaireSessionService` honours its composition on FIRST
 * construction only, so every web call site must come through here: with a
 * queue configured, respondent submits dispatch scoring (E1); without one,
 * the service falls back to its no-op dispatcher and admin re-scoring
 * catches up later.
 */
export function getWebQuestionnaireSessionService(): QuestionnaireSessionService {
  const queue = getJobQueue();
  return getQuestionnaireSessionService(
    queue ? { scoring: getScoringService({ queue }) } : {}
  );
}
