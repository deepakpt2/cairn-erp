import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TARGETS } from '../scripts/browser-smoke/targets';
import { ACCEPTANCE_DATABASE_GUARDS } from '../scripts/browser-smoke/database-guards';

const capability = 'CFG.PROC.PURORG.DEFINE';
const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
const runner = readFileSync('scripts/browser-smoke.ts', 'utf8');
const checks = readFileSync('scripts/browser-smoke/checks.ts', 'utf8');
const checkStart = checks.indexOf('async function purchasingOrgDefinition(ctx: BrowserContext)');
const checkEnd = checks.indexOf('\nexport const CHECKS:', checkStart);
const targetCheck = checks.slice(checkStart, checkEnd);

describe('SCR-017 guarded live-browser target contract', () => {
  it('reserves a unique fixture key and a guard naming the reviewed loopback database and its B-150 batch (R-77)', () => {
    const target = TARGETS.find((candidate) => candidate.id === 'purchasing-orgs');
    const guard = ACCEPTANCE_DATABASE_GUARDS['purchasing-orgs'];
    expect(target).toMatchObject({ client: 'T980' });
    expect(TARGETS.filter((candidate) => candidate.client === 'T980')).toHaveLength(1);
    expect(guard).toMatchObject({ database: 'cairn_b210', port: '5432', batch: 'B-150 local loopback' });
    expect(runner).toContain("assert.equal(process.env.CAIRN_ENV ?? 'development', 'development'");
    expect(runner).toContain('if (databaseGuard) await verifyAcceptanceDatabase(databaseGuard)');
  });

  it('adds a dedicated command and keeps post-run sign-out verification on the protected OX08 route', () => {
    expect(packageJson.scripts['smoke:browser:purchasing-orgs'])
      .toBe('tsx scripts/browser-smoke.ts --target purchasing-orgs');
    expect(runner).toContain("if (target.id === 'purchasing-orgs') return '/config/purchasing-orgs'");
    expect(checks).toContain("'purchasing-orgs': purchasingOrgDefinition,");
    expect(TARGETS.find((candidate) => candidate.id === 'purchasing-orgs')?.label)
      .toContain('exact-capability access');
  });

  it('covers OX08 lifecycle, assignment separation, forged-field resistance and Auditor read-only access', () => {
    expect(checkStart).toBeGreaterThanOrEqual(0);
    expect(targetCheck).toContain("'CFG.PROC.PURORG.DEFINE'");
    for (const marker of [
      'B149_PURORG_DEFINE',
      'purchasing.definer',
      'purchasing.viewer',
      "purchasing_org_plant",
      'company_code: null',
      'is_active: false',
      'changeReason',
      'deactivateReason',
      'spoofed.actor',
      'companyCode',
      'plant',
      'isActive',
      'No Plant assignments.',
      'Change history',
      'Read-only view. Changes require authority CFG.PROC.PURORG.DEFINE.',
      'reactivate',
    ]) {
      expect(targetCheck, marker).toContain(marker);
    }
    expect(targetCheck).toContain("changeHistory(tx, CLIENT, 'purchasing_org', code)");
    expect(targetCheck).not.toMatch(/(?:insert\s+into|update|delete\s+from)\s+purchasing_org(?:_plant)?/i);
    expect(targetCheck).toContain("page.goto(`${BASE}/config/purchasing-orgs?new=1&client=0100`");
    expect(targetCheck).toContain("page.goto(`${BASE}/config/purchasing-orgs?purchasingOrg=${code}&history=1&client=0100`");
  });
});
