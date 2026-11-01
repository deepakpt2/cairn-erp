import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/** Focused, fixture-managed Stage 3 DB tests; intentionally no purge or global setup. */
export default defineConfig({
  resolve: { alias: { '@': resolve(process.cwd(), './src') } },
  test: {
    environment: 'node',
    include: [
      'tests/credit-control-area-maintenance.test.ts',
      'tests/credit-control-area-atomicity.test.ts',
    ],
    globalSetup: [],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
