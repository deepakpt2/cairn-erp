import type { Config } from 'drizzle-kit';

/**
 * Drizzle configuration.
 *
 * Schema root is src/platform/schema.ts, which re-exports every module's schema
 * (see CAIRN.md §20.1 and §20.3 — a module contributes its tables by exporting them here).
 */
export default {
  schema: './src/platform/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://cairn:cairn_dev@127.0.0.1:5432/cairn',
  },
  verbose: true,
  strict: true,
} satisfies Config;
