import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { RESPONDENT_SESSION_COOKIE } from '@assessify/domain';
import { getRespondentAccessService } from '@assessify/services';

import { getWebReportService } from '@/lib/reports';

export const dynamic = 'force-dynamic';

/**
 * Respondent "Download PDF" (E3 — spec 09): same C1 cookie gate as the
 * report page, then stream the PDF straight from the PdfRenderer adapter —
 * generated on demand, never persisted. Only released, pdf-capable reports
 * (web-only templates 404 here; the page never links them).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
  const { token } = await params;
  const access = getRespondentAccessService();

  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(RESPONDENT_SESSION_COOKIE)?.value;
  const validated = await access.validateSessionToken(sessionCookie);
  if (!validated.ok) {
    return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });
  }
  const resolved = await access.resolveToken(token);
  if (!resolved.ok || resolved.value.sessionId !== validated.value.sessionId) {
    return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });
  }

  const result = await getWebReportService().renderPdfForSession(validated.value.sessionId);
  if (!result.ok) {
    const status =
      result.error.code === 'report/not_available' || result.error.code === 'report/pdf_unavailable'
        ? 404
        : 503;
    // Code only — never error internals to a respondent.
    return NextResponse.json({ error: result.error.code }, { status });
  }

  return new Response(result.value, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      // UUID-free, PII-free filename.
      'content-disposition': 'attachment; filename="report.pdf"',
      'cache-control': 'no-store',
    },
  });
}
