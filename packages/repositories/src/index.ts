// Postgres (Drizzle) repositories. Firestore repositories land with A4.
import { createDb } from '@assessify/db';

import { DrizzleProductRepository } from './products/drizzle-product-repository';
import type { ProductRepository } from './products/product-repository';

export type {
  ProductListQuery,
  ProductPage,
  ProductPatch,
  ProductRepository,
} from './products/product-repository';
export { DrizzleProductRepository } from './products/drizzle-product-repository';

export interface Repositories {
  products: ProductRepository;
  /** Drain the underlying pg pool (worker/app shutdown). */
  close(): Promise<void>;
}

/**
 * Composition helper: build the full Drizzle repository set from a Postgres
 * connection string. Called from composition roots (via the service layer's
 * default wiring) — apps never import repositories or db directly
 * (.dependency-cruiser.cjs).
 */
export function createRepositories(connectionString: string): Repositories {
  const { db, pool } = createDb(connectionString);
  return {
    products: new DrizzleProductRepository(db),
    close: async () => {
      await pool.end();
    },
  };
}
