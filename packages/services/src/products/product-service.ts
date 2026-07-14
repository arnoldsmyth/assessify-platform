import {
  createProductSchema,
  err,
  isSuperAdmin,
  listProductsQuerySchema,
  ok,
  productInvariantIssues,
  updateProductSchema,
  uuidv7,
  type AuditActor,
  type CallerContext,
  type DomainError,
  type Product,
  type Result,
  type UpdateProduct,
} from '@assessify/domain';
import type { ProductPatch, ProductRepository } from '@assessify/repositories';

import type { AuditService } from '../audit';

/**
 * Product catalogue business logic (B1 — spec 04 `products`, spec 11
 * slug/branding rules). Controllers (server actions, API routes) call this;
 * they never touch repositories directly. Authorization takes the shared
 * CallerContext (spec 05); every state change records an audit event (A8).
 */

export interface ProductList {
  items: Product[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ProductService {
  create(caller: CallerContext, input: unknown): Promise<Result<Product>>;
  update(caller: CallerContext, id: string, input: unknown): Promise<Result<Product>>;
  /** Sets status to 'retired' (spec 04). Idempotent. */
  archive(caller: CallerContext, id: string): Promise<Result<Product>>;
  get(caller: CallerContext, id: string): Promise<Result<Product>>;
  list(caller: CallerContext, query: unknown): Promise<Result<ProductList>>;
}

export interface ProductServiceDeps {
  products: ProductRepository;
  audit: AuditService;
  now?: () => Date;
  generateId?: () => string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validationError(
  issues: { path: string; message: string }[],
  message = 'Product payload failed validation'
): DomainError {
  return { code: 'product/validation', message, detail: { issues } };
}

function zodIssues(
  issues: ReadonlyArray<{ path: (string | number)[]; message: string }>
): { path: string; message: string }[] {
  return issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

function notFound(id: string): DomainError {
  return { code: 'product/not_found', message: 'Product not found', detail: { id } };
}

function slugTaken(slug: string): DomainError {
  return {
    code: 'product/slug_taken',
    message: `The slug "${slug}" is already in use`,
    detail: { slug },
  };
}

function forbidden(caller: CallerContext): DomainError | null {
  // Spec 05 access matrix: product management is super_admin only.
  if (isSuperAdmin(caller)) return null;
  return {
    code: 'product/forbidden',
    message: 'Only super admins can manage products',
    detail: { kind: caller.kind, roles: caller.roles.map((r) => r.role) },
  };
}

function auditActor(caller: CallerContext): AuditActor {
  return { kind: caller.kind, id: caller.id };
}

/** Drop keys whose value is undefined so a patch never clobbers with undefined. */
function definedFields(patch: UpdateProduct): UpdateProduct {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined)
  ) as UpdateProduct;
}

export function createProductService(deps: ProductServiceDeps): ProductService {
  const { products, audit } = deps;
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? uuidv7;

  // The state change and its audit entry are not yet one transaction (needs a
  // unit-of-work across repositories). Until then a failed audit write is
  // surfaced as the operation's error — loud beats a silent audit gap.
  return {
    async create(caller, input) {
      const denied = forbidden(caller);
      if (denied) return err(denied);

      const parsed = createProductSchema.safeParse(input);
      if (!parsed.success) return err(validationError(zodIssues(parsed.error.issues)));

      // Pre-check for a friendly error; the DB unique constraint remains the
      // backstop for the create/create race (that path throws — unexpected).
      if (await products.findBySlug(parsed.data.slug)) return err(slugTaken(parsed.data.slug));

      const timestamp = now();
      const product: Product = {
        id: generateId(),
        slug: parsed.data.slug,
        name: parsed.data.name,
        status: 'active',
        branding: parsed.data.branding,
        defaultLanguage: parsed.data.defaultLanguage,
        availableLanguages: parsed.data.availableLanguages,
        externalIds: parsed.data.externalIds,
        scoringConfig: parsed.data.scoringConfig,
        notificationDefaults: parsed.data.notificationDefaults,
        reportPageSizeDefault: parsed.data.reportPageSizeDefault,
        retailEnabled: parsed.data.retailEnabled,
        retailPrice: parsed.data.retailPrice ?? null,
        retailCurrency: parsed.data.retailCurrency ?? null,
        connectedStripeAccountId: null,
        revenueSplitPct: null,
        royaltyPolicy: null,
        timezone: parsed.data.timezone,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      const created = await products.insert(product);
      const audited = await audit.record(
        auditActor(caller),
        'product.created',
        { type: 'product', id: created.id },
        { slug: created.slug }
      );
      if (!audited.ok) return err(audited.error);
      return ok(created);
    },

    async update(caller, id, input) {
      const denied = forbidden(caller);
      if (denied) return err(denied);
      if (!UUID_RE.test(id)) return err(notFound(id));

      const parsed = updateProductSchema.safeParse(input);
      if (!parsed.success) return err(validationError(zodIssues(parsed.error.issues)));
      const patch = definedFields(parsed.data);

      const existing = await products.findById(id);
      if (!existing) return err(notFound(id));

      if (patch.slug && patch.slug !== existing.slug) {
        const collision = await products.findBySlug(patch.slug);
        if (collision && collision.id !== id) return err(slugTaken(patch.slug));
      }

      // Cross-field invariants hold on the merged result, not just the patch.
      const merged = { ...existing, ...patch };
      const issues = productInvariantIssues(merged);
      if (issues.length > 0) return err(validationError(issues));

      const updated = await products.update(id, {
        ...(patch as ProductPatch),
        updatedAt: now(),
      });
      if (!updated) return err(notFound(id));
      const audited = await audit.record(
        auditActor(caller),
        'product.updated',
        { type: 'product', id },
        { changedFields: Object.keys(patch) }
      );
      if (!audited.ok) return err(audited.error);
      return ok(updated);
    },

    async archive(caller, id) {
      const denied = forbidden(caller);
      if (denied) return err(denied);
      if (!UUID_RE.test(id)) return err(notFound(id));

      const existing = await products.findById(id);
      if (!existing) return err(notFound(id));
      if (existing.status === 'retired') return ok(existing);

      const archived = await products.update(id, { status: 'retired', updatedAt: now() });
      if (!archived) return err(notFound(id));
      const audited = await audit.record(
        auditActor(caller),
        'product.archived',
        { type: 'product', id },
        {}
      );
      if (!audited.ok) return err(audited.error);
      return ok(archived);
    },

    async get(caller, id) {
      const denied = forbidden(caller);
      if (denied) return err(denied);
      if (!UUID_RE.test(id)) return err(notFound(id));

      const product = await products.findById(id);
      if (!product) return err(notFound(id));
      return ok(product);
    },

    async list(caller, query) {
      const denied = forbidden(caller);
      if (denied) return err(denied);

      const parsed = listProductsQuerySchema.safeParse(query ?? {});
      if (!parsed.success) return err(validationError(zodIssues(parsed.error.issues)));

      const { page, pageSize, status, search } = parsed.data;
      const result = await products.list({
        status,
        search,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      return ok({ items: result.items, total: result.total, page, pageSize });
    },
  };
}
