/**
 * The assignment: which position an employee held, whose cost centre carried them, from when to when.
 *
 * This is §8.10's `position_assignment` ("Position → cost centre → employee assignment") and §15.1's
 * "Assignment | Position → cost centre → employee, with validity dates", and it borrows its whole date
 * discipline from `employee-master.ts` rather than inventing a second one:
 *
 * **A change is a new dated row.** The key is (employee, first day) and `valid_to` is the last day the
 * assignment applies, inclusive; writing a second assignment over a day one already covers is refused, and
 * `delimitAssignment` writes `valid_to` once. Nothing here deletes: `9194` grants UPDATE on this table for
 * that single act and no DELETE at all, so the append-only shape belongs to the database. Correcting the
 * values of the assignment that is *still open* is the one in-place write allowed, which is `9193`'s stated
 * decision for a dated record carried over, and it is why `changeAssignment` can move a person between cost
 * centres but cannot move a date.
 *
 * **One employee, one assignment, per day.** The overlap test is scoped to the employee, not to the
 * (employee, position) pair, so an employee never has two assignments standing at once and personnel cost has
 * exactly one place to go. The alternative — an assignment per position, with a percentage beside each — is
 * how a shared person is really split, and it is *not* built, because no rule in this design says how the
 * split divides and inventing a percentage would be an accounting rule. A person in two positions at once is
 * therefore written as two assignments with two spans, one ending the day before the other starts.
 *
 * **The cost centre is a dated master, so it is checked rather than keyed.** Its own primary key carries a
 * from-date (drizzle/0050), which no assignment span can name as one interval; the controlling area *is* a
 * real foreign key, and the service refuses a cost centre that does not stand in that area on the day the
 * assignment starts. Ending an assignment later never re-checks it: a record cannot be refused its own
 * history because a master moved afterwards.
 *
 * What waits on an owner decision and is therefore absent: the percentage split above, position exclusivity
 * (nothing here stops two employees standing in one position, which is what a vacancy report reads),
 * employee-to-employee reporting, and any posting — the cost centre recorded here is what a payroll posting
 * will one day charge (D-013, R-11, §15.3), and recording it charges nothing.
 */
import { and, desc, eq, gte, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { ASSIGNMENT_OBJECT_CLASS, position, positionAssignment } from './schema';

// The screen contract lives in `schema.ts`, beside the tables it names; re-exported here because a service is
// where a reader looks for what its screens may do.
export { ASSIGNMENT_CAPABILITY, ASSIGNMENT_ROUTE } from './schema';

const upper = z.string().transform((s) => s.trim().toUpperCase());
const clientField = upper.pipe(z.string().regex(/^[A-Z0-9]{2,4}$/, { message: 'CLIENT_FORMAT' }));
const personnelNumber = upper.pipe(z.string().regex(/^[A-Z0-9]{2,20}$/, { message: 'PERSONNEL_FORMAT' }));
const orgCode = upper.pipe(z.string().regex(/^([A-Z][A-Z0-9]{1,9})$/, { message: 'ORG_CODE_FORMAT' }));
const areaCode = upper.pipe(z.string().regex(/^[A-Z0-9]{4}$/, { message: 'AREA_FORMAT' }));
const costCenterCode = upper.pipe(z.string().regex(/^[A-Z0-9]{1,10}$/, { message: 'COST_CENTER_FORMAT' }));
const actor = z.string().transform((s) => s.trim()).refine((s) => s.length > 0 && s.length <= 60, { message: 'REQUIRED_TEXT' });
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const assignInput = z.object({
  client: clientField,
  personnelNumber,
  positionCode: orgCode,
  controllingArea: areaCode,
  costCenter: costCenterCode,
  validFrom: z.string().trim(),
  changedBy: actor,
  requestKey: z.string().trim().min(8).max(64).optional(),
});

const changeAssignmentInput = z.object({
  client: clientField,
  personnelNumber,
  validFrom: z.string().trim(),
  positionCode: orgCode.optional(),
  controllingArea: areaCode.optional(),
  costCenter: costCenterCode.optional(),
  changedBy: actor,
});

const delimitInput = z.object({
  client: clientField,
  personnelNumber,
  validFrom: z.string().trim(),
  validTo: z.string().trim(),
  changedBy: actor,
});

export interface AssignmentView {
  personnelNumber: string;
  employeeName: string;
  positionCode: string;
  positionTitle: string | null;
  /** The unit the position stands in, read through the structure so the screen shows one row per line. */
  orgUnitCode: string | null;
  orgUnitName: string | null;
  controllingArea: string;
  costCenter: string;
  costCenterName: string | null;
  validFrom: string;
  validTo: string | null;
  /**
   * True while the assignment is open, which for this table is the same thing as being the newest: nothing
   * can start over a day an open assignment covers, so an open row has no successor.
   */
  isCurrent: boolean;
  createdBy: string;
  changedBy: string | null;
}

export class AssignmentError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'AssignmentError';
    this.remedy = remedy;
  }
}

const REFUSALS: Record<string, [string, string]> = {
  CLIENT_FORMAT: [
    `A tenant is the two-to-four-character code the session was opened with.`,
    `Open the screen from the launchpad; the tenant comes from the session, not from the form.`,
  ],
  PERSONNEL_FORMAT: [`A personnel number is 2 to 20 characters of capitals and digits.`, `Use the number on the employee master.`],
  ORG_CODE_FORMAT: [`A position or unit code is one to ten characters, starting with a letter.`, `Pick it from the org screen's list.`],
  AREA_FORMAT: [`A controlling area is four characters.`, `Use the area the cost centre belongs to.`],
  COST_CENTER_FORMAT: [`A cost centre is 1 to 10 characters.`, `Write it as the cost centre master holds it.`],
  REQUIRED_TEXT: [`A name was blank or longer than 60 characters.`, `Write it as the contract writes it.`],
  DATE_FORMAT: [`A date has to read YYYY-MM-DD.`, `Write the day the assignment starts or ended, as the calendar holds it.`],
  EMPLOYEE_UNKNOWN: [
    `No employee with that personnel number stands in this tenant.`,
    `Create the employee first — the master and its number come before anything is assigned (§6.1).`,
  ],
  EMPLOYEE_INACTIVE: [
    `That employee is marked inactive, so no new assignment starts.`,
    `Set the master active again, or write the dated record that explains the gap.`,
  ],
  POSITION_UNKNOWN: [
    `No position of that code stands in this tenant.`,
    `Define the position in the org screen first: a definition has to precede an assignment (D-086).`,
  ],
  POSITION_RETIRED: [
    `That position is retired, so it takes no new assignment.`,
    `Set its validity back to true, or assign the person to a position that is still valid.`,
  ],
  COST_CENTER_UNKNOWN: [
    `No cost centre of that code stands in that controlling area.`,
    `Check the area and the code against the cost centre master; the assignment cannot invent either.`,
  ],
  COST_CENTER_NOT_VALID_YET: [
    `That cost centre does not stand in the area on the day the assignment starts.`,
    `Start the assignment on a day the cost centre is valid, or change its validity in the cost centre master.`,
  ],
  OVERLAP: [
    `The employee already has an assignment covering that day.`,
    `End the assignment that is standing, then start the new one the day after.`,
  ],
  ASSIGNMENT_UNKNOWN: [
    `No assignment of that employee begins on that date.`,
    `Pick the row the screen lists; its start date is part of its key.`,
  ],
  NOT_CURRENT: [
    `That assignment has been replaced, so its values are out of reach.`,
    `Write a new dated assignment instead: history is corrected by the record that follows, never by the one it replaces.`,
  ],
  ALREADY_DELIMITED: [
    `That assignment already has an end date.`,
    `A span is ended once. To change what a closed assignment said, write a new one.`,
  ],
  NOTHING_TO_CHANGE: [
    `No field was given, so nothing would change.`,
    `Send the position, the cost centre or the area you want moved.`,
  ],
  SPAN_ORDER: [
    `An end date cannot fall before the day the assignment started.`,
    `validTo has to be on or after validFrom: the last day an assignment applies is never its first day's predecessor.`,
  ],
};

function refusal(key: string, detail?: string): never {
  const [message, remedy] = REFUSALS[key] ?? [
    `The assignment write was not accepted (${key}).`,
    `Correct the value and submit again.`,
  ];
  throw new AssignmentError(detail ? `${message} ${detail}` : message, remedy);
}

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    refusal(first?.code === 'custom' ? String(first.message) : (first?.message ?? 'INVALID_INPUT'));
  }
  return parsed.data;
}

/** The day, in the only form this table's dates take: what the column holds, checked to be a real calendar day. */
function dayOf(value: string): string {
  const day = value.trim();
  if (!DATE_PATTERN.test(day)) refusal('DATE_FORMAT', day);
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) refusal('DATE_FORMAT', day);
  const round = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  if (round !== day) refusal('DATE_FORMAT', day);
  return day;
}

/** The employee's name, from the master 9193 created. Read here, never copied onto the assignment. */
async function employeeName(tx: Tx, client: string, number: string): Promise<string> {
  const rows = await tx.execute(sql`
    select full_name from public.employee where client = ${client} and personnel_number = ${number}`) as unknown as Array<{
    full_name: string;
  }>;
  const name = rows[0]?.full_name;
  if (name === undefined) refusal('EMPLOYEE_UNKNOWN', number);
  return name;
}

async function employeeActive(tx: Tx, client: string, number: string): Promise<boolean> {
  const rows = await tx.execute(sql`
    select is_active from public.employee where client = ${client} and personnel_number = ${number}`) as unknown as Array<{
    is_active: boolean;
  }>;
  return rows[0]?.is_active !== false;
}

/**
 * The cost centre, as of the day the assignment starts. Its validity is read from the dated master rather
 * than assumed: the row that stands on that day answers both whether the code exists in the area and what it
 * was named, which is what the screen shows and what a later posting will want.
 */
async function costCenterAsOf(
  tx: Tx,
  client: string,
  area: string,
  costCenter: string,
  day: string,
): Promise<{ name: string }> {
  const rows = await tx.execute(sql`
    select name, valid_from::text as valid_from, valid_to::text as valid_to
      from public.cost_center
     where client = ${client} and controlling_area = ${area} and cost_center = ${costCenter}
       and valid_from <= ${day} and valid_to >= ${day}
     order by valid_from desc
     limit 1`) as unknown as Array<{ name: string; valid_from: string; valid_to: string }>;
  const row = rows[0];
  if (!row) {
    const [exists] = await tx.execute(sql`
      select count(*)::int as n from public.cost_center
       where client = ${client} and controlling_area = ${area} and cost_center = ${costCenter}`) as unknown as Array<{ n: number }>;
    refusal(Number(exists?.n ?? 0) > 0 ? 'COST_CENTER_NOT_VALID_YET' : 'COST_CENTER_UNKNOWN', costCenter);
  }
  return { name: row!.name };
}

function shape(row: {
  personnel_number: string;
  employee_name: string;
  position_code: string;
  position_title: string | null;
  org_unit_code: string | null;
  org_unit_name: string | null;
  controlling_area: string;
  cost_center: string;
  cost_center_name: string | null;
  valid_from: string;
  valid_to: string | null;
  created_by: string;
  changed_by: string | null;
}): AssignmentView {
  return {
    personnelNumber: row.personnel_number,
    employeeName: row.employee_name,
    positionCode: row.position_code,
    positionTitle: row.position_title,
    orgUnitCode: row.org_unit_code,
    orgUnitName: row.org_unit_name,
    controllingArea: row.controlling_area,
    costCenter: row.cost_center,
    costCenterName: row.cost_center_name,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    isCurrent: row.valid_to === null,
    createdBy: row.created_by,
    changedBy: row.changed_by,
  };
}

/** The columns every read of this table shapes, joined once so a list is one statement rather than twenty. */
const READ = sql`
  select a.personnel_number, e.full_name as employee_name, a.position_code, p.title as position_title,
         u.code as org_unit_code, u.name as org_unit_name,
         a.controlling_area, a.cost_center,
         (select cc.name from public.cost_center cc
           where cc.client = a.client and cc.controlling_area = a.controlling_area
             and cc.cost_center = a.cost_center and cc.valid_from <= a.valid_from and cc.valid_to >= a.valid_from
           order by cc.valid_from desc limit 1) as cost_center_name,
         a.valid_from::text as valid_from, a.valid_to::text as valid_to,
         a.created_by, a.changed_by
    from public.position_assignment a
    join public.employee e on e.client = a.client and e.personnel_number = a.personnel_number
    join public.position p on p.client = a.client and p.code = a.position_code
    left join public.org_hierarchy h
      on h.client = a.client and h.relation_type = 'STRUCTURE' and h.child_kind = 'POSITION' and h.child_code = a.position_code
    left join public.org_unit u on u.client = a.client and u.code = h.parent_code`;

/**
 * Start an assignment. The advisory lock covers the overlap test and the insert together, because two clerks
 * dating the same person's org record in the same moment would otherwise both find the day free — the primary
 * key is the backstop, not the message (the same reason `employee-master.ts` takes the lock).
 */
export async function assignPosition(input: unknown): Promise<AssignmentView> {
  const parsed = parse(assignInput, input);
  const from = dayOf(parsed.validFrom);

  await withTenant(parsed.client, async (tx) => {
    await employeeName(tx, parsed.client, parsed.personnelNumber);
    if (!(await employeeActive(tx, parsed.client, parsed.personnelNumber))) {
      refusal('EMPLOYEE_INACTIVE', parsed.personnelNumber);
    }
    const [thePosition] = await tx.select().from(position).where(and(
      eq(position.client, parsed.client),
      eq(position.code, parsed.positionCode),
    )).limit(1);
    if (!thePosition) refusal('POSITION_UNKNOWN', parsed.positionCode);
    if (!thePosition!.isValid) refusal('POSITION_RETIRED', parsed.positionCode);
    await costCenterAsOf(tx, parsed.client, parsed.controllingArea, parsed.costCenter, from);

    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${
      `${parsed.client}/position-assignment/${parsed.personnelNumber}`}, 0))`);

    // A replay of the same key reports the assignment that stands instead of writing a second one.
    if (parsed.requestKey) {
      const [replay] = await tx.select({ validFrom: positionAssignment.validFrom }).from(positionAssignment).where(and(
        eq(positionAssignment.client, parsed.client),
        eq(positionAssignment.personnelNumber, parsed.personnelNumber),
        eq(positionAssignment.requestKey, parsed.requestKey),
      )).limit(1);
      if (replay) return undefined;
    }

    // An assignment is in the way when it is still open, or when it ends on or after the day the new one would
    // start. A row that ended before that day is history, and starting a new span the day after is exactly what
    // the dated-record rule is for.
    const blocking = await tx.select({
      validFrom: positionAssignment.validFrom,
      validTo: positionAssignment.validTo,
    }).from(positionAssignment).where(and(
      eq(positionAssignment.client, parsed.client),
      eq(positionAssignment.personnelNumber, parsed.personnelNumber),
      or(isNull(positionAssignment.validTo), gte(positionAssignment.validTo, from)),
    )).orderBy(desc(positionAssignment.validFrom)).limit(1);
    const clash = blocking[0];
    if (clash) {
      refusal('OVERLAP', `the assignment from ${clash.validFrom} to ${clash.validTo ?? 'open'} already covers ${from}.`);
    }

    try {
      await tx.insert(positionAssignment).values({
        client: parsed.client,
        personnelNumber: parsed.personnelNumber,
        positionCode: parsed.positionCode,
        controllingArea: parsed.controllingArea,
        costCenter: parsed.costCenter,
        validFrom: from,
        validTo: null,
        requestKey: parsed.requestKey ?? null,
        createdBy: parsed.changedBy,
      });
    } catch (caught) {
      if (typeof caught === 'object' && caught !== null && 'code' in caught && caught.code === '23505') {
        refusal('OVERLAP', `an assignment from ${from} was written in the same moment.`);
      }
      throw caught;
    }

    await recordChange(tx, {
      client: parsed.client,
      objectClass: ASSIGNMENT_OBJECT_CLASS,
      objectKey: `${parsed.personnelNumber}/${from}`,
      changeType: 'CREATE',
      changedBy: parsed.changedBy,
      transactionCode: 'PA30',
      after: {
        personnelNumber: parsed.personnelNumber,
        positionCode: parsed.positionCode,
        controllingArea: parsed.controllingArea,
        costCenter: parsed.costCenter,
        validFrom: from,
        validTo: null,
      },
    });
    return undefined;
  });

  return getAssignment(parsed.client, parsed.personnelNumber, from);
}

/**
 * Correct an open assignment's values in place: the position it names, the area and the cost centre that
 * carry it. The dates are not correctable — a span that was wrong on its first day is a span that should not
 * have started there, and the record for that is a new dated assignment. A closed one is out of reach.
 */
export async function changeAssignment(input: unknown): Promise<AssignmentView> {
  const parsed = parse(changeAssignmentInput, input);
  const from = dayOf(parsed.validFrom);

  await withTenant(parsed.client, async (tx) => {
    const [standing] = await tx.select().from(positionAssignment).where(and(
      eq(positionAssignment.client, parsed.client),
      eq(positionAssignment.personnelNumber, parsed.personnelNumber),
      eq(positionAssignment.validFrom, from),
    )).limit(1);
    if (!standing) refusal('ASSIGNMENT_UNKNOWN', `${parsed.personnelNumber} from ${from}`);
    if (standing!.validTo !== null) refusal('NOT_CURRENT');

    const patch: { positionCode?: string; controllingArea?: string; costCenter?: string } = {};
    if (parsed.positionCode !== undefined) {
      const [thePosition] = await tx.select().from(position).where(and(
        eq(position.client, parsed.client),
        eq(position.code, parsed.positionCode),
      )).limit(1);
      if (!thePosition) refusal('POSITION_UNKNOWN', parsed.positionCode);
      // A position that is already named by an open assignment may go on being named, retired or not; a
      // *new* naming of it is what retirement stops. That difference is the same one `9193` drew.
      if (!thePosition!.isValid && standing!.positionCode !== parsed.positionCode) {
        refusal('POSITION_RETIRED', parsed.positionCode);
      }
      patch.positionCode = parsed.positionCode;
    }
    const area = parsed.controllingArea ?? standing!.controllingArea;
    const centre = parsed.costCenter ?? standing!.costCenter;
    if (parsed.controllingArea !== undefined || parsed.costCenter !== undefined) {
      await costCenterAsOf(tx, parsed.client, area, centre, from);
      patch.controllingArea = area;
      patch.costCenter = centre;
    }
    if (Object.keys(patch).length === 0) refusal('NOTHING_TO_CHANGE');

    await tx.update(positionAssignment).set({ ...patch, changedBy: parsed.changedBy, changedAt: new Date() }).where(and(
      eq(positionAssignment.client, parsed.client),
      eq(positionAssignment.personnelNumber, parsed.personnelNumber),
      eq(positionAssignment.validFrom, from),
    ));

    await recordChange(tx, {
      client: parsed.client,
      objectClass: ASSIGNMENT_OBJECT_CLASS,
      objectKey: `${parsed.personnelNumber}/${from}`,
      changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      transactionCode: 'PA30',
      before: { positionCode: standing!.positionCode, controllingArea: standing!.controllingArea, costCenter: standing!.costCenter },
      after: patch,
      reason: 'Correction of the open assignment, permitted while it is the newest record',
    });
    return undefined;
  });

  return getAssignment(parsed.client, parsed.personnelNumber, from);
}

/** End an assignment: the one write to `valid_to` a dated record ever takes. */
export async function delimitAssignment(input: unknown): Promise<AssignmentView> {
  const parsed = parse(delimitInput, input);
  const from = dayOf(parsed.validFrom);
  const to = dayOf(parsed.validTo);
  if (to < from) refusal('SPAN_ORDER');

  await withTenant(parsed.client, async (tx) => {
    const [standing] = await tx.select().from(positionAssignment).where(and(
      eq(positionAssignment.client, parsed.client),
      eq(positionAssignment.personnelNumber, parsed.personnelNumber),
      eq(positionAssignment.validFrom, from),
    )).limit(1);
    if (!standing) refusal('ASSIGNMENT_UNKNOWN', `${parsed.personnelNumber} from ${from}`);
    if (standing!.validTo !== null) refusal('ALREADY_DELIMITED');

    await tx.update(positionAssignment).set({
      validTo: to,
      changedBy: parsed.changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(positionAssignment.client, parsed.client),
      eq(positionAssignment.personnelNumber, parsed.personnelNumber),
      eq(positionAssignment.validFrom, from),
    ));

    await recordChange(tx, {
      client: parsed.client,
      objectClass: ASSIGNMENT_OBJECT_CLASS,
      objectKey: `${parsed.personnelNumber}/${from}`,
      changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      transactionCode: 'PA30',
      before: { validTo: null },
      after: { validTo: to },
      reason: 'Assignment delimited so a later one may start the day after',
    });
    return undefined;
  });

  return getAssignment(parsed.client, parsed.personnelNumber, from);
}

/** One assignment, by the two parts of its key. */
export async function getAssignment(clientInput: string, personnelInput: string, validFromInput: string): Promise<AssignmentView> {
  const client = parse(clientField, clientInput);
  const number = parse(personnelNumber, personnelInput);
  const from = dayOf(validFromInput);
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`${READ}
       where a.client = ${client} and a.personnel_number = ${number} and a.valid_from = ${from}`) as unknown as Array<Parameters<typeof shape>[0]>;
    const row = rows[0];
    if (!row) refusal('ASSIGNMENT_UNKNOWN', `${number} from ${from}`);
    return shape(row);
  });
}

/** Everything one employee has been assigned to, newest first: the history the dated rows are kept for. */
export async function assignmentsOf(clientInput: string, personnelInput: string): Promise<AssignmentView[]> {
  const client = parse(clientField, clientInput);
  const number = parse(personnelNumber, personnelInput);
  return withTenant(client, async (tx) => {
    await employeeName(tx, client, number);
    const rows = await tx.execute(sql`${READ}
       where a.client = ${client} and a.personnel_number = ${number}
       order by a.valid_from desc`) as unknown as Array<Parameters<typeof shape>[0]>;
    return rows.map(shape);
  });
}

export interface AssignmentSearch {
  client: string;
  query?: string;
  positionCode?: string;
  costCenter?: string;
  /** Only the assignments standing today: the open ones, since an open row is always the newest. */
  openOnly?: boolean;
}

/**
 * Search, on the four things an assignment is made of. `query` matches a personnel number or a name; the
 * position and cost centre filters are exact, because they are answers to "who is in this position" and
 * "who does this cost centre carry", and a like-match on a code would quietly answer both wrongly.
 */
export async function listAssignments(search: AssignmentSearch): Promise<AssignmentView[]> {
  const parsed = parse(z.object({
    client: clientField,
    query: z.string().trim().optional(),
    positionCode: orgCode.optional(),
    costCenter: costCenterCode.optional(),
    openOnly: z.boolean().optional().default(false),
  }), search);
  const needle = (parsed.query ?? '').trim().toUpperCase();
  return withTenant(parsed.client, async (tx) => {
    const rows = await tx.execute(sql`${READ}
       where a.client = ${parsed.client}
         ${needle === '' ? sql`` : sql`and (a.personnel_number like ${`%${needle}%`} or upper(e.full_name) like ${`%${needle}%`})`}
         ${parsed.positionCode ? sql`and a.position_code = ${parsed.positionCode}` : sql``}
         ${parsed.costCenter ? sql`and a.cost_center = ${parsed.costCenter}` : sql``}
         ${parsed.openOnly ? sql`and a.valid_to is null` : sql``}
       order by a.personnel_number, a.valid_from desc
       limit 200`) as unknown as Array<Parameters<typeof shape>[0]>;
    return rows.map(shape);
  });
}

/**
 * The people a position carries today, for the org screen's incumbent column and for anyone deciding whether
 * it can be retired. An assignment counts while it covers the day: open, or ended no earlier than today.
 */
export async function incumbentsOf(clientInput: string, positionInput: string): Promise<Array<{ personnelNumber: string; employeeName: string; validFrom: string }>> {
  const client = parse(clientField, clientInput);
  const wanted = parse(orgCode, positionInput);
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select a.personnel_number, e.full_name as employee_name, a.valid_from::text as valid_from
        from public.position_assignment a
        join public.employee e on e.client = a.client and e.personnel_number = a.personnel_number
       where a.client = ${client} and a.position_code = ${wanted}
         and (a.valid_to is null or a.valid_to >= current_date)
       order by a.personnel_number`) as unknown as Array<{ personnel_number: string; employee_name: string; valid_from: string }>;
    return rows.map((row) => ({
      personnelNumber: row.personnel_number,
      employeeName: row.employee_name,
      validFrom: row.valid_from,
    }));
  });
}

/**
 * The assignment standing today — the open one, which for this table is always the newest. The screen reads
 * it for two things: the day a new assignment has to start (the day after this one's end, once ended), and
 * the warning that a span cannot be started over one that is open. Null when nothing is open, in which case
 * any day is free.
 */
export async function openAssignmentOf(clientInput: string, personnelInput: string): Promise<AssignmentView | null> {
  const client = parse(clientField, clientInput);
  const number = parse(personnelNumber, personnelInput);
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`${READ}
       where a.client = ${client} and a.personnel_number = ${number} and a.valid_to is null
       order by a.valid_from desc limit 1`) as unknown as Array<Parameters<typeof shape>[0]>;
    const row = rows[0];
    return row ? shape(row) : null;
  });
}
