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

  it('drives one press per unassign and refuses a second session that is told to display', () => {
    for (const phrase of [
      'const unassignRow = async (',
      "await unassignRow(firstRow, 'M210', 'M201');",
      "await unassignRow(secondRow, 'M210', 'M202');",
      'A display-only opening must not offer the press.',
      'is being changed by ${HOLDER}',
      'A refused unassign moved nothing.',
      'the refused press reached the action; the viewer was told:',
      'a lock nobody answers is released about three minutes after its last answer',
      "username: 'ox19.both.other'",
      'No lock stands after the holder finished.',
    ]) {
      expect(ox19).toContain(phrase);
    }
    // The single press is the workflow under test. A retry here would hide the defect this round
    // exists to close, so the helper is read for how many times it presses.
    const body = /const unassignRow = async \(([\s\S]*?)\n  \};/.exec(ox19)?.[1] ?? '';
    expect(body).not.toBe('');
    expect((body.match(/\.click\(\)/g) ?? []).length).toBe(1);
    // The second session signs in on its own terms: copying the first session's cookies would be
    // the same holder, which is not the contention this phase is about.
    expect(ox19).toContain('await other.locator(\'[name="username"]\').fill(VIEWER);');
    expect(ox19).not.toContain('addCookies');
    // The refusal is asserted against the database and the audit history, not against a
    // screenshot: nothing moved, nothing was filed, and the holder kept what it held.
    expect(ox19).toContain('A refused unassign filed no audit record.');
  });

  it('cuts the action route to prove a failed claim, its retry control, and that neither files anything', () => {
    // The failure phase exists because the shared contract says a claim can fail for a reason the
    // platform never described. It is driven as an operator would meet it — press once, read the row,
    // ask again — and asserted against copy, the table, the audit history and the lock row.
    for (const phrase of [
      "const cut = async (route: Route) => (route.request().method() === 'POST' ? route.abort('failed') : route.continue());",
      'await page.route(samePage, cut);',
      'The change lock for this record could not be opened\\.',
      'Nothing was written\\. Try again, and if it fails again ask an administrator to check the server log\\.',
      'assert.match(failureAlerts, /Failed to fetch/);',
      "a failure notice must not publish internals.'",
      'cannot change it|not open for change|is being changed by|display only|lock monitor/i',
      'a failed claim may not report a change.',
      "'A failed claim files nothing, then or afterwards.'",
      "'A claim that never reached the server took no lock.'",
      "'A failed claim leaves the row pressable, so the operator can ask again.'",
      "const retryControl = failure.getByRole('button', { name: 'Try again', exact: true });",
      "'a retried claim files nothing either.'",
      "'a retried claim takes no lock it was not granted.'",
      'await page.unroute(samePage, cut);',
      'after a failed claim the row completes in one press, and nothing the failure dropped comes back',
    ]) {
      expect(ox19).toContain(phrase);
    }
    // The route is cut for one interaction and no more: it is detached before the press that is meant to
    // succeed, so the retry is a normal workflow rather than a permanently broken page.
    expect((ox19.match(/await page\.route\(samePage, cut\);/g) ?? []).length).toBe(1);
    expect((ox19.match(/await page\.unroute\(samePage, cut\);/g) ?? []).length).toBe(1);
    expect(ox19.indexOf('await page.unroute(samePage, cut);')).toBeLessThan(ox19.lastIndexOf('await failButton.click();'));
    // A click on the row's own button, not a keyboard shortcut or a programmatic submit: the press is the
    // workflow, in both the failing and the succeeding half of this phase.
    expect((ox19.match(/await failButton\.click\(\);/g) ?? []).length).toBe(2);
    expect(ox19).not.toMatch(/requestSubmit|dispatchEvent/);
  });
});
