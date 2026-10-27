/**
 * Valuation class configuration in a browser: one page, three records, three claims.
 *
 * The screen maintains an account category reference, a valuation class, and the material type that names
 * a reference. Each section opens its own change lock, and this proves the two properties that only a
 * browser can show: a section refused by another session does not reach over into the section beside it,
 * and a claim that dies leaves a reason on the page instead of hiding the form. The table and the audit
 * trail are read back at every step, because a notice that lies about what it wrote must not pass.
 */
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';
import type { Route } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserContext } from '../browser-smoke/checks';

const ROUTE = '/config/valuation-classes';
const PASSWORD = 'browser-check-2026';
const LOCK_OBJECT = 'ACCOUNT_CATEGORY_REFERENCE';
const REFERENCE = 'BR01';
const TX_CODE = 'CFG.INV.VALCLASS.DEFINE';
const FAILURE_COPY = 'The change lock for this record could not be opened.';
const RECOVERY_COPY = 'Nothing was written. Try again, and if it fails again ask an administrator to check the server log.';

async function readReference(client: string) {
  const rows = (await withTenant(client, (tx) => tx.execute(sql`
    select reference, name, is_active from account_category_reference where client = ${client} and reference = ${REFERENCE}
  `))) as unknown as Array<{ reference: string; name: string; is_active: boolean }>;
  return rows[0] ?? null;
}

async function auditRows(client: string): Promise<number> {
  const rows = (await withTenant(client, (tx) => tx.execute(sql`
    select count(*)::int as n from change_document where client = ${client}
  `))) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/** Only this section's locks: the pages this run walks through file claims of their own. */
async function locks(client: string, object = LOCK_OBJECT) {
  return (await withTenant(client, (tx) => tx.execute(sql`
    select lock_object, argument, owner_user, mode from enqueue_entry where client = ${client} and lock_object = ${object}
  `))) as unknown as Array<{ lock_object: string; argument: string; owner_user: string; mode: string }>;
}

async function waitForLock(client: string, argument: string, user: string, held = true) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const mine = (await locks(client)).filter((row) => row.argument === argument && row.owner_user === user);
    if (mine.length > 0 === held) return mine;
    if (Date.now() > deadline) throw new Error(`${held ? 'no' : 'a stale'} ${LOCK_OBJECT} ${argument} lock for ${user} within 20s`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

export async function valuationClassesConfiguration(ctx: BrowserContext) {
  const { page, base: BASE, target } = ctx;
  const CLIENT = target.client;
  const USER = 'browser.admin';
  const url = new URL(ROUTE, BASE).href;
  const referenceSection = page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: 'Account category references', exact: true }) });
  // The route announcer is an empty `role="alert"` on every page, so the failure notice is located by what
  // it says rather than by its role alone.
  const failure = page.locator('div[role="alert"]').filter({ hasText: FAILURE_COPY });
  const saveReference = page.getByRole('button', { name: 'Save reference', exact: true });

  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await referenceSection.getByRole('heading', { level: 2, name: 'Account category references', exact: true }).waitFor();

  // ── A new reference asks for no lock, and writes once ─────────────────────────────────────
  const auditBeforeCreate = await auditRows(CLIENT);
  await page.getByRole('button', { name: 'New reference', exact: true }).click();
  const form = page.locator('form').filter({ has: page.locator('#reference-key') });
  await form.locator('#reference-key').fill(REFERENCE);
  await form.locator('#reference-name').fill('Browser acceptance reference');
  await form.locator('#reference-reason').fill('Created by the browser acceptance run');
  assert.deepEqual([...(await locks(CLIENT))], [], 'Creating a reference takes no change lock.');
  await saveReference.click();
  const deadline = Date.now() + 15_000;
  let created = await readReference(CLIENT);
  while (Date.now() < deadline && !created) {
    await page.waitForTimeout(200);
    created = await readReference(CLIENT);
  }
  assert.equal(created?.name, 'Browser acceptance reference', 'The created reference stands with what was typed.');
  assert.equal(await auditRows(CLIENT), auditBeforeCreate + 1, 'One creation, one audit record.');
  console.log('  ✓ a new account category reference is created without a lock, and one audit record stands for it');

  // ── A change is worked from the grant the section asked for ───────────────────────────────
  const held: { route?: Route } = {};
  const gate = async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    if (!(request.postData() ?? '').includes(TX_CODE)) return route.continue();
    held.route ??= route;
    return undefined;
  };
  // A saved create leaves the section sitting on the row it wrote, in change mode, so its claim has
  // already been filed and answered: the owed window is only observable from a fresh load.
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await referenceSection.getByRole('heading', { level: 2, name: 'Account category references', exact: true }).waitFor();
  await page.route(url, gate);
  const rowButton = page.locator('tbody tr').filter({ hasText: REFERENCE }).getByRole('button', { name: REFERENCE, exact: true });
  await rowButton.click();
  for (let attempt = 0; attempt < 60 && !held.route; attempt += 1) await page.waitForTimeout(100);
  // The section is held shut while the answer is owed, and the form is offered the moment it arrives.
  assert.ok(held.route, 'the section filed no claim when the row was chosen');
  assert.equal(await saveReference.isVisible(), false, 'While the claim is owed the section offers no save.');
  assert.equal(await failure.count(), 0, 'A claim in flight is not a failure, and is not shown as one.');
  await held.route.continue();
  delete held.route;
  await waitForLock(CLIENT, REFERENCE, USER);
  await saveReference.waitFor();
  await page.unroute(url, gate);
  console.log('  ✓ the reference section waits for its own grant, and opens when that grant arrives');

  const auditBeforeChange = await auditRows(CLIENT);
  await form.locator('#reference-name').fill('Changed under the grant');
  await form.locator('#reference-reason').fill('The grant said this session may write');
  await saveReference.click();
  const changeDeadline = Date.now() + 15_000;
  let changed = await readReference(CLIENT);
  while (Date.now() < changeDeadline && changed?.name !== 'Changed under the grant') {
    await page.waitForTimeout(200);
    changed = await readReference(CLIENT);
  }
  assert.equal(changed?.name, 'Changed under the grant', 'A granted change is persisted.');
  assert.equal(await auditRows(CLIENT), auditBeforeChange + 1, 'One change, one audit record.');
  console.log('  ✓ a granted change is applied to the reference and audited once');

  // ── A refusal closes one section, and leaves the next one alone ───────────────────────────
  const browser = page.context().browser();
  assert.ok(browser, 'the browser is available for a second session');
  const second = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const other = await second.newPage();
  await other.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
  await other.locator('[name="client"]').fill(CLIENT);
  await other.locator('[name="username"]').fill(USER);
  await other.locator('[name="password"]').fill(PASSWORD);
  const signedIn = other.waitForURL((entry) => entry.pathname === '/', { waitUntil: 'commit', timeout: 30_000 });
  await other.getByRole('button', { name: 'Sign in', exact: true }).click();
  await signedIn;
  await other.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  const otherSection = other.locator('section').filter({ has: other.getByRole('heading', { level: 2, name: 'Account category references', exact: true }) });
  await otherSection.getByRole('heading', { level: 2, name: 'Account category references', exact: true }).waitFor();
  await other.locator('tbody tr').filter({ hasText: REFERENCE }).getByRole('button', { name: REFERENCE, exact: true }).click();
  await other.getByRole('status').getByText(new RegExp(`${LOCK_OBJECT} ${REFERENCE} is being changed by ${USER} in ${TX_CODE}`)).waitFor();
  assert.match(
    (await other.getByRole('status').allInnerTexts()).join('\n'),
    /a lock nobody answers is released about three minutes after its last answer/,
    'the refusal carries the recovery sentence beside the section it refuses',
  );
  assert.equal(
    await other.locator('div[role="alert"]').filter({ hasText: FAILURE_COPY }).count(),
    0,
    'a refusal is never dressed as an infrastructure failure',
  );
  const beforeRefusal = await readReference(CLIENT);
  const auditBeforeRefusal = await auditRows(CLIENT);
  assert.equal(
    await other.getByRole('button', { name: 'Save reference', exact: true }).isVisible(),
    false,
    'The refused section takes its save away.',
  );
  // The section beside it is a different record with a different claim, and is untouched by this refusal.
  assert.equal(
    await other.getByRole('button', { name: 'New valuation class', exact: true }).isEnabled(),
    true,
    'A refusal on one section does not reach over into the next.',
  );
  assert.equal(
    await other.getByRole('button', { name: 'Check', exact: true }).isEnabled(),
    true,
    'The read-only action that asks for no lock stays offered.',
  );
  await other.getByRole('button', { name: 'Check', exact: true }).click();
  await other.waitForTimeout(1_200);
  assert.deepEqual(await readReference(CLIENT), beforeRefusal, 'The refused session moved nothing.');
  assert.equal(await auditRows(CLIENT), auditBeforeRefusal, 'The refused session filed no audit record.');
  assert.equal((await locks(CLIENT)).length, 1, 'The refused session neither took nor broke the lock.');
  console.log('  ✓ a refused section loses its save and keeps its recovery sentence, while the next section stays workable');
  await second.close();

  // ── A claim that dies is said out loud, in the section it belongs to ──────────────────────
  // Releasing has to be an in-app navigation: Chromium drops a request fired during a document load.
  await page.locator(`a[href="/config/material-types"]`).first().click();
  await page.waitForURL(/\/config\/material-types/, { waitUntil: 'commit' });
  await waitForLock(CLIENT, REFERENCE, USER, false);
  const cut = async (route: Route) => (route.request().method() === 'POST' ? route.abort('failed') : route.continue());
  await page.route(url, cut);
  const beforeFailure = await readReference(CLIENT);
  const auditBeforeFailure = await auditRows(CLIENT);
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await referenceSection.getByRole('heading', { level: 2, name: 'Account category references', exact: true }).waitFor();
  await page.locator('tbody tr').filter({ hasText: REFERENCE }).getByRole('button', { name: REFERENCE, exact: true }).click();
  await failure.getByText(FAILURE_COPY).waitFor();
  const shown = (await failure.allInnerTexts()).join('\n');
  assert.match(shown, /Failed to fetch/, 'the safe line of what was thrown is on the screen');
  assert.ok(shown.includes(RECOVERY_COPY), 'the whole recovery line is the one for an operation that wrote nothing, not its opening words');
  assert.doesNotMatch(shown, /is being changed by|display only/i, 'a failure never borrows the refusal wording');
  assert.equal(
    await saveReference.isVisible(),
    false,
    'A dead claim closes the section rather than leaving it open to a save that cannot be made.',
  );
  assert.deepEqual(await readReference(CLIENT), beforeFailure, 'A dead claim wrote nothing.');
  assert.equal(await auditRows(CLIENT), auditBeforeFailure, 'A dead claim filed no audit record.');
  assert.deepEqual([...(await locks(CLIENT))], [], 'A claim that never reached the server left no lock standing.');
  console.log('  ✓ a claim that cannot be reached names itself, and files nothing');

  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.waitForTimeout(600);
  assert.equal((await failure.allInnerTexts()).join('\n').includes(FAILURE_COPY), true, 'A retried claim that dies again is still told.');
  assert.deepEqual(await readReference(CLIENT), beforeFailure, 'The failed retry wrote nothing.');
  assert.equal(await auditRows(CLIENT), auditBeforeFailure, 'The failed retry filed no audit record.');

  // ── The press the failure dropped is not waiting behind the retry ─────────────────────────
  await page.unroute(url, cut);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await waitForLock(CLIENT, REFERENCE, USER);
  await failure.waitFor({ state: 'detached' });
  assert.deepEqual(await readReference(CLIENT), beforeFailure, 'Nothing was applied between the failure and the grant.');
  await saveReference.waitFor();
  const auditAtGrant = await auditRows(CLIENT);
  await form.locator('#reference-name').fill('Changed after the retry');
  await form.locator('#reference-reason').fill('One press, after the claim answered again');
  await saveReference.click();
  const retryDeadline = Date.now() + 15_000;
  let retried = await readReference(CLIENT);
  while (Date.now() < retryDeadline && retried?.name !== 'Changed after the retry') {
    await page.waitForTimeout(200);
    retried = await readReference(CLIENT);
  }
  assert.equal(retried?.name, 'Changed after the retry', 'The retried claim carries the change typed after it.');
  assert.equal(await auditRows(CLIENT), auditAtGrant + 1, 'One change went through: the dropped press did not arrive as a second one.');
  console.log('  ✓ after the retry one change is applied and audited once, and nothing the failure dropped comes back');

  await page.locator('a[href="/config/material-types"]').first().click();
  await page.waitForURL(/\/config\/material-types/, { waitUntil: 'commit' });
  await page.waitForTimeout(600);
  const left = await locks(CLIENT);
  assert.deepEqual([...left], [], `Leaving the section released its change lock; standing: ${JSON.stringify(left)}`);
  console.log('  ✓ leaving the section releases its lock, so no stale opening stands behind the record');
}
