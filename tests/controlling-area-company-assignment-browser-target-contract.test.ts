import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TARGETS, STATIC_ACCEPTANCE_TARGETS } from '../scripts/browser-smoke/targets';
import { ACCEPTANCE_DATABASE_GUARDS } from '../scripts/browser-smoke/database-guards';

const runner = readFileSync('scripts/browser-smoke.ts', 'utf8');
const targetSource = readFileSync('scripts/browser-smoke/targets.ts', 'utf8');
const checks = readFileSync('scripts/browser-smoke/checks.ts', 'utf8');
const ox19 = readFileSync('scripts/browser-smoke/ox19-assignment.ts', 'utf8');

describe('SCR-025 / OX19 browser acceptance target guard', () => {
  it('binds a unique reserved fixture and the reviewed loopback database', () => {
    const target = TARGETS.find((item) => item.id === 'controlling-area-company-assignment');
    const guard = ACCEPTANCE_DATABASE_GUARDS['controlling-area-company-assignment'];
    expect(target).toMatchObject({ client: 'T970' });
    expect(guard).toMatchObject({ database: 'cairn_b210', port: '5432', batch: 'B-211 local loopback' });
    expect(STATIC_ACCEPTANCE_TARGETS.has('controlling-area-company-assignment')).toBe(false);
    expect(targetSource).toContain("id: 'controlling-area-company-assignment'");
  });

  it('opens the OX19 route after sign-out and registers an independent browser check', () => {
    expect(runner).toContain("target.id === 'controlling-area-company-assignment') return '/config/controlling-area/assign-company-code'");
    expect(checks).toContain("'controlling-area-company-assignment': ox19Assignment");
    expect(ox19).toContain("page.waitForURL((url) => url.pathname === ROUTE");
    expect(ox19).toContain("getByRole('heading', { level: 1, name: 'Company Code Assignments'");
  });

  it('covers F4 eligibility, current assignment history, both scope rules and each approved capability', () => {
    for (const phrase of [
      'Open Controlling Area lookup (F4)',
      'Open Company Code lookup (F4)',
      'Not selectable',
      'DUPLICATE_NO_OP',
      'current CoA baseline',
      'SINGLE enforces exact Currency/Fiscal Year settings',
      'separate Unassign then Add',
      "'ox19.area.only', 'ox19.company.only'",
      "await signInAs('ox19.both')",
      'CONTROLLING_AREA_DEFINE, COMPANY_CODE_DEFINE',
    ]) {
      expect(ox19).toContain(phrase);
    }
  });
});
