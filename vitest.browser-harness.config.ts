/** Pure CLI/fixture/credential tests: intentionally no database setup or cleanup. */
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({
  resolve: { alias: { '@': resolve(process.cwd(), './src') } },
  test: {
    environment: 'node',
    include: ['tests/browser-targets.test.ts', 'tests/db-credentials.test.ts', 'tests/tenant-provisioning.test.ts', 'tests/onboarding-admission.test.ts'],
    globalSetup: [],
    fileParallelism: false,
    testTimeout: 5_000,
  },
});
