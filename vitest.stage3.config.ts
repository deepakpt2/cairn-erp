import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/** Focused lock/assignment/seed-prerequisite contracts; no database setup or mutation. */
export default defineConfig({
  resolve: { alias: { '@': resolve(process.cwd(), './src') } },
  test: {
    environment: 'node',
    include: [
      'tests/change-lock-claim-lifecycle.test.ts',
      'tests/walkthrough-credit-preflight.test.ts',
      'tests/purchasing-org-company-code-assignment-contract.test.ts',
      'tests/purchasing-org-company-code-assignment-ui-contract.test.ts',
      'tests/walkthrough-seed-contract.test.ts',
      'tests/credit-control-area-capability.test.ts',
      'tests/credit-control-area-maintenance-contract.test.ts',
      'tests/credit-control-area-validation.test.ts',
    ],
    globalSetup: [],
    fileParallelism: false,
    testTimeout: 10_000,
  },
});
