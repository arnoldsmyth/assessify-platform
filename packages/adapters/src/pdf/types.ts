/**
 * PdfRenderer adapter contract (docs/spec/09-reports-and-pdf.md).
 *
 * HTML in (option B, preferred — fully inlined assets, zero external fetches)
 * or a short-lived signed internal URL (option A, fallback for large
 * payloads); PDF bytes out as a stream. Generated PDFs are never persisted —
 * the stream is piped straight to the client response.
 *
 * Report-level orchestration (load `reports.data` → render the print template
 * to an HTML string → call this adapter) lives in the service layer; this
 * interface deliberately knows nothing about reports, only documents.
 */
export type PdfPageSize = 'a4' | 'letter';

export type PdfRenderInput =
  | {
      /** Complete, self-contained HTML document (all assets inlined). */
      html: string;
      url?: undefined;
      pageSize?: PdfPageSize;
    }
  | {
      /** Short-lived signed URL on the internal network (fallback). */
      url: string;
      html?: undefined;
      pageSize?: PdfPageSize;
    };

export interface PdfRenderer {
  /**
   * Render a document to PDF. Resolves with the PDF byte stream; rejects
   * with `PdfRenderError` if the rendering engine reports a failure.
   */
  render(input: PdfRenderInput): Promise<ReadableStream<Uint8Array>>;
}

/** Thrown by PdfRenderer providers when rendering fails. */
export class PdfRenderError extends Error {
  constructor(
    message: string,
    /** HTTP status returned by the rendering service, if any. */
    readonly status?: number
  ) {
    super(message);
    this.name = 'PdfRenderError';
  }
}
