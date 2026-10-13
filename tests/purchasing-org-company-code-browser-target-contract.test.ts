import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TARGETS } from '../scripts/browser-smoke/targets';
import { ACCEPTANCE_DATABASE_GUARDS } from '../scripts/browser-smoke/database-guards';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
const runner = readFileSync('scripts/browser-smoke.ts', 'utf8');
const checks = readFileSync('scripts/browser-smoke/checks.ts', 'utf8');
const start = checks.indexOf('async function purchasingOrgCompanyCodeAssignment(ctx: BrowserContext)');
const end = checks.indexOf('\nexport const CHECKS:', start);
const scenario = checks.slice(start, end);

describe('SCR-018 guarded browser target contract', () => {
  it('reserves its own tenant fixture and isolated disposable PostgreSQL guard', () => {
    const target = TARGETS.find((candidate) => candidate.id === 'purchasing-org-company-code');
    const guard = ACCEPTANCE_DATABASE_GUARDS['purchasing-org-company-code'];
    expect(target).toMatchObject({ client: 'T979' });
    expect(target?.client).not.toBe('T980');
    expect(guard).toMatchObject({ database: 'cairn_b151', port: '55528', batch: 'B-151' });
    expect(runner).toContain("target.id === 'purchasing-org-company-code'");
  });

  it('adds a one-target command and protects the assignment route after sign-out', () => {
    expect(packageJson.scripts['smoke:browser:purchasing-org-company-code'])
      .toBe('tsx scripts/browser-smoke.ts --target purchasing-org-company-code');
    expect(runner).toContain("if (target.id === 'purchasing-org-company-code') return '/config/purchasing-orgs/assign-company'");
    expect(checks).toContain("'purchasing-org-company-code': purchasingOrgCompanyCodeAssignment,");
  });

  it('covers pending OX08 definition, exact assignment authority, audit and read-only boundaries', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    for (const marker of [
      'B151_ASSIGN',
      'B151_DEFINE',
      'purchasing.assigner',
      'purchasing.definer',
      'purchasing.viewer',
      'company_code: null',
      "'CFG.PROC.PURORG.ASSIGN_COMPANY'",
      'spoofed.actor',
      'changeHistory(tx, CLIENT, \'purchasing_org\', code)',
      'no replacement or clear control.',
      'Read-only view. Changes require authority CFG.PROC.PURORG.ASSIGN_COMPANY.',
    ]) expect(scenario, marker).toContain(marker);
    expect(scenario).not.toMatch(/(?:insert\s+into|update|delete\s+from)\s+purchasing_org(?:_plant)?/i);
  });
});
