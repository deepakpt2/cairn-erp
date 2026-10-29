import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { directSql } from '../src/platform/db/client';

/**
 * Regression tests for the `directSql()` connection-targeting fix.
 *
 * These tests verify that `directSql()` uses the explicitly supplied connection
 * string and never silently falls back to `process.env.DATABASE_URL`. All
 * connections are read-only (`SELECT current_database()`) and target only the
 * development database `cairn` — never a protected acceptance database.
 *
 * The original defect: `directSql()` ignored its argument and always connected
 * via `process.env.DATABASE_URL`, so any caller that supplied an explicit
 * target was silently routed to whatever `DATABASE_URL` named instead.
 */
const CAIRN_URL =
  'postgresql://cairn_app:cairn_app_dev@127.0.0.1:5432/cairn';
const WRONG_URL =
  'postgresql://cairn_app:cairn_app_dev@127.0.0.1:5432/cairn_b210';

let originalDatabaseUrl: string | undefined;

beforeAll(() => {
  originalDatabaseUrl = process.env.DATABASE_URL;
});

afterEach(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

afterAll(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

describe('directSql() explicit target selection', () => {
  it('uses explicit target even when DATABASE_URL points elsewhere', async () => {
    process.env.DATABASE_URL = WRONG_URL;

    const sql = directSql(CAIRN_URL);
    try {
      const rows = await sql.unsafe<Array<{ db: string }>>(
        'select current_database() as db',
      );
      expect(rows[0].db).toBe('cairn');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('uses explicit target B even when DATABASE_URL points to A', async () => {
    // DATABASE_URL names cairn (target A); explicit target names a different
    // database that does not exist. The connection attempt must fail naming
    // the explicit target — this proves the explicit target was selected
    // rather than DATABASE_URL.
    process.env.DATABASE_URL = CAIRN_URL;

    const sql = directSql(
      'postgresql://cairn_app:cairn_app_dev@127.0.0.1:5432/nonexistent_db_for_target_test',
    );
    await expect(sql.unsafe('SELECT 1')).rejects.toThrow();
    await sql.end({ timeout: 5 }).catch(() => {});
  });

  it('fails safely when no target is supplied', async () => {
    // Calling directSql() with no argument is a TypeScript compile error; at
    // runtime undefined is passed, which postgres rejects with a clear error
    // rather than silently falling back to DATABASE_URL.
    const sql = directSql(undefined as unknown as string);
    await expect(sql.unsafe('SELECT 1')).rejects.toThrow();
    await sql.end({ timeout: 5 }).catch(() => {});
  });

  it('does not cache or reuse clients across different targets', async () => {
    process.env.DATABASE_URL = CAIRN_URL;

    const sql1 = directSql(CAIRN_URL);
    try {
      const rows1 = await sql1.unsafe<Array<{ db: string }>>(
        'select current_database() as db',
      );
      expect(rows1[0].db).toBe('cairn');
    } finally {
      await sql1.end({ timeout: 5 });
    }

    // A second explicit call to a non-existent database must fail on that
    // database, not succeed on cairn via a reused client.
    const sql2 = directSql(
      'postgresql://cairn_app:cairn_app_dev@127.0.0.1:5432/nonexistent_db_for_target_test',
    );
    await expect(sql2.unsafe('SELECT 1')).rejects.toThrow();
    await sql2.end({ timeout: 5 }).catch(() => {});
  });

  it('does not fall back to another database on connection failure', async () => {
    process.env.DATABASE_URL = CAIRN_URL;

    const sql = directSql(
      'postgresql://cairn_app:cairn_app_dev@127.0.0.1:5432/nonexistent_db_for_target_test',
    );
    // The failure must name the explicit (non-existent) target, not fall back
    // to DATABASE_URL (cairn).
    await expect(sql.unsafe('SELECT 1')).rejects.toThrow(
      /nonexistent_db_for_target_test/,
    );
    await sql.end({ timeout: 5 }).catch(() => {});
  });

  it('preserves parameterized query behavior on the explicit target', async () => {
    const sql = directSql(CAIRN_URL);
    try {
      const rows = await sql.unsafe<Array<{ db: string }>>(
        'select current_database() as db where $1 = $1',
        ['cairn'],
      );
      expect(rows[0].db).toBe('cairn');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('preserves transaction behavior on the explicit target', async () => {
    const sql = directSql(CAIRN_URL);
    try {
      await sql.unsafe('begin');
      try {
        const rows = await sql.unsafe<Array<{ db: string }>>(
          'select current_database() as db',
        );
        expect(rows[0].db).toBe('cairn');
        await sql.unsafe('commit');
      } catch (error) {
        await sql.unsafe('rollback');
        throw error;
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
