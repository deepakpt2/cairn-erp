import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasCapability } from '../src/platform/auth/session';

const defineCapability = 'CFG.ORG.COMPANYCODE.DEFINE';
const assignCoaCapability = 'CFG.ORG.COMPANYCODE.ASSIGN_COA';
const seedSource = readFileSync('scripts/seed.ts', 'utf8');
const capabilitySeed = seedSource.slice(
  seedSource.indexOf('const CAPABILITIES'),
  seedSource.indexOf('async function main()'),
);

describe('Company Code capability contract', () => {
  it('registers definition as a non-posting Foundation configuration capability without an explicit role grant', () => {
    expect(capabilitySeed).toContain(
      "{ code: 'CFG.ORG.COMPANYCODE.DEFINE', module: 'FND', action: 'CONFIGURE', posting: false, description: 'Define tenant-scoped company-code records' },",
    );
    expect(capabilitySeed).not.toMatch(/role_capability/i);
  });

  it('registers the chart-of-accounts assignment separately with no explicit role grant', () => {
    expect(capabilitySeed).toContain(
      "{ code: 'CFG.ORG.COMPANYCODE.ASSIGN_COA', module: 'FND', action: 'CONFIGURE', posting: false, description: 'Assign a chart of accounts to a Company Code' },",
    );
    expect(seedSource).toContain(
      "{ code: 'CFG.ORG.COMPANYCODE.ASSIGN_COA', area: 'ENTERPRISE_STRUCTURE', title: 'Assign chart of accounts to company code', kind: 'ASSIGN', prerequisites: ['CFG.ORG.COMPANYCODE.DEFINE', 'CFG.FIN.COA.DEFINE'], enables: 'Account posting', wizardStage: 'ONBOARDING', route: '/config/company-codes' },",
    );
    expect(capabilitySeed).not.toMatch(/role_capability/i);
  });

  it('preserves exact, Configurator-pattern, and Administrator-wildcard authorization semantics', () => {
    for (const capability of [defineCapability, assignCoaCapability]) {
      expect(hasCapability([capability], capability)).toBe(true);
      expect(hasCapability(['CFG.*'], capability)).toBe(true);
      expect(hasCapability(['*'], capability)).toBe(true);
      expect(hasCapability([], capability)).toBe(false);
    }
  });
});
