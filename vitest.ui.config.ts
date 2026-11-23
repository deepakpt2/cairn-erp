// DOM environment for component tests only (jsdom). Kept separate from the DB-backed config so the two do not
// interfere: these tests render real components with a mocked endpoint and never touch PostgreSQL.
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': resolve(process.cwd(), './src') } },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.ui.test.tsx'],
    globalSetup: [],
    fileParallelism: false,
    testTimeout: 20_000,
    setupFiles: ['./tests/ui-setup.ts'],
  },
});
