import type { Product, ProductStatus } from '@assessify/domain';

/**
 * Product data-access port. Services depend on this interface; the Drizzle
 * implementation is wired at the composition root. Repositories map rows to
 * domain entities and contain no business rules
 * (docs/spec/appendix-architecture-layers.md §2).
 */

export interface ProductListQuery {
  status?: ProductStatus;
  /** Case-insensitive substring match on name or slug. */
  search?: string;
  limit: number;
  offset: number;
}

export interface ProductPage {
  items: Product[];
  total: number;
}

/** Fields updatable after creation; `updatedAt` is set by the service. */
export type ProductPatch = Partial<Omit<Product, 'id' | 'createdAt'>>;

export interface ProductRepository {
  findById(id: string): Promise<Product | null>;
  findBySlug(slug: string): Promise<Product | null>;
  insert(product: Product): Promise<Product>;
  /** Returns the updated product, or null if no row matched. */
  update(id: string, patch: ProductPatch): Promise<Product | null>;
  list(query: ProductListQuery): Promise<ProductPage>;
}
