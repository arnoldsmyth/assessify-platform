import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { FileDown } from 'lucide-react';

import { RESPONDENT_SESSION_COOKIE } from '@assessify/domain';
import { getRespondentAccessService } from '@assessify/services';

import { getWebReportService } from '@/lib/reports';

import { AccessShell } from '../../../access/_components/access-shell';

export const metadata: Metadata = { title: 'Your report' };

/**
 * Respondent report route `/a/{token}/report` (E3 — spec 09: token+PIN gate,
 * only when `released`). The C1 cookie gate is identical to the
 * questionnaire route: a valid signed `resp_session` cookie that belongs to
 * THIS token's session, else back to PIN entry. The service returns one
 * generic "not available" state for missing/unreleased reports — no leaking
 * which. The assembled HTML is a full standalone document, so it renders in
 * a sandboxed iframe inside the white-label shell (CSS-isolated, no scripts).
 */
export default async function RespondentReportPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const access = getRespondentAccessService();

  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(RESPONDENT_SESSION_COOKIE)?.value;
  const validated = await access.validateSessionToken(sessionCookie);
  if (!validated.ok) redirect(`/a/${token}`);

  // The cookie must belong to this token's session — a signed cookie for a
  // different session never opens someone else's report.
  const resolved = await access.resolveToken(token);
  if (!resolved.ok || resolved.value.sessionId !== validated.value.sessionId) {
    redirect(`/a/${token}`);
  }

  const report = await getWebReportService().getRespondentReport(validated.value.sessionId);
  if (!report.ok) {
    return (
      <AccessShell
        title="Your report is not available yet"
        description="Reports become available once your assessment has been processed and released."
      >
        <p className="text-sm text-body">
          Please check back later, or contact the person who invited you if you believe this is a
          mistake.
        </p>
      </AccessShell>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-ink">Your report</h1>
        {report.value.pdfAvailable ? (
          <a
            href={`/a/${token}/report/pdf`}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-ink shadow-sm hover:bg-primary-tint/40"
          >
            <FileDown size={16} strokeWidth={1.75} aria-hidden="true" />
            Download PDF
          </a>
        ) : null}
      </div>
      <iframe
        title="Report"
        sandbox=""
        srcDoc={report.value.html}
        className="min-h-[80vh] w-full rounded-md border border-border bg-white shadow-sm"
      />
    </main>
  );
}
