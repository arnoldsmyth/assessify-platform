/**
 * Dev-only demo seed: one organization + one orderable product (with an
 * active questionnaire, a price, sync-internal scoring) + one client under
 * that org, so the admin order flow can be exercised end to end before the
 * real Clients/Org CRUD UI lands.
 *
 * Idempotent-ish: re-running creates fresh rows with unique slugs/numbers.
 * Not for production — throwaway local data.
 *
 * Usage (inside the web container, DATABASE_URL set):
 *   pnpm --filter @assessify/web exec tsx scripts/seed-demo.ts <super-admin-user-id>
 */
import { randomUUID } from 'node:crypto';

import type { CallerContext } from '@assessify/domain';
import {
  getOrganizationService,
  getProductService,
  getQuestionnaireVersionService,
} from '@assessify/services';
import { Pool } from 'pg';

import { getServerEnv } from '../lib/env';

// A minimal, schema-valid questionnaire (one likert question, keyed q1).
const DEFINITION = {
  schemaVersion: 1,
  key: 'demo',
  titleKey: 'demo.title',
  settings: { progressBar: true, allowBack: true },
  sections: [
    {
      key: 'only',
      questions: [
        {
          key: 'q1',
          type: 'likert',
          textKey: 'demo.q1.text',
          scale: {
            min: 1,
            max: 5,
            labelKeys: { '1': 'demo.low', '5': 'demo.high' },
            presentation: 'slider',
          },
        },
      ],
    },
  ],
};

function unwrap<T>(label: string, result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) {
    throw new Error(`${label} failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

async function main() {
  const userId = process.argv[2];
  if (!userId) {
    console.error('Usage: tsx scripts/seed-demo.ts <super-admin-user-id>');
    process.exit(1);
  }

  // NOTE: questionnaire_versions.created_by is a uuid column, but Better Auth
  // user ids are text — so passing the real admin id there fails (see bd bug).
  // authz uses roles, not the id, and created_by has no FK, so we use a uuid
  // here purely to satisfy the column type. `userId` is kept for reference.
  void userId;
  const caller: CallerContext = {
    kind: 'user',
    id: randomUUID(),
    roles: [
      {
        role: 'super_admin',
        organizationId: null,
        productId: null,
        clientId: null,
        permissions: {
          products: 'all',
          groups: 'all',
          canPlaceOrders: true,
          canViewResults: true,
          canReleaseReports: true,
        },
      },
    ],
  };

  const suffix = Date.now().toString(36);

  // 1. Organization
  const org = unwrap(
    'organization.create',
    await getOrganizationService().create(caller, {
      name: `Demo Org ${suffix}`,
      slug: `demo-org-${suffix}`,
    })
  );
  console.log(`org:        ${org.id} (${org.name})`);

  // 2. Product with an internal scale-sum scoring definition over q1
  const product = unwrap(
    'product.create',
    await getProductService().create(caller, {
      organizationId: org.id,
      slug: `demo-product-${suffix}`,
      name: `Demo Product ${suffix}`,
      scoringConfig: {
        mode: 'sync_internal',
        definition: { dimensions: [{ key: 'overall', questionKeys: ['q1'] }] },
      },
    })
  );
  console.log(`product:    ${product.id} (${product.name})`);

  // 3. Import + activate the questionnaire
  const version = unwrap(
    'questionnaire.import',
    await getQuestionnaireVersionService().importDefinition(caller, {
      productId: product.id,
      variant: 'self',
      definition: DEFINITION,
    })
  );
  unwrap('questionnaire.activate', await getQuestionnaireVersionService().activate(caller, version.id));
  console.log(`version:    ${version.id} (v${version.version}, active)`);

  // 4. Price: en / EUR / €150.00
  unwrap(
    'organization.upsertPrice',
    await getOrganizationService().upsertPrice(caller, {
      productId: product.id,
      language: 'en',
      currency: 'EUR',
      unitPrice: 15000,
    })
  );
  console.log('price:      en / EUR / 15000 minor units');

  // 5. Client (no create-service yet — direct insert). default_access on the
  //    product means the client can order it without an explicit grant.
  const env = getServerEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const clientId = randomUUID();
  try {
    const { rows } = await pool.query<{ client_number: number }>(
      'select coalesce(max(client_number), 0) + 1 as client_number from clients'
    );
    const clientNumber = rows[0]?.client_number ?? 1;
    await pool.query(
      `insert into clients (id, client_number, name, organization_id, default_currency, timezone, source)
       values ($1, $2, $3, $4, 'EUR', 'Europe/Dublin', 'native')`,
      [clientId, clientNumber, `Demo Client ${suffix}`, org.id]
    );
    console.log(`client:     ${clientId} (Demo Client ${suffix}, CLI-${clientNumber})`);
  } finally {
    await pool.end();
  }

  console.log('\nSeed complete. Go to /admin/orders/new, pick the demo client, then the demo product.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
