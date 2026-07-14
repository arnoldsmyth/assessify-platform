/**
 * WeasyPrint pdf-service HTTP client (docs/spec/09-reports-and-pdf.md).
 *
 * POSTs `{ html | url, pageSize }` to the internal pdf-service `/render`
 * endpoint (shared-secret header, internal network only) and returns the
 * streamed `application/pdf` response body.
 *
 * Concrete provider — wired at each app's composition root. Services import
 * the `PdfRenderer` interface from `@assessify/adapters`, never this file
 * (enforced by .dependency-cruiser.cjs).
 */
import { PdfRenderError, type PdfRenderer, type PdfRenderInput } from '../types';

export interface WeasyPrintPdfRendererOptions {
  /** Base URL of the pdf-service, e.g. `http://pdf-service.internal:8080`. */
  baseUrl: string;
  /** Shared secret sent as the `X-Pdf-Service-Secret` header. */
  sharedSecret: string;
  /** Abort the render after this many milliseconds (default 30 000). */
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class WeasyPrintPdfRenderer implements PdfRenderer {
  constructor(private readonly options: WeasyPrintPdfRendererOptions) {}

  async render(input: PdfRenderInput): Promise<ReadableStream<Uint8Array>> {
    const {
      baseUrl,
      sharedSecret,
      timeoutMs = 30_000,
      fetchImpl = fetch,
    } = this.options;

    const endpoint = new URL('/render', baseUrl);
    const body = JSON.stringify({
      html: input.html,
      url: input.url,
      pageSize: input.pageSize ?? 'a4',
    });

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pdf-service-secret': sharedSecret,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new PdfRenderError(
        `pdf-service unreachable: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }

    if (!response.ok) {
      throw new PdfRenderError(await readErrorMessage(response), response.status);
    }
    if (!response.body) {
      throw new PdfRenderError('pdf-service returned an empty body', response.status);
    }
    return response.body;
  }
}

/** Extract the `{ error }` payload the service returns on 4xx/5xx. */
async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `pdf-service responded ${response.status}`;
  try {
    const payload: unknown = await response.json();
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof (payload as { error: unknown }).error === 'string'
    ) {
      return (payload as { error: string }).error;
    }
  } catch {
    // Non-JSON error body — fall through to the generic message.
  }
  return fallback;
}
