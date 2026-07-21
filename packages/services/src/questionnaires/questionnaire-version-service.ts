import {
  err,
  isSuperAdmin,
  ok,
  orgScopeIds,
  uuidv7,
  type AuditActor,
  type CallerContext,
  type DomainError,
  type Product,
  type Result,
} from '@assessify/domain';
import { validateDefinition } from '@assessify/questionnaire-schema';
import type {
  ProductRepository,
  QuestionnaireVersion,
  QuestionnaireVersionRepository,
} from '@assessify/repositories';
import { z } from 'zod';

import type { AuditService } from '../audit';
import { canBrowseOrderCatalogue } from '../products/product-service';

/**
 * Questionnaire version lifecycle (B3 — spec 07 "Versioning rules", spec 04
 * `questionnaire_versions`). Import validates the JSON definition through
 * @assessify/questionnaire-schema and stores it as a `draft` with the next
 * version number for the product; activation enforces the spec-07 rule that
 * at most one version is `active` per product+variant (definitions are
 * language-agnostic — all copy is translation string keys). Versions are
 * immutable once active; a superseded active version becomes `retired`.
 *
 * Authorization (spec 05 permission matrix, "Manage questionnaire versions",
 * re-scoped per owner decisions 2026-07-21): super_admin, or assessment_admin
 * scoped to the product's ORGANIZATION — "may manage this product" resolves
 * through `product.organizationId`.
 */

export interface QuestionnaireVersionService {
  /**
   * Validate + store an uploaded definition as a new draft version.
   * Version number = max(version) for the product + 1 (all variants share the
   * numbering sequence per spec 07).
   */
  importDefinition(
    caller: CallerContext,
    input: unknown
  ): Promise<Result<QuestionnaireVersion>>;
  /**
   * Make a draft version the active one for its product+variant; the
   * previously active version (if any) is retired. Idempotent for an
   * already-active version. Retired versions cannot be reactivated
   * (immutable once active — re-import instead).
   */
  activate(caller: CallerContext, id: string): Promise<Result<QuestionnaireVersion>>;
  /** Retire a draft or active version without activating a replacement. Idempotent. */
  retire(caller: CallerContext, id: string): Promise<Result<QuestionnaireVersion>>;
  /** All versions of a product, newest first. */
  listByProduct(
    caller: CallerContext,
    productId: string
  ): Promise<Result<QuestionnaireVersion[]>>;
  /**
   * Active versions of a product as a slim projection for the order wizard
   * (spec 06 step 1: "choose product → active questionnaire version"; orders
   * pin the version at creation). Unlike the management methods, this is
   * available to order placers (spec 05: super_admin, client_admin,
   * client_user with canPlaceOrders) and to the product's managers.
   */
  listActiveForOrdering(
    caller: CallerContext,
    productId: string
  ): Promise<Result<ActiveQuestionnaireVersion[]>>;
}

/** Slim, definition-free projection for order placement UIs. */
export interface ActiveQuestionnaireVersion {
  id: string;
  version: number;
  /** 'self' or a rater variant key — named/bulk_named orders use 'self'. */
  variant: string;
}

export interface QuestionnaireVersionServiceDeps {
  questionnaireVersions: QuestionnaireVersionRepository;
  products: ProductRepository;
  audit: AuditService;
  now?: () => Date;
  generateId?: () => string;
}

export const importQuestionnaireVersionSchema = z.object({
  productId: z.string().uuid(),
  /** 'self' or a rater variant key like 'manager' (spec 04/07). */
  variant: z
    .string()
    .regex(
      /^[a-z][a-z0-9_-]*$/,
      'variant must be lowercase letters, digits, hyphens or underscores'
    )
    .max(50)
    .default('self'),
  /** Parsed JSON of the uploaded definition — validated against spec 07. */
  definition: z.unknown(),
});
export type ImportQuestionnaireVersionInput = z.infer<typeof importQuestionnaireVersionSchema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function forbidden(caller: CallerContext): DomainError {
  return {
    code: 'questionnaire_version/forbidden',
    message: 'Only super admins or the product’s assessment admins can manage questionnaire versions',
    detail: { kind: caller.kind, roles: caller.roles.map((r) => r.role) },
  };
}

/**
 * Spec 05 re-scoped (M2): manage questionnaire versions = super_admin, or
 * assessment_admin of the product's organization.
 */
function canManage(caller: CallerContext, product: Product): boolean {
  if (isSuperAdmin(caller)) return true;
  return caller.kind === 'user' && orgScopeIds(caller).includes(product.organizationId);
}

function notFound(id: string): DomainError {
  return {
    code: 'questionnaire_version/not_found',
    message: 'Questionnaire version not found',
    detail: { id },
  };
}

function productNotFound(productId: string): DomainError {
  return {
    code: 'questionnaire_version/product_not_found',
    message: 'Product not found',
    detail: { productId },
  };
}

function validationError(issues: { path: string; message: string }[]): DomainError {
  return {
    code: 'questionnaire_version/validation',
    message: 'Questionnaire import payload failed validation',
    detail: { issues },
  };
}

function auditActor(caller: CallerContext): AuditActor {
  return { kind: caller.kind, id: caller.id };
}

export function createQuestionnaireVersionService(
  deps: QuestionnaireVersionServiceDeps
): QuestionnaireVersionService {
  const { questionnaireVersions, products, audit } = deps;
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? uuidv7;

  // As in product-service: the state change and its audit entry are not yet
  // one transaction; a failed audit write surfaces as the operation's error.
  return {
    async importDefinition(caller, input) {
      const parsed = importQuestionnaireVersionSchema.safeParse(input);
      if (!parsed.success) {
        return err(
          validationError(
            parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            }))
          )
        );
      }
      const { productId, variant } = parsed.data;

      const product = await products.findById(productId);
      if (!product) return err(productNotFound(productId));
      if (!canManage(caller, product)) return err(forbidden(caller));

      // Shape + semantic rules (spec 07) — line-item issues go back to the UI.
      const validated = validateDefinition(parsed.data.definition);
      if (!validated.ok) return err(validated.error);

      // Race on concurrent imports is backstopped by the DB unique constraint
      // on (product_id, version, variant) — that path throws (unexpected).
      const version = (await questionnaireVersions.maxVersion(productId)) + 1;
      const created = await questionnaireVersions.insert({
        id: generateId(),
        productId,
        version,
        variant,
        definition: validated.value,
        status: 'draft',
        createdBy: caller.kind === 'user' ? caller.id : null,
        createdAt: now(),
      });

      const audited = await audit.record(
        auditActor(caller),
        'questionnaire_version.imported',
        { type: 'questionnaire_version', id: created.id },
        {
          productId,
          version: created.version,
          variant: created.variant,
          definitionKey: created.definition.key,
        }
      );
      if (!audited.ok) return err(audited.error);
      return ok(created);
    },

    async activate(caller, id) {
      if (!UUID_RE.test(id)) return err(notFound(id));
      const existing = await questionnaireVersions.findById(id);
      if (!existing) return err(notFound(id));
      const product = await products.findById(existing.productId);
      if (!product) return err(productNotFound(existing.productId));
      if (!canManage(caller, product)) return err(forbidden(caller));

      if (existing.status === 'active') return ok(existing);
      if (existing.status === 'retired') {
        return err({
          code: 'questionnaire_version/invalid_state',
          message:
            'Retired versions cannot be reactivated — versions are immutable once active; import a new version instead',
          detail: { id, status: existing.status },
        });
      }

      // Spec 07: at most one active version per product+variant — retire the
      // incumbent before activating the draft.
      const incumbent = await questionnaireVersions.findActive(
        existing.productId,
        existing.variant
      );
      if (incumbent && incumbent.id !== id) {
        const superseded = await questionnaireVersions.updateStatus(incumbent.id, 'retired');
        if (!superseded) return err(notFound(incumbent.id));
      }

      const activated = await questionnaireVersions.updateStatus(id, 'active');
      if (!activated) return err(notFound(id));

      const audited = await audit.record(
        auditActor(caller),
        'questionnaire_version.activated',
        { type: 'questionnaire_version', id },
        {
          productId: existing.productId,
          version: existing.version,
          variant: existing.variant,
          supersededVersionId: incumbent?.id ?? null,
        }
      );
      if (!audited.ok) return err(audited.error);
      return ok(activated);
    },

    async retire(caller, id) {
      if (!UUID_RE.test(id)) return err(notFound(id));
      const existing = await questionnaireVersions.findById(id);
      if (!existing) return err(notFound(id));
      const product = await products.findById(existing.productId);
      if (!product) return err(productNotFound(existing.productId));
      if (!canManage(caller, product)) return err(forbidden(caller));

      if (existing.status === 'retired') return ok(existing);

      const retired = await questionnaireVersions.updateStatus(id, 'retired');
      if (!retired) return err(notFound(id));

      const audited = await audit.record(
        auditActor(caller),
        'questionnaire_version.retired',
        { type: 'questionnaire_version', id },
        {
          productId: existing.productId,
          version: existing.version,
          variant: existing.variant,
          previousStatus: existing.status,
        }
      );
      if (!audited.ok) return err(audited.error);
      return ok(retired);
    },

    async listByProduct(caller, productId) {
      if (!UUID_RE.test(productId)) return err(productNotFound(productId));

      const product = await products.findById(productId);
      if (!product) return err(productNotFound(productId));
      if (!canManage(caller, product)) return err(forbidden(caller));

      return ok(await questionnaireVersions.listByProduct(productId));
    },

    async listActiveForOrdering(caller, productId) {
      if (!UUID_RE.test(productId)) return err(productNotFound(productId));

      const product = await products.findById(productId);
      if (!product) return err(productNotFound(productId));
      if (!canBrowseOrderCatalogue(caller) && !canManage(caller, product)) {
        return err(forbidden(caller));
      }

      const versions = await questionnaireVersions.listByProduct(productId);
      return ok(
        versions
          .filter((version) => version.status === 'active')
          .map(
            (version): ActiveQuestionnaireVersion => ({
              id: version.id,
              version: version.version,
              variant: version.variant,
            })
          )
      );
    },
  };
}
