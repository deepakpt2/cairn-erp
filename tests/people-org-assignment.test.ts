import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { changeHistory } from '../src/platform/change';
import { withTenant } from '../src/platform/db/client';
import { createEmployee } from '../src/modules/people/employee-master';
import {
  ASSIGNMENT_CAPABILITY,
  AssignmentError,
  assignPosition,
  assignmentsOf,
  changeAssignment,
  delimitAssignment,
  getAssignment,
  incumbentsOf,
  listAssignments,
  openAssignmentOf,
} from '../src/modules/people/assignment';
import {
  MAX_ORG_DEPTH,
  ORG_UNIT_CAPABILITY,
  POSITION_CAPABILITY,
  OrgStructureError,
  changeJob,
  changeOrgUnit,
  changePosition,
  defineJob,
  defineOrgUnit,
  definePosition,
  getJob,
  getOrgUnit,
  getPosition,
  listJobs,
  listOrgUnits,
  listPositions,
  measureChain,
} from '../src/modules/people/org-structure';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

/**
 * The People slice 2 — the organisation a person is assigned into, and the dated assignment that does it.
 *
 * Nothing is mocked: the tree is written by the service `/people/organization` calls and the assignment by the
 * one `/people/assignments` calls, and every claim is checked against what the tenant reads back afterwards.
 * Five things carry the weight of the slice:
 *
 *   1. one parent per object and no ring — the edge table's key is the whole of the first rule, so both are
 *      asserted where each is enforced: the walk in `measureChain` for depth and rings, a raw insert for the
 *      key and the relation checks a bypassing writer would otherwise slip past;
 *   2. a definition is retired, not deleted — validity stops what comes next and leaves what stands, and the
 *      runtime role has no DELETE on the three masters or on the assignment table at all, which is a privilege
 *      question and so is tested against the database with a live attempt rather than by reading a comment;
 *   3. an assignment is a dated record in `9193`'s sense — a change appends, `valid_to` is inclusive and is
 *      written once, and the only in-place write is the correction of values while the row is still open;
 *   4. the cost centre is checked against the dated master rather than keyed, because its own key carries a
 *      from-date, so "valid on the day the assignment starts" is asserted on both sides of that line;
 *   5. nothing is copied — a position's title, its unit and a cost centre's name are read through the joins, so
 *      renaming or retiring a master cannot leave a stale answer sitting on the assignment.
 *
 * Open spans are dated 2031 so that no assertion depends on what today is; a span that must have *stopped*
 * counting closes in 2020, which is in the past for as long as this suite matters.
 */
const ACTOR = 'PEOPLE_9194_TEST';
const AREA = 'A000';
const CC = 'CC100';
const CC_LATER = 'CC300';

let tenant: TestTenant;
let other: TestTenant;
let counter = 0;
const key = (what: string) => `ppl9194-${what}-${++counter}`;
const numberFor = () => `T${String(9100000 + ++counter)}`;
const codeFor = (what: string) => `${what}${String(++counter).padStart(3, '0')}`;

function unitInput(code: string, parentCode?: string) {
  return { client: tenant.client, code, name: `Unit ${code}`, parentCode, changedBy: ACTOR };
}

function unit(code: string, parentCode?: string) {
  return defineOrgUnit(unitInput(code, parentCode));
}

function positionIn(code: string, orgUnitCode: string, superiorCode?: string) {
  return definePosition({
    client: tenant.client,
    code,
    title: `Position ${code}`,
    orgUnitCode,
    superiorCode,
    changedBy: ACTOR,
  });
}

function person(label: string) {
  const personnelNumber = numberFor();
  return createEmployee({
    client: tenant.client,
    personnelNumber,
    fullName: `Org Test Person ${label}`,
    changedBy: ACTOR,
    requestKey: key(`emp-${label}`),
  }).then(() => personnelNumber);
}

function assign(personnelNumber: string, positionCode: string, validFrom: string, costCenter = CC) {
  return assignPosition({
    client: tenant.client,
    personnelNumber,
    positionCode,
    controllingArea: AREA,
    costCenter,
    validFrom,
    changedBy: ACTOR,
  });
}

function end(personnelNumber: string, validFrom: string, validTo: string) {
  return delimitAssignment({ client: tenant.client, personnelNumber, validFrom, validTo, changedBy: ACTOR });
}

async function counts(statement: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  return withTenant(tenant.client, async (tx) => {
    const rows = await tx.execute(statement);
    return rows as unknown as Array<Record<string, unknown>>;
  });
}

/** Runs a statement the application must not be able to run, and hands back the database's own words. */
async function refusalFromDatabase(statement: ReturnType<typeof sql>): Promise<string> {
  try {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(statement);
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the database accepted a statement it exists to refuse');
}

describe('people organisational structure and assignment (9194)', () => {
  beforeAll(async () => {
    tenant = await createTenant('people-9194', { currency: 'INR' });
    other = await createTenant('people-9194-b', { currency: 'INR' });
    // The cost centre the assignments name, and one that opens in 2032: the dated master is what the service
    // asks, so the suite needs a day it covers and a day it does not.
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
        values (${tenant.client}, ${AREA}, ${CC}, '2020-01-01', '9999-12-31', 'Org test cost centre', 'PRODUCTION', '1000', ${ACTOR}),
               (${tenant.client}, ${AREA}, ${CC_LATER}, '2032-01-01', '9999-12-31', 'Future cost centre', 'PRODUCTION', '1000', ${ACTOR})
        on conflict do nothing`);
    });
  }, 180_000);

  afterAll(async () => {
    // The helper takes the client code, not the record: handing it the tenant object fails inside the cleanup
    // and leaves the fixture key claimed for the next run.
    await destroyTenant(tenant.client);
    await destroyTenant(other.client);
  }, 180_000);

  it('counts a chain and finds a ring in the walk the two rules are built on', () => {
    const parents = new Map<string, string>([['ORGUNIT/B', 'ORGUNIT/A'], ['ORGUNIT/C', 'ORGUNIT/B']]);
    expect(measureChain(parents, 'ORGUNIT/A')).toEqual({ level: 1, cycle: false });
    expect(measureChain(parents, 'ORGUNIT/C')).toEqual({ level: 3, cycle: false });
    // A ring that never reaches a root has to be named as a ring, not reported as an unusually deep branch.
    expect(measureChain(new Map([['A', 'B'], ['B', 'A']]), 'A').cycle).toBe(true);
    // The cap is the one drizzle/0052 sets for a cost centre tree, and going past it is depth, not a cycle.
    const deep = new Map<string, string>();
    for (let level = 2; level <= MAX_ORG_DEPTH + 2; level += 1) deep.set(`N${level}`, `N${level - 1}`);
    const over = measureChain(deep, `N${MAX_ORG_DEPTH + 2}`);
    expect(over.cycle).toBe(false);
    expect(over.level).toBeGreaterThan(MAX_ORG_DEPTH);
  });

  it('gives an object one parent, and a move is a rewrite rather than a second edge', async () => {
    const root = await unit(codeFor('ROOT'));
    const branch = await unit(codeFor('BRCH'), root.code);
    expect(branch.level).toBe(2);
    expect(branch.parentCode).toBe(root.code);
    expect(branch.parentName).toBe(`Unit ${root.code}`);

    const newRoot = await unit(codeFor('ROOT'));
    const moved = await changeOrgUnit({
      client: tenant.client, code: branch.code, parentCode: newRoot.code, changedBy: ACTOR,
    });
    expect(moved.parentCode).toBe(newRoot.code);
    expect((await getOrgUnit(tenant.client, root.code)).children.map((c) => c.code)).not.toContain(branch.code);

    const edges = await counts(sql`
      select count(*)::int as n from org_hierarchy
       where client = ${tenant.client} and relation_type = 'STRUCTURE'
         and child_kind = 'ORGUNIT' and child_code = ${branch.code}`);
    expect(Number(edges[0]!.n)).toBe(1);

    // A code is a code: the same one twice is refused, not merged into the row that stands.
    await expect(unit(branch.code)).rejects.toThrow(/already stands/);
  });

  it('refuses a parent that would put a unit above itself, or below the tenth level', async () => {
    const top = await unit(codeFor('TOPA'));
    const middle = await unit(codeFor('MIDX'), top.code);
    const leaf = await unit(codeFor('LEAF'), middle.code);

    await expect(changeOrgUnit({
      client: tenant.client, code: top.code, parentCode: leaf.code, changedBy: ACTOR,
    })).rejects.toThrow(/its own parent/);
    await expect(changeOrgUnit({
      client: tenant.client, code: top.code, parentCode: top.code, changedBy: ACTOR,
    })).rejects.toThrow(/cannot point at itself/);

    // Chain down to the last level the structure accepts, and the next one is refused with the cap in its words.
    let cursor = top;
    for (let level = 2; level <= MAX_ORG_DEPTH; level += 1) cursor = await unit(codeFor('DEEP'), cursor.code);
    expect(cursor.level).toBe(MAX_ORG_DEPTH);
    await expect(unit(codeFor('OVER'), cursor.code)).rejects.toThrow(/levels at most/);

    // A unit may be detached — the tree is allowed more than one root — and detaching changes nothing else.
    const detached = await changeOrgUnit({
      client: tenant.client, code: middle.code, parentCode: null, changedBy: ACTOR,
    });
    expect(detached.parentCode).toBeNull();
    expect(detached.isValid).toBe(true);
    const afterDetach = await getOrgUnit(tenant.client, top.code);
    expect(afterDetach.children.map((c) => c.code)).not.toContain(middle.code);
    // The leaf came along with its parent, and is one level nearer the top for it: the level is read from the
    // tree, never stored on the unit.
    const movedBranch = await getOrgUnit(tenant.client, leaf.code);
    expect(movedBranch.parentCode).toBe(middle.code);
    expect(movedBranch.level).toBe(2);
  });

  it('retires a unit for what comes next and leaves what stands', async () => {
    const parent = await unit(codeFor('PART'));
    const child = await unit(codeFor('KIDD'), parent.code);
    const positionCode = codeFor('POSA');
    await positionIn(positionCode, parent.code);

    const retired = await changeOrgUnit({
      client: tenant.client, code: parent.code, isValid: false, changedBy: ACTOR,
    });
    expect(retired.isValid).toBe(false);
    await expect(unit(codeFor('NEWU'), parent.code)).rejects.toThrow(/retired/);
    await expect(positionIn(codeFor('POSB'), parent.code)).rejects.toThrow(/retired/);
    // What stood before the retirement stands still, and the retired unit is listed as retired rather than
    // hidden: a definition that anything cites is never absent.
    expect((await getOrgUnit(tenant.client, parent.code)).children.map((c) => c.code)).toContain(child.code);
    expect((await getPosition(tenant.client, positionCode)).orgUnitCode).toBe(parent.code);
    expect((await listOrgUnits(tenant.client, parent.code)).map((u) => u.code)).toContain(parent.code);
    await expect(unit(parent.code)).rejects.toThrow(/already stands/);
  });

  it('keeps a job usable by the positions that already cite it', async () => {
    const jobCode = codeFor('JOBK');
    const defined = await defineJob({
      client: tenant.client, code: jobCode, name: 'Accountant', description: 'Books and records', changedBy: ACTOR,
    });
    expect(defined.positions).toBe(0);

    const home = await unit(codeFor('FIN1'));
    const positionCode = codeFor('POSC');
    const withJob = await definePosition({
      client: tenant.client, code: positionCode, title: 'Bookkeeper', orgUnitCode: home.code, jobCode, changedBy: ACTOR,
    });
    expect(withJob.jobCode).toBe(jobCode);
    expect(withJob.jobName).toBe('Accountant');
    expect((await getJob(tenant.client, jobCode)).positions).toBe(1);
    expect((await listJobs(tenant.client, jobCode)).map((j) => j.code)).toEqual([jobCode]);

    const retired = await changeJob({ client: tenant.client, code: jobCode, isValid: false, changedBy: ACTOR });
    expect(retired.isValid).toBe(false);
    // A new position may not be described by a retired job; the one already named keeps it. That is the
    // difference `9193` drew for a record type, and it is the whole of what retiring a definition means.
    await expect(definePosition({
      client: tenant.client, code: codeFor('POSD'), title: 'Junior', orgUnitCode: home.code, jobCode, changedBy: ACTOR,
    })).rejects.toThrow(/retired/);
    expect((await getPosition(tenant.client, positionCode)).jobCode).toBe(jobCode);
    await expect(definePosition({
      client: tenant.client, code: codeFor('POSE'), title: 'Nobody', orgUnitCode: home.code, jobCode: 'NOJOB', changedBy: ACTOR,
    })).rejects.toThrow(/No job of that code/);
    // Clearing the job is a change, not a deletion of the position.
    const cleared = await changePosition({ client: tenant.client, code: positionCode, jobCode: null, changedBy: ACTOR });
    expect(cleared.jobCode).toBeNull();
    expect((await getJob(tenant.client, jobCode)).positions).toBe(0);
  });

  it('files a position in a unit and runs the reporting line between positions', async () => {
    const home = await unit(codeFor('DEPT'));
    const head = await positionIn(codeFor('HEAD'), home.code);
    const worker = await positionIn(codeFor('WORK'), home.code, head.code);
    expect(worker.superiorCode).toBe(head.code);
    expect(worker.superiorTitle).toBe(`Position ${head.code}`);
    expect(worker.orgUnitName).toBe(`Unit ${home.code}`);
    expect(worker.incumbents).toBe(0);

    await expect(changePosition({
      client: tenant.client, code: head.code, superiorCode: head.code, changedBy: ACTOR,
    })).rejects.toThrow(/cannot point at itself/);
    await expect(changePosition({
      client: tenant.client, code: head.code, superiorCode: worker.code, changedBy: ACTOR,
    })).rejects.toThrow(/its own parent/);

    // The line is removed by saying so. A position is never detached from its unit, because a position with
    // no unit is not a thing this structure can report on.
    const lineless = await changePosition({
      client: tenant.client, code: worker.code, superiorCode: null, changedBy: ACTOR,
    });
    expect(lineless.superiorCode).toBeNull();
    expect(lineless.orgUnitCode).toBe(home.code);
    await expect(changePosition({
      client: tenant.client, code: worker.code, orgUnitCode: 'NOSUCHUNIT', changedBy: ACTOR,
    })).rejects.toThrow(/No organisational unit of that code/);

    const listed = await listPositions(tenant.client, worker.code);
    expect(listed.map((p) => p.code)).toEqual([worker.code]);
    expect(listed[0]!.assignments).toBe(0);
  });

  it('writes an assignment that names a position, a unit and a cost centre without copying any of them', async () => {
    const home = await unit(codeFor('OPS1'));
    const head = await positionIn(codeFor('CHIE'), home.code);
    const worker = await positionIn(codeFor('DOER'), home.code, head.code);
    const who = await person('assign');

    const view = await assign(who, worker.code, '2031-01-01');
    expect(view).toMatchObject({
      personnelNumber: who,
      employeeName: 'Org Test Person assign',
      positionCode: worker.code,
      positionTitle: `Position ${worker.code}`,
      orgUnitCode: home.code,
      orgUnitName: `Unit ${home.code}`,
      controllingArea: AREA,
      costCenter: CC,
      costCenterName: 'Org test cost centre',
      validFrom: '2031-01-01',
      validTo: null,
      isCurrent: true,
      createdBy: ACTOR,
    });

    // A position does not know who holds it: the count went from 0 to 1 with no write to the position.
    expect((await getPosition(tenant.client, worker.code)).incumbents).toBe(1);
    expect(await incumbentsOf(tenant.client, worker.code)).toEqual([
      { personnelNumber: who, employeeName: 'Org Test Person assign', validFrom: '2031-01-01' },
    ]);
    expect((await listAssignments({ client: tenant.client, positionCode: worker.code })).map((a) => a.personnelNumber)).toEqual([who]);
    expect((await openAssignmentOf(tenant.client, who))?.validFrom).toBe('2031-01-01');

    // Renaming the master renames what the assignment shows, because the assignment never stored the name.
    await changePosition({ client: tenant.client, code: worker.code, title: 'Accounts clerk', changedBy: ACTOR });
    expect((await getAssignment(tenant.client, who, '2031-01-01')).positionTitle).toBe('Accounts clerk');
    // And the unit a position stands in can be moved, with the assignment following it.
    const otherHome = await unit(codeFor('OPS2'));
    await changePosition({ client: tenant.client, code: worker.code, orgUnitCode: otherHome.code, changedBy: ACTOR });
    expect((await getAssignment(tenant.client, who, '2031-01-01')).orgUnitCode).toBe(otherHome.code);
  });

  it('ends an assignment with a last day, and the next one starts the day after', async () => {
    const home = await unit(codeFor('SHFT'));
    const first = await positionIn(codeFor('OLDS'), home.code);
    const second = await positionIn(codeFor('NEWS'), home.code);
    const who = await person('shift');

    await assign(who, first.code, '2031-01-01');
    // Nothing may start over an open span: not on its first day, and not in the middle of it.
    await expect(assign(who, second.code, '2031-01-01')).rejects.toThrow(/already has an assignment covering/);
    await expect(assign(who, second.code, '2031-05-01')).rejects.toThrow(/already has an assignment covering/);

    const ended = await end(who, '2031-01-01', '2031-06-30');
    expect(ended.validTo).toBe('2031-06-30');
    expect(ended.isCurrent).toBe(false);

    // Inclusive at both ends, so the last day is still taken: the 30th belongs to the row that ends on it.
    await expect(assign(who, second.code, '2031-06-30')).rejects.toThrow(/already covers/);
    const next = await assign(who, second.code, '2031-07-01');
    expect(next.validFrom).toBe('2031-07-01');
    expect(next.validTo).toBeNull();

    // Back-dating over a span that is closed and still covers the day is refused as well.
    await expect(assign(who, first.code, '2031-03-01')).rejects.toThrow(/already covers/);

    expect((await assignmentsOf(tenant.client, who)).map((h) => [h.validFrom, h.validTo])).toEqual([
      ['2031-07-01', null],
      ['2031-01-01', '2031-06-30'],
    ]);
    // A span is ended once, and an end date is never before the start.
    await expect(end(who, '2031-01-01', '2031-08-31')).rejects.toThrow(/already has an end date/);
    await expect(end(who, '2031-07-01', '2031-06-30')).rejects.toThrow(/cannot fall before/);
  });

  it('corrects the values of the open assignment and nothing else, ever', async () => {
    const home = await unit(codeFor('FIXX'));
    const wrong = await positionIn(codeFor('WRNG'), home.code);
    const right = await positionIn(codeFor('RGHT'), home.code);
    const later = await positionIn(codeFor('LATR'), home.code);
    const who = await person('correct');

    await assign(who, wrong.code, '2031-01-01');
    const corrected = await changeAssignment({
      client: tenant.client,
      personnelNumber: who,
      validFrom: '2031-01-01',
      positionCode: right.code,
      costCenter: CC,
      changedBy: ACTOR,
    });
    expect(corrected.positionCode).toBe(right.code);
    expect(corrected.costCenter).toBe(CC);
    expect(corrected.validFrom).toBe('2031-01-01');
    expect(corrected.validTo).toBeNull();
    expect(corrected.changedBy).toBe(ACTOR);

    // A position that is already the one named may go on being named after it is retired; naming a retired
    // position *newly* is what retirement stops. The difference is `9193`'s, kept here so the module has one.
    await changePosition({ client: tenant.client, code: right.code, isValid: false, changedBy: ACTOR });
    expect((await changeAssignment({
      client: tenant.client, personnelNumber: who, validFrom: '2031-01-01', positionCode: right.code, changedBy: ACTOR,
    })).positionCode).toBe(right.code);
    await changePosition({ client: tenant.client, code: later.code, isValid: false, changedBy: ACTOR });
    await expect(changeAssignment({
      client: tenant.client, personnelNumber: who, validFrom: '2031-01-01', positionCode: later.code, changedBy: ACTOR,
    })).rejects.toThrow(/retired/);

    // While the row is still open, an empty patch is answered as "nothing was sent".
    await expect(changeAssignment({
      client: tenant.client, personnelNumber: who, validFrom: '2031-01-01', changedBy: ACTOR,
    })).rejects.toThrow(/No field was given/);

    // Once a newer row has taken over, the row is out of reach — but "newer" here means an overlapping open
    // row cannot exist, so what closes the door is the end date.
    await end(who, '2031-01-01', '2031-12-31');
    await expect(changeAssignment({
      client: tenant.client, personnelNumber: who, validFrom: '2031-01-01', costCenter: CC, changedBy: ACTOR,
    })).rejects.toThrow(/has been replaced/);
    // An empty patch on a row that is out of reach is answered as out of reach: which of the two refusals a
    // caller sees is a decision about what the clerk has to know first, and the order here is the service's.
    await expect(changeAssignment({
      client: tenant.client, personnelNumber: who, validFrom: '2031-01-01', changedBy: ACTOR,
    })).rejects.toThrow(/has been replaced/);
    await expect(changeAssignment({
      client: tenant.client, personnelNumber: who, validFrom: '2029-01-01', costCenter: CC, changedBy: ACTOR,
    })).rejects.toThrow(/No assignment of that employee begins/);
  });

  it('refuses an assignment that names something the masters do not have', async () => {
    const home = await unit(codeFor('GATE'));
    const good = await positionIn(codeFor('GOOD'), home.code);
    const dead = await positionIn(codeFor('DEAD'), home.code);
    await changePosition({ client: tenant.client, code: dead.code, isValid: false, changedBy: ACTOR });
    const who = await person('refuse');
    const gone = numberFor();
    await createEmployee({
      client: tenant.client, personnelNumber: gone, fullName: 'Gone', isActive: false, changedBy: ACTOR, requestKey: key('inactive'),
    });

    await expect(assign('T99999999', good.code, '2031-01-01')).rejects.toThrow(/No employee with that personnel number/);
    await expect(assign(gone, good.code, '2031-01-01')).rejects.toThrow(/marked inactive/);
    await expect(assign(who, 'NOSUCHPOS', '2031-01-01')).rejects.toThrow(/No position of that code/);
    await expect(assign(who, dead.code, '2031-01-01')).rejects.toThrow(/retired/);
    await expect(assignPosition({
      client: tenant.client, personnelNumber: who, positionCode: good.code, controllingArea: 'ZZZZ', costCenter: CC, validFrom: '2031-01-01', changedBy: ACTOR,
    })).rejects.toThrow(/No cost centre of that code stands in that controlling area/);
    await expect(assignPosition({
      client: tenant.client, personnelNumber: who, positionCode: good.code, controllingArea: AREA, costCenter: 'NOPE', validFrom: '2031-01-01', changedBy: ACTOR,
    })).rejects.toThrow(/No cost centre of that code stands in that controlling area/);
    // The 2032 cost centre exists and is not valid on the day: two different sentences, because the clerk's
    // next act differs — one is a wrong code, the other is a wrong date.
    await expect(assign(who, good.code, '2031-01-01', CC_LATER)).rejects.toThrow(/does not stand in the area on the day/);
    expect((await assign(who, good.code, '2032-02-01', CC_LATER)).costCenter).toBe(CC_LATER);
  });

  it('replays a request key instead of writing a second assignment', async () => {
    const home = await unit(codeFor('IDEM'));
    const worker = await positionIn(codeFor('TWICE'), home.code);
    const who = await person('replay');
    const requestKey = key('assign-once');
    const fields = {
      client: tenant.client,
      personnelNumber: who,
      positionCode: worker.code,
      controllingArea: AREA,
      costCenter: CC,
      validFrom: '2031-01-01',
      changedBy: ACTOR,
      requestKey,
    };

    await assignPosition(fields);
    await assignPosition(fields);
    expect(await assignmentsOf(tenant.client, who)).toHaveLength(1);
    expect(Number((await counts(sql`
      select count(*)::int as n from position_assignment where client = ${tenant.client} and personnel_number = ${who}`))[0]!.n)).toBe(1);
    // The key is scoped to the employee, so re-using it for a *different* date writes nothing: the replay is
    // answered by the row that stands, and the date that row does not have is reported as not found rather than
    // quietly written a second time. Idempotency here is a guard against doubling a write, not a way to amend
    // one — an amendment is the correction action, with its own rules about what may be changed.
    await end(who, '2031-01-01', '2031-06-30');
    await expect(assignPosition({ ...fields, validFrom: '2031-07-01' }))
      .rejects.toThrow(/No assignment of that employee begins/);
    expect(await assignmentsOf(tenant.client, who)).toHaveLength(1);
  });

  it('keeps one tenant\'s structure inside that tenant', async () => {
    const code = codeFor('SHR1');
    await unit(code);
    const home = await unit(codeFor('THR1'));
    const worker = await positionIn(codeFor('THRS'), home.code);
    const who = await person('isolate');
    await assign(who, worker.code, '2031-01-01');

    expect(await listOrgUnits(other.client, code)).toEqual([]);
    expect(await listPositions(other.client, worker.code)).toEqual([]);
    expect(await listAssignments({ client: other.client, query: who })).toEqual([]);

    // The other tenant may define the same code as its own object — the key is per tenant — and cannot borrow
    // this tenant's employee, position or cost centre.
    const theirs = await defineOrgUnit({ client: other.client, code: home.code, name: 'Their unit', changedBy: ACTOR });
    expect(theirs.name).toBe('Their unit');
    await expect(assignPosition({
      client: other.client, personnelNumber: who, positionCode: worker.code, controllingArea: AREA, costCenter: CC, validFrom: '2031-01-01', changedBy: ACTOR,
    })).rejects.toThrow(/No employee with that personnel number/);
    expect((await getAssignment(tenant.client, who, '2031-01-01')).orgUnitCode).toBe(home.code);
    // And a read of another tenant's object by its code finds nothing rather than our row.
    await expect(getOrgUnit(other.client, code)).rejects.toThrow(/No organisational unit of that code/);
  });

  it('leaves the runtime role no way to destroy a definition, an assignment or a person\'s history', async () => {
    const home = await unit(codeFor('LOCK'));
    const worker = await positionIn(codeFor('KEPT'), home.code);
    const who = await person('locked');
    await assign(who, worker.code, '2031-01-01');

    for (const statement of [
      sql`delete from position_assignment where client = ${tenant.client} and personnel_number = ${who}`,
      sql`delete from position where client = ${tenant.client} and code = ${worker.code}`,
      sql`delete from org_unit where client = ${tenant.client} and code = ${home.code}`,
      sql`truncate table position_assignment`,
      sql`truncate table org_unit`,
    ]) {
      await expect(withTenant(tenant.client, async (tx) => tx.execute(statement))).rejects.toThrow(/permission denied/);
    }
    expect((await getAssignment(tenant.client, who, '2031-01-01')).validFrom).toBe('2031-01-01');

    // The one delete the slice grants is the structure's, because moving an object rewrites its edge.
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        delete from org_hierarchy where client = ${tenant.client} and relation_type = 'STRUCTURE'
          and child_kind = 'POSITION' and child_code = ${worker.code}`);
    });
    expect((await getPosition(tenant.client, worker.code)).orgUnitCode).toBeNull();
    const refiled = await changePosition({
      client: tenant.client, code: worker.code, orgUnitCode: home.code, changedBy: ACTOR,
    });
    expect(refiled.orgUnitCode).toBe(home.code);
  });

  it('states the same rules in the database, where a writer could bypass the service', async () => {
    const home = await unit(codeFor('DBLK'));
    const worker = await positionIn(codeFor('DBPOS'), home.code);
    const otherPosition = await positionIn(codeFor('DBP2'), home.code);
    const who = await person('db');
    await assign(who, worker.code, '2031-01-01');

    // The primary key: a second assignment for the same employee beginning the same day.
    expect(await refusalFromDatabase(sql`
      insert into position_assignment (client, personnel_number, position_code, controlling_area, cost_center, valid_from, created_by)
      values (${tenant.client}, ${who}, ${otherPosition.code}, ${AREA}, ${CC}, '2031-01-01', ${ACTOR})`))
      .toMatch(/duplicate key value/);

    // The span check: a last day before the first day is not a span.
    expect(await refusalFromDatabase(sql`
      insert into position_assignment (client, personnel_number, position_code, controlling_area, cost_center, valid_from, valid_to, created_by)
      values (${tenant.client}, ${who}, ${otherPosition.code}, ${AREA}, ${CC}, '2032-01-01', '2031-12-31', ${ACTOR})`))
      .toMatch(/position_assignment_span_ck/);

    // The relation checks: a reporting line is between two positions, and the child is the key — one parent.
    expect(await refusalFromDatabase(sql`
      insert into org_hierarchy (client, relation_type, parent_kind, parent_code, child_kind, child_code, created_by)
      values (${tenant.client}, 'REPORTS_TO', 'ORGUNIT', ${home.code}, 'ORGUNIT', ${codeFor('NOPE')}, ${ACTOR})`))
      .toMatch(/org_hierarchy_pairs_ck/);
    expect(await refusalFromDatabase(sql`
      insert into org_hierarchy (client, relation_type, parent_kind, parent_code, child_kind, child_code, created_by)
      values (${tenant.client}, 'STRUCTURE', 'ORGUNIT', ${home.code}, 'POSITION', ${worker.code}, ${ACTOR})`))
      .toMatch(/org_hierarchy_pkey|duplicate key/);

    // A real foreign key on both sides of the assignment: neither a person nor a position can be invented.
    expect(await refusalFromDatabase(sql`
      insert into position_assignment (client, personnel_number, position_code, controlling_area, cost_center, valid_from, created_by)
      values (${tenant.client}, 'T99999998', ${worker.code}, ${AREA}, ${CC}, '2033-01-01', ${ACTOR})`))
      .toMatch(/violates foreign key constraint/);
    expect(await refusalFromDatabase(sql`
      insert into position_assignment (client, personnel_number, position_code, controlling_area, cost_center, valid_from, created_by)
      values (${tenant.client}, ${who}, 'NOSUCHPO', ${AREA}, ${CC}, '2033-01-01', ${ACTOR})`))
      .toMatch(/violates foreign key constraint/);
  });

  it('records who changed what, on the structure and on the assignment', async () => {
    const home = await unit(codeFor('AUDT'));
    const worker = await positionIn(codeFor('SEEN'), home.code);
    const who = await person('audited');
    await assign(who, worker.code, '2031-01-01');
    await changeOrgUnit({ client: tenant.client, code: home.code, name: 'Renamed under audit', changedBy: ACTOR });
    await end(who, '2031-01-01', '2031-06-30');

    const [unitDocs, assignmentDocs] = await withTenant(tenant.client, async (tx) => Promise.all([
      changeHistory(tx, tenant.client, 'org_unit', home.code),
      changeHistory(tx, tenant.client, 'position_assignment', `${who}/2031-01-01`),
    ]));
    expect(unitDocs.map((d) => d.changeType)).toEqual(expect.arrayContaining(['CREATE', 'CHANGE']));
    expect(assignmentDocs.map((d) => d.changeType)).toEqual(expect.arrayContaining(['CREATE', 'CHANGE']));
    expect(assignmentDocs).toHaveLength(2);
    expect(unitDocs.every((d) => d.changedBy === ACTOR)).toBe(true);
    // The write is filed under the transaction §10.8 gives the assignment, so an auditor looking for PA30
    // activity finds the personnel org writes beside the personnel record writes.
    expect(assignmentDocs.every((d) => d.transactionCode === 'PA30')).toBe(true);
    expect((await getOrgUnit(tenant.client, home.code)).name).toBe('Renamed under audit');
  });

  it('shows a filled position empty again once the span has closed', async () => {
    const home = await unit(codeFor('LEAV'));
    const worker = await positionIn(codeFor('HOLD'), home.code);
    const who = await person('leaver');
    await assign(who, worker.code, '2020-01-01');
    expect((await getPosition(tenant.client, worker.code)).incumbents).toBe(1);

    await end(who, '2020-01-01', '2020-12-31');
    // Nobody stands in it today, and the dated rows are all still there to be read: the vacancy is not a
    // column, so it cannot contradict the history it is counted from.
    expect((await getPosition(tenant.client, worker.code)).incumbents).toBe(0);
    expect((await getPosition(tenant.client, worker.code)).assignments).toBe(1);
    expect(await incumbentsOf(tenant.client, worker.code)).toEqual([]);
    expect(await listAssignments({ client: tenant.client, positionCode: worker.code, openOnly: true })).toEqual([]);
    expect(await listAssignments({ client: tenant.client, positionCode: worker.code })).toHaveLength(1);
    expect(await openAssignmentOf(tenant.client, who)).toBeNull();
    // The unit's own tally moves with it, because it is counted from the same rows.
    expect((await getOrgUnit(tenant.client, home.code)).positionsFilled).toBe(0);
    expect((await listOrgUnits(tenant.client, home.code))[0]!.positions).toBe(1);
  });

  it('names the capabilities the screens enforce, and answers a refusal in sentences', async () => {
    expect([ORG_UNIT_CAPABILITY, POSITION_CAPABILITY, ASSIGNMENT_CAPABILITY]).toEqual([
      'PEOPLE.ORGUNIT.CREATE', 'PEOPLE.POSITION.CREATE', 'PEOPLE.ASSIGNMENT.MAINTAIN',
    ]);
    const registered = await counts(sql`
      select code, is_posting_relevant from capability
       where code in (${ORG_UNIT_CAPABILITY}, ${POSITION_CAPABILITY}, ${ASSIGNMENT_CAPABILITY})
       order by code`);
    expect(registered.map((c) => c.code)).toEqual([
      ASSIGNMENT_CAPABILITY, ORG_UNIT_CAPABILITY, POSITION_CAPABILITY,
    ]);
    expect(registered.every((c) => c.is_posting_relevant === false)).toBe(true);

    // The routes the registry promises for those codes exist as screens.
    const routed = await counts(sql`
      select our_code, route_path from term_registry
       where our_code in (${ORG_UNIT_CAPABILITY}, ${POSITION_CAPABILITY}, ${ASSIGNMENT_CAPABILITY})
       order by our_code`);
    expect(routed).toEqual([
      { our_code: ASSIGNMENT_CAPABILITY, route_path: '/people/assignments' },
      { our_code: ORG_UNIT_CAPABILITY, route_path: '/people/organization' },
      { our_code: POSITION_CAPABILITY, route_path: '/people/organization' },
    ]);

    await expect(defineOrgUnit({ client: tenant.client, code: 'x', name: '', changedBy: ACTOR }))
      .rejects.toThrow(OrgStructureError);
    await expect(assignPosition({
      client: tenant.client, personnelNumber: 'nope', positionCode: 'x', controllingArea: 'a', costCenter: 'x', validFrom: 'not a date', changedBy: ACTOR,
    })).rejects.toThrow(AssignmentError);
    const message = await assignPosition({
      client: tenant.client, personnelNumber: 'nope', positionCode: 'x', controllingArea: 'a', costCenter: 'x', validFrom: 'not a date', changedBy: ACTOR,
    }).then(() => '', (error: AssignmentError) => error.message);
    expect(message).toMatch(/one to ten characters/);
    // and a remedy, which is the point of the pair.
    const remedy = await unit(codeFor('BAD!')).then(() => '', (error: OrgStructureError) => error.remedy);
    // The remedy has to say where a code is written, and it has to say it about the screen the operator is
    // standing on: the browser run for the structure screen found the old wording pointing at the assignment
    // screen instead, which is a dead end for somebody who is defining a unit.
    expect(remedy).toMatch(/screen that defines|already stands|capitals/);
  });
});
