import type { Locator, Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { createEmployee } from '../../src/modules/people/employee-master';
import { getPosition } from '../../src/modules/people/org-structure';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/people/assignments';
const ORG_ROUTE = '/people/organization';
const UNIT = 'A3000';
const POSITION = 'P100';
const EMPLOYEE = 'E2000001';
const AREA = 'A000';
const CC = 'CC900';
const CC_OTHER = 'CC901';
const CC_FUTURE = 'CC902';
const DAY1 = '2031-01-01';
const DAY_AFTER = '2031-01-02';
const FUTURE_DAY = '2032-07-01';

/**
 * The reference transaction is discussed at the end of the run: §10.8 cites PA30 here and for the employee
 * master, 9196 registered it against the master, and this journey records what typing it therefore does.
 *
 * The structure is built on its own screen first, because an operator arrives here with a
 * position already defined and the graph is what this screen reads. Assignment is the table
 * where a day is a constraint rather than a label, so the journey walks the constraint: one
 * assignment closed on its own first day, a second that cannot start on a covered day, the
 * replacement that starts the day after, and the mapping rule that only a cost centre in
 * force on that first day may be named — which is why the future-dated centre is refused for
 * the 2031 start and accepted for the 2032 one.
 *
 * Correction is asserted where the screen allows it and where it refuses: only the open row
 * can be corrected, the dates cannot be moved by a correction, and an empty correction changes
 * nothing. The one case this screen cannot reach is a correction of a row a newer one replaced,
 * because the screen does not offer the control there; that refusal is asserted in the service
 * tests and recorded as untested here rather than claimed.
 *
 * Employees and cost centres come in through the service and one seeded row: the employee
 * master and KS01 have their own acceptance targets, and this journey is about the assignment.
 */
export async function peopleAssignments(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log(
    'People: verify assignment through the screen, the covered-day refusal, the inclusive end date, the cost-centre validity as of the start, correction, search and the read-back',
  );

  // ── 1. The shape the screen needs: a unit, a position, an employee, two centres ─
  await page.goto(`${base}${ORG_ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const unit = panel(page, 'Define an organisational unit');
  await setField(unit, 'code', UNIT);
  await setField(unit, 'name', 'Alpine Operations');
  await unit.getByRole('button', { name: 'Define unit', exact: true }).click();
  await status(page, new RegExp(`Unit ${UNIT} — Alpine Operations — defined at level 1\\.`));

  await page.goto(`${base}${ORG_ROUTE}?tab=positions`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const position = panel(page, 'Define a position');
  await setField(position, 'code', POSITION);
  await setField(position, 'title', 'Rope Way Warden');
  await setField(position, 'orgUnitCode', UNIT);
  await position.getByRole('button', { name: 'Define position', exact: true }).click();
  await status(page, new RegExp(`Position ${POSITION} — Rope Way Warden — created in ${UNIT}\\.`));

  await createEmployee({
    client,
    personnelNumber: EMPLOYEE,
    fullName: 'Mariam Alsuwaidi',
    changedBy: 'browser.admin',
    requestKey: 'people-assignments-browser-employee',
  });
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      values
        (${client}, ${AREA}, ${CC}, '2020-01-01', '9999-12-31', 'Warden centre', 'PRODUCTION', '1000', 'browser.admin'),
        (${client}, ${AREA}, ${CC_OTHER}, '2020-01-01', '9999-12-31', 'Relief centre', 'PRODUCTION', '1000', 'browser.admin'),
        (${client}, ${AREA}, ${CC_FUTURE}, '2032-06-01', '9999-12-31', 'Later centre', 'PRODUCTION', '1000', 'browser.admin')
      on conflict do nothing`);
  });
  console.log('  ✓ the unit and position come from the structure screen; the employee and the centres are standing fixtures for this journey');

  // ── 2. The assignment is written ──────────────────────────────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Assignments', exact: true }).waitFor();
  assert.equal(
    (await page.locator('header .code').first().innerText()).trim(),
    'PEOPLE.ASSIGNMENT.MAINTAIN',
    'The screen names the activity that maintains it — and nothing else, because no reference transaction '
      + 'code is registered against this screen: 9196 gives PA30 to the employee master, which is what the '
      + 'reference product opens with it.',
  );

  const write = panel(page, 'Start an assignment');
  await setField(write, 'personnelNumber', EMPLOYEE);
  await setField(write, 'position', POSITION);
  await setField(write, 'controllingArea', AREA);
  await setField(write, 'costCenter', CC);
  await setField(write, 'validFrom', DAY1);
  await write.getByRole('button', { name: 'Write assignment', exact: true }).click();
  await status(page, new RegExp(`Assignment written for ${EMPLOYEE}: ${POSITION} on ${CC} from ${DAY1}\\.`));
  let stored = await assignmentRow(client, DAY1);
  assert.equal(stored?.cost_center, CC, 'The centre named on the form is the one stored.');
  assert.equal(stored?.valid_to, null, 'An assignment is open until it is ended.');
  assert.equal(stored?.controlling_area, AREA, 'And the mapping is stored with it, not derived later.');
  assert.equal((await getPosition(client, POSITION)).incumbents, 1, 'The position reads one incumbent, through the structure.');
  console.log('  ✓ the assignment is written, stands open, and the position counts its incumbent');

  // ── 3. Ending it on its own first day, inclusive ──────────────────────────
  await page.goto(`${base}${ROUTE}?employee=${EMPLOYEE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const standing = panel(page, 'The assignment standing today');
  await standing.waitFor();
  assert.match(await standing.innerText(), new RegExp(`${CC}`), 'The panel names the centre the assignment stands on.');
  await setField(standing, 'validTo', DAY1);
  await standing.getByRole('button', { name: 'End assignment', exact: true }).click();
  await status(page, new RegExp(`Assignment from ${DAY1} now runs to ${DAY1} inclusive\\. The next one may start on the day after it\\.`));
  stored = await assignmentRow(client, DAY1);
  assert.equal(stored?.valid_to, DAY1, 'The last day is the first day: the row covered exactly one day.');
  console.log('  ✓ the open assignment is ended on its own start day, and the day is inside the span');

  // ── 4. A second assignment cannot start on a covered day ─────────────────
  const retry = panel(page, 'Start an assignment');
  await setField(retry, 'personnelNumber', EMPLOYEE);
  await setField(retry, 'position', POSITION);
  await setField(retry, 'controllingArea', AREA);
  await setField(retry, 'costCenter', CC_OTHER);
  await setField(retry, 'validFrom', DAY1);
  await retry.getByRole('button', { name: 'Write assignment', exact: true }).click();
  await status(page, /The employee already has an assignment covering that day\./);
  assert.equal(await rowCount(client), 1, 'The covered day refused the write and left the table alone.');
  console.log('  ✓ starting on a day the closed assignment still covers is refused');

  // ── 5. The centre has to be in force on the day the assignment starts ─────
  const future = panel(page, 'Start an assignment');
  await setField(future, 'personnelNumber', EMPLOYEE);
  await setField(future, 'position', POSITION);
  await setField(future, 'controllingArea', AREA);
  await setField(future, 'costCenter', CC_FUTURE);
  await setField(future, 'validFrom', DAY_AFTER);
  await future.getByRole('button', { name: 'Write assignment', exact: true }).click();
  await status(page, /That cost centre does not stand in the area on the day the assignment starts\./);
  assert.equal(await rowCount(client), 1, 'The refused mapping wrote nothing: no half-mapped row stands.');

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const later = panel(page, 'Start an assignment');
  await setField(later, 'personnelNumber', EMPLOYEE);
  await setField(later, 'position', POSITION);
  await setField(later, 'controllingArea', AREA);
  await setField(later, 'costCenter', CC_FUTURE);
  await setField(later, 'validFrom', FUTURE_DAY);
  await later.getByRole('button', { name: 'Write assignment', exact: true }).click();
  await status(page, new RegExp(`Assignment written for ${EMPLOYEE}: ${POSITION} on ${CC_FUTURE} from ${FUTURE_DAY}\\.`));
  assert.equal(await rowCount(client), 2, 'The same centre is accepted once the day it starts on is inside its own validity.');
  console.log('  ✓ a centre not yet in force is refused for the earlier day and accepted for the later one');

  // ── 6. Correction reaches the open row, its dates stay ────────────────────
  await page.goto(`${base}${ROUTE}?employee=${EMPLOYEE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const correct = panel(page, 'The assignment standing today');
  await correct.getByRole('button', { name: 'Correct open assignment', exact: true }).click();
  await status(page, /No field was given, so nothing would change\./);

  const again = panel(page, 'The assignment standing today');
  await setField(again, 'costCenter', CC_OTHER);
  await again.getByRole('button', { name: 'Correct open assignment', exact: true }).click();
  await status(page, new RegExp(`Open assignment for ${EMPLOYEE} corrected: ${POSITION} on ${CC_OTHER}\\.`));
  const corrected = await assignmentRow(client, FUTURE_DAY);
  assert.equal(corrected?.cost_center, CC_OTHER, 'The centre moved as the operator asked.');
  assert.equal(corrected?.valid_from, FUTURE_DAY, 'The dates were left as they were written.');
  assert.equal(corrected?.valid_to, null, 'And the row is still open.');
  console.log('  ✓ an empty correction is refused, the mapped centre is corrected, and the dates were not touched');

  // ── 7. Search, the open-only filter, and what the lists show ─────────────
  // Two views of the same fact: the person's own history, which opens from their number, and the search list,
  // which the `q` box answers with. The history panel belongs to `?employee=` alone, so each is read from the
  // place the screen actually puts it.
  await page.goto(`${base}${ROUTE}?employee=${EMPLOYEE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  assert.equal(
    await panel(page, 'Assignment history').locator('tbody tr').count(),
    2,
    'Both spans of this employee are listed.',
  );
  await page.goto(`${base}${ROUTE}?q=${EMPLOYEE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  assert.equal(
    await panel(page, 'Assignments found').locator('tbody tr').count(),
    2,
    'And the search box answers with the same two spans.',
  );
  await page.goto(`${base}${ROUTE}?q=${EMPLOYEE}&open=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const openRows = panel(page, 'Assignments found');
  await openRows.waitFor();
  assert.match(await openRows.innerText(), new RegExp(FUTURE_DAY), 'Standing today leaves the closed span out.');
  assert.doesNotMatch(await openRows.innerText(), new RegExp(`${DAY1} →`), 'And the day it covered is not offered as standing.');

  await page.goto(`${base}${ROUTE}?position=${POSITION}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  assert.match(await page.locator('main').innerText(), new RegExp(EMPLOYEE), 'Reading the position finds the person assigned to it.');
  assert.equal(await page.getByRole('button', { name: /delete/i }).count(), 0, 'No row offers deletion: a span is ended, not removed.');
  console.log('  ✓ search and the standing-today filter answer from the same table, by employee and by position');

  // ── 8. The tenant holds exactly this run ──────────────────────────────────
  const rows = await withTenant(
    client,
    async (tx) =>
      (await tx.execute(sql`select personnel_number as personnel, count(*)::int as n from position_assignment group by 1`)) as unknown as Array<{
        personnel: string;
        n: number;
      }>,
  );
  // Mapped to pairs rather than compared as a whole array: the driver hands back its own array subclass, and a
  // deep comparison against a literal would fail on the constructor while the rows themselves are right.
  assert.deepEqual(
    rows.map((row) => [row.personnel, row.n]),
    [[EMPLOYEE, 2]],
    'Two spans for one employee, nothing else in the tenant.',
  );
  assert.equal(
    (await getPosition(client, POSITION)).incumbents,
    2,
    'The position counts the two spans that have not ended — a planned one holds the place — and not the one '
      + 'closed on its own first day.',
  );
  console.log('  ✓ the persisted table holds exactly what the run wrote, and the count follows the spans that have not ended');

  // ── 9. How the operator gets here, and what typing PA30 actually does ──────
  await page.goto(`${base}/people/organization`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('link', { name: 'Assignments', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: 'Assignments', exact: true }).waitFor();
  await page.goto(`${base}/registry?q=PA30`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const main = await page.locator('main').innerText();
  assert.match(main, /PA30/, 'Typing the reference code answers with the term that carries it.');
  assert.match(main, /Employee master/, 'And the term it answers with is the person, not this screen.');
  assert.equal(
    await page.locator(`main a[href="${ROUTE}"]`).count(),
    0,
    'The registry offers no way in from PA30 to the assignment screen, which is the decision 9196 made, '
      + 'not a broken link.',
  );
  console.log('  ✓ the structure screen links here, and PA30 leads to the person as registered');
}

async function status(page: Page, pattern: RegExp): Promise<string> {
  const notice = page.getByRole('status').filter({ hasText: pattern }).first();
  try {
    await notice.waitFor({ timeout: 15_000 });
  } catch (error) {
    // Print what the screen actually said before giving up: a wait that times out is either the wrong words in
    // the journey or a real refusal, and the two look identical from the outside.
    const seen = await page.getByRole('status').allInnerTexts();
    console.log(`  ! no status matching ${pattern}; the screen held: ${JSON.stringify(seen)}`);
    throw error;
  }
  return (await notice.innerText()).replace(/\s+/g, ' ');
}

/** The block a screen marks for an operator, whether the label sits on its section or its form. */
function panel(page: Page, label: string): Locator {
  return page.locator(`[aria-label="${label}"]`).first();
}

/** The stored row behind one span of this employee, read straight from the tenant. */
async function assignmentRow(client: string, validFrom: string): Promise<Record<string, string | null> | undefined> {
  const rows = await withTenant(
    client,
    async (tx) =>
      (await tx.execute(
        sql`select cost_center, controlling_area, valid_to, valid_from::text as valid_from
               from position_assignment
              where personnel_number = ${EMPLOYEE} and valid_from = ${validFrom}`,
      )) as unknown as Array<Record<string, string | null>>,
  );
  return rows[0];
}

async function rowCount(client: string): Promise<number> {
  return withTenant(
    client,
    async (tx) =>
      (await tx.execute(sql`select count(*)::int as n from position_assignment`)) as unknown as Array<{ n: number }>,
  ).then((rows) => rows[0]?.n ?? 0);
}

async function setField(scope: Locator, name: string, value: string | boolean): Promise<void> {
  const control = scope.locator(`[name="${name}"]`).first();
  if (!(await control.isVisible())) return;
  const tag = (await control.evaluate((node) => node.tagName)).toLowerCase();
  if (tag === 'select') {
    await control.selectOption(String(value));
    return;
  }
  if ((await control.getAttribute('type')) === 'checkbox') {
    if (value) await control.check();
    else await control.uncheck();
    return;
  }
  await control.fill(String(value));
}
