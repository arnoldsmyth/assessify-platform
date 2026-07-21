import {
  clientProductAccessSchema,
  clientScopeIds,
  createOrganizationSchema,
  err,
  hasRole,
  isSuperAdmin,
  ok,
  orgScopeIds,
  updateOrganizationSchema,
  upsertProductPriceSchema,
  uuidv7,
  type AuditActor,
  type CallerContext,
  type CallerContextOption,
  type ClientProductAccessGrant,
  type DomainError,
  type Organization,
  type Product,
  type ProductPrice,
  type Result,
} from '@assessify/domain';
import type {
  ClientProductAccessRepository,
  ClientRepository,
  ClientSummary,
  OrganizationRepository,
  ProductPriceRepository,
  ProductRepository,
} from '@assessify/repositories';
import { z } from 'zod';

import type { AuditService } from '../audit';

/**
 * Organization business logic (M1/M2 — owner decisions 2026-07-21: hierarchy
 * Platform → Organization → Client → Assessment taker).
 *
 * Authorization model:
 * - Org CRUD, and assigning products to orgs, is PLATFORM work: super_admin.
 * - Org admins (assessment_admin rows scoped by organization_id) manage the
 *   org-facing catalogue config for their org's products — the price list
 *   (per language edition) and per-client access grants — and READ their
 *   org's clients. Product CRUD itself stays super_admin (product service).
 */

export interface OrganizationService {
  create(caller: CallerContext, input: unknown): Promise<Result<Organization>>;
  update(caller: CallerContext, id: string, input: unknown): Promise<Result<Organization>>;
  /** Sets status to 'archived'. Idempotent. */
  archive(caller: CallerContext, id: string): Promise<Result<Organization>>;
  /** super_admin, or an assessment_admin of this organization. */
  get(caller: CallerContext, id: string): Promise<Result<Organization>>;
  /** All organizations, name A→Z (super_admin). */
  list(caller: CallerContext): Promise<Result<Organization[]>>;
  /** Move a product to an organization (super_admin — platform assigns products). */
  assignProductToOrg(
    caller: CallerContext,
    productId: string,
    organizationId: string
  ): Promise<Result<Product>>;
  /**
   * Create-or-overwrite one price-list row (product, language, currency) →
   * integer minor units. Org admin of the product's org, or super_admin.
   * The language must be one of the product's availableLanguages.
   */
  upsertPrice(caller: CallerContext, input: unknown): Promise<Result<ProductPrice>>;
  /** Remove one price-list row. Idempotent. Same authorization as upsertPrice. */
  removePrice(caller: CallerContext, input: unknown): Promise<Result<{ removed: boolean }>>;
  /** Price list for a product. Org admin of the product's org, or super_admin. */
  listPrices(caller: CallerContext, productId: string): Promise<Result<ProductPrice[]>>;
  /**
   * Grant a client access to a restricted product. The client must belong to
   * the product's organization. Idempotent. Org admin or super_admin.
   */
  grantClientProductAccess(
    caller: CallerContext,
    input: unknown
  ): Promise<Result<ClientProductAccessGrant>>;
  /** Revoke a grant. Idempotent. Org admin or super_admin. */
  revokeClientProductAccess(
    caller: CallerContext,
    input: unknown
  ): Promise<Result<{ revoked: boolean }>>;
  /** Grants for one product. Org admin of the product's org, or super_admin. */
  listClientProductAccess(
    caller: CallerContext,
    productId: string
  ): Promise<Result<ClientProductAccessGrant[]>>;
  /** The organization's clients, name A→Z. Org admin of the org, or super_admin. */
  listOrgClients(
    caller: CallerContext,
    organizationId: string
  ): Promise<Result<ClientSummary[]>>;
  /**
   * Every surface the caller can operate in, derived from role_assignments —
   * the data source for the admin context switcher (UI is a later issue).
   * Order: platform, then organizations A→Z, then clients A→Z.
   */
  listContexts(caller: CallerContext): Promise<Result<CallerContextOption[]>>;
}

export interface OrganizationServiceDeps {
  organizations: OrganizationRepository;
  products: ProductRepository;
  productPrices: ProductPriceRepository;
  clientProductAccess: ClientProductAccessRepository;
  clients: ClientRepository;
  audit: AuditService;
  now?: () => Date;
  generateId?: () => string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const removeProductPriceSchema = z
  .object({
    productId: z.string().uuid(),
    language: z.string().trim().min(1),
    currency: z.string().trim().regex(/^[A-Z]{3}$/),
  })
  .strict();

function validationError(
  issues: { path: string; message: string }[],
  message = 'Organization payload failed validation'
): DomainError {
  return { code: 'organization/validation', message, detail: { issues } };
}

function zodIssues(
  issues: ReadonlyArray<{ path: (string | number)[]; message: string }>
): { path: string; message: string }[] {
  return issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

function notFound(id: string): DomainError {
  return { code: 'organization/not_found', message: 'Organization not found', detail: { id } };
}

function productNotFound(productId: string): DomainError {
  return {
    code: 'organization/product_not_found',
    message: 'Product not found',
    detail: { productId },
  };
}

function clientNotFound(clientId: string): DomainError {
  return {
    code: 'organization/client_not_found',
    message: 'Client not found',
    detail: { clientId },
  };
}

function slugTaken(slug: string): DomainError {
  return {
    code: 'organization/slug_taken',
    message: `The slug "${slug}" is already in use`,
    detail: { slug },
  };
}

function forbidden(caller: CallerContext, message: string): DomainError {
  return {
    code: 'organization/forbidden',
    message,
    detail: { kind: caller.kind, roles: caller.roles.map((r) => r.role) },
  };
}

function superAdminOnly(caller: CallerContext): DomainError | null {
  if (isSuperAdmin(caller)) return null;
  return forbidden(caller, 'Only super admins can manage organizations');
}

/** Org admin (assessment_admin of the org) or super_admin. */
function canManageOrg(caller: CallerContext, organizationId: string): boolean {
  if (isSuperAdmin(caller)) return true;
  return caller.kind === 'user' && orgScopeIds(caller).includes(organizationId);
}

function auditActor(caller: CallerContext): AuditActor {
  return { kind: caller.kind, id: caller.id };
}

export function createOrganizationService(deps: OrganizationServiceDeps): OrganizationService {
  const { organizations, products, productPrices, clientProductAccess, clients, audit } = deps;
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? uuidv7;

  /** Load a product and check the caller may manage its org's catalogue config. */
  async function resolveManagedProduct(
    caller: CallerContext,
    productId: string
  ): Promise<Result<Product>> {
    if (!UUID_RE.test(productId)) return err(productNotFound(productId));
    const product = await products.findById(productId);
    if (!product) return err(productNotFound(productId));
    if (!canManageOrg(caller, product.organizationId)) {
      return err(
        forbidden(
          caller,
          'Only super admins or the organization’s admins can manage this product’s pricing and access'
        )
      );
    }
    return ok(product);
  }

  // As in product-service: the state change and its audit entry are not yet
  // one transaction; a failed audit write surfaces as the operation's error.
  return {
    async create(caller, input) {
      const denied = superAdminOnly(caller);
      if (denied) return err(denied);

      const parsed = createOrganizationSchema.safeParse(input);
      if (!parsed.success) return err(validationError(zodIssues(parsed.error.issues)));

      // Friendly pre-check; the unique constraint backstops the race.
      if (await organizations.findBySlug(parsed.data.slug)) {
        return err(slugTaken(parsed.data.slug));
      }

      const timestamp = now();
      const organization: Organization = {
        id: generateId(),
        name: parsed.data.name,
        slug: parsed.data.slug,
        status: 'active',
        connectedStripeAccountId: null,
        settlementEmail: parsed.data.settlementEmail ?? null,
        settlementCurrency: parsed.data.settlementCurrency,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const created = await organizations.insert(organization);
      const audited = await audit.record(
        auditActor(caller),
        'organization.created',
        { type: 'organization', id: created.id },
        { slug: created.slug }
      );
      if (!audited.ok) return err(audited.error);
      return ok(created);
    },

    async update(caller, id, input) {
      const denied = superAdminOnly(caller);
      if (denied) return err(denied);
      if (!UUID_RE.test(id)) return err(notFound(id));

      const parsed = updateOrganizationSchema.safeParse(input);
      if (!parsed.success) return err(validationError(zodIssues(parsed.error.issues)));
      const patch = Object.fromEntries(
        Object.entries(parsed.data).filter(([, value]) => value !== undefined)
      ) as typeof parsed.data;

      const existing = await organizations.findById(id);
      if (!existing) return err(notFound(id));

      if (patch.slug && patch.slug !== existing.slug) {
        const collision = await organizations.findBySlug(patch.slug);
        if (collision && collision.id !== id) return err(slugTaken(patch.slug));
      }

      const updated = await organizations.update(id, { ...patch, updatedAt: now() });
      if (!updated) return err(notFound(id));
      const audited = await audit.record(
        auditActor(caller),
        'organization.updated',
        { type: 'organization', id },
        { changedFields: Object.keys(patch) }
      );
      if (!audited.ok) return err(audited.error);
      return ok(updated);
    },

    async archive(caller, id) {
      const denied = superAdminOnly(caller);
      if (denied) return err(denied);
      if (!UUID_RE.test(id)) return err(notFound(id));

      const existing = await organizations.findById(id);
      if (!existing) return err(notFound(id));
      if (existing.status === 'archived') return ok(existing);

      const archived = await organizations.update(id, { status: 'archived', updatedAt: now() });
      if (!archived) return err(notFound(id));
      const audited = await audit.record(
        auditActor(caller),
        'organization.archived',
        { type: 'organization', id },
        {}
      );
      if (!audited.ok) return err(audited.error);
      return ok(archived);
    },

    async get(caller, id) {
      if (!UUID_RE.test(id)) return err(notFound(id));
      if (!canManageOrg(caller, id)) {
        return err(
          forbidden(caller, 'Only super admins or the organization’s admins can view it')
        );
      }
      const organization = await organizations.findById(id);
      if (!organization) return err(notFound(id));
      return ok(organization);
    },

    async list(caller) {
      const denied = superAdminOnly(caller);
      if (denied) return err(denied);
      return ok(await organizations.listAll());
    },

    async assignProductToOrg(caller, productId, organizationId) {
      const denied = superAdminOnly(caller);
      if (denied) return err(denied);
      if (!UUID_RE.test(productId)) return err(productNotFound(productId));
      if (!UUID_RE.test(organizationId)) return err(notFound(organizationId));

      const product = await products.findById(productId);
      if (!product) return err(productNotFound(productId));
      const organization = await organizations.findById(organizationId);
      if (!organization) return err(notFound(organizationId));
      if (product.organizationId === organizationId) return ok(product);

      const updated = await products.update(productId, {
        organizationId,
        updatedAt: now(),
      });
      if (!updated) return err(productNotFound(productId));
      const audited = await audit.record(
        auditActor(caller),
        'product.assigned_to_organization',
        { type: 'product', id: productId },
        { fromOrganizationId: product.organizationId, toOrganizationId: organizationId }
      );
      if (!audited.ok) return err(audited.error);
      return ok(updated);
    },

    async upsertPrice(caller, input) {
      const parsed = upsertProductPriceSchema.safeParse(input);
      if (!parsed.success) {
        return err(
          validationError(zodIssues(parsed.error.issues), 'Price payload failed validation')
        );
      }
      const { productId, language, currency, unitPrice } = parsed.data;

      const productResult = await resolveManagedProduct(caller, productId);
      if (!productResult.ok) return productResult;
      const product = productResult.value;

      // Prices are per language EDITION — the language must be declared on
      // the product first (products.available_languages), mirroring the
      // translation import rule.
      if (!product.availableLanguages.includes(language)) {
        return err({
          code: 'organization/language_not_available',
          message: `Language '${language}' is not in the product's available languages`,
          detail: { language, availableLanguages: product.availableLanguages },
        });
      }

      const price = await productPrices.upsert({
        id: generateId(),
        productId,
        language,
        currency,
        unitPrice,
        timestamp: now(),
      });
      const audited = await audit.record(
        auditActor(caller),
        'product_price.upserted',
        { type: 'product', id: productId },
        { language, currency, unitPrice }
      );
      if (!audited.ok) return err(audited.error);
      return ok(price);
    },

    async removePrice(caller, input) {
      const parsed = removeProductPriceSchema.safeParse(input);
      if (!parsed.success) {
        return err(
          validationError(zodIssues(parsed.error.issues), 'Price payload failed validation')
        );
      }
      const { productId, language, currency } = parsed.data;

      const productResult = await resolveManagedProduct(caller, productId);
      if (!productResult.ok) return productResult;

      const removed = await productPrices.delete(productId, language, currency);
      if (removed) {
        const audited = await audit.record(
          auditActor(caller),
          'product_price.removed',
          { type: 'product', id: productId },
          { language, currency }
        );
        if (!audited.ok) return err(audited.error);
      }
      return ok({ removed });
    },

    async listPrices(caller, productId) {
      const productResult = await resolveManagedProduct(caller, productId);
      if (!productResult.ok) return productResult;
      return ok(await productPrices.listByProduct(productId));
    },

    async grantClientProductAccess(caller, input) {
      const parsed = clientProductAccessSchema.safeParse(input);
      if (!parsed.success) {
        return err(
          validationError(zodIssues(parsed.error.issues), 'Access payload failed validation')
        );
      }
      const { clientId, productId } = parsed.data;

      const productResult = await resolveManagedProduct(caller, productId);
      if (!productResult.ok) return productResult;
      const product = productResult.value;

      const [client] = await clients.findByIds([clientId]);
      if (!client) return err(clientNotFound(clientId));
      // Grants never cross organizations: the client must belong to the
      // product's org (owner decision 2026-07-21 — per-org client rows).
      if (client.organizationId !== product.organizationId) {
        return err({
          code: 'organization/client_outside_organization',
          message: 'The client does not belong to the product’s organization',
          detail: { clientId, productId, organizationId: product.organizationId },
        });
      }

      const grant = await clientProductAccess.grant(clientId, productId, now());
      const audited = await audit.record(
        auditActor(caller),
        'client_product_access.granted',
        { type: 'product', id: productId },
        { clientId }
      );
      if (!audited.ok) return err(audited.error);
      return ok(grant);
    },

    async revokeClientProductAccess(caller, input) {
      const parsed = clientProductAccessSchema.safeParse(input);
      if (!parsed.success) {
        return err(
          validationError(zodIssues(parsed.error.issues), 'Access payload failed validation')
        );
      }
      const { clientId, productId } = parsed.data;

      const productResult = await resolveManagedProduct(caller, productId);
      if (!productResult.ok) return productResult;

      const revoked = await clientProductAccess.revoke(clientId, productId);
      if (revoked) {
        const audited = await audit.record(
          auditActor(caller),
          'client_product_access.revoked',
          { type: 'product', id: productId },
          { clientId }
        );
        if (!audited.ok) return err(audited.error);
      }
      return ok({ revoked });
    },

    async listClientProductAccess(caller, productId) {
      const productResult = await resolveManagedProduct(caller, productId);
      if (!productResult.ok) return productResult;
      return ok(await clientProductAccess.listByProduct(productId));
    },

    async listOrgClients(caller, organizationId) {
      if (!UUID_RE.test(organizationId)) return err(notFound(organizationId));
      if (!canManageOrg(caller, organizationId)) {
        return err(
          forbidden(caller, 'Only super admins or the organization’s admins can view its clients')
        );
      }
      const organization = await organizations.findById(organizationId);
      if (!organization) return err(notFound(organizationId));
      return ok(await clients.listByOrganizationIds([organizationId]));
    },

    async listContexts(caller) {
      if (caller.kind !== 'user') return ok([]);

      const options: CallerContextOption[] = [];
      if (hasRole(caller, 'super_admin')) options.push({ kind: 'platform' });

      const orgs = await organizations.findByIds(orgScopeIds(caller));
      for (const org of orgs) {
        options.push({ kind: 'organization', id: org.id, name: org.name });
      }

      const clientRows = await clients.findByIds(clientScopeIds(caller));
      for (const client of clientRows) {
        options.push({
          kind: 'client',
          id: client.id,
          name: client.name,
          organizationId: client.organizationId,
        });
      }

      return ok(options);
    },
  };
}
