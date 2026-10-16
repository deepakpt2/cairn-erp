import type { Locator, Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/config/chart-of-accounts/copy';
const CHARTS_ROUTE = '/config/chart-of-accounts';
const ACTIVITY = 'CFG.FIN.COA.COPY';
/** The operational chart the standard package installs, with its accounts already in it. */
const SOURCE = 'CA01';
/** A target of the same width, and empty: nothing has been copied into it yet. */
const TARGET = 'CA02';
/** A target too narrow for the source's account numbers, and empty besides. */
const NARROW = 'CA03';
/** The Account Group every account of the package chart belongs to. */
const GROUP = 'GENL';
const REASON = 'Browser acceptance run';

/**
 * SCR-027 / OBY7 browser acceptance: what copying one Chart of Accounts into another refuses.
 *
 * A copy is the one configuration act in this screen set that writes many rows and files a single
 * document, and almost all of what makes it safe is what it declines to do. Every refusal is
 * asserted twice: once for what the reader is told, and once for what was not written, because a
 * screen that explains a refusal while quietly doing the work would pass the first test alone.
 *
 * Scope, by owner ruling this round: the refusals. A successful copy needs the target chart to
 * hold the source's Account Groups first, and a copy never creates registry entries, so proving
 * the write path means driving the Account Group panel of the G/L account screen before the copy.
 * That is left out on purpose, and with it the padding of account numbers into a wider target, the
 * overwrite guard, an identical second copy, the one-document-for-many-accounts bargain, the guard
 * that aborts a copy whose overwrite would hit postings, open items or a locked balance, and the
 * target Account Group matrix dropping suppressed fields. They are recorded here rather than
 * quietly skipped, and none of them is covered by any other browser target.
 */
export async function chartOfAccountsCopyOby7(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('SCR-027 OBY7: verify what the chart copy refuses, and that every refusal writes nothing');

  // ── 1. The screen, and a copy onto itself ─────────────────────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Copy Chart of Accounts', exact: true }).waitFor();
  assert.match(
    await page.locator('.code.text-2xs').first().innerText(),
    new RegExp(`${ACTIVITY} · OBY7`),
    'The screen says which activity and which reference transaction it is.',
  );
  const panel = copyPanel(page);
  await panel.locator('#copy-chart-source').selectOption(SOURCE);
  await panel.locator('#copy-chart-target').selectOption(SOURCE);
  await panelParagraph(page, /must be different Charts of Accounts/).waitFor();
  assert.equal(await submit(page).isDisabled(), true, 'A chart cannot be copied onto itself.');
  assert.equal(
    await panel.locator('#copy-chart-source option:not([value=""])').count(),
    1,
    'With one chart defined, that is the only one offered.',
  );

  await page.goto(`${base}/config`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const workbenchRow = page.locator('tr').filter({ hasText: ACTIVITY }).first();
  await workbenchRow.waitFor();
  assert.equal(
    await workbenchRow.getByRole('link', { name: 'Open', exact: true }).getAttribute('href'),
    ROUTE,
    'The workbench opens the screen that can do the work.',
  );
  console.log('  ✓ the screen refuses a copy onto itself and the workbench routes the activity here');

  // ── 2. Two more charts, defined through their own screen ──────────────────
  await defineChart(page, base, TARGET, 'Copy target, same width', 10);
  await defineChart(page, base, NARROW, 'Copy target, too narrow', 8);
  assert.equal(await storedChartWidth(client, TARGET), 10, 'The same-width target is defined.');
  assert.equal(await storedChartWidth(client, NARROW), 8, 'The narrow target is defined.');
  assert.equal((await storedAccounts(client, TARGET)).length, 0, 'A new chart holds no accounts.');
  console.log(`  ✓ ${TARGET} and ${NARROW} defined through the Chart of Accounts screen, both empty`);

  // ── 3. A target too narrow is refused before the click ────────────────────
  const sourceAccounts = await storedAccounts(client, SOURCE);
  assert.ok(sourceAccounts.length > 0, 'The package chart holds accounts to copy.');

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await copyPanel(page).locator('#copy-chart-source').selectOption(SOURCE);
  await copyPanel(page).locator('#copy-chart-target').selectOption(NARROW);
  const narrow = await panelParagraph(page, /cannot take the/).innerText();
  assert.match(narrow, /holds 8 characters/, 'The refusal says how wide the target is.');
  assert.match(narrow, /10-character account numbers/, 'And how wide the source numbers are.');
  assert.equal(await submit(page).isDisabled(), true, 'A copy into a narrower chart cannot be submitted.');
  assert.equal((await storedAccounts(client, NARROW)).length, 0, 'Nothing was written to it.');
  console.log(`  ✓ copying into ${NARROW} is refused on the screen, naming both widths`);

  // ── 4. A wider target needs the padding flag ──────────────────────────────
  // The narrow chart is the source here: it is the only one that is narrower than another chart,
  // which is what makes the padding rule reachable at all.
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await copyPanel(page).locator('#copy-chart-source').selectOption(NARROW);
  await copyPanel(page).locator('#copy-chart-target').selectOption(TARGET);
  await copyPanel(page).locator('#copy-chart-reason').fill(REASON);
  const padding = await panelParagraph(page, /Account numbers grow from 8 to 10 characters/).innerText();
  assert.match(padding, /Enable Pad leading zeros/, 'The form says which flag the growth needs.');
  assert.equal(await submit(page).isDisabled(), true, 'Growing account numbers without the flag cannot be submitted.');
  await copyPanel(page).locator('[name="padLeadingZeros"]').check();
  await panelParagraph(page, /Ready to copy every account/).waitFor();
  assert.equal(await submit(page).isDisabled(), false, 'With the flag, the form has nothing left to object to.');
  console.log('  ✓ a wider target needs the padding flag, and the form says so before the click');

  // ── 5. An empty source has nothing to copy ────────────────────────────────
  // The form cannot know a chart is empty; the service can, and this is where it says so.
  await submit(page).click();
  // Found by what it says: the page carries an empty alert region before any answer arrives, and
  // waiting for "an alert" is satisfied by it.
  const empty = page.getByRole('alert').filter({ hasText: /holds no G\/L accounts/ });
  await empty.waitFor();
  const emptyText = await empty.innerText();
  assert.match(emptyText, /holds no G\/L accounts/, 'The refusal says the source chart is empty.');
  assert.match(emptyText, /Create accounts in FS00 first/, 'And it names the screen where that is done.');
  assert.equal((await storedAccounts(client, TARGET)).length, 0, 'Nothing was written to the target.');
  assert.equal((await copyDocuments(client)).length, 0, 'A refused copy files no document.');
  console.log(`  ✓ copying the empty ${NARROW} is refused by the service, naming where to create accounts`);

  // ── 6. A target without the source's Account Group is refused ─────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await copyPanel(page).locator('#copy-chart-source').selectOption(SOURCE);
  await copyPanel(page).locator('#copy-chart-target').selectOption(TARGET);
  await copyPanel(page).locator('#copy-chart-reason').fill(REASON);
  await panelParagraph(page, /Ready to copy every account/).waitFor();
  assert.equal(
    await submit(page).isDisabled(),
    false,
    'Both charts are the same width and the reason is given, so the form has nothing to object to.',
  );
  await submit(page).click();
  const group = page.getByRole('alert').filter({ hasText: /Account Group/ });
  await group.waitFor();
  const groupText = await group.innerText();
  assert.match(groupText, new RegExp(`Account Group ${GROUP}`), 'The refusal names the Account Group that is missing.');
  assert.match(groupText, new RegExp(`used by chart ${SOURCE}`), 'It names the chart whose accounts need it.');
  assert.match(groupText, new RegExp(`does not exist in chart ${TARGET}`), 'And the chart that does not hold it.');
  assert.match(
    groupText,
    /a copy never creates registry entries/,
    'The remedy says the copy will not create the group itself.',
  );
  assert.equal((await storedAccounts(client, TARGET)).length, 0, 'Nothing was copied.');
  assert.equal((await storedAccounts(client, SOURCE)).length, sourceAccounts.length, 'The source was not touched.');
  assert.equal((await copyDocuments(client)).length, 0, 'And no document was filed for a copy that did nothing.');
  await page.screenshot({ path: '.arena/chart-of-accounts-copy-refused-review.png', fullPage: true });
  console.log(`  ✓ a copy into ${TARGET} is refused for want of Account Group ${GROUP}, writing and filing nothing`);

  console.log('SCR-027 OBY7 passed: every refusal named, and nothing written behind any of them');
}

function copyPanel(page: Page): Locator {
  return page.locator('section[aria-labelledby="copy-chart-copy-title"]');
}

function submit(page: Page): Locator {
  return copyPanel(page).getByRole('button', { name: 'Copy Chart of Accounts', exact: true });
}

/**
 * A paragraph of the copy form's own commentary: its live problems and its preview of what is
 * about to happen. Neither carries a role - the role belongs to the answer an action returns - so
 * both are found by what they say.
 */
function panelParagraph(page: Page, text: RegExp): Locator {
  return copyPanel(page).locator('p').filter({ hasText: text }).first();
}

/** Define a chart through the OB13 screen, the only place a chart comes from. */
async function defineChart(page: Page, base: string, key: string, name: string, width: number) {
  await page.goto(`${base}${CHARTS_ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const panel = page.locator('section[aria-labelledby="ob13-create-title"]');
  await panel.locator('[name="chartOfAccounts"]').fill(key);
  await panel.locator('[name="name"]').fill(name);
  await panel.locator('[name="accountNumberLength"]').fill(String(width));
  await panel.getByRole('button', { name: 'Create Chart of Accounts', exact: true }).click();
  // Wait for the screen's own confirmation rather than for the network to go quiet: a quiet
  // network can arrive while the action is still in flight, and the caller reads the ledger
  // straight afterwards.
  await panel
    .getByRole('status')
    .filter({ hasText: new RegExp(`Chart of Accounts ${key} created`) })
    .waitFor();
  await page.waitForLoadState('networkidle');
}

type StoredAccount = { account_number: string; name: string };

async function storedAccounts(client: string, chart: string): Promise<StoredAccount[]> {
  return (await withTenant(client, (tx) =>
    tx.execute(
      sql`select account_number, name
            from gl_account
           where chart_of_accounts = ${chart}
           order by account_number`,
    ),
  )) as unknown as StoredAccount[];
}

async function storedChartWidth(client: string, chart: string): Promise<number | undefined> {
  const rows = (await withTenant(client, (tx) =>
    tx.execute(
      sql`select account_number_length from chart_of_accounts where chart_of_accounts = ${chart}`,
    ),
  )) as unknown as Array<{ account_number_length: number }>;
  return rows[0]?.account_number_length;
}

/** Every copy document this screen filed. In a tenant where every copy was refused: none. */
async function copyDocuments(client: string) {
  return (await withTenant(client, (tx) =>
    tx.execute(
      sql`select id, object_class, object_key, change_type
            from change_document
           where transaction_code = ${ACTIVITY}
           order by id`,
    ),
  )) as unknown as Array<{ id: string; object_class: string; object_key: string; change_type: string }>;
}
