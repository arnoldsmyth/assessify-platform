import {
  createAuditLogRepository,
  createOrderRepository,
  createReportRepository,
  createReportTemplateVersionRepository,
  createRespondentSessionRepository,
  DrizzleProductRepository,
  getDbHandle,
} from '@assessify/repositories';
import type { ObjectStorage, PdfRenderer } from '@assessify/adapters';

import { createAuditService } from '../audit';
import { getOrderService } from '../orders';
import { getTranslationService } from '../translations';
import {
  createReportTemplateService,
  type ReportTemplateService,
} from './report-template-service';
import {
  createReportService,
  type ReportReleasedHook,
  type ReportService,
} from './report-service';

// Module compiles with lib ES2022 (no @types/node in this package); declare
// the bits of `process` the default wiring needs.
declare const process: { env: Record<string, string | undefined> };

/**
 * Adapter instances the composition root supplies. Concrete providers (S3
 * object storage, the WeasyPrint pdf-service client) are constructed by the
 * app — services never import providers (.dependency-cruiser.cjs).
 */
export interface ReportServiceComposition {
  storage: ObjectStorage;
  pdf?: PdfRenderer;
  /** E6 seam: report_ready notification on release. */
  onReleased?: ReportReleasedHook;
}

function requireDatabaseUrl(): string {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — required for the default report service wiring');
  }
  return connectionString;
}

/**
 * Default composition-root wiring: Drizzle repositories over DATABASE_URL,
 * sharing the process-wide pg pool via getDbHandle. Call lazily — never at
 * module load. Storage is always caller-supplied (each app decides between
 * the S3 provider and the in-memory one).
 */
export function getReportTemplateService(composition: {
  storage: ObjectStorage;
}): ReportTemplateService {
  const { db } = getDbHandle(requireDatabaseUrl());
  return createReportTemplateService({
    reportTemplates: createReportTemplateVersionRepository(db),
    products: new DrizzleProductRepository(db),
    storage: composition.storage,
    audit: createAuditService({ auditLogRepository: createAuditLogRepository(db) }),
  });
}

export function getReportService(composition: ReportServiceComposition): ReportService {
  const connectionString = requireDatabaseUrl();
  const { db } = getDbHandle(connectionString);
  return createReportService({
    reports: createReportRepository(db),
    reportTemplates: createReportTemplateVersionRepository(db),
    sessions: createRespondentSessionRepository(connectionString),
    orders: createOrderRepository(db),
    products: new DrizzleProductRepository(db),
    translations: getTranslationService(),
    orderService: getOrderService(),
    audit: createAuditService({ auditLogRepository: createAuditLogRepository(db) }),
    storage: composition.storage,
    ...(composition.pdf ? { pdf: composition.pdf } : {}),
    ...(composition.onReleased ? { onReleased: composition.onReleased } : {}),
  });
}
