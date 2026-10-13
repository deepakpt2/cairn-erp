import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasCapability } from '../src/platform/auth/session';

const capability = 'CFG.PROC.PURORG.DEFINE';
const seedSource = readFileSync('scripts/seed.ts', 'utf8');
const activitySeed = seedSource.slice(
  seedSource.indexOf('const ACTIVITIES'),
  seedSource.indexOf('const CAPABILITIES'),
);
const capabilitySeed = seedSource.slice(
  seedSource.indexOf('const CAPABILITIES'),
  seedSource.indexOf('const REGISTRY'),
);

describe('SCR-017 Purchasing Organisation capability contract', () => {
  it('registers a dedicated non-posting Procurement configure capability without role grants', () => {
    expect(capabilitySeed).toContain(
      "{ code: 'CFG.PROC.PURORG.DEFINE', module: 'PROC', action: 'CONFIGURE', posting: false, description: 'Define and maintain tenant-scoped Purchasing Organisations' },",
    );
    expect(capabilitySeed).not.toMatch(/role_capability/i);
  });

  it('preserves exact, Configurator-wildcard and Administrator-wildcard semantics', () => {
    expect(hasCapability([capability], capability)).toBe(true);
    expect(hasCapability(['CFG.*'], capability)).toBe(true);
    expect(hasCapability(['*'], capability)).toBe(true);
    expect(hasCapability(['PROC.*'], capability)).toBe(false);
    expect(hasCapability([], capability)).toBe(false);
  });

  it('keeps the existing define activity and Company Code prerequisite unchanged', () => {
    expect(activitySeed).toContain(
      "{ code: 'CFG.PROC.PURORG.DEFINE', area: 'MATERIALS_MANAGEMENT', title: 'Define purchasing organisation', kind: 'DEFINE', prerequisites: ['CFG.ORG.COMPANYCODE.DEFINE'], enables: 'Purchasing', wizardStage: 'ONBOARDING', route: '/config/purchasing-orgs' },",
    );
  });
});
