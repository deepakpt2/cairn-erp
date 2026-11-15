import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migratorSettings, MigratorRoleError } from '../scripts/ensure-migrator-role';

const url = 'postgresql://cairn_integration_migrator:abc123@cairn-postgres:5432/cairn';

describe('ensure-migrator-role settings', () => {
  it('does nothing without the superuser password (dev and test databases)', () => {
    expect(migratorSettings({ MIGRATION_DATABASE_URL: url })).toBeNull();
  });

  it('takes host, database and the migrator password from MIGRATION_DATABASE_URL', () => {
    expect(migratorSettings({ MIGRATION_DATABASE_URL: url, CAIRN_DB_OWNER_PASSWORD: 'p@ss/word' })).toEqual({
      host: 'cairn-postgres', port: 5432, database: 'cairn', ownerUser: 'cairn', ownerPassword: 'p@ss/word', password: 'abc123',
    });
  });

  it('refuses a migration URL that is not the migrator, has no password, or no database', () => {
    const env = { CAIRN_DB_OWNER_PASSWORD: 'x' };
    expect(() => migratorSettings({ ...env, MIGRATION_DATABASE_URL: 'postgresql://cairn:x@h:5432/cairn' })).toThrow(/must connect as cairn_integration_migrator/);
    expect(() => migratorSettings({ ...env, MIGRATION_DATABASE_URL: 'postgresql://cairn_integration_migrator@h:5432/cairn' })).toThrow(MigratorRoleError);
    expect(() => migratorSettings({ ...env, MIGRATION_DATABASE_URL: 'postgresql://cairn_integration_migrator:x@h:5432/' })).toThrow(/name a database/);
    expect(() => migratorSettings(env)).toThrow(/MIGRATION_DATABASE_URL must be set/);
  });

  it('refuses the app or migrator role as the owner login', () => {
    expect(() => migratorSettings({ MIGRATION_DATABASE_URL: url, CAIRN_DB_OWNER_PASSWORD: 'x', CAIRN_DB_OWNER_USER: 'cairn_app' })).toThrow(/superuser/);
  });
});

describe('deployment wiring for the migrator role', () => {
  const compose = readFileSync('docker-compose.yml', 'utf8');
  const dockerfile = readFileSync('Dockerfile', 'utf8');
  const init = readFileSync('docker/postgres/10-app-role.sh', 'utf8');

  it('migrates as cairn_integration_migrator, never the superuser', () => {
    expect(compose).toMatch(/MIGRATION_DATABASE_URL: postgresql:\/\/cairn_integration_migrator:\$\{CAIRN_MIGRATOR_DB_PASSWORD/);
    expect(compose).not.toMatch(/MIGRATION_DATABASE_URL: postgresql:\/\/cairn:/);
  });

  it('creates or repairs the role before anything else runs', () => {
    expect(dockerfile).toMatch(/CMD \["sh", "-c", "npm run db:ensure-migrator && npm run db:sync-role && npm run db:migrate/);
  });

  it('creates the role on a fresh volume and hands it the database', () => {
    expect(init).toMatch(/CREATE ROLE cairn_integration_migrator LOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS/);
    expect(init).toMatch(/GRANT cairn_app TO cairn_integration_migrator WITH ADMIN TRUE, INHERIT FALSE, SET FALSE/);
    expect(init).toMatch(/ALTER DATABASE :"db_name" OWNER TO cairn_integration_migrator/);
  });
});
