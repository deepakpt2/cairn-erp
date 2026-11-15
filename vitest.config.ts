// Loads .env.test and refuses any database other than erp_test — tests never touch erp_dev.
import './tests/test-env';
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@': resolve(process.cwd(), './src') },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    // Database tests share one cluster. Running files serially keeps tenant-scoped
    // assertions honest rather than accidentally passing through contention.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
