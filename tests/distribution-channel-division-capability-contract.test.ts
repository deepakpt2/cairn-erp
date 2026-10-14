import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const seed = readFileSync('scripts/seed.ts', 'utf8');
const tenancy = readFileSync('src/platform/tenancy/index.ts', 'utf8');
const activities = seed.slice(seed.indexOf('const ACTIVITIES'), seed.indexOf('const CAPABILITIES'));
const capabilities = seed.slice(seed.indexOf('const CAPABILITIES'), seed.indexOf('const REGISTRY'));
const registry = seed.slice(seed.indexOf('const REGISTRY'), seed.indexOf('const MESSAGES'));

describe('SCR-022 Distribution Channel and Division capability/registry contract', () => {
  it('keeps the two tenant activities and routes separate', () => {
    expect(activities).toContain("code: 'CFG.ORG.DISTCHANNEL.DEFINE'");
    expect(activities).toContain("route: '/config/distribution-channels'");
    expect(activities).toContain("code: 'CFG.ORG.DIVISION.DEFINE'");
    expect(activities).toContain("route: '/config/divisions'");
  });

  it('registers each exact non-posting configure capability and preserves its default role grant', () => {
    expect(capabilities).toMatch(/\{ code: 'CFG\.ORG\.DISTCHANNEL\.DEFINE', module: 'SALES', action: 'CONFIGURE', posting: false,/);
    expect(capabilities).toMatch(/\{ code: 'CFG\.ORG\.DIVISION\.DEFINE', module: 'SALES', action: 'CONFIGURE', posting: false,/);
    expect(tenancy).toContain("'CFG.ORG.DISTCHANNEL.DEFINE'");
    expect(tenancy).toContain("'CFG.ORG.DIVISION.DEFINE'");
  });

  it('adds both native workbench terms and search-only transaction aliases', () => {
    expect(registry).toContain("ourCode: 'CFG.ORG.DISTCHANNEL.DEFINE'");
    expect(registry).toContain("route: '/config/distribution-channels'");
    expect(registry).toContain("aliases: ['OVXI']");
    expect(registry).toContain("ourCode: 'CFG.ORG.DIVISION.DEFINE'");
    expect(registry).toContain("route: '/config/divisions'");
    expect(registry).toContain("aliases: ['OVXB']");
  });
});
