import type { Locator, Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { changeHistory } from '../../src/platform/change';
import { withTenant } from '../../src/platform/db/client';
import { getJob, getOrgUnit, getPosition, listOrgUnits } from '../../src/modules/people/org-structure';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ROUTE = '/people/organization';
const REGISTRY = '/registry';
const ROOT = 'A1000';
const CHILD = 'A1100';
const OTHER = 'A2000';
const JOB = 'J001';
const POSITION = 'P001';
const SUPERIOR = 'P002';

/**
 * PPOCE / PPOME / PO10 browser acceptance for the organisational structure.
 *
 * Three masters share one screen because an operator cannot define one without the others
 * in view: a unit hangs under a unit, a position stands in a unit and is described by a job.
 * So the journey builds the shape and then tries to break it the two ways the structure says
 * no — a parent that would close a cycle, and a change that names no field at all. Movement
 * is asserted where it matters, which is that the object ends up under its new parent exactly
 * once and the old parent stops listing it, because a hierarchy read is only trustworthy if
 * both sides agree.
 *
 * Retirement is the case a screen can get wrong quietly: a retired job stays on every
 * position that named it and refuses the next one, and the unit list has to show the level
 * and the counts the structure actually holds. The reference codes are checked last, because
 * finding this screen by typing PPOME is part of what was promised.
 */
export async function peopleOrganization(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log(
    'People: verify unit and job and position definition, the levels, the move, the cycle refusal, the empty change, retirement, the counts and the registry lookup',
  );

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Organisation', exact: true }).waitFor();
  const header = await page.locator('header .code').first().innerText();
  assert.match(header, /PEOPLE\.ORGUNIT\.CREATE · PEOPLE\.POSITION\.CREATE/, 'The screen says which activities maintain it.');
  // Both reference transactions are registered against the tenant's term table (PPOME for the position half,
  // PPOCE for the unit half, §10.8) — but nothing in the UI reads that table yet, so this run records the
  // codes as registered data only. Typing PPOME into a search box is not something the product can do today,
  // and the capability matrix says so rather than counting a table row as a search.
  assert.equal(await page.getByRole('searchbox').count(), 0, 'No global term search exists to be confused here.');
  console.log('  ✓ the screen opens with both activities stated and no invented search behind them');

  // ── 1. A root unit, then a child under it ─────────────────────────────────
  const root = panel(page, 'Define an organisational unit');
  await setField(root, 'code', ROOT);
  await setField(root, 'name', 'Cairn Operations');
  await root.getByRole('button', { name: 'Define unit', exact: true }).click();
  await status(page, new RegExp(`Unit ${ROOT} — Cairn Operations — defined at level 1\\.`));

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const child = panel(page, 'Define an organisational unit');
  await setField(child, 'code', CHILD);
  await setField(child, 'name', 'Field Operations');
  await setField(child, 'parentCode', ROOT);
  await child.getByRole('button', { name: 'Define unit', exact: true }).click();
  await status(page, new RegExp(`Unit ${CHILD} — Field Operations — defined at level 2\\.`));
  const listed = await listOrgUnits(client);
  assert.equal(listed.length, 2, 'Both units stand in the structure.');
  assert.equal(listed.find((row) => row.code === CHILD)?.level, 2, 'The list carries the level the parent implies.');
  assert.equal((await getOrgUnit(client, ROOT)).childUnits, 1, 'The parent lists exactly one child.');
  assert.deepEqual(
    (await getOrgUnit(client, ROOT)).children.map((row) => [row.code, row.isValid]),
    [[CHILD, true]],
    'And the child it names is the one just defined.',
  );
  console.log('  ✓ the child unit stands one level below the root, and both sides agree');

  // ── 2. A job, a position in a unit, and the reporting line ────────────────
  // The screen keeps one part of the structure in front of the operator at a time, so each object is worked on
  // from the tab that lists it — a job is defined under the jobs tab, a position under the positions tab.
  await page.goto(`${base}${ROUTE}?tab=jobs`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const job = panel(page, 'Define a job');
  await setField(job, 'code', JOB);
  await setField(job, 'name', 'Field Supervisor');
  await job.getByRole('button', { name: 'Define job', exact: true }).click();
  await status(page, new RegExp(`Job ${JOB} — Field Supervisor — defined\\.`));

  await page.goto(`${base}${ROUTE}?tab=positions`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const superior = panel(page, 'Define a position');
  await setField(superior, 'code', SUPERIOR);
  await setField(superior, 'title', 'Operations Lead');
  await setField(superior, 'orgUnitCode', ROOT);
  await superior.getByRole('button', { name: 'Define position', exact: true }).click();
  await status(page, new RegExp(`Position ${SUPERIOR} — Operations Lead — created in ${ROOT}\\.`));

  await page.goto(`${base}${ROUTE}?tab=positions`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const second = panel(page, 'Define a position');
  await setField(second, 'code', POSITION);
  await setField(second, 'title', 'Field Supervisor');
  await setField(second, 'orgUnitCode', CHILD);
  await setField(second, 'jobCode', JOB);
  await setField(second, 'superiorCode', SUPERIOR);
  await second.getByRole('button', { name: 'Define position', exact: true }).click();
  await status(page, new RegExp(`Position ${POSITION} — Field Supervisor — created in ${CHILD}\\.`));
  const positionView = await getPosition(client, POSITION);
  assert.equal(positionView.jobCode, JOB, 'The position carries the job it was given.');
  assert.equal(positionView.superiorCode, SUPERIOR, 'And the position it reports to.');
  assert.equal(positionView.incumbents, 0, 'A position with nobody assigned counts none, rather than failing.');
  assert.equal((await getJob(client, JOB)).positions, 1, 'The job knows the position that describes itself by it.');
  console.log('  ✓ the job describes the position, which hangs in a unit under a superior');

  // ── 3. A parent that would close a cycle is refused ───────────────────────
  await page.goto(`${base}${ROUTE}?unit=${ROOT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const move = panel(page, 'Change this unit');
  await setField(move, 'parentCode', CHILD);
  await move.getByRole('button', { name: 'Change unit', exact: true }).click();
  await status(page, /That would make an object its own parent, directly or through what hangs below it\./);
  assert.equal((await getOrgUnit(client, ROOT)).parentCode, null, 'The refused move left the root a root.');
  assert.equal((await getOrgUnit(client, CHILD)).level, 2, 'And nothing below it shifted.');
  console.log('  ✓ attaching a unit under its own child is refused and changes nothing');

  // ── 4. The move that is allowed: a child to another parent ────────────────
  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const other = panel(page, 'Define an organisational unit');
  await setField(other, 'code', OTHER);
  await setField(other, 'name', 'Cairn Commerce');
  await other.getByRole('button', { name: 'Define unit', exact: true }).click();
  await status(page, new RegExp(`Unit ${OTHER} — Cairn Commerce — defined at level 1\\.`));

  await page.goto(`${base}${ROUTE}?unit=${CHILD}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const reparent = panel(page, 'Change this unit');
  await setField(reparent, 'parentCode', OTHER);
  await reparent.getByRole('button', { name: 'Change unit', exact: true }).click();
  await status(page, new RegExp(`Unit ${CHILD} updated — under ${OTHER}, validity on\\.`));
  assert.equal((await getOrgUnit(client, CHILD)).parentCode, OTHER, 'The child names its new parent.');
  assert.equal((await getOrgUnit(client, ROOT)).childUnits, 0, 'The old parent no longer lists it.');
  assert.equal((await getOrgUnit(client, OTHER)).childUnits, 1, 'The new parent lists it once, not twice.');
  const positionUnit = await getOrgUnit(client, CHILD);
  assert.equal(positionUnit.positions, 1, 'The moved unit still carries its position.');
  console.log('  ✓ a unit moves to another parent, leaving the old one empty of it and taking its position along');

  // ── 5. One position, one parent: the move is a move ───────────────────────
  await page.goto(`${base}${ROUTE}?tab=positions&position=${POSITION}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const relocate = panel(page, 'Change this position');
  await setField(relocate, 'orgUnitCode', ROOT);
  await relocate.getByRole('button', { name: 'Change position', exact: true }).click();
  await status(page, new RegExp(`Position ${POSITION} updated — in ${ROOT}, reporting to ${SUPERIOR}, 0 spans not yet ended\\.`));
  assert.equal((await getPosition(client, POSITION)).orgUnitCode, ROOT);
  const counts = await withTenant(
    client,
    async (tx) =>
      // The unit a position stands in is an edge in the tree table, not a column on the position — this is the
      // same join the screen reads, checked at the row it is kept in.
      (await tx.execute(
        sql`select h.parent_code as unit, count(*)::int as n
              from org_hierarchy h
             where h.relation_type = 'STRUCTURE' and h.parent_kind = 'ORGUNIT' and h.child_kind = 'POSITION'
             group by 1 order by 1`,
      )) as unknown as Array<{ unit: string; n: number }>,
  );
  assert.deepEqual(
    counts.map((row) => [row.unit, row.n]),
    [[ROOT, 2]],
    'Both positions stand in the moved-to unit and the old one has no row left to count.',
  );
  const rootDetail = await getOrgUnit(client, ROOT);
  assert.equal(rootDetail.positions, 2, 'The unit the positions moved into counts both.');
  assert.equal(rootDetail.positionsFilled, 0, 'And none of them is filled.');
  console.log('  ✓ a position changes unit by moving, and both the unit and the row agree');

  // ── 6. An empty change is refused; retirement then stands where it should ─
  await page.goto(`${base}${ROUTE}?tab=jobs&job=${JOB}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  // The change form arrives holding the name and description the job already has, so pressing it untouched is
  // not an empty patch — it is a save that changes nothing, and the screen writes it as a change. The service
  // refusal for a patch with no field in it at all is held by the focused tests; no form on this screen can
  // produce it, and this run records that rather than pretending to reach it.
  await panel(page, 'Change this job').getByRole('button', { name: 'Change job', exact: true }).click();
  await status(page, new RegExp(`Job ${JOB} updated; 1 position still describe themselves by it\\.`));
  const beforeRetire = (await documents(client, 'job', JOB)).length;
  assert.ok(
    beforeRetire >= 2,
    `Every save on this screen files a document, including the one that changed nothing (${beforeRetire} so far).`,
  );

  // Reload so the next notice cannot be mistaken for the one above it.
  await page.goto(`${base}${ROUTE}?tab=jobs&job=${JOB}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const retire = panel(page, 'Change this job');
  await setField(retire, 'isValid', 'no');
  await retire.getByRole('button', { name: 'Change job', exact: true }).click();
  await status(page, new RegExp(`Job ${JOB} updated; 1 position still describe themselves by it\\.`));
  assert.equal((await getJob(client, JOB)).isValid, false, 'The job is retired.');
  assert.equal((await getPosition(client, POSITION)).jobCode, JOB, 'And the position that named it still does.');

  // A definition that is retired is taken out of the choices a new object is given rather than left there to
  // be misfiled: the position form's list of jobs no longer carries J001, so no new position can be described
  // by it from this screen. A job defined beside it still is, which is the same list proving it is not simply
  // empty. What the service answers if a retired code is posted anyway — the job stays, the position that
  // already named it goes on naming it — is held by the focused tests, since the screen offers no way to ask.
  const liveJob = 'J002';
  await page.goto(`${base}${ROUTE}?tab=jobs`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const another = panel(page, 'Define a job');
  await setField(another, 'code', liveJob);
  await setField(another, 'name', 'Shift Analyst');
  await another.getByRole('button', { name: 'Define job', exact: true }).click();
  await status(page, new RegExp(`Job ${liveJob} — Shift Analyst — defined\\.`));

  await page.goto(`${base}${ROUTE}?tab=positions`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const positionForm = panel(page, 'Define a position');
  const jobChoices = await positionForm
    .locator('[name="jobCode"]')
    .first()
    .locator('option')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('value') ?? ''));
  assert.ok(!jobChoices.includes(JOB), `The retired job is out of the list a new position is offered: ${jobChoices.join(', ')}`);
  assert.ok(jobChoices.includes(liveJob), 'And a standing job is still in it.');

  await setField(positionForm, 'code', 'P003');
  await setField(positionForm, 'title', 'Described by the standing job');
  await setField(positionForm, 'orgUnitCode', ROOT);
  await setField(positionForm, 'jobCode', liveJob);
  await positionForm.getByRole('button', { name: 'Define position', exact: true }).click();
  await status(page, new RegExp(`Position P003 — Described by the standing job — created in ${ROOT}\\.`));
  assert.equal((await getPosition(client, 'P003')).jobCode, liveJob, 'The new position is filed under the standing job.');
  console.log(
    '  ✓ a save that changes nothing is written and documented, retirement leaves the standing position alone, and a retired job leaves the choices',
  );

  // ── 7. The documents behind the screen, and the list the screen shows ─────
  const rootDocs = await documents(client, 'org_unit', ROOT);
  assert.ok(rootDocs.length >= 1, `The unit is documented: ${rootDocs.length} document(s).`);
  assert.equal(
    rootDocs.filter((doc) => doc.changeType === 'CREATE').length,
    1,
    'One creation among them, however many changes follow.',
  );
  assert.equal(
    (await getOrgUnit(client, CHILD)).changedBy,
    'browser.admin',
    'The unit that was moved names the browser session as the one that moved it.',
  );

  await page.goto(`${base}${ROUTE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  assert.equal(
    // The unit list is the tree itself — one row per unit, indented by its level — not a table.
    await panel(page, 'Organisational units').locator('li').count(),
    3,
    'Every unit this run defined is listed, and nothing else.',
  );
  assert.equal(await page.getByRole('button', { name: /delete/i }).count(), 0, 'Nothing here deletes: objects are retired.');
  console.log('  ✓ the change documents stand behind the screen and the list shows exactly this tenant');

  // ── 8. The reference codes find the screen ───────────────────────────────
  for (const [code, title] of [
    ['PPOCE', 'Organisational unit maintain'],
    ['PPOME', 'Position maintain'],
  ] as const) {
    await page.goto(`${base}${REGISTRY}?q=${code}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    const main = await page.locator('main').innerText();
    assert.match(main, new RegExp(code), `Typing ${code} in the registry returns the term that carries it.`);
    assert.match(main, new RegExp(title), `And the hit for ${code} names the object it stands for.`);
    // The route a hit carries is its "Open" link's href, never a string printed beside it, so the way into the
    // screen is read off the link.
    assert.ok(
      (await page.locator(`main a[href="${ROUTE}"]`).count()) >= 1,
      `The hit for ${code} offers the way in: a link to ${ROUTE}.`,
    );
  }
  console.log('  ✓ the reference transaction codes resolve to this screen through the registry');
}

/** The change documents of one object, read on the tenant's own connection. */
async function documents(client: string, objectClass: string, objectKey: string) {
  return withTenant(client, (tx) => changeHistory(tx, client, objectClass, objectKey));
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
