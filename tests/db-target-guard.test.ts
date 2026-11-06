import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { postgresMock } = vi.hoisted(() => ({ postgresMock: vi.fn() }));
vi.mock('postgres', () => ({ default: postgresMock }));

import {
  isProtected,
  registerProtected,
  validateTarget,
} from '../src/platform/db/target-guard';

const APP_DB = 'target_guard_app_fixture';
const SCRATCH_DB = 'target_guard_scratch_fixture';
const PROTECTED_DB = 'cairn_b210';
const SYNTHETIC_PROTECTED_DB = 'target_guard_synthetic_protected';
const ENV_URL = 'postgresql://env-user:env-pass@environment.invalid/env_database';
const VERIFY_URL = 'postgresql://verify-user:verify-pass@verify.invalid/ignored_database';

const ENV_KEYS = [
  'DATABASE_URL',
  'CAIRN_DB_AUTHORIZATION_TOKEN',
  'CAIRN_DB_USER',
  'CAIRN_DB_PASSWORD',
  'CAIRN_DB_HOST',
  'CAIRN_DB_PORT',
] as const;
let originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;
let lastFakeClient: ReturnType<typeof makeFakeClient> | undefined;

function makeFakeClient(actualDatabase: string) {
  const query = vi.fn().mockResolvedValue([{ current_database: actualDatabase }]);
  const end = vi.fn().mockResolvedValue(undefined);
  return Object.assign(query, { end });
}

function setVerificationIdentity() {
  process.env.CAIRN_DB_USER = 'fixture-user';
  process.env.CAIRN_DB_PASSWORD = 'fixture-pass';
  process.env.CAIRN_DB_HOST = 'verify-fixture.invalid';
  process.env.CAIRN_DB_PORT = '16432';
}

beforeAll(() => {
  originalEnv = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as typeof originalEnv;
});

beforeEach(() => {
  setVerificationIdentity();
  delete process.env.CAIRN_DB_AUTHORIZATION_TOKEN;
  delete process.env.DATABASE_URL;
  postgresMock.mockReset();
  lastFakeClient = undefined;
  postgresMock.mockImplementation((connectionString: string) => {
    const actualDatabase = new URL(connectionString).pathname.replace(/^\//, '');
    lastFakeClient = makeFakeClient(actualDatabase);
    return lastFakeClient;
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  postgresMock.mockReset();
});

describe('validateTarget() — missing target', () => {
  it.each([undefined, '', '   ', null])(
    'refuses an absent target (%s) without opening a connection',
    async (target) => {
      await expect(validateTarget(target as string)).rejects.toThrow(
        /Database target is required/,
      );
      expect(postgresMock).not.toHaveBeenCalled();
    },
  );
});

describe('validateTarget() — protected target refusal', () => {
  it('rejects cairn_b210 before invoking the PostgreSQL client', async () => {
    await expect(validateTarget(PROTECTED_DB)).rejects.toThrow(
      /Refusing to target protected database/,
    );
    expect(postgresMock).not.toHaveBeenCalled();
  });

  it('rejects a wrong token before invoking the PostgreSQL client', async () => {
    process.env.CAIRN_DB_AUTHORIZATION_TOKEN = 'expected-fixture-token';
    await expect(validateTarget(PROTECTED_DB, {
      token: 'wrong-fixture-token',
      database: PROTECTED_DB,
      reason: 'unit test',
    })).rejects.toThrow(/Authorization token does not match/);
    expect(postgresMock).not.toHaveBeenCalled();
  });

  it('rejects authorization for a different database before invoking PostgreSQL', async () => {
    process.env.CAIRN_DB_AUTHORIZATION_TOKEN = 'expected-fixture-token';
    await expect(validateTarget(PROTECTED_DB, {
      token: 'expected-fixture-token',
      database: APP_DB,
      reason: 'unit test',
    })).rejects.toThrow(/names database .* but target is/);
    expect(postgresMock).not.toHaveBeenCalled();
  });

  it('rejects a dynamically registered protected target before connecting', async () => {
    registerProtected(SYNTHETIC_PROTECTED_DB);
    await expect(validateTarget(SYNTHETIC_PROTECTED_DB)).rejects.toThrow(
      /Refusing to target protected database/,
    );
    expect(postgresMock).not.toHaveBeenCalled();
  });

  it('identifies protected names without making a connection', () => {
    expect(isProtected(PROTECTED_DB)).toBe(true);
    expect(isProtected(APP_DB)).toBe(false);
    expect(postgresMock).not.toHaveBeenCalled();
  });
});

describe('validateTarget() — environment and explicit target selection', () => {
  it('uses configured verification identity and the explicit target, not DATABASE_URL', async () => {
    process.env.DATABASE_URL = ENV_URL;

    const result = await validateTarget(APP_DB);

    expect(result).toEqual({ database: APP_DB, protected: false });
    expect(postgresMock).toHaveBeenCalledTimes(1);
    expect(postgresMock.mock.calls[0][0]).toBe(
      `postgresql://fixture-user:fixture-pass@verify-fixture.invalid:16432/${APP_DB}`,
    );
    expect(postgresMock.mock.calls[0][0]).not.toContain('environment.invalid');
    expect(lastFakeClient?.end).toHaveBeenCalledTimes(1);
  });

  it('uses an explicitly supplied verification URL while replacing its database with the target', async () => {
    const result = await validateTarget(SCRATCH_DB, undefined, VERIFY_URL);

    expect(result).toEqual({ database: SCRATCH_DB, protected: false });
    expect(postgresMock).toHaveBeenCalledTimes(1);
    const verificationUrl = new URL(postgresMock.mock.calls[0][0]);
    expect(verificationUrl.username).toBe('verify-user');
    expect(verificationUrl.hostname).toBe('verify.invalid');
    expect(Number(verificationUrl.port)).toBeGreaterThan(0);
    expect(verificationUrl.pathname).toBe(`/${SCRATCH_DB}`);
  });

  it('detects a connected-identity mismatch and closes the fake client', async () => {
    const mismatchedClient = makeFakeClient('different_fixture_database');
    postgresMock.mockImplementationOnce(() => mismatchedClient);

    await expect(validateTarget(APP_DB)).rejects.toThrow(/Database identity mismatch/);

    expect(postgresMock).toHaveBeenCalledTimes(1);
    expect(mismatchedClient.end).toHaveBeenCalled();
  });
});
