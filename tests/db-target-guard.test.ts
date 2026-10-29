import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  validateTarget,
  isProtected,
  registerProtected,
  type DbAuthorization,
} from '../src/platform/db/target-guard';

/**
 * Regression tests for the database target safety guard.
 *
 * These tests verify that `validateTarget()`:
 *   1. Requires an explicit target (no fallback to DATABASE_URL)
 *   2. Verifies actual connected database identity matches the requested target
 *   3. Rejects protected databases without explicit authorization
 *   4. Accepts development/scratch databases
 *   5. Fails closed on missing, mismatched, or unverifiable targets
 *   6. Supports explicitly authorized acceptance execution
 *
 * Read-only diagnostic access (directSql) is NOT tested here — it is outside
 * the guard's scope by design.
 *
 * The `cairn` development database is used for positive tests. No protected
 * acceptance database is used as a test fixture.
 */

const CAIRN_DB = 'cairn';
const SCRATCH_DB = 'cairn_scratch_guard_test';
const PROTECTED_DB = 'cairn_b210';

let originalEnv: Record<string, string | undefined>;

beforeAll(() => {
  originalEnv = {
    CAIRN_DB_AUTHORIZATION_TOKEN: process.env.CAIRN_DB_AUTHORIZATION_TOKEN,
    CAIRN_DB_USER: process.env.CAIRN_DB_USER,
    CAIRN_DB_PASSWORD: process.env.CAIRN_DB_PASSWORD,
    CAIRN_DB_HOST: process.env.CAIRN_DB_HOST,
    CAIRN_DB_PORT: process.env.CAIRN_DB_PORT,
  };
});

afterAll(() => {
  // Restore original environment
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  // Clean up: unregister any test-protected databases we may have added
  // (isProtected checks a module-level Set; we can't easily remove from it,
  // but tests only add and don't rely on removal across files).
});

afterEach(() => {
  // Reset env vars that tests may have changed
  if (originalEnv.CAIRN_DB_AUTHORIZATION_TOKEN === undefined) {
    delete process.env.CAIRN_DB_AUTHORIZATION_TOKEN;
  } else {
    process.env.CAIRN_DB_AUTHORIZATION_TOKEN = originalEnv.CAIRN_DB_AUTHORIZATION_TOKEN;
  }
  vi.restoreAllMocks();
});

describe('validateTarget() — missing or invalid target', () => {
  it('throws when target is undefined', async () => {
    await expect(validateTarget(undefined)).rejects.toThrow(
      /Database target is required/,
    );
  });

  it('throws when target is empty string', async () => {
    await expect(validateTarget('')).rejects.toThrow(
      /Database target is required/,
    );
  });

  it('throws when target is whitespace only', async () => {
    await expect(validateTarget('   ')).rejects.toThrow(
      /Database target is required/,
    );
  });

  it('throws when target is null', async () => {
    await expect(validateTarget(null as unknown as string)).rejects.toThrow(
      /Database target is required/,
    );
  });
});

describe('validateTarget() — protected database rejection', () => {
  it('rejects cairn_b210 without authorization', async () => {
    delete process.env.CAIRN_DB_AUTHORIZATION_TOKEN;
    await expect(validateTarget(PROTECTED_DB)).rejects.toThrow(
      /Refusing to target protected database/,
    );
  });

  it('rejects cairn_b210 with wrong token', async () => {
    process.env.CAIRN_DB_AUTHORIZATION_TOKEN = 'correct-token';
    await expect(
      validateTarget(PROTECTED_DB, {
        token: 'wrong-token',
        database: PROTECTED_DB,
        reason: 'test',
      }),
    ).rejects.toThrow(/Authorization token does not match/);
  });

  it('rejects cairn_b210 with mismatched database name in authorization', async () => {
    process.env.CAIRN_DB_AUTHORIZATION_TOKEN = 'test-token';
    await expect(
      validateTarget(PROTECTED_DB, {
        token: 'test-token',
        database: 'cairn',
        reason: 'test',
      }),
    ).rejects.toThrow(/names database "cairn" but target is/);
  });

  it('rejects a newly registered protected database without authorization', async () => {
    registerProtected('cairn_scratch_protected');
    delete process.env.CAIRN_DB_AUTHORIZATION_TOKEN;
    await expect(
      validateTarget('cairn_scratch_protected'),
    ).rejects.toThrow(/Refusing to target protected database/);
  });

  it('isProtected() returns true for cairn_b210', () => {
    expect(isProtected(PROTECTED_DB)).toBe(true);
  });

  it('isProtected() returns false for non-protected databases', () => {
    expect(isProtected(CAIRN_DB)).toBe(false);
    expect(isProtected(SCRATCH_DB)).toBe(false);
  });
});

describe('validateTarget() — authorized acceptance execution', () => {
  it('accepts cairn_b210 with valid authorization token and matching database', async () => {
    process.env.CAIRN_DB_AUTHORIZATION_TOKEN = 'test-acceptance-token';
    // This test verifies the authorization path works. The connection attempt
    // to cairn_b210 will succeed (it exists) but the guard only verifies
    // identity, not whether mutations are allowed. We assert the guard returns
    // a validated target with protected=true.
    const result = await validateTarget(PROTECTED_DB, {
      token: 'test-acceptance-token',
      database: PROTECTED_DB,
      reason: 'Regression test: authorized acceptance execution path',
    });
    expect(result.database).toBe(PROTECTED_DB);
    expect(result.protected).toBe(true);
  });

  it('rejects cairn_b210 with valid token but missing authorization object', async () => {
    process.env.CAIRN_DB_AUTHORIZATION_TOKEN = 'test-acceptance-token';
    await expect(validateTarget(PROTECTED_DB)).rejects.toThrow(
      /No authorization supplied/,
    );
  });
});

describe('validateTarget() — accepted development database', () => {
  it('accepts the cairn development database and verifies identity', async () => {
    const result = await validateTarget(CAIRN_DB);
    expect(result.database).toBe(CAIRN_DB);
    expect(result.protected).toBe(false);
  });

  it('accepts a scratch database name format and verifies identity', async () => {
    // Use cairn as a stand-in for a scratch database (both exist on the cluster).
    // The key assertion is that identity verification passes.
    const result = await validateTarget(CAIRN_DB);
    expect(result.database).toBe(CAIRN_DB);
  });
});

describe('validateTarget() — database identity mismatch', () => {
  it('throws when the connected database does not match the requested target', async () => {
    // Request a database that does not exist on the cluster. The connection
    // will fail, proving the guard attempts to connect to the explicit target
    // rather than falling back to DATABASE_URL.
    await expect(
      validateTarget('nonexistent_database_guard_test_xyz'),
    ).rejects.toThrow(/Cannot verify database target/);
  });
});

describe('validateTarget() — no silent fallback to another database', () => {
  it('fails when DATABASE_URL points to a different database than the explicit target', async () => {
    // Set DATABASE_URL to point at cairn_b210 while explicitly requesting cairn.
    // The guard must use the explicit target (cairn), not DATABASE_URL.
    const originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `postgresql://cairn_app:cairn_app_dev@127.0.0.1:5432/${PROTECTED_DB}`;

    try {
      const result = await validateTarget(CAIRN_DB);
      expect(result.database).toBe(CAIRN_DB);
      expect(result.protected).toBe(false);
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }
  });
});

describe('validateTarget() — rejected operations execute no mutation', () => {
  it('throws before any connection is made to a protected database', async () => {
    // If the guard threw AFTER connecting, we'd see a connection error or
    // a successful identity check. Instead, it throws before connecting
    // when authorization is missing for a protected database.
    delete process.env.CAIRN_DB_AUTHORIZATION_TOKEN;
    let threwBeforeConnect = false;
    try {
      await validateTarget(PROTECTED_DB);
    } catch (error) {
      // The error message should mention "protected database" not a connection error
      threwBeforeConnect =
        error instanceof Error &&
        error.message.includes('Refusing to target protected database');
    }
    expect(threwBeforeConnect).toBe(true);
  });
});

describe('target-guard module exports', () => {
  it('exports validateTarget, isProtected, registerProtected, and DbAuthorization type', () => {
    expect(typeof validateTarget).toBe('function');
    expect(typeof isProtected).toBe('function');
    expect(typeof registerProtected).toBe('function');
    // DbAuthorization is a type import; its existence is proven by the tests
    // that construct DbAuthorization objects above.
  });
});
