/**
 * The settlement masters (`/config/settlement-configuration`) in a browser, on the screen that was **not**
 * migrated to the claim handle: its three sections read the legacy projection `useChangeLock`, so everything
 * they show for a claim that died comes from `projectClaim` alone. That makes this the run that answers Pass
 * 36's disclosed question — whether the one shared arm really makes every legacy screen close on a failed
 * claim and say so — and it is the follow-up the settlement-ownership work recorded as "worth a browser-level
 * pass".
 *
 * Nothing here is judged from the page alone: `allocation_structure`, `change_document` and `enqueue_entry`
 * are read at every phase, so a notice that lies about what it wrote cannot pass.
 */
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';
import type { Route } from '@playwright/test';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserContext } from '../browser-smoke/checks';

const ROUTE = '/config/settlement-configuration';
const PASSWORD = 'browser-check-2026';
const LOCK_OBJECT = 'SETTLEMENT_ALLOCATION_STRUCTURE';
const TX_CODE = 'CFG.COST.SETTLEMENT.DEFINE';
const CODE = 'BRST';
const ADDED_CODE = 'BRST2';
const FAILURE_COPY = 'The change lock for this record could not be opened.';
const RECOVERY_COPY = 'Nothing was written. Try again, and if it fails again ask an administrator to check the server log.';

/**
 * The row as the screen reads it. `version` is not a column here: a settlement master's version is the number
 * of change documents its own key has accumulated — which is why a key that was assigned and removed keeps a
 * version, and why the stale-form guard is counted rather than stored.
 */
type Row = { structure_code: string; description: string; version: number } | null;

async function readStructure(client: string, structureCode: string): Promise<Row> {
  const rows = (await withTenant(client, (tx) => tx.execute(sql`
    select s.structure_code, s.description, (
      select count(*)::int from change_document d
        where d.client = s.client and d.object_class = 'allocation_structure' and d.object_key = s.structure_code
    ) as version
    from allocation_structure s where s.client = ${client} and s.structure_code = ${structureCode}
  `))) as unknown as Row[];
  return rows[0] ?? null;
}

async function auditRows(client: string): Promise<number> {
  const rows = (await withTenant(client, (tx) => tx.execute(sql`
    select count(*)::int as n from change_document where client = ${client}
  `))) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/** Only this screen's objects: the configuration home files claims of its own, and so does the link it offers. */
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

/** The claim is owed for one round trip; the run has to know it was filed before it can call a window empty. */
function holderWait(holder: { route?: Route }): Promise<boolean> {
  return new Promise(async (resolve) => {
    for (let i = 0; i < 80; i += 1) {
      if (holder.route) return resolve(true);
      await new Promise((next) => setTimeout(next, 100));
    }
    resolve(false);
  });
}

async function waitForRow(client: string, structureCode: string): Promise<Row> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const row = await readStructure(client, structureCode);
    if (row) return row;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function waitForDescription(client: string, structureCode: string, wanted: string): Promise<Row> {
  const deadline = Date.now() + 15_000;
  let row = await readStructure(client, structureCode);
  while (Date.now() < deadline && row?.description !== wanted) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    row = await readStructure(client, structureCode);
  }
  return row;
}

export async function settlementConfigurationMasters(ctx: BrowserContext) {
  const { page, base: BASE, target } = ctx;
  const CLIENT = target.client;
  const USER = 'browser.admin';
  const url = new URL(ROUTE, BASE).href;
  const panel = page.locator('section[aria-label="Allocation structures"]');
  // The section's notices are `role="status"` paragraphs inside the forms that own them: the page keeps an
  // empty `role="alert"` announcer of its own, and `Message` shares the status role, so every read below is
  // taken from the form the claim belongs to.
  const editForm = panel.locator('form').filter({ has: page.getByRole('button', { name: 'Save description', exact: true }) });
  const createForm = panel.locator('form').filter({ has: page.getByRole('button', { name: 'Create structure', exact: true }) });
  const descriptionInput = editForm.locator('[name="description"]');
  const saveButton = editForm.getByRole('button', { name: 'Save description', exact: true });
  const notice = editForm.getByRole('status');
  const failure = panel.getByRole('status').filter({ hasText: FAILURE_COPY });
  // `hasText` would match BRST2 as readily as BRST, so a row is found by a cell that holds the code and
  // nothing else.
  const structureRowOn = (scope: typeof page, code: string) => scope.locator('tbody tr').filter({ has: scope.getByText(code, { exact: true }) });

  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  const heading = page.getByRole('heading', { level: 2, name: 'Allocation structures', exact: true });
  await heading.waitFor();
  assert.equal(
    await createForm.getByRole('button', { name: 'Create structure', exact: true }).isDisabled(),
    false,
    'A session that may maintain is offered creation.',
  );

  // ── Creation asks for no change session, and files none while it is being filed ─────────────
  const auditBeforeCreate = await auditRows(CLIENT);
  assert.deepEqual([...(await locks(CLIENT))], [], 'The screen files no claim before a row is chosen.');
  await createForm.locator('[name="structureCode"]').fill(CODE);
  await createForm.locator('[name="description"]').fill('Browser acceptance structure');
  await createForm.getByRole('button', { name: 'Create structure', exact: true }).click();
  const created = await waitForRow(CLIENT, CODE);
  assert.equal(created?.description, 'Browser acceptance structure', 'The created structure stands with what was typed.');
  assert.equal(await auditRows(CLIENT), auditBeforeCreate + 1, 'One creation, one audit record.');
  assert.deepEqual([...(await locks(CLIENT))], [], 'Creating a structure took no change lock.');
  console.log('  ✓ an allocation structure is created without a lock, and one audit record stands for it');

  // ── A change waits for the grant; while the answer is owed the form is closed and silent ────
  // A fresh load first: the create above left the section sitting on no row, and the owed window is only
  // observable where nothing has been asked for yet.
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await heading.waitFor();
  // Hold only this screen's claim, so releases, saves and navigations keep flowing. The handler is named, and
  // removed by that name: a stale gate would swallow every later claim this run files.
  const holder: { route?: Route } = {};
  const gate = async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    if (!(request.postData() ?? '').includes(TX_CODE)) return route.continue();
    holder.route ??= route;
    return undefined;
  };
  await page.route(url, gate);
  const auditBeforeClaim = await auditRows(CLIENT);
  await structureRowOn(page, CODE).getByRole('button', { name: 'Edit', exact: true }).click();
  assert.ok(await holderWait(holder), 'the section filed no claim when the row was chosen');
  assert.equal(await descriptionInput.isDisabled(), true, 'While the claim is owed the field is not open for a write.');
  assert.equal(await saveButton.isDisabled(), true, 'While the claim is owed the save is not offered.');
  assert.equal(await failure.count(), 0, 'A claim in flight is not a failure, and is not shown as one.');
  const beforeGrant = await readStructure(CLIENT, CODE);
  assert.equal(await auditRows(CLIENT), auditBeforeClaim, 'The owed window wrote nothing, and filed no audit record of its own.');
  await holder.route!.continue();
  delete holder.route;
  await waitForLock(CLIENT, CODE, USER);
  assert.equal(await descriptionInput.isDisabled(), false, 'The grant is what opens the field.');
  assert.equal(await saveButton.isDisabled(), false, 'The grant is what opens the save.');
  assert.equal(await notice.count(), 0, 'A granted change has nothing to report, and says nothing.');
  console.log('  ✓ the change waits for the grant, and opens the moment the answer arrives');
  await page.unroute(url, gate);

  // ── A granted change writes once, and the row's version moves with it ───────────────────────
  const auditBeforeChange = await auditRows(CLIENT);
  await descriptionInput.fill('Changed under the grant');
  await saveButton.click();
  const changed = await waitForDescription(CLIENT, CODE, 'Changed under the grant');
  assert.equal(changed?.description, 'Changed under the grant', 'A granted change is persisted.');
  assert.equal(changed?.version, (beforeGrant?.version ?? 0) + 1, 'The version the next stale form has to submit is one audit row further along.');
  assert.equal(await auditRows(CLIENT), auditBeforeChange + 1, 'One change, one audit record.');
  console.log('  ✓ a granted change is applied to the structure and audited once');

  // ── A second session is refused on the row, and is still free to create another one ─────────
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
  const otherPanel = other.locator('section[aria-label="Allocation structures"]');
  await otherPanel.getByRole('heading', { level: 2, name: 'Allocation structures', exact: true }).waitFor();
  await structureRowOn(other, CODE).getByRole('button', { name: 'Edit', exact: true }).click();
  const otherEdit = otherPanel.locator('form').filter({ has: other.getByRole('button', { name: 'Save description', exact: true }) });
  await otherEdit
    .getByRole('status')
    .getByText(new RegExp(`${LOCK_OBJECT} ${CODE} is being changed by ${USER} in ${TX_CODE}`))
    .waitFor();
  assert.match(
    (await otherEdit.getByRole('status').allInnerTexts()).join('\n'),
    /a lock nobody answers is released about three minutes after its last answer/,
    'the refusal carries the recovery sentence for a standing opening, not a retry invitation',
  );
  assert.equal(await otherEdit.getByRole('status').filter({ hasText: FAILURE_COPY }).count(), 0, 'a refusal is never dressed as an infrastructure failure');
  assert.equal(await otherEdit.locator('[name="description"]').isDisabled(), true, 'The refused session cannot type into the row it was refused.');
  assert.equal(await otherEdit.getByRole('button', { name: 'Save description', exact: true }).isDisabled(), true, 'The refused session is offered no save.');
  // A refusal is about one row. The same session may still create a structure nobody has opened, because a
  // create asks the platform for no session at all — the property Pass 36 found Missing Types had lost.
  const auditBeforeRefusal = await auditRows(CLIENT);
  const refusedRowBefore = await readStructure(CLIENT, CODE);
  const otherCreate = otherPanel.locator('form').filter({ has: other.getByRole('button', { name: 'Create structure', exact: true }) });
  assert.equal(await otherCreate.getByRole('button', { name: 'Create structure', exact: true }).isDisabled(), false, 'A refusal does not close creation of another row.');
  await otherCreate.locator('[name="structureCode"]').fill(ADDED_CODE);
  await otherCreate.locator('[name="description"]').fill('Created by the refused session');
  await otherCreate.getByRole('button', { name: 'Create structure', exact: true }).click();
  const added = await waitForRow(CLIENT, ADDED_CODE);
  assert.equal(added?.description, 'Created by the refused session', 'The refused session still creates what it is entitled to create.');
  assert.deepEqual(await readStructure(CLIENT, CODE), refusedRowBefore, 'A refusal wrote nothing to the row it was refused.');
  assert.equal(await auditRows(CLIENT), auditBeforeRefusal + 1, 'Only the legitimate create was audited.');
  assert.equal((await locks(CLIENT)).length, 1, 'The refused session neither took nor broke the lock.');
  console.log('  ✓ a second session is refused on the row, keeps its sentence, and is still free to create another');
  await second.close();

  // ── A claim that cannot be reached: the legacy screen now says so, because the projection says so ──
  // Releasing has to be an in-app navigation, or Chromium drops the release the way it drops any request in
  // flight during a document load.
  await page.locator('a[href="/config"]').first().click();
  await page.waitForURL(/\/config$/, { waitUntil: 'commit' });
  await waitForLock(CLIENT, CODE, USER, false);
  const cut = async (route: Route) => (route.request().method() === 'POST' ? route.abort('failed') : route.continue());
  await page.route(url, cut);
  const beforeFailure = await readStructure(CLIENT, CODE);
  const auditBeforeFailure = await auditRows(CLIENT);
  await page.goto(`${BASE}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await heading.waitFor();
  await structureRowOn(page, CODE).getByRole('button', { name: 'Edit', exact: true }).click();
  await failure.waitFor();
  const shown = (await failure.allInnerTexts()).join('\n');
  assert.match(shown, /Failed to fetch/, 'the safe line of what was thrown is on the screen');
  assert.ok(shown.includes(RECOVERY_COPY), 'the whole recovery line is shown, not its opening words');
  assert.doesNotMatch(shown, /is being changed by|display only/i, 'a failure never borrows the refusal wording');
  assert.equal(await descriptionInput.isDisabled(), true, 'A dead claim closes the field: the projection answers DISPLAY.');
  assert.equal(await saveButton.isDisabled(), true, 'A dead claim closes the save.');
  assert.deepEqual(await readStructure(CLIENT, CODE), beforeFailure, 'A dead claim wrote nothing.');
  assert.equal(await auditRows(CLIENT), auditBeforeFailure, 'A dead claim filed no audit record.');
  assert.deepEqual([...(await locks(CLIENT))], [], 'A claim that never reached the server left no lock standing.');
  console.log('  ✓ on an unmigrated screen a dead claim is told by the shared projection, and closes the write');

  // There is no retry control here — `ClaimFailureNotice` is on the migrated screens only, so the recovery a
  // legacy screen offers is to open the row again, which files a fresh claim. DI-002 records the difference.
  await page.unroute(url, cut);
  await structureRowOn(page, CODE).getByRole('button', { name: 'Close', exact: true }).click();
  // Deselecting a row drops the argument the hook was given, and the effect answers that with `reset`: a claim
  // is retired with the row it was filed for, rather than left to speak over an empty form. Asserted, because
  // the alternative — a dead claim's notice still hanging under "Description of the selected structure" —
  // would read as if the blank form itself had been refused.
  await failure.waitFor({ state: 'detached' });
  assert.equal(await failure.count(), 0, 'Leaving the row retires the claim, so no stale notice is left over an empty form.');
  assert.equal(
    (await panel.getByRole('heading', { level: 3, name: /^Description of/ }).innerText()).trim(),
    'Description of the selected structure',
    'The form is left with no row of its own.',
  );
  assert.equal(await saveButton.isDisabled(), true, 'With no row chosen, the save is not offered either way.');
  assert.deepEqual([...(await locks(CLIENT))], [], 'A retired claim leaves nothing standing behind the record.');
  await structureRowOn(page, CODE).getByRole('button', { name: 'Edit', exact: true }).click();
  await waitForLock(CLIENT, CODE, USER);
  await failure.waitFor({ state: 'detached' });
  assert.deepEqual(await readStructure(CLIENT, CODE), beforeFailure, 'Nothing was applied between the failure and the re-open.');
  const auditAtGrant = await auditRows(CLIENT);
  await descriptionInput.fill('Changed after the re-open');
  await saveButton.click();
  const retried = await waitForDescription(CLIENT, CODE, 'Changed after the re-open');
  assert.equal(retried?.description, 'Changed after the re-open', 'The re-opened claim carries the change typed after it.');
  assert.equal(await auditRows(CLIENT), auditAtGrant + 1, 'One change went through: nothing the failure dropped came back as a second one.');
  console.log('  ✓ re-opening the row files a new claim, and one change is audited once afterwards');

  // ── Leaving the section releases its opening ───────────────────────────────────────────────
  await page.locator('a[href="/config"]').first().click();
  await page.waitForURL(/\/config$/, { waitUntil: 'commit' });
  await waitForLock(CLIENT, CODE, USER, false);
  assert.deepEqual([...(await locks(CLIENT))], [], 'No stale opening stands behind the structure.');
  console.log('  ✓ leaving the screen releases the lock, so no stale opening stands behind the record');
}
