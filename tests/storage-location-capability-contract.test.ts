import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasCapability } from '../src/platform/auth/session';

const capability = 'CFG.ORG.STORAGELOC.DEFINE';
const seedSource = readFileSync('scripts/seed.ts', 'utf8');
const capabilitySeed = seedSource.slice(
  seedSource.indexOf('const CAPABILITIES'),
  seedSource.indexOf('async function main()'),
);

describe('Storage Location capability contract', () => {
  it('registers a separate, non-posting Foundation configuration capability without role grants', () => {
    expect(capabilitySeed).toContain(
      "{ code: 'CFG.ORG.STORAGELOC.DEFINE', module: 'FND', action: 'CONFIGURE', posting: false, description: 'Define and maintain tenant-scoped Storage Locations' },",
    );
    expect(capabilitySeed).not.toMatch(/role_capability/i);
  });

  it('preserves exact, Configurator-pattern, and Administrator-wildcard authorization semantics', () => {
    expect(hasCapability([capability], capability)).toBe(true);
    expect(hasCapability(['CFG.*'], capability)).toBe(true);
    expect(hasCapability(['*'], capability)).toBe(true);
    expect(hasCapability([], capability)).toBe(false);
  });

  it('keeps the existing Storage Location activity linked to its parent Plant-definition prerequisite', () => {
    expect(seedSource).toContain(
      "{ code: 'CFG.ORG.STORAGELOC.DEFINE', area: 'ENTERPRISE_STRUCTURE', title: 'Define storage location', kind: 'DEFINE', prerequisites: ['CFG.ORG.PLANT.DEFINE'], enables: 'Stock management by area', wizardStage: 'ONBOARDING', route: '/config/storage-locations' },",
    );
  });
});
