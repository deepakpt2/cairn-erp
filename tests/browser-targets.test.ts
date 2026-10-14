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
  it('uses distinct reserved test keys, never the development company key', () => {
    expect(new Set(TARGETS.map((target) => target.client)).size).toBe(TARGETS.length);
    for (const target of TARGETS) expect(target.client).toMatch(/^T\d{3}$/);
    expect(TARGETS.some((target) => String(target.client) === '0100')).toBe(false);
  });
  it('keeps B-115 acceptance guarded by its own disposable database and port', () => {
    const definition = ACCEPTANCE_DATABASE_GUARDS['company-code-definition'];
    const assignment = ACCEPTANCE_DATABASE_GUARDS['company-code-coa-assignment'];
    expect(definition).toMatchObject({ database: 'cairn_b110', port: '55496', batch: 'B-110' });
    expect(assignment).toMatchObject({ database: 'cairn_b115', port: '55498', batch: 'B-115' });
    expect(assignment?.database).not.toBe(definition?.database);
    expect(assignment?.port).not.toBe(definition?.port);
  });
  it('keeps B-125 Plant definition browser acceptance isolated from B-123 service acceptance', () => {
    const plant = TARGETS.find((target) => target.id === 'plant-definition');
    const guard = ACCEPTANCE_DATABASE_GUARDS['plant-definition'];
    expect(plant).toMatchObject({ client: 'T984' });
    expect(guard).toMatchObject({ database: 'cairn_b125', port: '55521', batch: 'B-125' });
    expect(guard?.database).not.toBe('cairn_b123');
    expect(guard?.port).not.toBe('55520');
  });
  it('keeps B-129 Plant Company Code assignment acceptance isolated from B-125 and B-128', () => {
    const assignment = TARGETS.find((target) => target.id === 'plant-company-code-assignment');
    const guard = ACCEPTANCE_DATABASE_GUARDS['plant-company-code-assignment'];
    expect(assignment).toMatchObject({ client: 'T983' });
    expect(guard).toMatchObject({ database: 'cairn_b129', port: '55523', batch: 'B-129' });
    expect(guard?.database).not.toBe('cairn_b125');
    expect(guard?.database).not.toBe('cairn_b128');
    expect(guard?.port).not.toBe('55521');
  });
  it('keeps B-139 Storage Location browser acceptance isolated from the cross-tenant fixture key', () => {
    const storageLocations = TARGETS.find((target) => target.id === 'storage-locations');
    const guard = ACCEPTANCE_DATABASE_GUARDS['storage-locations'];
    expect(storageLocations).toMatchObject({ client: 'T981' });
    expect(guard).toMatchObject({ database: 'cairn_b139', port: '55525', batch: 'B-139' });
    expect(guard?.database).not.toBe('cairn_b137');
    expect(guard?.port).not.toBe('55556');
    expect(storageLocations?.client).not.toBe('T980');
  });
  it('keeps B-150 SCR-017 browser acceptance on a separate reserved fixture and database guard', () => {
    const purchasingOrgs = TARGETS.find((target) => target.id === 'purchasing-orgs');
    const guard = ACCEPTANCE_DATABASE_GUARDS['purchasing-orgs'];
    expect(purchasingOrgs).toMatchObject({ client: 'T980' });
    expect(purchasingOrgs?.client).not.toBe('T982');
    expect(guard).toMatchObject({ database: 'cairn_b150', port: '55527', batch: 'B-150' });
    expect(guard?.database).not.toBe('cairn_b145');
    expect(guard?.port).not.toBe('38436');
  });
  it('keeps B-151 SCR-018 assignment acceptance isolated from OX08 browser acceptance', () => {
    const assignment = TARGETS.find((target) => target.id === 'purchasing-org-company-code');
    const guard = ACCEPTANCE_DATABASE_GUARDS['purchasing-org-company-code'];
    expect(assignment).toMatchObject({ client: 'T979' });
    expect(assignment?.client).not.toBe('T980');
    expect(guard).toMatchObject({ database: 'cairn_b151', port: '55528', batch: 'B-151' });
    expect(guard?.database).not.toBe('cairn_b150');
    expect(guard?.port).not.toBe('55527');
  });
  it('reserves T976 for SCR-021 Sales Organization Company Code assignment', () => {
    const assignment = TARGETS.find((target) => target.id === 'sales-org-company-code');
    expect(assignment).toMatchObject({ client: 'T976' });
    expect(assignment?.client).not.toBe('T977');
    expect(assignment?.client).not.toBe('T978');
    expect(assignment?.client).not.toBe('T979');
    expect(assignment?.client).not.toBe('T980');
  });
  it('keeps B-152 SCR-019 acceptance on a distinct reserved client, database and port', () => {
    const groups = TARGETS.find((target) => target.id === 'purchasing-groups');
    const guard = ACCEPTANCE_DATABASE_GUARDS['purchasing-groups'];
    expect(groups).toMatchObject({ client: 'T978' });
    expect(groups?.client).not.toBe('T982');
    expect(groups?.client).not.toBe('T979');
    expect(groups?.client).not.toBe('T980');
    expect(groups?.client).not.toBe('T981');
    expect(guard).toMatchObject({ database: 'cairn_b152', port: '55529', batch: 'B-152' });
    expect(guard?.database).not.toBe('cairn_b150');
    expect(guard?.database).not.toBe('cairn_b151');
    expect(guard?.port).not.toBe('55527');
    expect(guard?.port).not.toBe('55528');
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
