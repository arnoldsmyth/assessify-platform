import { createRepositories } from '@assessify/repositories';

import { createProductService, type ProductService } from './product-service';

// Module compiles with lib ES2022 (no @types/node in this package); declare
// the bits of `process` the default wiring needs.
declare const process: { env: Record<string, string | undefined> };

let instance: ProductService | undefined;

/**
 * Default composition-root wiring: Drizzle repositories over DATABASE_URL.
 * Lives in the service layer because apps must not import repositories or db
 * (.dependency-cruiser.cjs). Lazy so importing @assessify/services never
 * opens a connection at module load (or during `next build`).
 */
export function getProductService(): ProductService {
  if (!instance) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set — required for the default product service wiring');
    }
    instance = createProductService({ products: createRepositories(connectionString).products });
  }
  return instance;
}
