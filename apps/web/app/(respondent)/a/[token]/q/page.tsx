import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { RESPONDENT_SESSION_COOKIE } from '@assessify/domain';
import { getQuestionnaireSessionService, getRespondentAccessService } from '@assessify/services';

import { AccessShell } from '../../../access/_components/access-shell';
import { QuestionnaireRenderer } from './_components/questionnaire-renderer';

export const metadata: Metadata = { title: 'Assessment' };

/**
 * Questionnaire route `/a/{token}/q` (C2 — spec 07). The C1 cookie gate is
 * unchanged: a valid signed `resp_session` cookie that belongs to THIS
 * token's session, else back to PIN entry. The gate then hands the raw
 * cookie to the questionnaire session service, which loads the pinned
 * definition + saved answers + resume position (creating the draft response
 * on first load). Thin controller: all flow rules live in the service.
 */
export default async function QuestionnairePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const service = getRespondentAccessService();

  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(RESPONDENT_SESSION_COOKIE)?.value;
  const validated = await service.validateSessionToken(sessionCookie);
  if (!validated.ok) redirect(`/a/${token}`);

  // The cookie must belong to this token's session — a signed cookie for a
  // different session never opens someone else's questionnaire.
  const resolved = await service.resolveToken(token);
  if (!resolved.ok || resolved.value.sessionId !== validated.value.sessionId) {
    redirect(`/a/${token}`);
  }

  const state = await getQuestionnaireSessionService().loadState(sessionCookie);
  if (!state.ok) {
    if (state.error.code.startsWith('respondent_access/')) redirect(`/a/${token}`);
    return (
      <AccessShell title="Assessment unavailable" description={state.error.message}>
        <p className="text-sm text-body">
          Please try again later or contact the person who invited you.
        </p>
      </AccessShell>
    );
  }

  // Submitted responses are immutable (spec 07) — reopening the link only
  // ever shows the confirmation.
  if (state.value.status === 'submitted') {
    return (
      <AccessShell
        title="Already submitted"
        description="Your answers have been submitted and can no longer be changed."
      >
        <p className="text-sm text-body">You can close this window.</p>
      </AccessShell>
    );
  }

  return (
    <QuestionnaireRenderer
      token={token}
      definition={state.value.definition}
      initialAnswers={state.value.answers}
      resumeSectionIndex={state.value.resumeSectionIndex}
    />
  );
}
