import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Static UI contracts only: intentionally no PostgreSQL global setup or
 * mutation, so the shell can be checked on a machine with no database.
 */
export default defineConfig({
  resolve: { alias: { '@': resolve(process.cwd(), './src') } },
  test: {
    environment: 'node',
    include: [
      'tests/work-indicator-contract.test.ts',
      'tests/shell-navigation-contract.test.ts',
      'tests/related-screens-access.test.ts',
      'tests/role-capability-select.test.ts',
    ],
    globalSetup: [],
    fileParallelism: false,
    testTimeout: 5_000,
  },
});
