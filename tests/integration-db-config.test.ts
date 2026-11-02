import { describe, expect, it } from 'vitest';
import { redactConnectionUrls, validateIntegrationDatabaseConfig } from '../scripts/integration-db-config';

function config(mode: 'persistent' | 'disposable', database: string) {
  const appPassword = 'a'.repeat(64);
  const migrationPassword = 'b'.repeat(64);
  return {
    CAIRN_ENV: 'development',
    CAIRN_INTEGRATION_MODE: mode,
    CAIRN_TEST_DB_NAME: database,
    CAIRN_INTEGRATION_DATA_DIRECTORY: '/home/cairn/.local/share/postgresql/cairn_integration/data',
    CAIRN_INTEGRATION_SYSTEM_IDENTIFIER: '7703407688127814566',
    CAIRN_DB_HOST: '127.0.0.1',
    CAIRN_DB_PORT: '55435',
    CAIRN_DB_USER: 'cairn_app',
    CAIRN_DB_PASSWORD: appPassword,
    DATABASE_URL: `postgresql://cairn_app:${appPassword}@127.0.0.1:55435/${database}`,
    MIGRATION_DATABASE_URL: `postgresql://cairn_integration_migrator:${migrationPassword}@127.0.0.1:55435/${database}`,
  };
}

describe('integration database target configuration', () => {
  it('accepts only explicit persistent integration identity and separate roles', () => {
    expect(validateIntegrationDatabaseConfig(config('persistent', 'cairn_integration'))).toMatchObject({
      mode: 'persistent',
      database: 'cairn_integration',
      host: '127.0.0.1',
      port: 55435,
      runtimeRole: 'cairn_app',
      migrationRole: 'cairn_integration_migrator',
    });
  });

  it('allows only clearly named, dated disposable migration targets', () => {
    expect(validateIntegrationDatabaseConfig(config('disposable', 'cairn_migration_test_20261102_a1b2')).database)
      .toBe('cairn_migration_test_20261102_a1b2');
    expect(() => validateIntegrationDatabaseConfig(config('disposable', 'cairn_integration')))
      .toThrow('unique cairn_migration_test_YYYYMMDD_<run-id>');
  });

  it('rejects a mismatched PostgreSQL cluster system identifier before a connection', () => {
    const wrongCluster = config('persistent', 'cairn_integration');
    wrongCluster.CAIRN_INTEGRATION_SYSTEM_IDENTIFIER = '0';
    expect(() => validateIntegrationDatabaseConfig(wrongCluster)).toThrow('expected PostgreSQL system identifier');
  });

  it('rejects B210 before a connection and withholds URL secrets in errors', () => {
    expect(redactConnectionUrls('failed postgresql://role:secret@127.0.0.1:55435/cairn_integration retry'))
      .toBe('failed [connection URL withheld] retry');
    const invalid = config('persistent', 'cairn_integration');
    invalid.DATABASE_URL = 'postgresql://cairn_app:do-not-log@127.0.0.1:55435/cairn_b210';
    expect(() => validateIntegrationDatabaseConfig(invalid)).toThrow(/DATABASE_URL must explicitly target cairn_integration/);
    try {
      validateIntegrationDatabaseConfig(invalid);
    } catch (error) {
      expect(String(error)).not.toContain('do-not-log');
    }
  });

  it('rejects a missing URL, a fallback target, a mismatched role, or non-loopback host', () => {
    const missing = config('persistent', 'cairn_integration');
    delete (missing as Partial<typeof missing>).MIGRATION_DATABASE_URL;
    expect(() => validateIntegrationDatabaseConfig(missing)).toThrow('MIGRATION_DATABASE_URL must be set explicitly');

    const wrongDatabase = config('persistent', 'cairn_integration');
    wrongDatabase.DATABASE_URL = wrongDatabase.DATABASE_URL.replace('/cairn_integration', '/cairn');
    expect(() => validateIntegrationDatabaseConfig(wrongDatabase)).toThrow('DATABASE_URL must explicitly target');

    const wrongRole = config('persistent', 'cairn_integration');
    wrongRole.MIGRATION_DATABASE_URL = wrongRole.MIGRATION_DATABASE_URL.replace('cairn_integration_migrator', 'cairn_app');
    expect(() => validateIntegrationDatabaseConfig(wrongRole)).toThrow('MIGRATION_DATABASE_URL must use cairn_integration_migrator');

    const remote = config('persistent', 'cairn_integration');
    remote.DATABASE_URL = remote.DATABASE_URL.replace('127.0.0.1', '192.0.2.10');
    expect(() => validateIntegrationDatabaseConfig(remote)).toThrow('approved loopback PostgreSQL endpoint');
  });
});
