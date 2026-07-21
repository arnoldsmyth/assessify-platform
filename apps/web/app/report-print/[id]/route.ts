import { NextResponse } from 'next/server';

import { getServerEnv } from '@/lib/env';
import { getWebReportService } from '@/lib/reports';

export const dynamic = 'force-dynamic';

/**
 * Internal print route consumed by pdf-service (spec 09 option A / E4
 * contract): serves the RAW assembled report HTML for `{reportId}`, gated by
 * the same shared secret the WeasyPrint client uses (`x-pdf-service-secret`).
 * Internal network only; answers 503 until the secret is configured — never
 * secret-less (same convention as the webhook routes). Never linked from any
 * user-facing surface; the id in the URL is an opaque UUID.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const secret = getServerEnv().PDF_SERVICE_SHARED_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'print_route_not_configured' }, { status: 503 });
  }
  const presented = request.headers.get('x-pdf-service-secret');
  if (presented === null || !timingSafeEqual(presented, secret)) {
    return NextResponse.json({ error: 'invalid or missing shared secret' }, { status: 401 });
  }

  const { id } = await params;
  const result = await getWebReportService().getPrintHtml(id);
  if (!result.ok) {
    const status = result.error.code === 'report/not_found' ? 404 : 500;
    return NextResponse.json({ error: result.error.code }, { status });
  }

  return new Response(result.value.html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/** Constant-time string comparison — never short-circuits on a mismatch. */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i += 1) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}
