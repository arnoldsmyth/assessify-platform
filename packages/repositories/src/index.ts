// Postgres (Drizzle) repositories. Response-store (jsonb) repositories land with A4.
import { createDb } from '@assessify/db';

import {
  createQuestionnaireVersionRepository,
  type QuestionnaireVersionRepository,
} from './postgres/questionnaire-versions';
import { DrizzleProductRepository } from './products/drizzle-product-repository';
import type { ProductRepository } from './products/product-repository';

export * from './audit-log';
export { getDbHandle } from './postgres/client';
export {
  createQuestionnaireVersionRepository,
  type QuestionnaireVersion,
  type QuestionnaireVersionRepository,
  type QuestionnaireVersionStatus,
} from './postgres/questionnaire-versions';
export {
  createRoleAssignmentRepository,
  type RoleAssignmentRepository,
} from './postgres/role-assignments';

export type {
  ProductListQuery,
  ProductPage,
  ProductPatch,
  ProductRepository,
} from './products/product-repository';
export { DrizzleProductRepository } from './products/drizzle-product-repository';

export interface Repositories {
  products: ProductRepository;
  questionnaireVersions: QuestionnaireVersionRepository;
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
    questionnaireVersions: createQuestionnaireVersionRepository(db),
    close: async () => {
      await pool.end();
    },
  };
}
