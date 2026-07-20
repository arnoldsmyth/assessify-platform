import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Unit tests for controller-layer helpers that are deliberately pure (tenant
// routing policy, tenant header codec, branding CSS builder) — no Next.js
// runtime involved.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    include: ['lib/**/*.test.ts'],
  },
});
