import type { ObjectStorage, PdfRenderer } from '@assessify/adapters';
import { MemoryStorage } from '@assessify/adapters/storage/memory';
import { S3Storage, s3ConfigFromEnv } from '@assessify/adapters/storage/s3';
import { WeasyPrintPdfRenderer } from '@assessify/adapters/pdf/weasyprint';
import {
  getReportService,
  getReportTemplateService,
  type ReportService,
  type ReportTemplateService,
} from '@assessify/services';

import { getServerEnv } from './env';

/**
 * Web composition root for report services (E3 — spec 09). Concrete
 * providers are chosen here and injected; nothing below the composition root
 * knows which it got (.dependency-cruiser.cjs).
 *
 * - Object storage: the S3-compatible provider when `S3_*` env is set
 *   (Hetzner/DO Spaces in production), else a process-local in-memory store
 *   for dev — templates/reports then live only inside THIS web process and
 *   are invisible to the worker; set the S3 env for cross-process flows.
 * - PDF: the WeasyPrint pdf-service client when `PDF_SERVICE_URL` +
 *   `PDF_SERVICE_SHARED_SECRET` are set; otherwise PDF downloads return a typed
 *   error and the affordance is hidden.
 */

let storageInstance: ObjectStorage | undefined;

export function getWebObjectStorage(): ObjectStorage {
  if (!storageInstance) {
    try {
      storageInstance = new S3Storage(s3ConfigFromEnv());
    } catch {
      console.warn(
        '[web] S3_* storage env not set — using in-memory object storage (dev only; not shared with the worker)'
      );
      storageInstance = new MemoryStorage();
    }
  }
  return storageInstance;
}

function getPdfRenderer(): PdfRenderer | undefined {
  const env = getServerEnv();
  if (!env.PDF_SERVICE_URL || !env.PDF_SERVICE_SHARED_SECRET) return undefined;
  return new WeasyPrintPdfRenderer({
    baseUrl: env.PDF_SERVICE_URL,
    sharedSecret: env.PDF_SERVICE_SHARED_SECRET,
  });
}

export function getWebReportTemplateService(): ReportTemplateService {
  return getReportTemplateService({ storage: getWebObjectStorage() });
}

export function getWebReportService(): ReportService {
  const pdf = getPdfRenderer();
  return getReportService({
    storage: getWebObjectStorage(),
    ...(pdf ? { pdf } : {}),
  });
}
