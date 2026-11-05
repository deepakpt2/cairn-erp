import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertFreshWalkthroughFirstAdmin,
  assertFreshWalkthroughTenantInventory,
  assertWalkthroughCheckpointActor,
  assertWalkthroughCheckpointRequest,
  assertWalkthroughDatabaseTarget,
  assertWalkthroughScopeSet,
  assertWalkthroughSeedRuntime,
} from '../src/platform/tenancy/walkthrough-install-guard';

const guard = readFileSync('src/platform/tenancy/walkthrough-install-guard.ts', 'utf8');
const freshness = readFileSync('src/platform/tenancy/walkthrough-provisioning.ts', 'utf8');
const scopes = readFileSync('src/modules/platform/organisation-scope-admin.ts', 'utf8');
const seed = readFileSync('walkthrough-seed.ts', 'utf8');
const originalEnv = { ...process.env };
const originalArgv = [...process.argv];

afterEach(() => {
  process.env = { ...originalEnv };
  process.argv = [...originalArgv];
});

describe('trusted walkthrough provisioning contract', () => {
  it('accepts only the exact runtime URL/database, application role, and documented disposable-name pattern', () => {
    const db = 'cairn_migration_test_20261105_walkthrough_a1';
    expect(() => assertWalkthroughDatabaseTarget(db, `postgresql://cairn_app@127.0.0.1:55435/${db}`)).not.toThrow();
    expect(() => assertWalkthroughDatabaseTarget(db, `postgresql://cairn_app@127.0.0.1:55435/other_db`)).toThrow(/exactly CAIRN_SEED_DATABASE/);
    expect(() => assertWalkthroughDatabaseTarget('cairn', 'postgresql://cairn_app@127.0.0.1:5432/cairn')).toThrow(/uniquely named disposable/);
    expect(() => assertWalkthroughDatabaseTarget(db, `postgresql://cairn_owner@127.0.0.1:55435/${db}`)).toThrow(/cairn_app/);
  });

  it('rejects tenant, first-admin, role, and pre-existing-scope conflicts', () => {
    expect(() => assertFreshWalkthroughTenantInventory(2, 'WK01', 'WK01')).toThrow(/exactly one tenant/);
    expect(() => assertFreshWalkthroughTenantInventory(1, 'WK02', 'WK01')).toThrow(/exactly one tenant/);
    const eligible = {
      users: [{ id: 'user-1', username: 'walkthrough.admin', isActive: true, isLocked: false, mustChangePassword: false }],
      expectedUsername: 'walkthrough.admin',
      roleAssignments: [{ userId: 'user-1', roleCode: 'ADMINISTRATOR' }],
      scopeCount: 0,
    };
    expect(() => assertFreshWalkthroughFirstAdmin(eligible)).not.toThrow();
    expect(() => assertFreshWalkthroughFirstAdmin({ ...eligible, users: [...eligible.users, { ...eligible.users[0], id: 'user-2' }] })).toThrow(/single active first administrator/);
    expect(() => assertFreshWalkthroughFirstAdmin({ ...eligible, roleAssignments: [{ userId: 'user-1', roleCode: 'PLATFORM_ADMIN' }] })).toThrow(/only the initial ADMINISTRATOR/);
    expect(() => assertFreshWalkthroughFirstAdmin({ ...eligible, scopeCount: 1 })).toThrow(/pre-existing.*scopes/);
  });

  it('accepts only the two exact installation scopes and rejects added or conflicting grants', () => {
    const exact = [
      { id: 'scope-c', userId: 'user-1', scopeType: 'COMPANY_CODE', scopeValue: '1000', createdBy: 'walkthrough.admin' },
      { id: 'scope-p', userId: 'user-1', scopeType: 'PLANT', scopeValue: '1000', createdBy: 'walkthrough.admin' },
    ];
    expect(() => assertWalkthroughScopeSet(exact, 'user-1', 'walkthrough.admin', 'scope-c', 'scope-p')).not.toThrow();
    expect(() => assertWalkthroughScopeSet([...exact, { ...exact[0], id: 'scope-extra', scopeValue: '2000' }], 'user-1', 'walkthrough.admin', 'scope-c', 'scope-p')).toThrow(/exactly match/);
    expect(() => assertWalkthroughScopeSet(exact.map((row) => ({ ...row, userId: 'other-user' })), 'user-1', 'walkthrough.admin', 'scope-c', 'scope-p')).toThrow(/exactly match/);
  });

  it('permits deterministic same-date retries but rejects changed date, tenant, database, payload, or actor', () => {
    const checkpoint = { operation: 'WALKTHROUGH_SEED_V1', client: 'WK01', database: 'cairn_migration_test_20261105_run1', asOf: '2026-11-05' };
    expect(() => assertWalkthroughCheckpointRequest(checkpoint, checkpoint)).not.toThrow();
    expect(() => assertWalkthroughCheckpointRequest(checkpoint, { ...checkpoint, asOf: '2026-11-06' })).toThrow(/replay protection/);
    expect(() => assertWalkthroughCheckpointRequest(checkpoint, { ...checkpoint, operation: 'WALKTHROUGH_SEED_V2' })).toThrow(/payload/);
    expect(() => assertWalkthroughCheckpointActor({ actorUserId: 'user-1', username: 'walkthrough.admin' }, { userId: 'user-2', username: 'walkthrough.admin' })).toThrow(/different first administrator/);
  });

  it('refuses every prohibited persistent/acceptance target before a database call', () => {
    for (const db of ['cairn_integration', 'cairn_b210', 'cairn_hr_accept', 'cairn_demo', 'cairn_acceptance']) {
      expect(() => assertWalkthroughDatabaseTarget(db, `postgresql://cairn_app@127.0.0.1:55435/${db}`)).toThrow(/protected or persistent/);
    }
    expect(seed.indexOf('assertWalkthroughDatabaseTarget(database, process.env.DATABASE_URL)'))
      .toBeLessThan(seed.indexOf('validateTarget(database'));
    expect(seed.indexOf('assertWalkthroughDatabaseTarget(database, process.env.DATABASE_URL)'))
      .toBeLessThan(seed.indexOf('assertApplicationRole()'));
  });

  it('binds the special grant to the development CLI and exact tenant, DB, and administrator identity', () => {
    const db = 'cairn_migration_test_20261105_walkthrough_a1';
    process.env.CAIRN_ENV = 'development';
    process.env.CAIRN_SEED_TENANT = 'WK01';
    process.env.CAIRN_SEED_DATABASE = db;
    process.env.CAIRN_SEED_USERNAME = 'walkthrough.admin';
    process.env.DATABASE_URL = `postgresql://cairn_app@127.0.0.1:55435/${db}`;
    process.argv[1] = 'walkthrough-seed.ts';
    expect(() => assertWalkthroughSeedRuntime({ client: 'WK01', database: db, username: 'walkthrough.admin' })).not.toThrow();
    process.argv[1] = 'server.js';
    expect(() => assertWalkthroughSeedRuntime({ client: 'WK01', database: db, username: 'walkthrough.admin' })).toThrow(/only from the development walkthrough-seed.ts CLI/);
  });

  it('makes freshness fail closed on extra tenants, users, scopes, prior structure, and tenant data while exempting global reference tables', () => {
    expect(freshness).toContain('assertFreshWalkthroughTenantInventory(tenants.length, tenants[0]?.client, client)');
    expect(freshness).toContain('assertFreshWalkthroughFirstAdmin({ users, expectedUsername, roleAssignments: assignments, scopeCount: scopes.length })');
    expect(freshness).toContain('structureTables');
    expect(freshness).toContain('businessDataTables');
    expect(freshness).toContain("row.table_name === 'audit_access_log'");
    expect(freshness).toContain('information_schema.columns');
    expect(freshness).toContain('Global reference tables have no `client` column');
    expect(freshness).not.toContain('cairn_integration_guard');
  });

  it('makes structure, normal scope records, audit, and the PROVISIONED checkpoint one rollback-safe transaction', () => {
    const transactionStart = seed.indexOf('const installed = await withTenant(tenant, async (tx) => {');
    const packagePhase = seed.indexOf('await ensureStandardPackage(tx, tenant, true)', transactionStart);
    const structurePhase = seed.indexOf('applyStandardStructureInTransaction(tx,', transactionStart);
    const scopePhase = seed.indexOf('provisionWalkthroughFirstAdminScopesInTransaction(tx,', transactionStart);
    const checkpointPhase = seed.indexOf('writeWalkthroughCheckpoint(tx,', transactionStart);
    const transactionEnd = seed.indexOf('});', checkpointPhase);
    expect(transactionStart).toBeGreaterThan(-1);
    expect(packagePhase).toBeLessThan(structurePhase);
    expect(structurePhase).toBeLessThan(scopePhase);
    expect(scopePhase).toBeLessThan(checkpointPhase);
    expect(checkpointPhase).toBeLessThan(transactionEnd);
    expect(seed).toContain("if (!checkpoint) throw new Error('Walkthrough installation checkpoint is missing after provisioning.');");
    expect(seed).toContain('checkpoint.state === \'COMPLETE\'');
    expect(seed).toContain('refusing to repair or adopt partial rows');
  });

  it('keeps normal self-grant and live-session authorization unchanged while limiting the bootstrap to two scopes', () => {
    expect(scopes).toContain('if (actor.userId === targetUserId)');
    expect(scopes).toContain('await requireAdministrator(tx, client, actor)');
    expect(scopes).toContain('await lockUserScopes(tx, client, actor.userId)');
    expect(scopes).toContain("scopeType: 'COMPANY_CODE', scopeValue: '1000'");
    expect(scopes).toContain("scopeType: 'PLANT', scopeValue: '1000'");
    expect(scopes).toContain('existingScopes.length');
    expect(scopes).toContain('WALKTHROUGH_INSTALL_REASON');
    expect(scopes).toContain('auditCorrelationId: input.correlationId');
    expect(scopes).toContain('assertWalkthroughSeedRuntime');
    expect(seed).toContain('recordChange(tx,');
    expect(seed).toContain('WALKTHROUGH_INSTALL_OBJECT_CLASS');
    expect(seed).toContain('checkpoint.state === \'COMPLETE\'');
    expect(seed).toContain('assertWalkthroughCheckpointRequest(checkpoint, { operation: WALKTHROUGH_INSTALL_OPERATION, client: tenant, database, asOf })');
    expect(seed).toContain('applyStandardStructureInTransaction(tx,');
  });
});
