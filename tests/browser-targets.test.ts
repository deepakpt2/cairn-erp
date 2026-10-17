import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TARGETS, FIXTURE_NAME, RUN_TIMEOUT_MS, browserRunTimeoutMs, browserTimeoutMs, STATIC_ACCEPTANCE_TARGETS, parseBrowserCommand, isOwnedFixture } from '../scripts/browser-smoke/targets';
import { ACCEPTANCE_DATABASE_GUARDS } from '../scripts/browser-smoke/database-guards';

describe('bounded browser target selection', () => {
  it('defaults to the existing foundation regression only', () => {
    expect(parseBrowserCommand([])).toEqual({ mode: 'run', target: TARGETS[0] });
  });
  it.each(TARGETS.map((target) => [target.id, target] as const))('selects %s independently', (id, target) => {
    expect(parseBrowserCommand(['--target', id])).toEqual({ mode: 'run', target });
  });
  it('accepts the equals-form flag without adding another target', () => {
    expect(parseBrowserCommand(['--target=material-mrp'])).toEqual({ mode: 'run', target: TARGETS[3] });
  });
  it.each(['help', 'list'])('supports --%s without choosing a browser run', (mode) => {
    expect(parseBrowserCommand([`--${mode}`])).toEqual({ mode });
  });
  it.each([['--all'], ['--target'], ['--target', 'foundation', '--target', 'material-basic'], ['--list', '--target', 'foundation']])('rejects combined or malformed arguments %j', (...args) => {
    expect(() => parseBrowserCommand(args)).toThrow('exactly one target');
  });
  it.each(['unknown', '', 'Foundation', '0100'])('rejects an unknown target %j', (name) => {
    expect(() => parseBrowserCommand(['--target', name])).toThrow('Unknown browser target');
  });
  it('binds every browser target to a reviewed database, and every guard to a real target', () => {
    // The runner verifies a guard that exists and runs a target that has none, so completeness is
    // the whole protection: one missing entry silently drops the check for that target.
    const unguarded = TARGETS.filter((target) => !ACCEPTANCE_DATABASE_GUARDS[target.id]).map((target) => target.id);
    expect(unguarded).toEqual([]);
    const stale = Object.keys(ACCEPTANCE_DATABASE_GUARDS).filter(
      (id) => !TARGETS.some((target) => target.id === id),
    );
    expect(stale).toEqual([]);
    for (const target of TARGETS) {
      const guard = ACCEPTANCE_DATABASE_GUARDS[target.id];
      expect(guard?.database, target.id).toMatch(/^cairn/);
      expect(guard?.port, target.id).toMatch(/^\d+$/);
      expect(guard?.batch, target.id).toMatch(/\S/);
    }
  });
  it('rebinds business-partners bank fixture writes to the guarded migration connection (R-79)', () => {
    const target = TARGETS.find((candidate) => candidate.id === 'business-partners');
    const guard = ACCEPTANCE_DATABASE_GUARDS['business-partners'];
    expect(target).toMatchObject({ client: 'T992' });
    expect(guard).toMatchObject({ database: 'cairn_b210', port: '5432' });
    const checksSource = readFileSync('scripts/browser-smoke/checks.ts', 'utf8');
    expect(checksSource).toContain('process.env.MIGRATION_DATABASE_URL');
    expect(checksSource).toContain("ACCEPTANCE_DATABASE_GUARDS['business-partners']");
    expect(checksSource).not.toContain('CAIRN_SMOKE_FIXTURE_DATABASE_URL');
    expect(checksSource).not.toContain("'cairn_test'");
  });
  it('uses distinct reserved test keys, never the development company key', () => {
    expect(new Set(TARGETS.map((target) => target.client)).size).toBe(TARGETS.length);
    for (const target of TARGETS) expect(target.client).toMatch(/^T\d{3}$/);
    expect(TARGETS.some((target) => String(target.client) === '0100')).toBe(false);
  });
  it('keeps B-110 and B-115 acceptance on the reviewed loopback database, apart by fixture key (R-77)', () => {
    const definition = ACCEPTANCE_DATABASE_GUARDS['company-code-definition'];
    const assignment = ACCEPTANCE_DATABASE_GUARDS['company-code-coa-assignment'];
    expect(definition).toMatchObject({ database: 'cairn_b210', port: '5432', batch: 'B-110 local loopback' });
    expect(assignment).toMatchObject({ database: 'cairn_b210', port: '5432', batch: 'B-115 local loopback' });
    // Separate clusters are not available here, so what keeps the two apart is the reserved key.
    const definitionKey = TARGETS.find((target) => target.id === 'company-code-definition')?.client;
    const assignmentKey = TARGETS.find((target) => target.id === 'company-code-coa-assignment')?.client;
    expect(assignmentKey).not.toBe(definitionKey);
  });
  it('keeps B-125 Plant definition browser acceptance on the reviewed loopback database, named for its batch (R-77)', () => {
    const plant = TARGETS.find((target) => target.id === 'plant-definition');
    const guard = ACCEPTANCE_DATABASE_GUARDS['plant-definition'];
    expect(plant).toMatchObject({ client: 'T984' });
    expect(guard).toMatchObject({ database: 'cairn_b210', port: '5432', batch: 'B-125 local loopback' });
    expect(guard?.batch).toMatch(/B-125/);
    expect(plant?.client).not.toBe(TARGETS.find((target) => target.id === 'plant-company-code-assignment')?.client);
  });
  it('keeps B-129 Plant Company Code assignment acceptance on the reviewed loopback database, named for its batch (R-77)', () => {
    const assignment = TARGETS.find((target) => target.id === 'plant-company-code-assignment');
    const guard = ACCEPTANCE_DATABASE_GUARDS['plant-company-code-assignment'];
    expect(assignment).toMatchObject({ client: 'T983' });
    expect(guard).toMatchObject({ database: 'cairn_b210', port: '5432', batch: 'B-129 local loopback' });
    expect(guard?.batch).toMatch(/B-129/);
  });
  it('keeps B-139 Storage Location browser acceptance on the reviewed loopback database, off the cross-tenant fixture key (R-77)', () => {
    const storageLocations = TARGETS.find((target) => target.id === 'storage-locations');
    const guard = ACCEPTANCE_DATABASE_GUARDS['storage-locations'];
    expect(storageLocations).toMatchObject({ client: 'T981' });
    expect(guard).toMatchObject({ database: 'cairn_b210', port: '5432', batch: 'B-139 local loopback' });
    expect(guard?.batch).toMatch(/B-139/);
    expect(storageLocations?.client).not.toBe('T980');
  });
  it('keeps B-150 SCR-017 browser acceptance on a separate reserved fixture and the reviewed loopback guard (R-77)', () => {
    const purchasingOrgs = TARGETS.find((target) => target.id === 'purchasing-orgs');
    const guard = ACCEPTANCE_DATABASE_GUARDS['purchasing-orgs'];
    expect(purchasingOrgs).toMatchObject({ client: 'T980' });
    expect(purchasingOrgs?.client).not.toBe('T982');
    expect(guard).toMatchObject({ database: 'cairn_b210', port: '5432', batch: 'B-150 local loopback' });
    expect(guard?.batch).toMatch(/B-150/);
  });
  it('keeps B-151 SCR-018 assignment acceptance on the reviewed loopback database, off the OX08 fixture key (R-77)', () => {
    const assignment = TARGETS.find((target) => target.id === 'purchasing-org-company-code');
    const guard = ACCEPTANCE_DATABASE_GUARDS['purchasing-org-company-code'];
    expect(assignment).toMatchObject({ client: 'T979' });
    expect(assignment?.client).not.toBe('T980');
    expect(guard).toMatchObject({ database: 'cairn_b210', port: '5432', batch: 'B-151 local loopback' });
    expect(guard?.batch).toMatch(/B-151/);
  });
  it('reserves T976 for SCR-021 Sales Organization Company Code assignment', () => {
    const assignment = TARGETS.find((target) => target.id === 'sales-org-company-code');
    expect(assignment).toMatchObject({ client: 'T976' });
    expect(assignment?.client).not.toBe('T977');
    expect(assignment?.client).not.toBe('T978');
    expect(assignment?.client).not.toBe('T979');
    expect(assignment?.client).not.toBe('T980');
  });
  it('reserves T973 and loopback PostgreSQL for OVXA Sales Organization / Division acceptance', () => {
    const assignment = TARGETS.find((target) => target.id === 'sales-org-division');
    const guard = ACCEPTANCE_DATABASE_GUARDS['sales-org-division'];
    expect(assignment).toMatchObject({ client: 'T973' });
    expect(assignment?.client).not.toBe('T974');
    expect(assignment?.client).not.toBe('T975');
    expect(assignment?.client).not.toBe('T976');
    expect(assignment?.client).not.toBe('T977');
    // OVXA recorded the local database name of its day; this environment's reviewed loopback
    // database is cairn_b210, so the guard names that and the target runs again.
    expect(guard).toMatchObject({ database: 'cairn_b210', port: '5432', batch: 'OVXA local loopback' });
    expect(guard?.batch).toMatch(/local loopback/);
  });
  it('reserves T972 for SCR-024 OKKP and binds it only to local PostgreSQL', () => {
    const okkp = TARGETS.find((target) => target.id === 'controlling-area');
    const guard = ACCEPTANCE_DATABASE_GUARDS['controlling-area'];
    expect(okkp).toMatchObject({ client: 'T972' });
    expect(okkp?.client).not.toBe('T973');
    // SCR-024 recorded the local database name of its day. This environment's reviewed loopback
    // database is cairn_b210, so the guard names that and the target runs again.
    expect(guard).toMatchObject({ database: 'cairn_b210', port: '5432', batch: 'SCR-024 local loopback' });
    expect(guard?.batch).toMatch(/local loopback/);
    expect(STATIC_ACCEPTANCE_TARGETS.has('controlling-area')).toBe(false);
  });
  it('reserves T970 for SCR-025 OX19 and binds acceptance to a guarded local PostgreSQL database', () => {
    const ox19 = TARGETS.find((target) => target.id === 'controlling-area-company-assignment');
    const guard = ACCEPTANCE_DATABASE_GUARDS['controlling-area-company-assignment'];
    expect(ox19).toMatchObject({ client: 'T970' });
    expect(guard).toMatchObject({ database: 'cairn_b210', port: '5432', batch: 'B-211 local loopback' });
    expect(guard?.database).not.toBe('cairn');
    expect(guard?.database).not.toBe('cairn_b115');
    expect(STATIC_ACCEPTANCE_TARGETS.has('controlling-area-company-assignment')).toBe(false);
  });
  it('reserves T969 for SCR-026 OB13 on the guarded local acceptance database', () => {
    const ob13 = TARGETS.find((target) => target.id === 'chart-of-accounts');
    const guard = ACCEPTANCE_DATABASE_GUARDS['chart-of-accounts'];
    expect(ob13).toMatchObject({ client: 'T969' });
    expect(ob13?.client).not.toBe('T970');
    expect(guard).toMatchObject({ database: 'cairn_b210', port: '5432', batch: 'SCR-026 local loopback' });
    expect(STATIC_ACCEPTANCE_TARGETS.has('chart-of-accounts')).toBe(false);
  });
  it('keeps SCR-028 FS00 acceptance on its own reserved client and the loopback guard OB13 uses', () => {
    const fs00 = TARGETS.find((target) => target.id === 'gl-accounts');
    const guard = ACCEPTANCE_DATABASE_GUARDS['gl-accounts'];
    expect(fs00).toMatchObject({ client: 'T968' });
    expect(fs00?.client).not.toBe('T969');
    expect(guard).toMatchObject({ database: 'cairn_b210', port: '5432', batch: 'SCR-028 local loopback' });
    expect(STATIC_ACCEPTANCE_TARGETS.has('gl-accounts')).toBe(false);
  });
  it('keeps B-152 SCR-019 acceptance on a distinct reserved client and the reviewed loopback guard (R-77)', () => {
    const groups = TARGETS.find((target) => target.id === 'purchasing-groups');
    const guard = ACCEPTANCE_DATABASE_GUARDS['purchasing-groups'];
    expect(groups).toMatchObject({ client: 'T978' });
    expect(groups?.client).not.toBe('T982');
    expect(groups?.client).not.toBe('T979');
    expect(groups?.client).not.toBe('T980');
    expect(groups?.client).not.toBe('T981');
    expect(guard).toMatchObject({ database: 'cairn_b210', port: '5432', batch: 'B-152 local loopback' });
    expect(guard?.batch).toMatch(/B-152/);
  });
  it('limits each browser target to two minutes', () => {
    expect(RUN_TIMEOUT_MS).toBe(120_000);
  });
});

describe('static-database acceptance mode (D-097)', () => {
  it('approves only the owner-directed static-database browser targets', () => {
    expect([...STATIC_ACCEPTANCE_TARGETS].sort()).toEqual([
      'distribution-channels',
      'divisions',
      'purchasing-groups',
      'purchasing-org-company-code',
      'sales-org-company-code',
      'sales-orgs',
    ]);
    for (const id of STATIC_ACCEPTANCE_TARGETS) {
      expect(TARGETS.some((target) => target.id === id)).toBe(true);
    }
  });
  it('keeps the 120-second contract deadline as the default and allows only a raise through the environment', () => {
    delete process.env.CAIRN_BROWSER_RUN_TIMEOUT_MS;
    expect(browserRunTimeoutMs()).toBe(120_000);
    process.env.CAIRN_BROWSER_RUN_TIMEOUT_MS = '600000';
    expect(browserRunTimeoutMs()).toBe(600_000);
    process.env.CAIRN_BROWSER_RUN_TIMEOUT_MS = '1000';
    expect(browserRunTimeoutMs()).toBe(120_000);
    delete process.env.CAIRN_BROWSER_RUN_TIMEOUT_MS;
  });
  it('keeps page and navigation timeouts at their contract defaults unless explicitly raised', () => {
    delete process.env.CAIRN_BROWSER_PAGE_TIMEOUT_MS;
    delete process.env.CAIRN_BROWSER_NAV_TIMEOUT_MS;
    expect(browserTimeoutMs('CAIRN_BROWSER_PAGE_TIMEOUT_MS', 30_000)).toBe(30_000);
    expect(browserTimeoutMs('CAIRN_BROWSER_NAV_TIMEOUT_MS', 60_000)).toBe(60_000);
    process.env.CAIRN_BROWSER_NAV_TIMEOUT_MS = '5000';
    expect(browserTimeoutMs('CAIRN_BROWSER_NAV_TIMEOUT_MS', 60_000)).toBe(60_000);
    process.env.CAIRN_BROWSER_NAV_TIMEOUT_MS = '300000';
    expect(browserTimeoutMs('CAIRN_BROWSER_NAV_TIMEOUT_MS', 60_000)).toBe(300_000);
    delete process.env.CAIRN_BROWSER_NAV_TIMEOUT_MS;
  });
  it('does not carry static-database connection details in the repository', () => {
    const source = readFileSync('scripts/browser-smoke.ts', 'utf8');
    expect(source).toContain('CAIRN_TEST_DATABASE_URL');
    expect(source).not.toMatch(/supabase|pooler\.supabase|yyskxzdytncsatwjkiva/i);
  });
});

describe('browser fixture ownership guard', () => {
  const target = TARGETS[0];
  const fixture = { client: target.client, name: FIXTURE_NAME, is_development: true };
  it('recognises only the exact owned fixture', () => {
    expect(isOwnedFixture(target, fixture)).toBe(true);
  });
  it('refuses a differently named tenant with the same key', () => {
    expect(isOwnedFixture(target, { ...fixture, name: 'Owner company' })).toBe(false);
  });
  it('refuses a non-development tenant', () => {
    expect(isOwnedFixture(target, { ...fixture, is_development: false })).toBe(false);
  });
  it('refuses a tenant with a different key', () => {
    expect(isOwnedFixture(target, { ...fixture, client: '0100' })).toBe(false);
  });
});
