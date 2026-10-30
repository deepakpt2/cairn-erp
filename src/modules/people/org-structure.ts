/**
 * The organisational block: units, jobs, positions, and the two relations that place them.
 *
 * Four rules carry this file, and each is enforced where the write happens.
 *
 * **The tree has one answer.** A unit's parent and a position's unit are rows of `org_hierarchy`, keyed by
 * (relation, child), so nothing can stand in two places at once — the same shape drizzle/0052 gives cost
 * centre nodes, where "the unique index on the assignment IS the one-parent rule". A move rewrites that one
 * row, which is why `9194` grants DELETE on this table and on no other table of the slice: a structure is
 * not history, and a position filed under the wrong unit has to be movable.
 *
 * **No rings, and at most `MAX_ORG_DEPTH` levels.** Neither is a check over one row, so the service walks
 * the chain inside the transaction that writes the edge — the way `depthOf` does in
 * src/modules/foundation/cost-center-hierarchy.ts. `measureChain` is exported because the walk is the whole
 * of both rules and is worth a test of its own.
 *
 * **A definition is retired, not deleted.** `is_valid = false` stops anything *new* being filed under a unit
 * or a position, and leaves everything already standing — the semantics `9193` chose for a record type,
 * carried over unchanged so the module has one answer. `restrict` on the foreign keys says an object another
 * object cites cannot be removed at all, and DELETE is not granted on the three masters.
 *
 * **A position does not know who holds it.** Whether it is filled is read from `position_assignment` as of
 * today, never stored on the position: a column there would be a second answer to a question the assignment
 * table already answers, and it would be wrong the moment a dated assignment were delimited.
 *
 * What this service will not do, because nothing in CAIRN.md §8.10 or §15.1 asks it to: date the structure
 * (§15.1 requires validity dates for the Assignment, and the tree stays as-today, with the consequence for
 * reporting recorded in `9194`), lead a unit with a position, plan a vacancy, assign a unit to a company code,
 * or draw a line between two *employees* — §15.1 lists the reporting line beside positions and hierarchy, so
 * it joins a position to the position above it.
 */
import { and, asc, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { AuthzError } from '../../platform/auth/current';
import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import {
  JOB_OBJECT_CLASS,
  MAX_ORG_DEPTH,
  ORG_UNIT_CAPABILITY,
  ORG_UNIT_OBJECT_CLASS,
  POSITION_CAPABILITY,
  POSITION_OBJECT_CLASS,
  job,
  orgHierarchy,
  orgUnit,
  position,
} from './schema';
import type { OrgNodeKind, OrgRelation } from './schema';

// The screen contract lives in `schema.ts`, beside the tables it names; re-exported here because a service is
// where a reader looks for what its screens may do.
export {
  MAX_ORG_DEPTH,
  ORG_ROUTE,
  ORG_UNIT_CAPABILITY,
  POSITION_CAPABILITY,
  POSITION_OBJECT_CLASS,
  ORG_UNIT_OBJECT_CLASS,
} from './schema';

const NAME_MAX = 60;
const DESC_MAX = 200;

/** Refuse a write when the caller holds none of the required authority. */
function assertCapability(
  capabilities: readonly string[] | undefined,
  required: string,
  actor: string,
): void {
  if (!capabilities || !hasCapability([...capabilities], required)) {
    throw new AuthzError(required, actor);
  }
}

const upper = z.string().transform((s) => s.trim().toUpperCase());
const orgCode = upper.pipe(z.string().regex(/^([A-Z][A-Z0-9]{1,9})$/, { message: 'ORG_CODE_FORMAT' }));
const clientField = upper.pipe(z.string().regex(/^[A-Z0-9]{2,4}$/, { message: 'CLIENT_FORMAT' }));
const kept = (max: number) => z.string()
  .transform((s) => s.trim())
  .refine((s) => s.length > 0 && s.length <= max, { message: 'REQUIRED_TEXT' });
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const defineUnitInput = z.object({
  client: clientField,
  code: orgCode,
  name: kept(NAME_MAX),
  description: optionalText(DESC_MAX),
  parentCode: orgCode.optional(),
  changedBy: kept(60),
});

const changeUnitInput = z.object({
  client: clientField,
  code: orgCode,
  name: kept(NAME_MAX).optional(),
  description: optionalText(DESC_MAX),
  isValid: z.boolean().optional(),
  /** A code moves the unit; an explicit `null` makes it a root. Omit it and the parent is untouched. */
  parentCode: orgCode.nullable().optional(),
  changedBy: kept(60),
});

const defineJobInput = z.object({
  client: clientField,
  code: orgCode,
  name: kept(NAME_MAX),
  description: optionalText(DESC_MAX),
  changedBy: kept(60),
});

const changeJobInput = z.object({
  client: clientField,
  code: orgCode,
  name: kept(NAME_MAX).optional(),
  description: optionalText(DESC_MAX),
  isValid: z.boolean().optional(),
  changedBy: kept(60),
});

const definePositionInput = z.object({
  client: clientField,
  code: orgCode,
  title: kept(NAME_MAX),
  jobCode: orgCode.optional(),
  /** Required: §15.1's structure is units *and* positions, so a position is created where it stands. */
  orgUnitCode: orgCode,
  superiorCode: orgCode.optional(),
  description: optionalText(DESC_MAX),
  changedBy: kept(60),
});

const changePositionInput = z.object({
  client: clientField,
  code: orgCode,
  title: kept(NAME_MAX).optional(),
  jobCode: orgCode.nullable().optional(),
  /** A code moves the position to another unit. `null` is refused rather than obeyed: see POSITION_UNIT_REQUIRED. */
  orgUnitCode: orgCode.nullable().optional(),
  superiorCode: orgCode.nullable().optional(),
  isValid: z.boolean().optional(),
  description: optionalText(DESC_MAX),
  changedBy: kept(60),
});

export interface OrgUnitView {
  code: string;
  name: string;
  description: string | null;
  isValid: boolean;
  parentCode: string | null;
  parentName: string | null;
  /** 1 for a root. Counted from the tree as it stands, because the tree is not dated (`9194`). */
  level: number;
  childUnits: number;
  positions: number;
  positionsFilled: number;
  createdBy: string;
  changedBy: string | null;
}

export interface OrgUnitDetail extends OrgUnitView {
  children: Array<{ code: string; name: string; isValid: boolean }>;
  positionList: Array<{ code: string; title: string; isValid: boolean; incumbents: number }>;
}

export interface JobView {
  code: string;
  name: string;
  description: string | null;
  isValid: boolean;
  positions: number;
  createdBy: string;
  changedBy: string | null;
}

export interface PositionView {
  code: string;
  title: string;
  jobCode: string | null;
  jobName: string | null;
  description: string | null;
  isValid: boolean;
  orgUnitCode: string | null;
  orgUnitName: string | null;
  superiorCode: string | null;
  superiorTitle: string | null;
  /**
   * How many assignment spans of this position have not ended — `valid_to` empty, or a last day that has not
   * passed. A span planned for next year counts, because it already reserves the place; a span closed yesterday
   * does not. Read from the assignments and never stored here, which is why it is a count rather than a
   * vacancy flag: the position does not know who holds it, the assignment table does.
   */
  incumbents: number;
  /** Every dated assignment this position has ever had, which is what a retired position keeps. */
  assignments: number;
  createdBy: string;
  changedBy: string | null;
}

export class OrgStructureError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'OrgStructureError';
    this.remedy = remedy;
  }
}

const REFUSALS: Record<string, [string, string]> = {
  ORG_CODE_FORMAT: [
    `An org object code is one to ten characters of capitals and digits, starting with a letter.`,
    `Write the code here, on the screen that defines the unit, the job or the position — the assignment and `
    + `employee screens take a code that already stands, they do not create one.`,
  ],
  CLIENT_FORMAT: [
    `A tenant is the two-to-four-character code the session was opened with.`,
    `Open the screen from the launchpad; the tenant comes from the session, not from the form.`,
  ],
  REQUIRED_TEXT: [
    `A name or title was blank or longer than ${NAME_MAX} characters.`,
    `Write it as the contract writes it, up to ${NAME_MAX} characters.`,
  ],
  NOTHING_TO_CHANGE: [
    `No field was given, so nothing would change.`,
    `Send the name, the validity, the unit or the reporting line you want moved.`,
  ],
  UNIT_EXISTS: [
    `An organisational unit with that code already stands in this tenant.`,
    `Change the one that stands, or pick a code the structure has not used.`,
  ],
  UNIT_UNKNOWN: [
    `No organisational unit of that code stands in this tenant.`,
    `Define it first — the structure is built from the top down, as §6.1's define-before-assign graph has it.`,
  ],
  UNIT_RETIRED: [
    `That unit is retired, so nothing new can be filed under it.`,
    `Set its validity back to true, or file the object under a unit that is still valid.`,
  ],
  JOB_EXISTS: [`A job with that code already stands in this tenant.`, `Change the job that stands, or name the new one differently.`],
  JOB_UNKNOWN: [`No job of that code stands in this tenant.`, `Define the job here first, or leave the position's job blank.`],
  POSITION_EXISTS: [`A position with that code already stands in this tenant.`, `Change the position that stands, or pick another code.`],
  JOB_RETIRED: [
    `That job is retired, so no new position may be described by it.`,
    `Set its validity back to true, or pick a job that is still valid. Positions already citing the retired one keep it.`,
  ],
  POSITION_UNKNOWN: [
    `No position of that code stands in this tenant.`,
    `Define the position before assigning anyone to it (§6.1, D-086: the definition comes first).`,
  ],
  POSITION_RETIRED: [
    `That position is retired, so it takes no new assignment and no new position below it.`,
    `Set its validity back to true, or point at a position that is still valid.`,
  ],
  POSITION_UNIT_REQUIRED: [
    `A position stands in an org unit: this structure has no "no unit" for one.`,
    `Move it to the unit it belongs to now, or retire it if it is no longer to be filled.`,
  ],
  CYCLE: [
    `That would make an object its own parent, directly or through what hangs below it.`,
    `Attach it under something above it in the tree, not under one of its own descendants.`,
  ],
  TOO_DEEP: [
    `A structure chain may run ${MAX_ORG_DEPTH} levels at most.`,
    `Move the branch under a higher unit. The cap is the one drizzle/0052 sets for a cost centre tree, taken over rather than newly drawn.`,
  ],
  SELF_LINK: [
    `An object cannot point at itself.`,
    `A unit's parent is another unit; a position reports to another position.`,
  ],
};

function refusal(key: string, detail?: string): never {
  const [message, remedy] = REFUSALS[key] ?? [
    `The organisational structure write was not accepted (${key}).`,
    `Correct the value and submit again.`,
  ];
  throw new OrgStructureError(detail ? `${message} ${detail}` : message, remedy);
}

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    refusal(first?.code === 'custom' ? String(first.message) : (first?.message ?? 'INVALID_INPUT'));
  }
  return parsed.data;
}

const node = (kind: OrgNodeKind, codeValue: string): string => `${kind}/${codeValue}`;

/**
 * Walk a parent map up from one node: `level` is 1 for a root, and `cycle` says the chain closed on itself
 * before it reached one. Pure and exported, because the walk is the whole of both rules the database cannot
 * state, and a test should be able to call it without a tenant.
 */
export function measureChain(
  parents: Map<string, string>,
  from: string,
  maxDepth: number = MAX_ORG_DEPTH,
): { level: number; cycle: boolean } {
  const seen = new Set<string>([from]);
  let level = 1;
  let cursor = parents.get(from);
  while (cursor !== undefined) {
    if (seen.has(cursor)) return { level, cycle: true };
    seen.add(cursor);
    level += 1;
    if (level > maxDepth) return { level, cycle: false };
    cursor = parents.get(cursor);
  }
  return { level, cycle: false };
}

function unitRow(tx: Tx, client: string, codeValue: string) {
  return tx.select().from(orgUnit)
    .where(and(eq(orgUnit.client, client), eq(orgUnit.code, codeValue)))
    .limit(1)
    .then((rows) => rows[0]);
}

function positionRow(tx: Tx, client: string, codeValue: string) {
  return tx.select().from(position)
    .where(and(eq(position.client, client), eq(position.code, codeValue)))
    .limit(1)
    .then((rows) => rows[0]);
}

async function edgeRows(tx: Tx, client: string, relation: OrgRelation): Promise<Map<string, string>> {
  const rows = await tx.select({
    parentKind: orgHierarchy.parentKind,
    parentCode: orgHierarchy.parentCode,
    childKind: orgHierarchy.childKind,
    childCode: orgHierarchy.childCode,
  }).from(orgHierarchy)
    .where(and(eq(orgHierarchy.client, client), eq(orgHierarchy.relationType, relation)));
  const parents = new Map<string, string>();
  for (const row of rows) {
    parents.set(node(row.childKind as OrgNodeKind, row.childCode), node(row.parentKind as OrgNodeKind, row.parentCode));
  }
  return parents;
}

/**
 * File one object under another, or move it: the edge is the whole of the relation, so a move rewrites the
 * child's row. The parent is checked for existence and validity, and the chain is walked with the proposed
 * edge already in place — which is what catches a ring that only closes *because* of this move.
 */
async function attachOrMove(
  tx: Tx,
  args: {
    client: string;
    relation: OrgRelation;
    parentCode: string;
    childKind: OrgNodeKind;
    childCode: string;
    changedBy: string;
  },
): Promise<void> {
  const parentKind: OrgNodeKind = args.relation === 'REPORTS_TO' ? 'POSITION' : 'ORGUNIT';
  if (parentKind === args.childKind && args.parentCode === args.childCode) refusal('SELF_LINK');

  if (parentKind === 'ORGUNIT') {
    const parent = await unitRow(tx, args.client, args.parentCode);
    if (!parent) refusal('UNIT_UNKNOWN', args.parentCode);
    if (!parent!.isValid) refusal('UNIT_RETIRED', args.parentCode);
  } else {
    const parent = await positionRow(tx, args.client, args.parentCode);
    if (!parent) refusal('POSITION_UNKNOWN', args.parentCode);
    if (!parent!.isValid) refusal('POSITION_RETIRED', args.parentCode);
  }

  const parents = await edgeRows(tx, args.client, args.relation);
  const childKey = node(args.childKind, args.childCode);
  parents.set(childKey, node(parentKind, args.parentCode));
  const measured = measureChain(parents, childKey);
  if (measured.cycle) refusal('CYCLE', `${args.childCode} would sit above itself.`);
  if (measured.level > MAX_ORG_DEPTH) {
    refusal('TOO_DEEP', `${args.childCode} would stand at level ${measured.level}.`);
  }

  await tx.delete(orgHierarchy).where(and(
    eq(orgHierarchy.client, args.client),
    eq(orgHierarchy.relationType, args.relation),
    eq(orgHierarchy.childKind, args.childKind),
    eq(orgHierarchy.childCode, args.childCode),
  ));
  await tx.insert(orgHierarchy).values({
    client: args.client,
    relationType: args.relation,
    parentKind,
    parentCode: args.parentCode,
    childKind: args.childKind,
    childCode: args.childCode,
    createdBy: args.changedBy,
    changedBy: args.changedBy,
    changedAt: new Date(),
  });
}

/** Drop one edge, when the change is that an object is no longer below anything (roots only: a unit). */
async function detach(tx: Tx, args: { client: string; relation: OrgRelation; childKind: OrgNodeKind; childCode: string }): Promise<boolean> {
  const parents = await edgeRows(tx, args.client, args.relation);
  if (!parents.has(node(args.childKind, args.childCode))) return false;
  await tx.delete(orgHierarchy).where(and(
    eq(orgHierarchy.client, args.client),
    eq(orgHierarchy.relationType, args.relation),
    eq(orgHierarchy.childKind, args.childKind),
    eq(orgHierarchy.childCode, args.childCode),
  ));
  return true;
}

/** The names a view needs without a join per row: every unit and every position of the tenant, once. */
async function catalogues(tx: Tx, client: string) {
  const [units, positions] = await Promise.all([
    tx.select({ code: orgUnit.code, name: orgUnit.name }).from(orgUnit)
      .where(eq(orgUnit.client, client)).orderBy(asc(orgUnit.code)),
    tx.select({ code: position.code, title: position.title }).from(position)
      .where(eq(position.client, client)).orderBy(asc(position.code)),
  ]);
  return {
    unitNames: new Map(units.map((u) => [u.code, u.name])),
    positionTitles: new Map(positions.map((p) => [p.code, p.title])),
  };
}

/** Per-unit counts of the positions filed in them and of the ones a person stands in today. */
async function unitCounts(tx: Tx, client: string): Promise<Map<string, { positions: number; filled: number }>> {
  const rows = await tx.execute(sql`
    select u.code as unit,
           (select count(*)::int
              from org_hierarchy p
             where p.client = u.client and p.relation_type = 'STRUCTURE'
               and p.parent_kind = 'ORGUNIT' and p.parent_code = u.code and p.child_kind = 'POSITION') as positions,
           (select count(*)::int
              from org_hierarchy p
              join position_assignment a
                on a.client = p.client and a.position_code = p.child_code
               and (a.valid_to is null or a.valid_to >= current_date)
             where p.client = u.client and p.relation_type = 'STRUCTURE'
               and p.parent_kind = 'ORGUNIT' and p.parent_code = u.code and p.child_kind = 'POSITION') as filled
      from org_unit u
     where u.client = ${client}`) as unknown as Array<{ unit: string; positions: number; filled: number }>;
  return new Map(rows.map((row) => [row.unit, { positions: Number(row.positions), filled: Number(row.filled) }]));
}

/** Define a unit, optionally under one that already stands. */
export async function defineOrgUnit(
  input: unknown,
  capabilities?: readonly string[],
): Promise<OrgUnitDetail> {
  const parsed = parse(defineUnitInput, input);
  assertCapability(capabilities, ORG_UNIT_CAPABILITY, parsed.changedBy);
  await withTenant(parsed.client, async (tx) => {
    if (await unitRow(tx, parsed.client, parsed.code)) refusal('UNIT_EXISTS', parsed.code);
    await tx.insert(orgUnit).values({
      client: parsed.client,
      code: parsed.code,
      name: parsed.name,
      description: parsed.description ?? null,
      isValid: true,
      createdBy: parsed.changedBy,
    });
    if (parsed.parentCode) {
      await attachOrMove(tx, {
        client: parsed.client,
        relation: 'STRUCTURE',
        parentCode: parsed.parentCode,
        childKind: 'ORGUNIT',
        childCode: parsed.code,
        changedBy: parsed.changedBy,
      });
    }
    await recordChange(tx, {
      client: parsed.client,
      objectClass: ORG_UNIT_OBJECT_CLASS,
      objectKey: parsed.code,
      changeType: 'CREATE',
      changedBy: parsed.changedBy,
      after: { code: parsed.code, name: parsed.name, parentCode: parsed.parentCode ?? null },
    });
    return undefined;
  });
  return getOrgUnit(parsed.client, parsed.code);
}

/** Change a unit's name, its description, its validity, or where it hangs. */
export async function changeOrgUnit(
  input: unknown,
  capabilities?: readonly string[],
): Promise<OrgUnitDetail> {
  const parsed = parse(changeUnitInput, input);
  assertCapability(capabilities, ORG_UNIT_CAPABILITY, parsed.changedBy);
  await withTenant(parsed.client, async (tx) => {
    const standing = await unitRow(tx, parsed.client, parsed.code);
    if (!standing) refusal('UNIT_UNKNOWN', parsed.code);

    const patch: { name?: string; description?: string | null; isValid?: boolean } = {};
    if (parsed.name !== undefined) patch.name = parsed.name;
    if (parsed.description !== undefined) patch.description = parsed.description;
    if (parsed.isValid !== undefined) patch.isValid = parsed.isValid;
    const moving = parsed.parentCode !== undefined;
    if (Object.keys(patch).length === 0 && !moving) refusal('NOTHING_TO_CHANGE');

    if (Object.keys(patch).length > 0) {
      await tx.update(orgUnit).set({ ...patch, changedBy: parsed.changedBy, changedAt: new Date() }).where(and(
        eq(orgUnit.client, parsed.client),
        eq(orgUnit.code, parsed.code),
      ));
    }

    let detached = false;
    if (moving) {
      if (parsed.parentCode === null) detached = await detach(tx, {
        client: parsed.client, relation: 'STRUCTURE', childKind: 'ORGUNIT', childCode: parsed.code,
      });
      else if (parsed.parentCode !== undefined) {
        await attachOrMove(tx, {
          client: parsed.client,
          relation: 'STRUCTURE',
          parentCode: parsed.parentCode,
          childKind: 'ORGUNIT',
          childCode: parsed.code,
          changedBy: parsed.changedBy,
        });
      }
    }

    await recordChange(tx, {
      client: parsed.client,
      objectClass: ORG_UNIT_OBJECT_CLASS,
      objectKey: parsed.code,
      changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      before: { name: standing!.name, isValid: standing!.isValid },
      after: { ...patch, ...(moving ? { parentCode: parsed.parentCode, detached } : {}) },
    });
    return undefined;
  });
  return getOrgUnit(parsed.client, parsed.code);
}

/** One unit with what hangs below it: the child units, and the positions filed in it. */
export async function getOrgUnit(clientInput: string, codeValue: string): Promise<OrgUnitDetail> {
  const client = parse(clientField, clientInput);
  const wanted = parse(orgCode, codeValue);
  return withTenant(client, async (tx) => {
    const row = await unitRow(tx, client, wanted);
    if (!row) refusal('UNIT_UNKNOWN', wanted);

    const [edges, positionEdges, names, counts] = await Promise.all([
      edgeRows(tx, client, 'STRUCTURE'),
      tx.select({
        parentCode: orgHierarchy.parentCode,
        code: position.code,
        title: position.title,
        isValid: position.isValid,
      }).from(orgHierarchy)
        .innerJoin(position, and(
          eq(position.client, orgHierarchy.client),
          eq(position.code, orgHierarchy.childCode),
        ))
        .where(and(
          eq(orgHierarchy.client, client),
          eq(orgHierarchy.relationType, 'STRUCTURE'),
          eq(orgHierarchy.parentKind, 'ORGUNIT'),
          eq(orgHierarchy.parentCode, wanted),
          eq(orgHierarchy.childKind, 'POSITION'),
        )),
      catalogues(tx, client),
      unitCounts(tx, client),
    ]);
    const incumbents = await tx.execute(sql`
      select p.code as position, count(a.personnel_number)::int as incumbents
        from org_hierarchy h
        join position p on p.client = h.client and p.code = h.child_code
        left join position_assignment a
          on a.client = p.client and a.position_code = p.code
         and (a.valid_to is null or a.valid_to >= current_date)
       where h.client = ${client} and h.relation_type = 'STRUCTURE'
         and h.parent_kind = 'ORGUNIT' and h.parent_code = ${wanted} and h.child_kind = 'POSITION'
       group by p.code`) as unknown as Array<{ position: string; incumbents: number }>;
    const filled = new Map(incumbents.map((r) => [r.position, Number(r.incumbents)]));

    const childRows = await tx.select({ code: orgUnit.code, name: orgUnit.name, isValid: orgUnit.isValid })
      .from(orgHierarchy)
      .innerJoin(orgUnit, and(eq(orgUnit.client, orgHierarchy.client), eq(orgUnit.code, orgHierarchy.childCode)))
      .where(and(
        eq(orgHierarchy.client, client),
        eq(orgHierarchy.relationType, 'STRUCTURE'),
        eq(orgHierarchy.parentKind, 'ORGUNIT'),
        eq(orgHierarchy.parentCode, wanted),
        eq(orgHierarchy.childKind, 'ORGUNIT'),
      )).orderBy(asc(orgUnit.code));

    const tally = counts.get(wanted) ?? { positions: 0, filled: 0 };
    const parentCode = edges.get(node('ORGUNIT', wanted))?.slice('ORGUNIT/'.length) ?? null;
    return {
      code: row!.code,
      name: row!.name,
      description: row!.description ?? null,
      isValid: row!.isValid,
      parentCode,
      parentName: parentCode ? names.unitNames.get(parentCode) ?? null : null,
      level: measureChain(edges, node('ORGUNIT', wanted)).level,
      childUnits: childRows.length,
      positions: tally.positions,
      positionsFilled: tally.filled,
      createdBy: row!.createdBy,
      changedBy: row!.changedBy ?? null,
      children: childRows.map((c) => ({ code: c.code, name: c.name, isValid: c.isValid })),
      positionList: positionEdges.map((p) => ({
        code: p.code,
        title: p.title,
        isValid: p.isValid,
        incumbents: filled.get(p.code) ?? 0,
      })).sort((a, b) => a.code.localeCompare(b.code)),
    };
  });
}

/** The units, in code order, each with the level the tree puts it at. Search is by code or name. */
export async function listOrgUnits(clientInput: string, query?: string): Promise<OrgUnitView[]> {
  const client = parse(clientField, clientInput);
  const needle = (query ?? '').trim().toUpperCase();
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(orgUnit).where(and(
      eq(orgUnit.client, client),
      ...(needle === '' ? [] : [or(
        sql`${orgUnit.code} like ${`%${needle}%`}`,
        sql`upper(${orgUnit.name}) like ${`%${needle}%`}`,
      )!]),
    )).orderBy(asc(orgUnit.code)).limit(200);
    const [edges, names, counts] = await Promise.all([
      edgeRows(tx, client, 'STRUCTURE'),
      catalogues(tx, client),
      unitCounts(tx, client),
    ]);
    // The unit's own children are counted from the same edge map the level is walked on, so one read answers
    // both: an extra query per row would be the N+1 this module's other list functions avoid on purpose.
    const childCount = new Map<string, number>();
    for (const [child, parent] of edges.entries()) {
      if (!child.startsWith('ORGUNIT/') || !parent.startsWith('ORGUNIT/')) continue;
      childCount.set(parent.slice('ORGUNIT/'.length), (childCount.get(parent.slice('ORGUNIT/'.length)) ?? 0) + 1);
    }
    return rows.map((row) => {
      const tally = counts.get(row.code) ?? { positions: 0, filled: 0 };
      const parentCode = edges.get(node('ORGUNIT', row.code))?.slice('ORGUNIT/'.length) ?? null;
      return {
        code: row.code,
        name: row.name,
        description: row.description ?? null,
        isValid: row.isValid,
        parentCode,
        parentName: parentCode ? names.unitNames.get(parentCode) ?? null : null,
        level: measureChain(edges, node('ORGUNIT', row.code)).level,
        childUnits: childCount.get(row.code) ?? 0,
        positions: tally.positions,
        positionsFilled: tally.filled,
        createdBy: row.createdBy,
        changedBy: row.changedBy ?? null,
      };
    });
  });
}

/** Define a job. §10.8 has no code of its own for jobs, so this is position-maintenance authority (§8.10). */
export async function defineJob(
  input: unknown,
  capabilities?: readonly string[],
): Promise<JobView> {
  const parsed = parse(defineJobInput, input);
  assertCapability(capabilities, POSITION_CAPABILITY, parsed.changedBy);
  await withTenant(parsed.client, async (tx) => {
    const [standing] = await tx.select().from(job)
      .where(and(eq(job.client, parsed.client), eq(job.code, parsed.code))).limit(1);
    if (standing) refusal('JOB_EXISTS', parsed.code);
    await tx.insert(job).values({
      client: parsed.client,
      code: parsed.code,
      name: parsed.name,
      description: parsed.description ?? null,
      isValid: true,
      createdBy: parsed.changedBy,
    });
    await recordChange(tx, {
      client: parsed.client,
      objectClass: JOB_OBJECT_CLASS,
      objectKey: parsed.code,
      changeType: 'CREATE',
      changedBy: parsed.changedBy,
      after: { code: parsed.code, name: parsed.name },
    });
    return undefined;
  });
  return getJob(parsed.client, parsed.code);
}

export async function changeJob(
  input: unknown,
  capabilities?: readonly string[],
): Promise<JobView> {
  const parsed = parse(changeJobInput, input);
  assertCapability(capabilities, POSITION_CAPABILITY, parsed.changedBy);
  await withTenant(parsed.client, async (tx) => {
    const [standing] = await tx.select().from(job)
      .where(and(eq(job.client, parsed.client), eq(job.code, parsed.code))).limit(1);
    if (!standing) refusal('JOB_UNKNOWN', parsed.code);
    const patch: { name?: string; description?: string | null; isValid?: boolean } = {};
    if (parsed.name !== undefined) patch.name = parsed.name;
    if (parsed.description !== undefined) patch.description = parsed.description;
    if (parsed.isValid !== undefined) patch.isValid = parsed.isValid;
    if (Object.keys(patch).length === 0) refusal('NOTHING_TO_CHANGE');
    await tx.update(job).set({ ...patch, changedBy: parsed.changedBy, changedAt: new Date() }).where(and(
      eq(job.client, parsed.client),
      eq(job.code, parsed.code),
    ));
    await recordChange(tx, {
      client: parsed.client,
      objectClass: JOB_OBJECT_CLASS,
      objectKey: parsed.code,
      changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      before: { name: standing!.name, isValid: standing!.isValid },
      after: patch,
    });
    return undefined;
  });
  return getJob(parsed.client, parsed.code);
}

export async function getJob(clientInput: string, codeValue: string): Promise<JobView> {
  const client = parse(clientField, clientInput);
  const wanted = parse(orgCode, codeValue);
  return withTenant(client, async (tx) => {
    const [row] = await tx.select().from(job)
      .where(and(eq(job.client, client), eq(job.code, wanted))).limit(1);
    if (!row) refusal('JOB_UNKNOWN', wanted);
    const [usage] = await tx.select({ positions: sql<number>`count(*)::int` }).from(position).where(and(
      eq(position.client, client),
      eq(position.jobCode, wanted),
    ));
    return {
      code: row!.code,
      name: row!.name,
      description: row!.description ?? null,
      isValid: row!.isValid,
      positions: Number(usage?.positions ?? 0),
      createdBy: row!.createdBy,
      changedBy: row!.changedBy ?? null,
    };
  });
}

export async function listJobs(clientInput: string, query?: string): Promise<JobView[]> {
  const client = parse(clientField, clientInput);
  const needle = (query ?? '').trim().toUpperCase();
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(job).where(and(
      eq(job.client, client),
      ...(needle === '' ? [] : [or(
        sql`${job.code} like ${`%${needle}%`}`,
        sql`upper(${job.name}) like ${`%${needle}%`}`,
      )!]),
    )).orderBy(asc(job.code)).limit(200);
    if (rows.length === 0) return [];
    const usage = await tx.select({
      jobCode: position.jobCode,
      positions: sql<number>`count(*)::int`,
    }).from(position).where(and(
      eq(position.client, client),
      sql`${position.jobCode} is not null`,
    )).groupBy(position.jobCode);
    const counts = new Map(usage.filter((u) => u.jobCode !== null).map((u) => [u.jobCode as string, Number(u.positions)]));
    return rows.map((row) => ({
      code: row.code,
      name: row.name,
      description: row.description ?? null,
      isValid: row.isValid,
      positions: counts.get(row.code) ?? 0,
      createdBy: row.createdBy,
      changedBy: row.changedBy ?? null,
    }));
  });
}

/** Define a position in the unit it belongs to, with the position it reports to if one is decided now. */
export async function definePosition(
  input: unknown,
  capabilities?: readonly string[],
): Promise<PositionView> {
  const parsed = parse(definePositionInput, input);
  assertCapability(capabilities, POSITION_CAPABILITY, parsed.changedBy);
  await withTenant(parsed.client, async (tx) => {
    if (await positionRow(tx, parsed.client, parsed.code)) refusal('POSITION_EXISTS', parsed.code);
    const unit = await unitRow(tx, parsed.client, parsed.orgUnitCode);
    if (!unit) refusal('UNIT_UNKNOWN', parsed.orgUnitCode);
    if (!unit!.isValid) refusal('UNIT_RETIRED', parsed.orgUnitCode);
    if (parsed.jobCode) {
      const [theJob] = await tx.select().from(job)
        .where(and(eq(job.client, parsed.client), eq(job.code, parsed.jobCode))).limit(1);
      if (!theJob) refusal('JOB_UNKNOWN', parsed.jobCode);
      // A retired job may go on naming positions that already cite it; it cannot name a new one, which is
      // the same rule `9193` gave a retired record type.
      if (!theJob!.isValid) refusal('JOB_RETIRED', parsed.jobCode);
    }

    await tx.insert(position).values({
      client: parsed.client,
      code: parsed.code,
      title: parsed.title,
      jobCode: parsed.jobCode ?? null,
      description: parsed.description ?? null,
      isValid: true,
      createdBy: parsed.changedBy,
    });
    await attachOrMove(tx, {
      client: parsed.client,
      relation: 'STRUCTURE',
      parentCode: parsed.orgUnitCode,
      childKind: 'POSITION',
      childCode: parsed.code,
      changedBy: parsed.changedBy,
    });
    if (parsed.superiorCode) {
      await attachOrMove(tx, {
        client: parsed.client,
        relation: 'REPORTS_TO',
        parentCode: parsed.superiorCode,
        childKind: 'POSITION',
        childCode: parsed.code,
        changedBy: parsed.changedBy,
      });
    }
    await recordChange(tx, {
      client: parsed.client,
      objectClass: POSITION_OBJECT_CLASS,
      objectKey: parsed.code,
      changeType: 'CREATE',
      changedBy: parsed.changedBy,
      after: {
        code: parsed.code,
        title: parsed.title,
        jobCode: parsed.jobCode ?? null,
        orgUnitCode: parsed.orgUnitCode,
        superiorCode: parsed.superiorCode ?? null,
      },
    });
    return undefined;
  });
  return getPosition(parsed.client, parsed.code);
}

/**
 * Change a position: its title, its job, its description, its validity, the unit it stands in, and the
 * position it reports to. `superiorCode: null` removes the reporting line; a unit is never removed, because
 * a position without one is not a position this structure can report.
 */
export async function changePosition(
  input: unknown,
  capabilities?: readonly string[],
): Promise<PositionView> {
  const parsed = parse(changePositionInput, input);
  assertCapability(capabilities, POSITION_CAPABILITY, parsed.changedBy);
  await withTenant(parsed.client, async (tx) => {
    const standing = await positionRow(tx, parsed.client, parsed.code);
    if (!standing) refusal('POSITION_UNKNOWN', parsed.code);

    const patch: { title?: string; jobCode?: string | null; description?: string | null; isValid?: boolean } = {};
    if (parsed.title !== undefined) patch.title = parsed.title;
    if (parsed.description !== undefined) patch.description = parsed.description;
    if (parsed.isValid !== undefined) patch.isValid = parsed.isValid;
    if (parsed.jobCode !== undefined) {
      if (parsed.jobCode === null) patch.jobCode = null;
      else {
        const [theJob] = await tx.select().from(job)
          .where(and(eq(job.client, parsed.client), eq(job.code, parsed.jobCode))).limit(1);
        if (!theJob) refusal('JOB_UNKNOWN', parsed.jobCode);
        if (!theJob!.isValid) refusal('JOB_RETIRED', parsed.jobCode);
        patch.jobCode = parsed.jobCode;
      }
    }

    if (parsed.orgUnitCode === null) refusal('POSITION_UNIT_REQUIRED', parsed.code);
    const movingUnit = parsed.orgUnitCode ?? undefined;
    let removingLine = false;
    if (parsed.superiorCode === null) removingLine = true;
    if (Object.keys(patch).length === 0 && movingUnit === undefined && !removingLine
      && parsed.superiorCode === undefined) refusal('NOTHING_TO_CHANGE');

    if (Object.keys(patch).length > 0) {
      await tx.update(position).set({ ...patch, changedBy: parsed.changedBy, changedAt: new Date() }).where(and(
        eq(position.client, parsed.client),
        eq(position.code, parsed.code),
      ));
    }
    if (movingUnit !== undefined) {
      await attachOrMove(tx, {
        client: parsed.client,
        relation: 'STRUCTURE',
        parentCode: movingUnit,
        childKind: 'POSITION',
        childCode: parsed.code,
        changedBy: parsed.changedBy,
      });
    }
    if (removingLine) {
      await detach(tx, { client: parsed.client, relation: 'REPORTS_TO', childKind: 'POSITION', childCode: parsed.code });
    } else if (parsed.superiorCode !== undefined && parsed.superiorCode !== null) {
      await attachOrMove(tx, {
        client: parsed.client,
        relation: 'REPORTS_TO',
        parentCode: parsed.superiorCode,
        childKind: 'POSITION',
        childCode: parsed.code,
        changedBy: parsed.changedBy,
      });
    }

    await recordChange(tx, {
      client: parsed.client,
      objectClass: POSITION_OBJECT_CLASS,
      objectKey: parsed.code,
      changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      before: { title: standing!.title, jobCode: standing!.jobCode, isValid: standing!.isValid },
      after: {
        ...patch,
        ...(movingUnit !== undefined ? { orgUnitCode: movingUnit } : {}),
        ...(parsed.superiorCode !== undefined ? { superiorCode: parsed.superiorCode } : {}),
      },
    });
    return undefined;
  });
  return getPosition(parsed.client, parsed.code);
}

export async function getPosition(clientInput: string, codeValue: string): Promise<PositionView> {
  const client = parse(clientField, clientInput);
  const wanted = parse(orgCode, codeValue);
  return withTenant(client, async (tx) => {
    const row = await positionRow(tx, client, wanted);
    if (!row) refusal('POSITION_UNKNOWN', wanted);
    const [unitEdges, lineEdges, names, tally] = await Promise.all([
      edgeRows(tx, client, 'STRUCTURE'),
      edgeRows(tx, client, 'REPORTS_TO'),
      catalogues(tx, client),
      tx.execute(sql`
        select (select j.name from public.job j where j.client = p.client and j.code = p.job_code) as job_name,
               (select count(*)::int from public.position_assignment a
                 where a.client = p.client and a.position_code = p.code
                   and (a.valid_to is null or a.valid_to >= current_date)) as incumbents,
               (select count(*)::int from public.position_assignment a
                 where a.client = p.client and a.position_code = p.code) as assignments
          from public.position p
         where p.client = ${client} and p.code = ${wanted}`) as unknown as Array<{
        job_name: string | null; incumbents: number; assignments: number;
      }>,
    ]);
    const [jobName, counts] = [tally[0]?.job_name ?? null, tally[0]];
    const unitCode = unitEdges.get(node('POSITION', wanted))?.slice('ORGUNIT/'.length) ?? null;
    const superiorCode = lineEdges.get(node('POSITION', wanted))?.slice('POSITION/'.length) ?? null;
    return {
      code: row!.code,
      title: row!.title,
      jobCode: row!.jobCode ?? null,
      jobName,
      description: row!.description ?? null,
      isValid: row!.isValid,
      orgUnitCode: unitCode,
      orgUnitName: unitCode ? names.unitNames.get(unitCode) ?? null : null,
      superiorCode,
      superiorTitle: superiorCode ? names.positionTitles.get(superiorCode) ?? null : null,
      incumbents: Number(counts?.incumbents ?? 0),
      assignments: Number(counts?.assignments ?? 0),
      createdBy: row!.createdBy,
      changedBy: row!.changedBy ?? null,
    };
  });
}

/** Positions, in code order, with the unit and line each stands in. Search is by code or title. */
export async function listPositions(clientInput: string, query?: string): Promise<PositionView[]> {
  const client = parse(clientField, clientInput);
  const needle = (query ?? '').trim().toUpperCase();
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(position).where(and(
      eq(position.client, client),
      ...(needle === '' ? [] : [or(
        sql`${position.code} like ${`%${needle}%`}`,
        sql`upper(${position.title}) like ${`%${needle}%`}`,
      )!]),
    )).orderBy(asc(position.code)).limit(200);
    if (rows.length === 0) return [];
    const [unitEdges, lineEdges, names] = await Promise.all([
      edgeRows(tx, client, 'STRUCTURE'),
      edgeRows(tx, client, 'REPORTS_TO'),
      catalogues(tx, client),
    ]);
    const jobs = await tx.select({ code: job.code, name: job.name }).from(job).where(eq(job.client, client));
    const jobNames = new Map(jobs.map((j) => [j.code, j.name]));
    const counts = await tx.execute(sql`
      select p.code as position,
             count(a.personnel_number) filter (where a.valid_to is null or a.valid_to >= current_date)::int as incumbents,
             count(a.personnel_number)::int as assignments
        from position p
        left join position_assignment a on a.client = p.client and a.position_code = p.code
       where p.client = ${client}
       group by p.code`) as unknown as Array<{ position: string; incumbents: number; assignments: number }>;
    const perPosition = new Map(counts.map((c) => [c.position, {
      incumbents: Number(c.incumbents),
      assignments: Number(c.assignments),
    }]));

    return rows.map((row) => {
      const unitCode = unitEdges.get(node('POSITION', row.code))?.slice('ORGUNIT/'.length) ?? null;
      const superiorCode = lineEdges.get(node('POSITION', row.code))?.slice('POSITION/'.length) ?? null;
      const tally = perPosition.get(row.code) ?? { incumbents: 0, assignments: 0 };
      return {
        code: row.code,
        title: row.title,
        jobCode: row.jobCode ?? null,
        jobName: row.jobCode ? jobNames.get(row.jobCode) ?? null : null,
        description: row.description ?? null,
        isValid: row.isValid,
        orgUnitCode: unitCode,
        orgUnitName: unitCode ? names.unitNames.get(unitCode) ?? null : null,
        superiorCode,
        superiorTitle: superiorCode ? names.positionTitles.get(superiorCode) ?? null : null,
        incumbents: tally.incumbents,
        assignments: tally.assignments,
        createdBy: row.createdBy,
        changedBy: row.changedBy ?? null,
      };
    });
  });
}
