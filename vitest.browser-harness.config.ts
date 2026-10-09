/** Pure CLI/fixture/credential tests: intentionally no database setup or cleanup. */
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/browser-targets.test.ts', 'tests/db-credentials.test.ts'],
    globalSetup: [],
    fileParallelism: false,
    testTimeout: 5_000,
  },
});
