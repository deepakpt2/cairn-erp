import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasCapability } from '../src/platform/auth/session';

const capability = 'CFG.ORG.COMPANYCODE.DEFINE';
const seedSource = readFileSync('scripts/seed.ts', 'utf8');
const capabilitySeed = seedSource.slice(
  seedSource.indexOf('const CAPABILITIES'),
  seedSource.indexOf('async function main()'),
);

describe('Company Code define capability contract', () => {
  it('registers a non-posting Foundation configuration capability without role grants', () => {
    expect(capabilitySeed).toContain(
      "{ code: 'CFG.ORG.COMPANYCODE.DEFINE', module: 'FND', action: 'CONFIGURE', posting: false, description: 'Define tenant-scoped company-code records' },",
    );
    expect(capabilitySeed).not.toMatch(/role_capability/i);
  });

  it('preserves exact and Administrator wildcard authorization semantics', () => {
    expect(hasCapability([capability], capability)).toBe(true);
    expect(hasCapability(['*'], capability)).toBe(true);
    expect(hasCapability([], capability)).toBe(false);
  });
});
