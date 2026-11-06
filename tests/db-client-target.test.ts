import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const { postgresMock } = vi.hoisted(() => ({ postgresMock: vi.fn() }));
vi.mock('postgres', () => ({ default: postgresMock }));

import { closeDb, directSql, sql as applicationSql } from '../src/platform/db/client';

const ENV_URL = 'postgresql://env-user:env-pass@environment.invalid/env_database';
const EXPLICIT_URL_A = 'postgresql://test-user:test-pass@target-a.invalid/database_a';
const EXPLICIT_URL_B = 'postgresql://test-user:test-pass@target-b.invalid/database_b';

let originalDatabaseUrl: string | undefined;
let originalMigrationDatabaseUrl: string | undefined;

beforeAll(() => {
  originalDatabaseUrl = process.env.DATABASE_URL;
  originalMigrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL;
});

afterEach(async () => {
  await closeDb();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalMigrationDatabaseUrl === undefined) delete process.env.MIGRATION_DATABASE_URL;
  else process.env.MIGRATION_DATABASE_URL = originalMigrationDatabaseUrl;
  postgresMock.mockReset();
});

function installPostgresMock() {
  postgresMock.mockImplementation(() => {
    return Object.assign(vi.fn().mockResolvedValue([]), {
      end: vi.fn().mockResolvedValue(undefined),
    });
  });
}

describe('database client target selection', () => {
  it('uses the explicit directSql target instead of either environment URL', () => {
    installPostgresMock();
    process.env.DATABASE_URL = ENV_URL;
    process.env.MIGRATION_DATABASE_URL = EXPLICIT_URL_A;

    directSql(EXPLICIT_URL_B);

    expect(postgresMock).toHaveBeenCalledTimes(1);
    expect(postgresMock.mock.calls[0][0]).toBe(EXPLICIT_URL_B);
    expect(postgresMock.mock.calls[0][1]).toMatchObject({ max: 1, prepare: false });
  });

  it('selects DATABASE_URL for the shared application client', () => {
    installPostgresMock();
    process.env.DATABASE_URL = ENV_URL;

    const first = applicationSql();
    const second = applicationSql();

    expect(second).toBe(first);
    expect(postgresMock).toHaveBeenCalledTimes(1);
    expect(postgresMock.mock.calls[0][0]).toBe(ENV_URL);
  });

  it('creates a fresh direct client for each distinct explicit target', () => {
    installPostgresMock();

    directSql(EXPLICIT_URL_A);
    directSql(EXPLICIT_URL_B);

    expect(postgresMock).toHaveBeenCalledTimes(2);
    expect(postgresMock.mock.calls.map(([url]) => url)).toEqual([
      EXPLICIT_URL_A,
      EXPLICIT_URL_B,
    ]);
  });

  it.each([undefined, '', '   '])(
    'refuses missing or blank explicit configuration (%s) without calling postgres',
    (connectionString) => {
      installPostgresMock();
      process.env.DATABASE_URL = ENV_URL;
      process.env.MIGRATION_DATABASE_URL = EXPLICIT_URL_A;

      expect(() => directSql(connectionString as string)).toThrow(
        /directSql requires an explicit, non-empty connection string/,
      );
      expect(postgresMock).not.toHaveBeenCalled();
    },
  );
});
