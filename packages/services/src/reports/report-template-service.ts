import {
  err,
  isSuperAdmin,
  ok,
  orgScopeIds,
  reportTemplateCapabilitiesSchema,
  reportTemplateConfigSchema,
  UPLOADED_HTML_COMPONENT_KEY,
  uuidv7,
  type AuditActor,
  type CallerContext,
  type DomainError,
  type Product,
  type ReportTemplateCapabilities,
  type ReportTemplateConfig,
  type Result,
} from '@assessify/domain';
import type { ObjectStorage } from '@assessify/adapters';
import type {
  ProductRepository,
  ReportTemplateVersion,
  ReportTemplateVersionRepository,
} from '@assessify/repositories';
import { z } from 'zod';

import type { AuditService } from '../audit';

/**
 * Report template lifecycle (E3 — spec 09 re-scoped 2026-07-21: templates
 * are manually built, pixel-perfect HTML files per product, uploaded to
 * object storage). Upload stores the bytes at
 * `templates/{productId}/{templateVersionId}.html` via the injected
 * ObjectStorage and records a `report_template_versions` row (`draft`, next
 * version number for the product) whose `config` carries the storage key and
 * the web/pdf capability flags; activation enforces at most one `active`
 * version per product. Versions are immutable once active; a superseded
 * active version becomes `retired` — B3's exact status conventions
 * (questionnaire versions, spec 07).
 *
 * Authorization (spec 05 matrix "manage questionnaire/report versions",
 * re-scoped per owner decisions 2026-07-21): super_admin, or
 * assessment_admin scoped to the product's ORGANIZATION.
 */

export interface ReportTemplateVersionView {
  id: string;
  productId: string;
  version: number;
  status: ReportTemplateVersion['status'];
  capabilities: ReportTemplateCapabilities;
  storageKey: string;
  createdAt: Date;
}

export interface ReportTemplateService {
  /**
   * Store an uploaded HTML template as a new draft version. Version number =
   * max(version) for the product + 1.
   */
  upload(caller: CallerContext, input: unknown): Promise<Result<ReportTemplateVersionView>>;
  /**
   * Make a draft version the product's active template; the previously
   * active version (if any) is retired. Idempotent for an already-active
   * version. Retired versions cannot be reactivated (immutable once active —
   * re-upload instead).
   */
  activate(caller: CallerContext, id: string): Promise<Result<ReportTemplateVersionView>>;
  /** Retire a draft or active version without activating a replacement. Idempotent. */
  retire(caller: CallerContext, id: string): Promise<Result<ReportTemplateVersionView>>;
  /** All template versions of a product, newest first. */
  listByProduct(
    caller: CallerContext,
    productId: string
  ): Promise<Result<ReportTemplateVersionView[]>>;
}

export interface ReportTemplateServiceDeps {
  reportTemplates: ReportTemplateVersionRepository;
  products: ProductRepository;
  storage: ObjectStorage;
  audit: AuditService;
  now?: () => Date;
  generateId?: () => string;
}

/** Hand-built HTML documents; anything above 5 MB is a mistake (inline assets included). */
export const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024;

export const uploadReportTemplateSchema = z.object({
  productId: z.string().uuid(),
  /** The full HTML document text as uploaded/pasted. */
  html: z
    .string()
    .min(1, 'Template HTML is required')
    .max(MAX_TEMPLATE_BYTES, 'Template is too large (5 MB max)'),
  capabilities: reportTemplateCapabilitiesSchema,
});
export type UploadReportTemplateInput = z.input<typeof uploadReportTemplateSchema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Deterministic storage-key scheme — ids only, never PII (spec 00). */
export function templateStorageKey(productId: string, templateVersionId: string): string {
  return `templates/${productId}/${templateVersionId}.html`;
}

function forbidden(caller: CallerContext): DomainError {
  return {
    code: 'report_template/forbidden',
    message:
      'Only super admins or the product’s assessment admins can manage report templates',
    detail: { kind: caller.kind, roles: caller.roles.map((r) => r.role) },
  };
}

function canManage(caller: CallerContext, product: Product): boolean {
  if (isSuperAdmin(caller)) return true;
  return caller.kind === 'user' && orgScopeIds(caller).includes(product.organizationId);
}

function notFound(id: string): DomainError {
  return {
    code: 'report_template/not_found',
    message: 'Report template version not found',
    detail: { id },
  };
}

function productNotFound(productId: string): DomainError {
  return {
    code: 'report_template/product_not_found',
    message: 'Product not found',
    detail: { productId },
  };
}

function auditActor(caller: CallerContext): AuditActor {
  return { kind: caller.kind, id: caller.id };
}

/** Encode UTF-8 without assuming @types/node (this package is lib ES2022). */
declare const TextEncoder: new () => { encode(input: string): Uint8Array };

function toView(row: ReportTemplateVersion, config: ReportTemplateConfig): ReportTemplateVersionView {
  return {
    id: row.id,
    productId: row.productId,
    version: row.version,
    status: row.status,
    capabilities: config.capabilities,
    storageKey: config.storageKey,
    createdAt: row.createdAt,
  };
}

/**
 * Parse a stored row's config. Uploaded rows always validate; a row from the
 * pre-re-scope React shape surfaces as a typed error instead of a crash.
 */
export function parseTemplateConfig(
  row: ReportTemplateVersion
): Result<ReportTemplateConfig, DomainError> {
  const parsed = reportTemplateConfigSchema.safeParse(row.config);
  if (!parsed.success) {
    return err({
      code: 'report_template/config_invalid',
      message: 'The template version does not carry an uploaded-HTML config',
      detail: { id: row.id, componentKey: row.componentKey },
    });
  }
  return ok(parsed.data);
}

export function createReportTemplateService(
  deps: ReportTemplateServiceDeps
): ReportTemplateService {
  const { reportTemplates, products, storage, audit } = deps;
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? uuidv7;

  async function loadForManage(
    caller: CallerContext,
    id: string
  ): Promise<Result<{ row: ReportTemplateVersion; config: ReportTemplateConfig }>> {
    if (!UUID_RE.test(id)) return err(notFound(id));
    const row = await reportTemplates.findById(id);
    if (!row) return err(notFound(id));
    const product = await products.findById(row.productId);
    if (!product) return err(productNotFound(row.productId));
    if (!canManage(caller, product)) return err(forbidden(caller));
    const config = parseTemplateConfig(row);
    if (!config.ok) return err(config.error);
    return ok({ row, config: config.value });
  }

  return {
    async upload(caller, input) {
      const parsed = uploadReportTemplateSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'report_template/validation',
          message: 'Report template upload failed validation',
          detail: {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        });
      }
      const { productId, html, capabilities } = parsed.data;

      const product = await products.findById(productId);
      if (!product) return err(productNotFound(productId));
      if (!canManage(caller, product)) return err(forbidden(caller));

      const id = generateId();
      const storageKey = templateStorageKey(productId, id);
      try {
        await storage.upload({
          key: storageKey,
          body: new TextEncoder().encode(html),
          contentType: 'text/html; charset=utf-8',
        });
      } catch (cause) {
        return err({
          code: 'report_template/storage_failed',
          message: 'Failed to store the template HTML',
          detail: { cause: cause instanceof Error ? cause.message : String(cause) },
        });
      }

      const config: ReportTemplateConfig = {
        storageKey,
        contentType: 'text/html',
        capabilities,
      };
      // Race on concurrent uploads is backstopped by the DB unique constraint
      // on (product_id, version) — that path throws (unexpected).
      const version = (await reportTemplates.maxVersion(productId)) + 1;
      const created = await reportTemplates.insert({
        id,
        productId,
        version,
        componentKey: UPLOADED_HTML_COMPONENT_KEY,
        config,
        status: 'draft',
        createdAt: now(),
      });

      const audited = await audit.record(
        auditActor(caller),
        'report_template.uploaded',
        { type: 'report_template_version', id: created.id },
        {
          productId,
          version: created.version,
          storageKey,
          capabilities: { web: capabilities.web, pdf: capabilities.pdf },
          bytes: html.length,
        }
      );
      if (!audited.ok) return err(audited.error);
      return ok(toView(created, config));
    },

    async activate(caller, id) {
      const loaded = await loadForManage(caller, id);
      if (!loaded.ok) return loaded;
      const { row, config } = loaded.value;

      if (row.status === 'active') return ok(toView(row, config));
      if (row.status === 'retired') {
        return err({
          code: 'report_template/invalid_state',
          message:
            'Retired versions cannot be reactivated — versions are immutable once active; upload a new version instead',
          detail: { id, status: row.status },
        });
      }

      // At most one active template per product — retire the incumbent
      // before activating the draft (B3 convention).
      const incumbent = await reportTemplates.findActive(row.productId);
      if (incumbent && incumbent.id !== id) {
        const superseded = await reportTemplates.updateStatus(incumbent.id, 'retired');
        if (!superseded) return err(notFound(incumbent.id));
      }

      const activated = await reportTemplates.updateStatus(id, 'active');
      if (!activated) return err(notFound(id));

      const audited = await audit.record(
        auditActor(caller),
        'report_template.activated',
        { type: 'report_template_version', id },
        {
          productId: row.productId,
          version: row.version,
          supersededVersionId: incumbent?.id ?? null,
        }
      );
      if (!audited.ok) return err(audited.error);
      return ok(toView(activated, config));
    },

    async retire(caller, id) {
      const loaded = await loadForManage(caller, id);
      if (!loaded.ok) return loaded;
      const { row, config } = loaded.value;

      if (row.status === 'retired') return ok(toView(row, config));

      const retired = await reportTemplates.updateStatus(id, 'retired');
      if (!retired) return err(notFound(id));

      const audited = await audit.record(
        auditActor(caller),
        'report_template.retired',
        { type: 'report_template_version', id },
        { productId: row.productId, version: row.version, previousStatus: row.status }
      );
      if (!audited.ok) return err(audited.error);
      return ok(toView(retired, config));
    },

    async listByProduct(caller, productId) {
      if (!UUID_RE.test(productId)) return err(productNotFound(productId));

      const product = await products.findById(productId);
      if (!product) return err(productNotFound(productId));
      if (!canManage(caller, product)) return err(forbidden(caller));

      const rows = await reportTemplates.listByProduct(productId);
      const views: ReportTemplateVersionView[] = [];
      for (const row of rows) {
        const config = parseTemplateConfig(row);
        // Pre-re-scope React rows (none in production) are skipped rather
        // than crashing the listing.
        if (config.ok) views.push(toView(row, config.value));
      }
      return ok(views);
    },
  };
}
