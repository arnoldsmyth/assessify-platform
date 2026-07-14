import {
  createProductSchema,
  err,
  listProductsQuerySchema,
  ok,
  productInvariantIssues,
  updateProductSchema,
  uuidv7,
  type DomainError,
  type Product,
  type Result,
  type UpdateProduct,
} from '@assessify/domain';
import type { ProductPatch, ProductRepository } from '@assessify/repositories';

/**
 * Product catalogue business logic (B1 — spec 04 `products`, spec 11
 * slug/branding rules). Controllers (server actions, API routes) call this;
 * they never touch repositories directly.
 */

/**
 * Minimal caller identity — the authorization seam.
 *
 * TODO(A3): replace with the shared CallerContext once auth (Better Auth)
 * lands; the coordinator wires this at merge. Until then controllers pass a
 * stub super_admin actor.
 */
export interface Actor {
  readonly userId: string;
  /** role_name enum (spec 04/05). */
  readonly role:
    | 'super_admin'
    | 'assessment_admin'
    | 'client_admin'
    | 'client_user'
    | 'assessment_taker';
}

export interface ProductList {
  items: Product[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ProductService {
  create(actor: Actor, input: unknown): Promise<Result<Product>>;
  update(actor: Actor, id: string, input: unknown): Promise<Result<Product>>;
  /** Sets status to 'retired' (spec 04). Idempotent. */
  archive(actor: Actor, id: string): Promise<Result<Product>>;
  get(actor: Actor, id: string): Promise<Result<Product>>;
  list(actor: Actor, query: unknown): Promise<Result<ProductList>>;
}

export interface ProductServiceDeps {
  products: ProductRepository;
  now?: () => Date;
  generateId?: () => string;
  // TODO(A8): accept an auditService once it exists and record
  // product.created / product.updated / product.archived events.
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

function forbidden(actor: Actor): DomainError | null {
  // Spec 05 access matrix: product management is super_admin only.
  if (actor.role === 'super_admin') return null;
  return {
    code: 'product/forbidden',
    message: 'Only super admins can manage products',
    detail: { role: actor.role },
  };
}

/** Drop keys whose value is undefined so a patch never clobbers with undefined. */
function definedFields(patch: UpdateProduct): UpdateProduct {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined)
  ) as UpdateProduct;
}

export function createProductService(deps: ProductServiceDeps): ProductService {
  const { products } = deps;
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? uuidv7;

  return {
    async create(actor, input) {
      const denied = forbidden(actor);
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
      // TODO(A8): audit — record product.created (actor.userId, product.id).
      return ok(created);
    },

    async update(actor, id, input) {
      const denied = forbidden(actor);
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
      // TODO(A8): audit — record product.updated (actor.userId, changed keys).
      return ok(updated);
    },

    async archive(actor, id) {
      const denied = forbidden(actor);
      if (denied) return err(denied);
      if (!UUID_RE.test(id)) return err(notFound(id));

      const existing = await products.findById(id);
      if (!existing) return err(notFound(id));
      if (existing.status === 'retired') return ok(existing);

      const archived = await products.update(id, { status: 'retired', updatedAt: now() });
      if (!archived) return err(notFound(id));
      // TODO(A8): audit — record product.archived (actor.userId, product.id).
      return ok(archived);
    },

    async get(actor, id) {
      const denied = forbidden(actor);
      if (denied) return err(denied);
      if (!UUID_RE.test(id)) return err(notFound(id));

      const product = await products.findById(id);
      if (!product) return err(notFound(id));
      return ok(product);
    },

    async list(actor, query) {
      const denied = forbidden(actor);
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
