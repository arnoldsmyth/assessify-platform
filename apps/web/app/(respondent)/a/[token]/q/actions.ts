'use server';

import { cookies } from 'next/headers';

import { RESPONDENT_SESSION_COOKIE, type Result } from '@assessify/domain';
import type { SaveAnswersOutcome, SubmitOutcome } from '@assessify/services';
import type { ResponseProgress } from '@assessify/domain';

import { getWebQuestionnaireSessionService } from '@/lib/questionnaire-session';

/**
 * Questionnaire renderer server actions (C2 — spec 07). Thin controllers:
 * read the signed `resp_session` cookie and pass it straight through — the
 * service derives session identity from the validated payload, so no
 * client-supplied id is ever trusted. `Result` objects are plain data and
 * cross the server-action boundary as-is; controllers add nothing.
 */

async function sessionCookie(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(RESPONDENT_SESSION_COOKIE)?.value;
}

/** Debounced autosave flush: { questionKey → answer record }. */
export async function saveAnswersAction(patch: unknown): Promise<Result<SaveAnswersOutcome>> {
  return getWebQuestionnaireSessionService().saveAnswers(await sessionCookie(), patch);
}

/** Record the section the respondent navigated to (resume position). */
export async function savePositionAction(sectionKey: string): Promise<Result<ResponseProgress>> {
  return getWebQuestionnaireSessionService().savePosition(await sessionCookie(), sectionKey);
}

/** Final submit: server-side completeness validation + immutability flip. */
export async function submitAction(): Promise<Result<SubmitOutcome>> {
  return getWebQuestionnaireSessionService().submit(await sessionCookie());
}
