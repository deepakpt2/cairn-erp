/**
 * Movement type configuration (OMJJ) in a browser: a master-detail screen where creation asks for no
 * lock, a change asks for one, a check asks for nothing at all, and a claim that dies has to be said out
 * loud instead of hiding the form.
 *
 * Each phase is proved twice: on the page, and against `movement_type` and `change_document`, so a notice
 * that lies about what it wrote cannot pass.
 */
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';
import type { Route } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserContext } from '../browser-smoke/checks';

const ROUTE = '/config/movement-types';
const PASSWORD = 'browser-check-2026';
const LOCK_OBJECT = 'MOVEMENT_TYPE';
const TX_CODE = 'OMJJ';
const KEY = 'Z99';
const FAILURE_COPY = 'The change lock for this record could not be opened.';
const RECOVERY_COPY = 'Nothing was written. Try again, and if it fails again ask an administrator to check the server log.';

type Row = { movement_type: string; description: string } | null;

async function readMovement(client: string, movementType: string): Promise<Row> {
  const rows = (await withTenant(client, (tx) => tx.execute(sql`
    select movement_type, description from movement_type where client = ${client} and movement_type = ${movementType}
  `))) as unknown as Row[];
  return rows[0] ?? null;
}

async function auditRows(client: string): Promise<number> {
  const rows = (await withTenant(client, (tx) => tx.execute(sql`
    select count(*)::int as n from change_document where client = ${client}
  `))) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/** The locks this screen could have taken, and only those: the destination page files claims of its own. */
async function locks(client: string) {
  return (await withTenant(client, (tx) => tx.execute(sql`
    select lock_object, argument, owner_user, mode from enqueue_entry where client = ${client} and lock_object = ${LOCK_OBJECT}
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

function holderWait(holder: { route?: Route }): Promise<boolean> {
  return new Promise(async (resolve) => {
    for (let i = 0; i < 60; i += 1) {
      if (holder.route) return resolve(true);
      await new Promise((next) => setTimeout(next, 100));
    }
    resolve(false);
  });
}

export async function movementTypesConfiguration(ctx: BrowserContext) {
  const { page, base: BASE, target } = ctx;
  const CLIENT = target.client;
  const USER = 'browser.admin';
  const url = new URL(ROUTE, BASE).href;
  // The route announcer is an empty `role="alert"` on every page; the notice is found beside the row it
  // speaks for instead, so "no alert" can mean what it says.
  const failure = page.locator('div[role="alert"]').filter({ hasText: FAILURE_COPY });

  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  const heading = page.getByRole('heading', { level: 2, name: 'Movement types', exact: true });
  await heading.waitFor();
  const create = page.getByRole('button', { name: 'New movement type', exact: true });
  assert.equal(await create.isVisible(), true, 'A session that may maintain is offered creation.');

  // ── Creation asks for no lock, and the screen files none while it is being filed ──────────
  async function waitForRow(movementType: string): Promise<Row> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const row = await readMovement(CLIENT, movementType);
      if (row) return row;
      if (Date.now() > deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  const auditBeforeCreate = await auditRows(CLIENT);
  await create.click();
  await page.getByRole('heading', { level: 2, name: 'Create movement type', exact: true }).waitFor();
  const form = page.locator('form').filter({ has: page.locator('[name="movementType"]') });
  await form.locator('[name="movementType"]').fill(KEY);
  await form.locator('[name="description"]').fill('Browser acceptance movement');
  await form.locator('#movement-type-direction').selectOption('RECEIPT');
  await form.locator('#movement-type-reference').selectOption('MATERIAL_DOCUMENT');
  await form.locator('#movement-type-reason').fill('Created by the browser acceptance run');
  assert.deepEqual([...(await locks(CLIENT))], [], 'Creating a movement takes no change lock.');
  assert.equal(
    await form.getByRole('button', { name: 'Save', exact: true }).isDisabled(),
    false,
    'Creation is not held behind a grant it never needed.',
  );
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  const created = await waitForRow(KEY);
  assert.equal(created?.description, 'Browser acceptance movement', 'The created movement stands with what was typed.');
  assert.equal(await auditRows(CLIENT), auditBeforeCreate + 1, 'One creation, one audit record.');
  console.log('  ✓ a new movement is created without a lock, and one audit record stands for it');

  // ── A change takes the grant; while it is owed the form is not offered at all ─────────────
  // A saved create leaves the screen sitting on the row it wrote, in change mode, so its claim has
  // already been filed and answered. The owed window is only observable from a fresh load, where nothing
  // has been asked for yet.
  const owed = page.getByRole('heading', { level: 2, name: `Change ${KEY}`, exact: true });
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await heading.waitFor();
  // Hold only this screen's claim, so releases, saves and navigations keep flowing. The handler is kept
  // in a name and removed by reference: an anonymous handler cannot be unroute()d, and a stale claim
  // gate would swallow every later opening this run files.
  const holder: { route?: Route } = {};
  const gate = async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    if (!(request.postData() ?? '').includes(TX_CODE)) return route.continue();
    holder.route ??= route;
    return undefined;
  };
  await page.route(url, gate);
  const rowButton = page.locator('tbody tr').filter({ hasText: KEY }).getByRole('button', { name: KEY, exact: true });
  await rowButton.click();
  assert.ok(await holderWait(holder), 'the screen filed no claim when the row was chosen');
  assert.equal(await owed.isVisible(), false, 'While the claim is owed the change form is not offered, and nothing pretends to be saved.');
  assert.equal(await failure.count(), 0, 'A claim in flight is not a failure, and is not shown as one.');
  await holder.route!.continue();
  delete holder.route;
  await waitForLock(CLIENT, KEY, USER);
  await owed.waitFor();
  assert.equal(
    await form.getByRole('button', { name: 'Save', exact: true }).isDisabled(),
    false,
    'The grant is what opens the change form.',
  );
  console.log('  ✓ the change form waits for the grant, and opens the moment the answer arrives');
  await page.unroute(url, gate);

  // ── A granted change writes, once ────────────────────────────────────────────────────────
  const auditBeforeChange = await auditRows(CLIENT);
  await form.locator('[name="description"]').fill('Changed under the grant');
  await form.locator('#movement-type-reason').fill('The grant said this session may write');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  const changedDeadline = Date.now() + 15_000;
  let changed = await readMovement(CLIENT, KEY);
  while (Date.now() < changedDeadline && changed?.description !== 'Changed under the grant') {
    await page.waitForTimeout(200);
    changed = await readMovement(CLIENT, KEY);
  }
  assert.equal(changed?.description, 'Changed under the grant', 'A granted change is persisted.');
  assert.equal(await auditRows(CLIENT), auditBeforeChange + 1, 'One change, one audit record.');
  console.log('  ✓ a granted change is applied to the row and audited once');

  // ── A second session is refused, keeps its read-only actions, and files nothing ───────────
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
  await other.getByRole('heading', { level: 2, name: 'Movement types', exact: true }).waitFor();
  await other.locator('tbody tr').filter({ hasText: KEY }).getByRole('button', { name: KEY, exact: true }).click();
  await other.getByRole('status').getByText(new RegExp(`${LOCK_OBJECT} ${KEY} is being changed by ${USER} in ${TX_CODE}`)).waitFor();
  assert.match(
    (await other.getByRole('status').allInnerTexts()).join('\n'),
    /a lock nobody answers is released about three minutes after its last answer/,
    'the refusal carries the recovery sentence, not a retry invitation',
  );
  assert.equal(
    await other.locator('div[role="alert"]').filter({ hasText: FAILURE_COPY }).count(),
    0,
    'a refusal is never dressed as an infrastructure failure',
  );
  const auditBeforeRefusal = await auditRows(CLIENT);
  const beforeRefusal = await readMovement(CLIENT, KEY);
  // The refused session still reads the row, and the read-only action that asks for no lock stays offered.
  const checkButton = other.getByRole('button', { name: 'Check', exact: true });
  assert.equal(await checkButton.isVisible(), true, 'A refusal does not take away an action that asks for no lock.');
  assert.equal(await checkButton.isDisabled(), false, 'Check stays offered while the row is refused.');
  await checkButton.click();
  await other.waitForTimeout(1_200);
  assert.deepEqual(await readMovement(CLIENT, KEY), beforeRefusal, 'Check wrote nothing.');
  assert.equal(await auditRows(CLIENT), auditBeforeRefusal, 'Check filed no audit record.');
  assert.equal((await locks(CLIENT)).length, 1, 'The refused session neither took nor broke the lock.');
  console.log('  ✓ a refused session reads the row, keeps the action that asks for no lock, and files nothing');
  await second.close();

  // ── A claim that cannot be reached is told, and the form it used to hide now says why ──────
  // Releasing has to be an in-app navigation, because Chromium drops the release the way it drops any
  // request in flight during a document load.
  await page.locator('a[href="/config"]').first().click();
  await page.waitForURL(/\/config$/, { waitUntil: 'commit' });
  await waitForLock(CLIENT, KEY, USER, false);
  const cut = async (route: Route) => (route.request().method() === 'POST' ? route.abort('failed') : route.continue());
  await page.route(url, cut);
  const beforeFailure = await readMovement(CLIENT, KEY);
  const auditBeforeFailure = await auditRows(CLIENT);
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await heading.waitFor();
  await page.locator('tbody tr').filter({ hasText: KEY }).getByRole('button', { name: KEY, exact: true }).click();
  await failure.waitFor();
  const shown = (await failure.allInnerTexts()).join('\n');
  assert.match(shown, /Failed to fetch/, 'the safe line of what was thrown is on the screen');
  assert.ok(shown.includes(RECOVERY_COPY), 'the whole recovery line is the one for an operation that wrote nothing, not its opening words');
  assert.doesNotMatch(shown, /is being changed by|display only/i, 'a failure never borrows the refusal wording');
  // Pass 35's point, in a browser: the form comes back, with its reason, rather than staying hidden.
  await owed.waitFor();
  const saveButton = form.getByRole('button', { name: 'Save', exact: true });
  const deleteButton = page.getByRole('button', { name: 'Delete', exact: true });
  assert.equal(await saveButton.isDisabled(), true, 'A dead claim closes the save, whatever the form around it offers.');
  assert.equal(await deleteButton.isDisabled(), true, 'A dead claim closes the delete too.');
  assert.deepEqual(await readMovement(CLIENT, KEY), beforeFailure, 'A dead claim wrote nothing.');
  assert.equal(await auditRows(CLIENT), auditBeforeFailure, 'A dead claim filed no audit record.');
  assert.deepEqual([...(await locks(CLIENT))], [], 'A claim that never reached the server left no lock standing.');
  console.log('  ✓ a claim that cannot be reached names itself, keeps the form visible with its reason, and closes both writes');

  // The retry, pressed into the same failure, is a new claim and still files nothing.
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.waitForTimeout(600);
  assert.equal((await failure.allInnerTexts()).join('\n').includes(FAILURE_COPY), true, 'A retried claim that dies again is still told.');
  assert.deepEqual(await readMovement(CLIENT, KEY), beforeFailure, 'The failed retry wrote nothing.');
  assert.equal(await auditRows(CLIENT), auditBeforeFailure, 'The failed retry filed no audit record.');

  // ── The press the failure dropped is not waiting behind the retry ─────────────────────────
  await page.unroute(url, cut);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await waitForLock(CLIENT, KEY, USER);
  await failure.waitFor({ state: 'detached' });
  assert.deepEqual(await readMovement(CLIENT, KEY), beforeFailure, 'Nothing was applied between the failure and the grant.');
  const auditAtGrant = await auditRows(CLIENT);
  await form.locator('[name="description"]').fill('Changed after the retry');
  await form.locator('#movement-type-reason').fill('One press, after the claim answered again');
  await saveButton.click();
  const retriedDeadline = Date.now() + 15_000;
  let retried = await readMovement(CLIENT, KEY);
  while (Date.now() < retriedDeadline && retried?.description !== 'Changed after the retry') {
    await page.waitForTimeout(200);
    retried = await readMovement(CLIENT, KEY);
  }
  assert.equal(retried?.description, 'Changed after the retry', 'The retried claim carries the change typed after it.');
  assert.equal(await auditRows(CLIENT), auditAtGrant + 1, 'One change went through: the dropped press did not arrive as a second one.');
  console.log('  ✓ after the retry one change is applied and audited once, and nothing the failure dropped comes back');

  // Leaving the row released the opening, so no stale lock stands behind the work.
  await page.locator('a[href="/config"]').first().click();
  await page.waitForURL(/\/config$/, { waitUntil: 'commit' });
  await page.waitForTimeout(600);
  const left = await locks(CLIENT);
  assert.deepEqual([...left], [], `Leaving the row released the change lock; standing: ${JSON.stringify(left)}`);
  console.log('  ✓ leaving the row releases the lock, so no stale opening stands behind the record');
}
