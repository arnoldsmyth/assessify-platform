import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { RESPONDENT_SESSION_COOKIE } from '@assessify/domain';
import { getRespondentAccessService } from '@assessify/services';

import { AccessShell } from '../../../access/_components/access-shell';

export const metadata: Metadata = { title: 'Assessment' };

/**
 * Cookie-guarded questionnaire route `/a/{token}/q` (spec 07). C1 owns only
 * the gate: a valid signed `resp_session` cookie that belongs to THIS
 * token's session, else back to PIN entry. The questionnaire renderer (C2)
 * replaces the placeholder body below.
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

  return (
    <AccessShell title="You're in" description="Your access has been verified.">
      <p className="text-sm text-body">
        The questionnaire will load here once the questionnaire engine (C2) lands.
      </p>
    </AccessShell>
  );
}
