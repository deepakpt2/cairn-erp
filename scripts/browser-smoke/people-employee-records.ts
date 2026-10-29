import type { Locator, Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import { getEmployee } from '../../src/modules/people/employee-master';
import { getRecordType } from '../../src/modules/people/record-types';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/people/employees';
const REGISTRY = '/registry';
const CONFIG_ROUTE = '/config/people-record-types';
const ACTIVITY = 'CFG.PEOPLE.RECORDTYPE.DEFINE';
const TYPE = 'BANKD';
const EMPLOYEE = 'E1000001';
const PERSON = 'Huda Almutairi';
const DAY1 = '2031-01-01';
const DAY2 = '2031-07-01';

/**
 * PA30 / PA40 / PT60 browser acceptance for the employee master and its dated records.
 *
 * This is where People differs from every master before it: a date decides whether a
 * write is allowed at all. So the journey is walked through the screens rather than the
 * service — the record type is defined and extended, an employee is created, the first
 * record is written, a record for a date already covered is refused, the open record is
 * delimited and its replacement accepted the day after, and a correction is refused once
 * a newer record stands and accepted while the record is the open one. The screen has to
 * carry those decisions; the service tests already assert the rules behind them.
 *
 * Every write is read back from the database through the service, because a form that
 * renders a value is not a form that stored it, and the change document is read back
 * beside it, because the audit trail is part of what was promised.
 */
export async function peopleEmployeeRecords(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log(
    'People: verify the record-type definition and field change, the employee master, the dated record, the overlap refusal, delimitation, correction and the documents',
  );

  // ── 1. The configuration workbench opens the record-type screen ───────────
  await page.goto(`${base}/config`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const workbenchRow = page.locator('tr').filter({ hasText: ACTIVITY }).first();
  await workbenchRow.waitFor();
  assert.equal(
    await workbenchRow.getByRole('link', { name: 'Open', exact: true }).getAttribute('href'),
    CONFIG_ROUTE,
    'The workbench opens the screen that can define record types.',
  );
  console.log('  ✓ the workbench routes to the record-type screen');

  // ── 2. A type is defined with its first required field ────────────────────
  await page.goto(`${base}${CONFIG_ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Employee record types', exact: true }).waitFor();
  // The header names the activity and nothing else: §10.8 gives this configuration step no reference
  // transaction of its own, and the screen does not invent one.
  assert.equal(
    (await page.locator('header .code').first().innerText()).trim(),
    ACTIVITY,
    'The screen says which activity maintains it.',
  );

  const define = panel(page, 'Define record type');
  await setField(define, 'code', TYPE);
  await setField(define, 'name', 'Bank detail');
  await setField(define, 'description', 'Where the salary is paid.');
  await setField(define, 'fieldCode', 'ACCT');
  await setField(define, 'fieldLabel', 'Account number');
  await setField(define, 'valueKind', 'TEXT');
  await setField(define, 'fieldRequired', true);
  await define.getByRole('button', { name: 'Define type', exact: true }).click();
  await status(page, new RegExp(`${TYPE} — Bank detail — defined with 1 field`));
  let stored = await getRecordType(client, TYPE);
  assert.equal(stored.fields.length, 1, 'The first field came with the definition.');
  assert.equal(stored.fields[0]?.code, 'ACCT');
  assert.equal(stored.fields[0]?.isRequired, true, 'The field was marked required and stored that way.');
  assert.equal(stored.isValid, true);
  let docs = await documents(client, 'record_type', TYPE);
  assert.equal(docs.length, 1, 'One definition, one document.');
  assert.equal(docs[0]?.changeType, 'CREATE', 'The definition is recorded as a creation, not an overwrite.');
  console.log(`  ✓ ${TYPE} defined with its required field, stored and documented`);

  // ── 3. The same code again is refused, and files nothing ──────────────────
  const again = panel(page, 'Define record type');
  await setField(again, 'code', TYPE);
  await setField(again, 'name', 'Bank detail second');
  await setField(again, 'fieldCode', 'ACCT');
  await setField(again, 'fieldLabel', 'Account number');
  await setField(again, 'valueKind', 'TEXT');
  await again.getByRole('button', { name: 'Define type', exact: true }).click();
  await status(page, /A record type with that code is already defined in this tenant\./);
  assert.equal((await documents(client, 'record_type', TYPE)).length, 1, 'A refused definition files no document.');
  console.log('  ✓ a second type under the same code is refused and files nothing');

  // ── 4. A second field is added, then relaxed from the selected type ───────
  await page.goto(`${base}${CONFIG_ROUTE}?type=${TYPE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const listed = panel(page, 'Defined record types');
  await listed.getByRole('button', { name: 'Add a field', exact: true }).click();
  const addField = page.locator(`form[aria-label="Add a field to ${TYPE}"]`);
  await setField(addField, 'fieldCode', 'OPEN');
  await setField(addField, 'fieldLabel', 'Opened on');
  await setField(addField, 'valueKind', 'DATE');
  await addField.getByRole('button', { name: 'Add field', exact: true }).click();
  await status(page, /OPEN added to BANKD — 2 fields now\./);
  stored = await getRecordType(client, TYPE);
  assert.deepEqual(
    stored.fields.map((field) => [field.code, field.valueKind, field.isRequired]),
    [
      ['ACCT', 'TEXT', true],
      ['OPEN', 'DATE', false],
    ],
    'The new field joins the ones already there rather than replacing them.',
  );

  await listed.getByRole('button', { name: 'make required', exact: true }).first().click();
  await status(page, /OPEN on BANKD: required\./);
  stored = await getRecordType(client, TYPE);
  assert.equal(stored.fields[1]?.isRequired, true, 'The toggle reached the field, not just the screen.');
  console.log('  ✓ a field is added to a standing type and its requirement changed in place');

  // ── 5. The employee is created, and a duplicate is refused ────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Employees', exact: true }).waitFor();
  const create = panel(page, 'Create employee');
  await setField(create, 'personnelNumber', EMPLOYEE);
  await setField(create, 'fullName', PERSON);
  await create.getByRole('button', { name: 'Create employee', exact: true }).click();
  await status(page, new RegExp(`Employee ${EMPLOYEE} — ${PERSON} — created with no record yet\\.`));
  let view = await getEmployee(client, EMPLOYEE);
  assert.equal(view.isActive, true);
  assert.equal(view.records.length, 0, 'A new employee has a master and no history.');
  const employeeDocs = await documents(client, 'employee', EMPLOYEE);
  assert.equal(employeeDocs.length, 1, 'The creation is documented.');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const dupe = panel(page, 'Create employee');
  await setField(dupe, 'personnelNumber', EMPLOYEE);
  await setField(dupe, 'fullName', 'Someone else');
  await dupe.getByRole('button', { name: 'Create employee', exact: true }).click();
  await status(page, /An employee with that personnel number already stands in this tenant\./);
  console.log('  ✓ the employee stands, and a second person cannot share the number');

  // ── 6. A record for a date already covered is refused ─────────────────────
  await page.goto(`${base}${ROUTE}?employee=${EMPLOYEE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const write = panel(page, 'Write a dated record');
  await setField(write, 'recordType', TYPE);
  await setField(write, 'validFrom', DAY1);
  await setField(write, 'f_ACCT', 'KW-01');
  await setField(write, 'f_OPEN', DAY1);
  await write.getByRole('button', { name: 'Write record', exact: true }).click();
  await status(page, new RegExp(`Record of ${TYPE} written from ${DAY1}\\.`));
  view = await getEmployee(client, EMPLOYEE);
  assert.equal(view.records.length, 1);
  assert.equal(view.records[0]?.validTo, null, 'The record stands open with no last day.');

  const againWrite = panel(page, 'Write a dated record');
  await setField(againWrite, 'recordType', TYPE);
  await setField(againWrite, 'validFrom', DAY1);
  await setField(againWrite, 'f_ACCT', 'KW-02');
  await setField(againWrite, 'f_OPEN', DAY1);
  await againWrite.getByRole('button', { name: 'Write record', exact: true }).click();
  await status(page, /Another record of the same type already covers that date\./);
  view = await getEmployee(client, EMPLOYEE);
  assert.equal(view.records.length, 1, 'The refused overlap wrote nothing beside the first record.');
  console.log('  ✓ the first record stands, and a second one for the same date is refused');

  // ── 7. Delimit, then the replacement is accepted the day after ───────────
  // Every standing record carries its own end-and-correct controls, and the row itself says which record they
  // act on through its hidden inputs — so the operator works from the row rather than naming the record again.
  const ended = page.locator('li', { hasText: `${DAY1} → open` }).first();
  await setField(ended.locator('form[aria-label="End record"]'), 'validTo', DAY2);
  await ended.getByRole('button', { name: 'End record', exact: true }).click();
  await status(page, new RegExp(`Record of ${TYPE} from ${DAY1} now ends on ${DAY2}\\.`));
  const dayAfter = '2031-07-02';
  const next = panel(page, 'Write a dated record');
  await setField(next, 'recordType', TYPE);
  await setField(next, 'validFrom', dayAfter);
  await setField(next, 'f_ACCT', 'KW-02');
  await setField(next, 'f_OPEN', dayAfter);
  await next.getByRole('button', { name: 'Write record', exact: true }).click();
  await status(page, new RegExp(`Record of ${TYPE} written from ${dayAfter}\\.`));
  view = await getEmployee(client, EMPLOYEE);
  assert.equal(view.records.length, 2, 'Both records stand: the delimited one and its replacement.');
  const closed = view.records.find((record: { validFrom: string }) => record.validFrom === DAY1);
  assert.equal(closed?.validTo, DAY2, 'The closed record keeps the last day it was given.');
  assert.equal(
    answer(closed, 'ACCT'),
    'KW-01',
    'Delimiting left the answered values alone: history is not rewritten.',
  );
  console.log('  ✓ the record is delimited, the replacement starts the day after, and the closed row keeps its values');

  // ── 8. Correction reaches only the open record ───────────────────────────
  // The screen never offers a correction on a record a newer one has replaced: the row says so in words and
  // carries no control. What the service does if a correction is posted for that record anyway is held by the
  // focused tests — a browser cannot reach a form the UI does not render, so this run says that plainly rather
  // than claiming a refusal it never asked for.
  const closedRow = page.locator('li', { hasText: `${DAY1} → ${DAY2}` }).first();
  assert.equal(
    await closedRow.getByRole('button', { name: 'Correct this record' }).count(),
    0,
    'A replaced record is not offered for correction.',
  );
  assert.match(
    await closedRow.innerText(),
    /Replaced by a newer record of this type/,
    'The row says why the closed record is left alone.',
  );

  // The open record beside it is corrected — and only it.
  const openRow = page.locator('li', { hasText: `${dayAfter} → open` }).first();
  await openRow.getByRole('button', { name: 'Correct this record', exact: true }).click();
  const correct = openRow.locator('form[aria-label="Correct record values"]');
  await setField(correct, 'f_ACCT', 'KW-77');
  await correct.getByRole('button', { name: 'Save the answers', exact: true }).click();
  await status(page, new RegExp(`Record of ${TYPE} from ${dayAfter} corrected`));
  view = await getEmployee(client, EMPLOYEE);
  assert.equal(
    answer(view.records.find((record: { validFrom: string }) => record.validFrom === dayAfter), 'ACCT'),
    'KW-77',
    'The open record answers to the correction.',
  );
  assert.equal(
    answer(view.records.find((record: { validFrom: string }) => record.validFrom === DAY1), 'ACCT'),
    'KW-01',
    'Correction reached the open row alone: the closed one still reads as it was written.',
  );
  console.log('  ✓ a replaced record carries no correction control and keeps its values; the open one is corrected');
  assert.equal(
    await page.getByRole('button', { name: /delete/i }).count(),
    0,
    'Neither the employee nor the record offers a delete: the model retires and delimits instead.',
  );

  // ── 9. Search finds the person and an unknown term finds nobody ───────────
  // The list row is one link reading `E1000001 · Huda Rahim`, and an empty result is a sentence rather than a
  // blank table, so both halves of the search are read the way the screen says them.
  await page.goto(`${base}${ROUTE}?q=Huda`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const employeeList = panel(page, 'Employees');
  assert.equal(
    await employeeList.getByRole('link', { name: new RegExp(`${EMPLOYEE} ·`) }).count(),
    1,
    'Searching a name part answers with the person and a way in.',
  );
  assert.match(
    await employeeList.innerText(),
    new RegExp(`${EMPLOYEE} · ${PERSON}`),
    'The row shows the number and the name the search was written for.',
  );
  await page.goto(`${base}${ROUTE}?q=nobody-here`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  assert.equal(await panel(page, 'Employees').getByRole('link').count(), 0, 'A search for nothing lists nobody.');
  assert.match(
    await panel(page, 'Employees').innerText(),
    /No employee of this tenant matches/,
    'The screen says so in words rather than leaving an empty grid.',
  );
  const count = await withTenant(
    client,
    async (tx) => (await tx.execute(sql`select count(*)::int as n from employee`)) as unknown as Array<{ n: number }>,
  );
  assert.equal(count[0]?.n, 1, 'The tenant holds exactly the employee this journey created: nothing leaked beside it.');
  console.log('  ✓ search answers on the person, and the tenant holds only what this run created');

  // ── 10. The reference codes resolve to this screen through the registry ───
  // §10.8 gives the employee master PA30 and PA40. 9196 registered those aliases against
  // PEOPLE.EMPLOYEE.CREATE with route_path = /people/employees, so typing either code into the registry
  // must answer with the term and lead here. This is the product's own lookup surface, not an invented one:
  // the registry screen reads term_registry + term_alias and offers the hit's route_path as a link.
  for (const code of ['PA30', 'PA40']) {
    await page.goto(`${base}${REGISTRY}?q=${code}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    const main = await page.locator('main').innerText();
    assert.match(main, new RegExp(code), `Typing ${code} in the registry returns the term that carries it.`);
    assert.match(
      main,
      /Employee master/,
      `And the hit for ${code} names the employee master by its registry title.`,
    );
    // The route a hit carries is the "Open" link's href, not a string printed on the page — the registry
    // screen keeps the path in the link alone, so this reads the link.
    assert.ok(
      (await page.locator(`main a[href="${ROUTE}"]`).count()) >= 1,
      `The hit for ${code} offers the way in: a link to ${ROUTE}.`,
    );
  }
  console.log('  ✓ PA30 and PA40 resolve to the employee master through the registry');
}

/** The change documents of one object, read on the tenant's own connection. */
async function documents(client: string, objectClass: string, objectKey: string) {
  return withTenant(client, (tx) => changeHistory(tx, client, objectClass, objectKey));
}

/** The answer one field got on one record, read the way the screen reads it. */
function answer(
  record: { values: Array<{ fieldCode: string; value: string }> } | undefined,
  field: string,
): string | undefined {
  return record?.values.find((row) => row.fieldCode === field)?.value;
}

/** The block a screen marks for an operator, whether the label sits on its section or its form. */
function panel(page: Page, label: string): Locator {
  return page.locator(`[aria-label="${label}"]`).first();
}

async function status(page: Page, pattern: RegExp): Promise<string> {
  const notice = page.getByRole('status').filter({ hasText: pattern }).first();
  await notice.waitFor();
  return (await notice.innerText()).replace(/\s+/g, ' ');
}

/**
 * Fill whatever the screen offers under that name. Controls the page prefills and keeps
 * hidden are left as the screen set them; a select is chosen rather than typed.
 */
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
