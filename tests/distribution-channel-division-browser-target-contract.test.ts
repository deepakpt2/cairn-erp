import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STATIC_ACCEPTANCE_TARGETS, TARGETS } from '../scripts/browser-smoke/targets';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
const runner = readFileSync('scripts/browser-smoke.ts', 'utf8');
const checksSource = readFileSync('scripts/browser-smoke/checks.ts', 'utf8');
const checksStart = checksSource.indexOf('async function distributionDimensionDefinition');
const checksEnd = checksSource.indexOf('\nasync function distributionChannels', checksStart);
const check = checksSource.slice(checksStart, checksEnd);

describe('SCR-022 Distribution Channel and Division isolated browser targets', () => {
  it('reserves unique owner-static acceptance tenants and protected routes', () => {
    const channelTarget = TARGETS.find((target) => target.id === 'distribution-channels');
    const divisionTarget = TARGETS.find((target) => target.id === 'divisions');
    expect(channelTarget).toMatchObject({ client: 'T975' });
    expect(divisionTarget).toMatchObject({ client: 'T974' });
    expect(TARGETS.filter((target) => target.client === 'T975')).toHaveLength(1);
    expect(TARGETS.filter((target) => target.client === 'T974')).toHaveLength(1);
    expect(STATIC_ACCEPTANCE_TARGETS.has('distribution-channels')).toBe(true);
    expect(STATIC_ACCEPTANCE_TARGETS.has('divisions')).toBe(true);
    expect(runner).toContain("if (target.id === 'distribution-channels') return '/config/distribution-channels'");
    expect(runner).toContain("if (target.id === 'divisions') return '/config/divisions'");
  });

  it('registers one independently runnable smoke command for each activity', () => {
    expect(packageJson.scripts['smoke:browser:distribution-channels'])
      .toBe('tsx scripts/browser-smoke.ts --target distribution-channels');
    expect(packageJson.scripts['smoke:browser:divisions'])
      .toBe('tsx scripts/browser-smoke.ts --target divisions');
    expect(checksSource).toContain("'distribution-channels': distributionChannels,");
    expect(checksSource).toContain('  divisions,');
  });

  it('covers distinct exact capabilities, copy-as-new, audited name change, reference guard and mobile layout', () => {
    expect(check).toContain("'CFG.ORG.DISTCHANNEL.DEFINE'");
    expect(check).toContain("'CFG.ORG.DIVISION.DEFINE'");
    for (const marker of [
      'role_capability',
      'distributionChannel',
      'name-only change increments the audit version',
      'Copy must require a new, immutable key.',
      'Sales Area dependency prevents deactivation',
      'isSecurityRelevant === \'true\'',
      'width: 390',
      'horizontalOverflow <= 1',
      'client: \'0100\', changedBy: \'spoofed.actor\', isActive: \'false\'',
      'Read-only user receives no',
    ]) expect(check, marker).toContain(marker);
    expect(checksSource).toContain('async function distributionChannels(ctx: BrowserContext)');
    expect(checksSource).toContain('async function divisions(ctx: BrowserContext)');
  });
});
