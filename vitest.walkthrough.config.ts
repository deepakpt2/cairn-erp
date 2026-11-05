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
