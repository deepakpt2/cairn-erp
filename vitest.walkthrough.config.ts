// Loads .env.test and refuses any database other than erp_test — tests never touch erp_dev.
import './tests/test-env';
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/** Static contracts only: intentionally no PostgreSQL global setup or mutation. */
export default defineConfig({
  resolve: { alias: { '@': resolve(process.cwd(), './src') } },
  test: {
    environment: 'node',
    include: ['tests/docker-provisioning-contract.test.ts', 'tests/walkthrough-seed-contract.test.ts', 'tests/walkthrough-provisioning-contract.test.ts'],
    globalSetup: [],
    fileParallelism: false,
    testTimeout: 5_000,
  },
});
