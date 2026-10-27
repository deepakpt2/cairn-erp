/**
 * The three configuration screens whose change lock is now proven in a browser, and the harness that
 * proves it.
 *
 * Pass 36 added Movement Types, Valuation Classes and Batch Document Management as browser targets. A
 * `.tsx` component cannot be mounted in this vitest setup, and running a target belongs to the smoke
 * runner rather than to the suite — so what is pinned here is the harness's *obligations*: that each target
 * is registered on its own reserved key, that it looks for the catalogue's failure lines instead of
 * inventing prose, that it measures the record and the audit trail rather than only the page, and that the
 * interception which opens a pending or failed window is filtered to this screen's claim and released again
 * by reference. A target that quietly stopped doing any of those would leave its screen "covered" by a run
 * that proves less than its name claims.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { TARGETS } from '../scripts/browser-smoke/targets';

const SUITE = [
  { id: 'movement-types', route: '/config/movement-types', module: 'scripts/browser-smoke/movement-types.ts' },
  { id: 'valuation-classes', route: '/config/valuation-classes', module: 'scripts/browser-smoke/valuation-classes.ts' },
  {
    id: 'batch-document-management',
    route: '/config/batch-document-management',
    module: 'scripts/browser-smoke/batch-document-management.ts',
  },
  {
    id: 'settlement-configuration',
    route: '/config/settlement-configuration',
    module: 'scripts/browser-smoke/settlement-configuration.ts',
  },
] as const;

const FAILURE_COPY = 'The change lock for this record could not be opened.';
const RECOVERY_COPY = 'Nothing was written. Try again, and if it fails again ask an administrator to check the server log.';

const source = (path: string) => readFileSync(path, 'utf8');
const moduleOf = (id: string) => source(SUITE.find((entry) => entry.id === id)!.module);

/**
 * The screens that render `ClaimFailureNotice`, and with it the catalogue's retry control. The fourth target
 * drives a screen that was never migrated to that notice: it gets the failure from `projectClaim` alone and
 * recovers by asking again, which is a different shape and gets its own case below (DI-002).
 */
const MIGRATED = ['movement-types', 'valuation-classes', 'batch-document-management'];

describe('the change-lock configuration browser targets', () => {
  it('are registered, each on a key no other target shares', () => {
    const runner = source('scripts/browser-smoke.ts');
    const checks = source('scripts/browser-smoke/checks.ts');
    for (const { id, route } of SUITE) {
      const target = TARGETS.find((entry) => entry.id === id);
      expect(target, id).toBeTruthy();
      expect(TARGETS.filter((entry) => entry.client === target?.client).length, `${id} owns its client key`).toBe(1);
      // Registered twice over: a check to run, and a protected route the run must refuse after sign-out.
      expect(checks, `${id} is wired into CHECKS`).toContain(`'${id}':`);
      expect(runner, `${id} states its own protected route`).toContain(`'${id}') return '${route}'`);
    }
  });

  it('drive the screen from a fixture tenant and tear that tenant down by its reserved key', () => {
    const runner = source('scripts/browser-smoke.ts');
    expect(runner).toContain('delete from client where client = ${target.client} and name = ${FIXTURE_NAME} and is_development = true');
    for (const { id } of SUITE) {
      const text = moduleOf(id);
      // The tenant and its sessions come from the app: onboarding through `/clients/new`, sign-in through
      // the form. No harness may mint a session or a user behind the authorization layer.
      expect(text, `${id}: no session minted`).not.toMatch(/insert into (user_session|app_user|session)/);
      expect(text, `${id}: reads through the tenant connection`).toContain('withTenant');
      expect(text, `${id}: signs a second session in through the form`).toMatch(/\/signin|Sign in/);
    }
  });

  it('look for the catalogue copy a failed claim speaks, and locate it inside the region that renders it', () => {
    for (const { id } of SUITE) {
      const text = moduleOf(id);
      expect(text, `${id}: the failure message`).toContain(FAILURE_COPY);
      expect(text, `${id}: the recovery line`).toMatch(/Nothing was written\. Try again|RECOVERY_COPY/);
      expect(text, `${id}: the recovery copy is the catalogue's own`).toContain(RECOVERY_COPY);
      // The retry control is a *migrated* screen's affordance; a legacy screen has none, and its run must not
      // claim one. The migrated list is checked for the press itself in the case below.
      if (MIGRATED.includes(id)) expect(text, `${id}: the retry control is pressed, not described`).toContain("'Try again'");
      // Next keeps an empty `role="alert"` announcer on every page: waiting on the document-wide role is how
      // a run ends up waiting for a node that is never removed.
      expect(text, `${id}: never waits on the route announcer`).not.toContain("page.getByRole('alert')");
      expect(text, `${id}: the notice is located in its region`).toMatch(/(form|otherForm|failure)\.(getByRole\('alert'\)|getByText|allInnerTexts|waitFor)/);
    }
  });

  it('measure the record and the audit trail at every claim phase, not only the notice', () => {
    for (const { id } of SUITE) {
      const text = moduleOf(id);
      const reads = (text.match(/await read(Indicator|Movement|Reference|Structure)\(/g) ?? []).length;
      expect(reads, `${id}: its table is read on both sides of each claim`).toBeGreaterThanOrEqual(5);
      const audits = (text.match(/await auditRows\(/g) ?? []).length;
      expect(audits, `${id}: audit records are counted around each phase`).toBeGreaterThanOrEqual(6);
      expect(text, `${id}: proves a lock really stood for the grant`).toMatch(/waitFor(?:Held)?Lock\(/);
      expect(text, `${id}: scopes lock reads to the record this screen owns`).toMatch(/lock_object = \$\{LOCK_OBJECT\}|and lock_object = /);
    }
  });

  it('use a real second session for contention, and keep a refusal out of the failure costume', () => {
    for (const { id } of SUITE) {
      const text = moduleOf(id);
      expect(text, `${id}: opens a second browser session`).toContain('browser.newContext');
      expect(text, `${id}: reads the refusal the platform worded`).toMatch(/is being changed by/);
      expect(text, `${id}: asserts the recovery sentence the refusal carries`).toMatch(/a lock nobody answers is released|Display does not take the lock/);
      expect(text, `${id}: refuses to read a refusal as a failure`).toMatch(/never dressed as/);
      expect(text, `${id}: the refused session files nothing`).toMatch(/moved nothing|files nothing|wrote nothing/);
      expect(text, `${id}: closes the second session`).toContain('second.close()');
    }
  });

  it('hold only the claim of this screen in a pending window, and let the handler go afterwards', () => {
    for (const { id } of SUITE) {
      const text = moduleOf(id);
      // A blanket interception would also swallow the release a component files as it unmounts, and the
      // run would then be measuring its own traffic jam. So: filter by method, and by this screen's claim.
      expect(text, `${id}: leaves non-POSTs alone`).toContain("method() !== 'POST'");
      expect(text, `${id}: holds only this screen's claim`).toMatch(/includes\(TX_CODE\)|includes\('ODOC'\)/);
      // `unroute` removes only a handler it can identify, so every gate is a named function, and every gate
      // that is installed is taken down again.
      const installs = (text.match(/page\.route\(/g) ?? []).length;
      const removals = (text.match(/page\.unroute\(/g) ?? []).length;
      expect(removals, `${id}: every route it installs it also removes`).toBe(installs);
      // `unroute(url, handler)` only lets go of a handler the runner can name, so a gate that is installed
      // anonymously would outlive its phase and swallow a later claim — which is exactly how Pass 36's first
      // run of this target lost its retry.
      const removed = text.match(/page\.unroute\([^;]*\);/g) ?? [];
      expect(removed.length, `${id}: every interception it installs it also takes down`).toBe(installs);
      for (const call of removed) {
        expect(call, `${id}: released by reference — ${call}`).toMatch(/, (?:gate|cut),?\);/);
      }
    }
  });

  it('exercise a retry into the same failure before the retry that gets through', () => {
    for (const id of MIGRATED) {
      const text = moduleOf(id);
      const presses = (text.match(/'Try again', exact: true \}\)\.click\(\)|retry\.click\(\)/g) ?? []).length;
      expect(presses, `${id}: retried once into the failure and once out of it`).toBeGreaterThanOrEqual(2);
      expect(text, `${id}: nothing arrives between the failure and the recovery`).toMatch(
        /Nothing was applied between the failure and the (?:grant|re-open)|the dropped press never comes back/,
      );
      expect(text, `${id}: exactly one change is audited after the retry`).toMatch(
        /grantedAfterOwed \+ 1|auditAtGrant \+ 1|auditBeforeFailure \+ 1/,
      );
    }
  });

  it('recover from a dead claim on an unmigrated screen the only way that screen has, a fresh claim', () => {
    // DI-002 in `docs/DEFERRED_ISSUES.md`: `ClaimFailureNotice`, and with it the retry button, is mounted on
    // the migrated screens only. A legacy screen gets the failure from `projectClaim` and has to ask again,
    // so its target must prove that *that* path recovers the row — and must not invent a control the screen
    // does not have.
    const text = moduleOf('settlement-configuration');
    expect(text, 'the failure is read from the notice the screen renders').not.toMatch(/getByRole\('alert'\)/);
    expect(text, 'no retry control is pressed on a screen that has none').not.toMatch(/Try again', exact: true \}\)\.click\(\)/);
    const closeAt = text.indexOf("name: 'Close', exact: true })");
    const reopenAt = text.indexOf("name: 'Edit', exact: true })", closeAt);
    expect(closeAt, 'the run leaves the row the claim died on').toBeGreaterThanOrEqual(0);
    expect(reopenAt, 'and chooses it again, which files a fresh claim').toBeGreaterThan(closeAt);
    // Whatever the run does in between, it must not press a control the screen does not render.
    const between = text.slice(closeAt, reopenAt);
    expect(between, 'no retry control is pressed between the two').not.toContain("name: 'Try again'");
    expect(between, 'the re-open is preceded by waiting the retired notice out, not by a button').toContain("failure.waitFor({ state: 'detached' })");
    expect(text, 'the projection is what closes the write, and the run says so').toContain('the projection answers DISPLAY');
  });

  it('leave no lock standing for a dead claim, and none behind when the run moves on', () => {
    for (const { id } of SUITE) {
      const text = moduleOf(id);
      expect(text, `${id}: a dead claim leaves no lock`).toContain('left no lock standing');
      expect(text, `${id}: leaving the screen releases the lock`).toMatch(/releas(?:ed|es)(?: the(?: change)?| its) lock/);
      // The release has to be an in-app navigation, or Chromium drops it the way it drops any request in
      // flight during a document load — which would make the assertion above measure the harness.
      expect(text, `${id}: releases through an in-app navigation`).toMatch(/getByRole\('link'|a\[href=|locator\('a\[href/);
    }
  });
});
