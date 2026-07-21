/**
 * One-off local/dev bootstrap: create the first super_admin.
 *
 * There is no self-serve signup route by design (spec 05 — staff/client
 * accounts are provisioned, not registered). This script exists only because
 * a fresh database has no users at all; run it once, then manage roles
 * through the admin UI / role_assignments directly.
 *
 * Usage: pnpm --filter @assessify/web exec tsx scripts/bootstrap-admin.ts \
 *          you@example.com "a strong password" "Your Name"
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { getAuth } from '../lib/auth';
import { getServerEnv } from '../lib/env';

async function main() {
  const [email, password, name = 'Admin'] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: tsx scripts/bootstrap-admin.ts <email> <password> [name]');
    process.exit(1);
  }

  const env = getServerEnv();
  const auth = getAuth();

  const result = await auth.api.signUpEmail({ body: { email, password, name } });
  const userId = result.user.id;

  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    await pool.query(
      `insert into role_assignments (id, user_id, role, permissions)
       values ($1, $2, 'super_admin', '{}'::jsonb)
       on conflict do nothing`,
      [randomUUID(), userId]
    );
  } finally {
    await pool.end();
  }

  console.log(`Created super_admin ${email} (user id ${userId}). Sign in at /login.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
