/**
 * The batch document management indicator, and the three answers of the claim its screen opens on mount.
 *
 * The screen keeps one row per client (KZDCD) and asks for a change lock before it will let that row be
 * written, so a single page exercises the whole contract: the grant that opens the form, the refusal that
 * turns a second visitor into a reader, the failure of a claim that never reached the server, and the retry
 * that has to start a new claim rather than replay the press the failure dropped. Every step is checked
 * against the table and the audit trail, not only against what the page says.
 */
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';
import type { Route } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserContext } from '../browser-smoke/checks';

const ROUTE = '/config/batch-document-management';
const PASSWORD = 'browser-check-2026';
const LOCK_OBJECT = 'BATCH_DOCUMENT_MANAGEMENT';
const TX_CODE = 'ODOC';
const FAILURE_COPY = 'The change lock for this record could not be opened.';
const RECOVERY_COPY = 'Nothing was written. Try again, and if it fails again ask an administrator to check the server log.';

type Indicator = { code: string; version: number; changedBy: string } | null;

async function readIndicator(client: string): Promise<Indicator> {
  const rows = (await withTenant(client, (tx) => tx.execute(sql`
    select document_management, version, changed_by from batch_document_management where client = ${client}
  `))) as unknown as Array<{ document_management: string; version: number; changed_by: string }>;
  const row = rows[0];
  return row ? { code: row.document_management.trim(), version: row.version, changedBy: row.changed_by } : null;
}

async function auditRows(client: string): Promise<number> {
  const rows = (await withTenant(client, (tx) => tx.execute(sql`
    select count(*)::int as n from change_document where client = ${client}
  `))) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

async function locks(client: string) {
  return (await withTenant(client, (tx) => tx.execute(sql`
    select lock_object, argument, owner_user, owner_session_id, mode, transaction_code,
           (now() - acquired_at) > interval '1 second' as aged
      from enqueue_entry where client = ${client} and lock_object = ${LOCK_OBJECT}
  `))) as unknown as Array<{
    lock_object: string;
    argument: string;
    owner_user: string;
    owner_session_id: string;
    mode: string;
    transaction_code: string | null;
    aged: boolean;
  }>;
}

/** The claim this screen files on mount, seen from the server side rather than from the page. */
async function waitForHeldLock(client: string, user: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const held = (await locks(client)).filter((row) => row.lock_object === LOCK_OBJECT && row.owner_user === user);
    if (held.length > 0) return held;
    if (Date.now() > deadline) throw new Error(`no ${LOCK_OBJECT} lock held by ${user} within 20s`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

export async function batchDocumentManagementIndicator(ctx: BrowserContext) {
  const { page, base: BASE, target } = ctx;
  const CLIENT = target.client;
  const USER = 'browser.admin';
  const form = page.locator('form').filter({ hasText: 'Document management for batches' });
  // Next keeps its own empty `role="alert"` announcer on every page, so the failure notice is located
  // inside the form that renders it rather than across the document.
  const failure = form.getByRole('alert');

  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 2, name: 'Document management for batches', exact: true }).waitFor();

  // ── The opening: a claim this page filed for itself, granted ─────────────────────────────
  const held = await waitForHeldLock(CLIENT, USER);
  assert.equal(held.length, 1, 'The screen holds exactly one change lock for the indicator record.');
  assert.equal(
    (await form.getByRole('alert').allInnerTexts()).join('\n'),
    '',
    'A granted claim says nothing: no failure notice on a page that may write.',
  );
  assert.equal(await form.locator('fieldset').first().getAttribute('disabled'), null, 'A grant leaves the indicator editable.');
  console.log('  ✓ the screen claims its own record on opening and is editable once the claim answers');

  // ── While an answer is owed the screen says nothing, and offers nothing that has not been granted ──
  // This is the deliberate shape of the screen, not an oversight: `writable` closes on an answer that
  // says no, and a claim in flight is no answer yet, so the form stays open and the save is answered by
  // the action. That boundary is exercised below, by the refused session pressing anyway — the same
  // `ENQUEUE_NOT_HELD` branch a save filed mid-claim would meet — so what is proved here is the part only
  // a browser can show: an owed claim invents no failure notice, and no lock stands until the server
  // agrees to one.
  let heldClaim: Route | undefined;
  const gate = async (route: Route) => {
    const request = route.request();
    // Only the claim is held. A save is let through, and every navigation and asset request with it,
    // so the page keeps working while its own opening is in the air.
    if (request.method() !== 'POST') return route.continue();
    // The claim is the one call that names the transaction code; the release and the save are not held,
    // so the page can tear its old lock down and keep working while its new opening is in the air.
    const body = request.postData() ?? '';
    if (!body.includes(TX_CODE)) return route.continue();
    heldClaim ??= route;
    return undefined;
  };
  const url = new URL(ROUTE, BASE).href;
  await page.route(url, gate);
  const beforeOwed = await readIndicator(CLIENT);
  const auditBeforeOwed = await auditRows(CLIENT);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 2, name: 'Document management for batches', exact: true }).waitFor();
  await page.waitForTimeout(400);
  assert.ok(heldClaim, 'the screen filed its own claim when it was opened');
  assert.equal((await form.getByRole('alert').allInnerTexts()).join('\n'), '', 'a claim in flight is not a failure, and is not shown as one');
  assert.equal((await page.getByRole('status').allInnerTexts()).join('\n'), '', 'a claim in flight composes no notice of its own');
  // A reload does not hand the record over: the row that stands here belongs to this same session, which
  // opened it before the navigation and is told by this claim that it still holds it. What an owed claim
  // may not do is put anyone else in front, write anything, or say anything.
  const owed = await locks(CLIENT);
  assert.ok(
    owed.every((row) => row.owner_user === USER),
    `an owed claim left the record in other hands: ${JSON.stringify(owed)}`,
  );
  assert.deepEqual(await readIndicator(CLIENT), beforeOwed, 'an owed claim wrote nothing');
  assert.equal(await auditRows(CLIENT), auditBeforeOwed, 'an owed claim filed no audit record');
  await heldClaim.continue();
  await waitForHeldLock(CLIENT, USER);
  await page.unroute(url, gate);
  console.log('  ✓ while the answer is owed the screen invents nothing: no notice, no lock, no write, and the grant lands when the answer does');

  // ── The refusal: a second session reads, and is told who holds the record ────────────────
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 2, name: 'Document management for batches', exact: true }).waitFor();
  await waitForHeldLock(CLIENT, USER);
  const browser = page.context().browser();
  assert.ok(browser, 'the browser is available for a second session');
  const second = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const other = await second.newPage();
  await other.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
  await other.locator('[name="client"]').fill(CLIENT);
  await other.locator('[name="username"]').fill(USER);
  await other.locator('[name="password"]').fill(PASSWORD);
  const signedIn = other.waitForURL((url) => url.pathname === '/', { waitUntil: 'commit', timeout: 30_000 });
  await other.getByRole('button', { name: 'Sign in', exact: true }).click();
  await signedIn;
  await other.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await other.getByRole('heading', { level: 2, name: 'Document management for batches', exact: true }).waitFor();

  const otherForm = other.locator('form').filter({ hasText: 'Document management for batches' });
  await other.getByRole('status').filter({ hasText: 'is being changed by' }).waitFor();
  const refusal = (await other.getByRole('status').allInnerTexts()).join('\n');
  assert.match(refusal, new RegExp(`${LOCK_OBJECT} ${CLIENT} is being changed by ${USER}`), 'The refusal names the holder.');
  assert.match(refusal, /a lock nobody answers is released about three minutes after its last answer/, 'The refusal carries the recovery sentence.');
  // Playwright does not treat a `fieldset` as a control, so the inert state is read where it is applied:
  // the attribute on the group, and the two inputs the group holds.
  const fieldset = otherForm.locator('fieldset').first();
  assert.notEqual(await fieldset.getAttribute('disabled'), null, 'A display-only opening closes the indicator group.');
  assert.equal(
    await otherForm.locator('[name="reason"]').isDisabled(),
    true,
    'A display-only opening does not let the second session type a reason.',
  );
  assert.equal(
    await otherForm.getByRole('button', { name: 'Save indicator', exact: true }).isDisabled(),
    true,
    'A display-only opening does not offer the save.',
  );
  // A refusal is not a failure: the retry invitation belongs to the other half of the contract only.
  assert.doesNotMatch(refusal, /could not be opened|Try again/, 'A refusal is never dressed as an infrastructure failure.');
  assert.equal((await other.locator('form').filter({ hasText: 'Document management for batches' }).getByRole('alert').allInnerTexts()).join('\n'), '', 'The refused session shows no failure alert.');
  const beforeRefusal = await readIndicator(CLIENT);
  const auditBeforeRefusal = await auditRows(CLIENT);
  // The client gate is not the boundary. The fields are re-enabled by hand and the form is submitted
  // outside React, so what is tested is the action, not the disabled attribute: the platform answers the
  // write with its own refusal, and the row stays where it was.
  await otherForm.evaluate((node: HTMLFormElement) => {
    for (const control of Array.from(node.querySelectorAll('input, button, select, textarea'))) {
      (control as HTMLFieldSetElement).disabled = false;
    }
    const reason = node.querySelector('[name="reason"]') as HTMLInputElement;
    reason.value = 'Filed from the refused session';
    const radios = Array.from(node.querySelectorAll('input[name="documentManagement"]')) as HTMLInputElement[];
    radios[1].checked = true;
  });
  await otherForm.locator('button[type="submit"]').evaluate((node: HTMLButtonElement) => node.form?.requestSubmit());
  await other.getByRole('alert').getByText(/is being changed by/).waitFor();
  await other.waitForTimeout(1_200);
  assert.deepEqual(await readIndicator(CLIENT), beforeRefusal, 'The refused session moved the indicator not at all.');
  assert.equal(await auditRows(CLIENT), auditBeforeRefusal, 'The refused session filed no audit record.');
  assert.equal((await locks(CLIENT)).length, 1, 'The refused session neither took nor broke the lock.');
  console.log('  ✓ a second session is read-only, is told who holds the record, and files nothing when it insists');
  await second.close();

  // ── The failure: the claim cannot be reached, and the screen says so instead of going quiet ─
  // First leave the record properly, so the session's own lock is really released and the only thing left
  // to prove is what a screen does when its opening never arrives. Cutting the route also cuts that
  // release, so a reload from here would leave the old row standing and the assertion would mean nothing.
  // The release is filed by the component's cleanup, so it has to be an in-app navigation: a full
  // document load would let Chromium drop the request the way it drops one during unload.
  await page.getByRole('link', { name: 'Batch level', exact: true }).click();
  await page.waitForURL(/\/config\/batch-level/, { waitUntil: 'commit' });
  await page.waitForTimeout(600);
  const cut = async (route: Route) => (route.request().method() === 'POST' ? route.abort('failed') : route.continue());
  await page.route(new URL(ROUTE, BASE).href, cut);
  const beforeFailure = await readIndicator(CLIENT);
  const auditBeforeFailure = await auditRows(CLIENT);
  const released = await locks(CLIENT);
  assert.deepEqual([...released], [], `leaving the screen released the lock the session held; standing: ${JSON.stringify(released)}`);
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { level: 2, name: 'Document management for batches', exact: true }).waitFor();
  await failure.getByText(FAILURE_COPY).waitFor();
  const shown = (await failure.allInnerTexts()).join('\n');
  assert.match(shown, /Failed to fetch/, 'The safe line of what was thrown is on the screen.');
  assert.match(shown, new RegExp(RECOVERY_COPY.replace(/[.]/g, '\\.')), 'The recovery line is the one every operation that wrote nothing gives.');
  assert.doesNotMatch(shown, /is being changed by|This opening is display only/, 'A failure never borrows the refusal wording.');
  assert.notEqual(await form.locator('fieldset').first().getAttribute('disabled'), null, 'A claim that died closes the indicator.');
  assert.equal(await form.getByRole('button', { name: 'Save indicator', exact: true }).isDisabled(), true, 'A claim that died closes the save.');
  assert.deepEqual(await readIndicator(CLIENT), beforeFailure, 'A dead claim wrote nothing.');
  assert.equal(await auditRows(CLIENT), auditBeforeFailure, 'A dead claim filed no audit record.');
  assert.equal((await locks(CLIENT)).length, 0, 'A claim that never reached the server left no lock standing.');
  console.log('  ✓ a claim that cannot be reached is told as a failure, offers Try again, and files nothing');

  // The retry control, pressed while the route is still cut: a new claim, and the same answer again.
  const retry = form.getByRole('button', { name: 'Try again', exact: true });
  await retry.click();
  await page.waitForTimeout(600);
  assert.equal((await failure.allInnerTexts()).join('\n').includes(FAILURE_COPY), true, 'A retried claim that dies again is still told.');
  assert.notEqual(await form.locator('fieldset').first().getAttribute('disabled'), null, 'A failed retry does not hand the form back.');
  assert.deepEqual(await readIndicator(CLIENT), beforeFailure, 'The failed retry wrote nothing.');
  assert.equal(await auditRows(CLIENT), auditBeforeFailure, 'The failed retry filed no audit record.');
  console.log('  ✓ retrying into the same failure starts a new claim and still files nothing');

  // ── The press that the failure dropped is not waiting behind the retry ───────────────────
  await page.unroute(new URL(ROUTE, BASE).href, cut);
  await retry.click();
  await waitForHeldLock(CLIENT, USER);
  await failure.waitFor({ state: 'detached' });
  assert.deepEqual(await readIndicator(CLIENT), beforeFailure, 'Nothing was applied between the failure and the grant.');
  const target2 = beforeFailure?.code === 'X' ? '' : 'X';
  await form.locator(`input[name="documentManagement"][value="${target2}"]`).check();
  await form.locator('[name="reason"]').fill('Opened again after the claim failed');
  await form.getByRole('button', { name: 'Save indicator', exact: true }).click();
  const saveDeadline = Date.now() + 15_000;
  let saved = await readIndicator(CLIENT);
  while (Date.now() < saveDeadline && (saved?.version ?? 0) !== (beforeFailure?.version ?? 0) + 1) {
    await page.waitForTimeout(200);
    saved = await readIndicator(CLIENT);
  }
  assert.equal(saved?.code, target2.trim() === '' ? '' : 'X', 'The saved indicator is the one the page chose.');
  assert.notDeepEqual(saved, beforeFailure, 'The write went through after the retry.');
  assert.equal(saved?.version, (beforeFailure?.version ?? 0) + 1, 'The optimistic version moved by one, so the save ran once.');
  assert.equal(await auditRows(CLIENT), auditBeforeFailure + 1, 'One completed change, one audit record, no duplicate.');
  console.log('  ✓ after a failed claim the indicator is written by one save, and the dropped press never comes back');

  // Leaving the record released the opening, so no stale lock stands behind the work.
  await page.getByRole('link', { name: 'Batch level', exact: true }).click();
  await page.waitForURL(/\/config\/batch-level/, { waitUntil: 'commit' });
  await page.waitForTimeout(600);
  const left = await locks(CLIENT);
  assert.deepEqual([...left], [], `Leaving the screen released the change lock; standing: ${JSON.stringify(left)}`);
  console.log('  ✓ leaving the screen releases the lock, so no stale opening stands behind the record');
}
