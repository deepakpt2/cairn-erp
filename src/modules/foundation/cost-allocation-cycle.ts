/**
 * Cost allocation cycles — definition (KSU1/KSU2/KSU3) and assessment execution (KSU5).
 *
 * A cycle holds segments; a segment relieves sender cost centres of their posted cost and charges
 * receiver cost centres by a rule. Assessment bundles everything into one account: every line of the
 * AL document — sender credit and receiver debit alike — carries the account the tenant named on
 * posting event CO_ASSESSMENT, and a cost centre, so the account nets to zero inside the document.
 * There are no secondary cost elements in this product; the original cost element is not preserved
 * (that is distribution, KSV5, defined here but refused at run time).
 *
 * The rules this file keeps (owner decisions, 2026-11-15):
 * - **Assessable cost is the sender's net balance** in the period: debits minus credits on its lines,
 *   in documents standing POSTED or REVERSED (a reversed original keeps its line; its reversal posts
 *   the credit), never PARKED; lines already on the assessment account are excluded, so a run cannot
 *   assess its own output. A negative net is refused — there is no arrears mechanism to carry it.
 * - **A sender appears in one segment only**; a centre both sending and receiving in one segment is
 *   refused. Receiving in a later segment after sending in an earlier one is chained allocation.
 * - **One company code per run.** Centres in more than one company are refused, naming them: the
 *   posting service writes one document per company, and no cross-company clearing account stands.
 * - **Company-currency amounts** (`amount_local`); a company currency other than the controlling
 *   area's is refused, never silently excluded.
 * - **One EXECUTED run per cycle, year and period**, by a partial unique index. A correction is a
 *   reversal of the run's document, then `cancelAssessmentRun` (refused unless the document stands
 *   reversed), then a new run.
 * - **One pass**, `iterations: 1`; `allocatePass` is the pass, so iteration has a body when it comes.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { type ServiceAuthorityContext, verifyServiceAuthorityInTx } from '../../platform/auth/service-authority';
import { hasOrgAccess } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import { NumberRangeError } from '../../platform/numbering';
import { PeriodError, checkPostingAllowed, derivePosition, getCompanyCode } from '../../platform/periods';
import { PostingError, computeTotals } from '../../platform/posting';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { GlDocumentError, postGlDocument, type GlDocumentLineInput } from '../finance/gl-document';
import { planningContext } from './activity-rate-definition';
import { resolveGroupMembers, type GroupLeafRow } from './cost-center-hierarchy';
import {
  ALLOCATION_CATEGORIES,
  RECEIVER_RULES,
  costAllocationCycle,
  costAllocationReceiver,
  costAllocationRun,
  costAllocationSegment,
  costAllocationSender,
  type ReceiverRule,
} from './schema';

export const ALLOCATION_DEFINE_CAPABILITY = 'CFG.COST.ALLOCATION.DEFINE';
export const ALLOCATION_EXECUTE_CAPABILITY = 'CO.ASSESSMENT.EXECUTE';
export const ALLOCATION_CYCLE_ROUTE = '/controlling/allocation-cycles';
export const ASSESSMENT_EVENT = 'CO_ASSESSMENT';
export const ALLOCATION_DOCUMENT_TYPE = 'AL';
export const ALLOCATION_OBJECT_CLASS = 'cost_allocation_cycle';
export const ALLOCATION_RUN_OBJECT_CLASS = 'cost_allocation_run';
export { RECEIVER_RULES, ALLOCATION_CATEGORIES };
export type { ReceiverRule };

export class AllocationCycleError extends Error {
  readonly remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'AllocationCycleError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new AllocationCycleError(message, remedy);
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];
type Authority = { authorization?: ServiceAuthorityContext };

const list = (values: readonly (string | number)[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

// ── Authority ───────────────────────────────────────────────────────────────

async function areaCompanies(tx: Tx, client: string, area: string): Promise<string[]> {
  const rows = (await tx.execute(sql`
    select company_code from controlling_area_company where client = ${client} and controlling_area = ${area} order by company_code
  `)) as unknown as Array<{ company_code: string }>;
  return rows.map((r) => String(r.company_code).trim());
}

/** The session must hold the capability and reach every company of the controlling area. */
async function judge(tx: Tx, client: string, area: string, authorization: ServiceAuthorityContext | undefined, capability: string): Promise<void> {
  const verdict = await verifyServiceAuthorityInTx(tx, client, authorization, capability, { requirePlantScope: false });
  if (!verdict.ok) {
    fail(verdict.refusal.message.startsWith('You do not hold the authority') ? `You do not hold ${capability}.` : verdict.refusal.message, verdict.refusal.remedy);
  }
  for (const company of await areaCompanies(tx, client, area)) {
    if (!hasOrgAccess(verdict.restrictions, 'COMPANY_CODE', company)) {
      fail(`Your Company Code scope does not cover company code ${company} of Controlling Area ${area}; a cycle spans every company of its area.`, 'Ask an administrator to extend your Company Code scope, then repeat the action.');
    }
  }
}

// ── Input ───────────────────────────────────────────────────────────────────

const upperKey = (pattern: RegExp, message: string) =>
  z.string().trim().transform((v) => v.toUpperCase()).pipe(z.string().regex(pattern, message));
const areaField = upperKey(/^[A-Z0-9]{4}$/, 'The Controlling Area is exactly four letters or digits.');
const cycleField = upperKey(/^[A-Z0-9]{1,6}$/, 'The Cycle is up to six letters or digits.');
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.');
const reasonField = z.string().trim().min(1, 'A reason is required.').max(500, 'The reason is at most 500 characters.');
const segmentField = z.number().int().min(1, 'A segment number is between 1 and 999.').max(999, 'A segment number is between 1 and 999.');
const itemField = z.number().int().min(1, 'An item number is between 1 and 999.').max(999, 'An item number is between 1 and 999.');
const optionalUpper = (max: number, message: string) =>
  z.union([z.literal('').transform(() => null), z.null(), upperKey(new RegExp(`^[A-Z0-9]{1,${max}}$`), message)]).optional();
const actorFields = { client: z.string().regex(/^[A-Za-z0-9]{2,4}$/), changedBy: z.string().trim().min(1).max(60) };

const saveCycleSchema = z.object({
  mode: z.enum(['CREATE', 'CHANGE']),
  controllingArea: areaField,
  cycleCode: cycleField,
  name: z.string().trim().min(1, 'A cycle needs a name.').max(40, 'The name is at most 40 characters.'),
  category: z.enum(ALLOCATION_CATEGORIES).default('ASSESSMENT'),
  validFrom: isoDate,
  validTo: isoDate,
  isActive: z.boolean().default(true),
  reason: reasonField,
}).extend(actorFields).strict();

const setSegmentSchema = z.object({
  controllingArea: areaField,
  cycleCode: cycleField,
  segmentNumber: segmentField,
  name: z.string().trim().min(1, 'A segment needs a name.').max(40, 'The name is at most 40 characters.'),
  senderRule: z.string().trim().toUpperCase().default('POSTED'),
  receiverRule: z.string().trim().toUpperCase(),
  costElementFrom: optionalUpper(10, 'A cost element is a G/L account number of up to ten letters or digits.'),
  costElementTo: optionalUpper(10, 'A cost element is a G/L account number of up to ten letters or digits.'),
  reason: reasonField,
}).extend(actorFields).strict();

const setNodeSchema = z.object({
  controllingArea: areaField,
  cycleCode: cycleField,
  segmentNumber: segmentField,
  itemNumber: itemField,
  costCenter: optionalUpper(10, 'The Cost Centre is up to ten letters or digits.'),
  groupName: optionalUpper(24, 'The Group is up to 24 letters or digits.'),
  /** Receivers only. */
  weight: z.string().trim().optional(),
  reason: reasonField,
}).extend(actorFields).strict();

const removeSchema = z.object({
  controllingArea: areaField,
  cycleCode: cycleField,
  segmentNumber: segmentField.optional(),
  reason: reasonField,
}).extend(actorFields).strict();

const runSchema = z.object({
  controllingArea: areaField,
  cycleCode: cycleField,
  fiscalYear: z.number().int().min(1900, 'The Fiscal Year is a four-digit year.').max(9999, 'The Fiscal Year is a four-digit year.'),
  period: z.number().int().min(1, 'The fiscal period is between 1 and 16.').max(16, 'The fiscal period is between 1 and 16.'),
  reason: reasonField,
}).extend(actorFields).strict();

const cancelSchema = z.object({ runId: z.string().trim().min(1).max(36), reason: reasonField }).extend(actorFields).strict();

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) fail(parsed.error.issues[0]?.message ?? 'The input is not valid.', 'Correct the indicated value and submit again.');
  return parsed.data;
}

export type SaveCycleInput = z.input<typeof saveCycleSchema>;
export type SetSegmentInput = z.input<typeof setSegmentSchema>;
export type SetNodeInput = z.input<typeof setNodeSchema>;
export type RemoveInput = z.input<typeof removeSchema>;
export type RunAssessmentInput = z.input<typeof runSchema>;
export type CancelRunInput = z.input<typeof cancelSchema>;

// ── Views ───────────────────────────────────────────────────────────────────

export interface CycleRow {
  controllingArea: string;
  cycleCode: string;
  name: string;
  category: string;
  validFrom: string;
  validTo: string;
  isActive: boolean;
  segments: number;
}

export interface NodeView { itemNumber: number; costCenter: string | null; groupName: string | null; weight?: string }
export interface SegmentView {
  segmentNumber: number;
  name: string;
  senderRule: string;
  receiverRule: string;
  costElementFrom: string | null;
  costElementTo: string | null;
  senders: NodeView[];
  receivers: NodeView[];
}
export interface CycleView extends Omit<CycleRow, 'segments'> { segments: SegmentView[] }

async function cycleRow(tx: Tx, client: string, area: string, code: string) {
  const [row] = await tx.select().from(costAllocationCycle).where(and(
    eq(costAllocationCycle.client, client), eq(costAllocationCycle.controllingArea, area), eq(costAllocationCycle.cycleCode, code),
  )).limit(1);
  return row ?? null;
}

async function cycleView(tx: Tx, client: string, area: string, code: string): Promise<CycleView | null> {
  const head = await cycleRow(tx, client, area, code);
  if (!head) return null;
  const key = (t: typeof costAllocationSegment | typeof costAllocationSender | typeof costAllocationReceiver) =>
    and(eq(t.client, client), eq(t.controllingArea, area), eq(t.cycleCode, code));
  const [segments, senders, receivers] = await Promise.all([
    tx.select().from(costAllocationSegment).where(key(costAllocationSegment)).orderBy(asc(costAllocationSegment.segmentNumber)),
    tx.select().from(costAllocationSender).where(key(costAllocationSender)).orderBy(asc(costAllocationSender.itemNumber)),
    tx.select().from(costAllocationReceiver).where(key(costAllocationReceiver)).orderBy(asc(costAllocationReceiver.itemNumber)),
  ]);
  return {
    controllingArea: head.controllingArea, cycleCode: head.cycleCode, name: head.name, category: head.category,
    validFrom: head.validFrom, validTo: head.validTo, isActive: head.isActive,
    segments: segments.map((s) => ({
      segmentNumber: s.segmentNumber, name: s.name, senderRule: s.senderRule, receiverRule: s.receiverRule,
      costElementFrom: s.costElementFrom ?? null, costElementTo: s.costElementTo ?? null,
      senders: senders.filter((n) => n.segmentNumber === s.segmentNumber).map((n) => ({ itemNumber: n.itemNumber, costCenter: n.costCenter ?? null, groupName: n.groupName ?? null })),
      receivers: receivers.filter((n) => n.segmentNumber === s.segmentNumber).map((n) => ({ itemNumber: n.itemNumber, costCenter: n.costCenter ?? null, groupName: n.groupName ?? null, weight: fromScaled(toScaled(String(n.weight))) })),
    })),
  };
}

export async function listCycles(client: string, controllingArea?: string): Promise<CycleRow[]> {
  return withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select c.controlling_area, c.cycle_code, c.name, c.category, c.valid_from::text as valid_from, c.valid_to::text as valid_to, c.is_active,
             (select count(*)::int from cost_allocation_segment s
               where s.client = c.client and s.controlling_area = c.controlling_area and s.cycle_code = c.cycle_code) as segments
        from cost_allocation_cycle c
       where c.client = ${client} ${controllingArea ? sql`and c.controlling_area = ${controllingArea.toUpperCase()}` : sql``}
       order by c.controlling_area, c.cycle_code
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      controllingArea: String(r.controlling_area), cycleCode: String(r.cycle_code), name: String(r.name), category: String(r.category),
      validFrom: day(r.valid_from), validTo: day(r.valid_to), isActive: Boolean(r.is_active), segments: Number(r.segments),
    }));
  });
}

export async function getCycle(client: string, controllingArea: string, cycleCode: string): Promise<CycleView | null> {
  return withTenant(client, (tx) => cycleView(tx, client, controllingArea.toUpperCase(), cycleCode.toUpperCase()));
}

// ── Definition (KSU1 / KSU2) ────────────────────────────────────────────────

async function assertCentreStands(tx: Tx, client: string, area: string, centre: string): Promise<void> {
  const rows = (await tx.execute(sql`select 1 from cost_center where client = ${client} and controlling_area = ${area} and cost_center = ${centre} limit 1`)) as unknown as unknown[];
  if (rows.length === 0) fail(`Cost Centre ${centre} does not stand in Controlling Area ${area}.`, 'Name a cost centre of the area (KS01).');
}
async function assertGroupStands(tx: Tx, client: string, area: string, group: string): Promise<void> {
  const rows = (await tx.execute(sql`select 1 from cost_center_group where client = ${client} and controlling_area = ${area} and group_name = ${group} limit 1`)) as unknown as unknown[];
  if (rows.length === 0) fail(`Cost Centre Group ${group} does not stand in Controlling Area ${area}.`, 'Name a group of the area (KSH1).');
}

export async function saveCycle(raw: SaveCycleInput, options: Authority = {}): Promise<CycleView> {
  const p = parse(saveCycleSchema, raw);
  if (p.validTo < p.validFrom) fail(`The cycle cannot end (${p.validTo}) before it starts (${p.validFrom}).`, 'Choose an end on or after the start.');
  return withTenant(p.client, async (tx) => {
    await judge(tx, p.client, p.controllingArea, options.authorization, ALLOCATION_DEFINE_CAPABILITY);
    const areaRows = (await tx.execute(sql`select 1 from controlling_area where client = ${p.client} and controlling_area = ${p.controllingArea}`)) as unknown as unknown[];
    if (areaRows.length === 0) fail(`Controlling Area ${p.controllingArea} is not defined in this tenant.`, 'Choose a controlling area that stands.');
    const standing = await cycleRow(tx, p.client, p.controllingArea, p.cycleCode);
    if (p.mode === 'CREATE' && standing) fail(`Cycle ${p.cycleCode} already stands in Controlling Area ${p.controllingArea}.`, 'Change it instead, or choose another code.');
    if (p.mode === 'CHANGE' && !standing) fail(`Cycle ${p.cycleCode} does not stand in Controlling Area ${p.controllingArea}.`, 'Create it first.');
    const values = { name: p.name, category: p.category, validFrom: p.validFrom, validTo: p.validTo, isActive: p.isActive };
    if (standing) {
      await tx.update(costAllocationCycle).set({ ...values, changedBy: p.changedBy, changedAt: new Date() })
        .where(and(eq(costAllocationCycle.client, p.client), eq(costAllocationCycle.controllingArea, p.controllingArea), eq(costAllocationCycle.cycleCode, p.cycleCode)));
    } else {
      await tx.insert(costAllocationCycle).values({ client: p.client, controllingArea: p.controllingArea, cycleCode: p.cycleCode, ...values, createdBy: p.changedBy });
    }
    await recordChange(tx, {
      client: p.client, objectClass: ALLOCATION_OBJECT_CLASS, objectKey: `${p.controllingArea}/${p.cycleCode}`,
      changeType: standing ? 'CHANGE' : 'CREATE', changedBy: p.changedBy, transactionCode: ALLOCATION_DEFINE_CAPABILITY, reason: p.reason,
      before: standing ? { name: standing.name, category: standing.category, validFrom: standing.validFrom, validTo: standing.validTo, isActive: standing.isActive } : undefined,
      after: values,
    });
    return (await cycleView(tx, p.client, p.controllingArea, p.cycleCode))!;
  });
}

export async function setSegment(raw: SetSegmentInput, options: Authority = {}): Promise<SegmentView> {
  const p = parse(setSegmentSchema, raw);
  if (p.senderRule !== 'POSTED') fail(`Sender rule ${p.senderRule} is not built; only posted actual amounts are sent.`, 'Choose sender rule POSTED.');
  if (!(RECEIVER_RULES as readonly string[]).includes(p.receiverRule)) {
    fail(`Receiver rule ${p.receiverRule} is not built: variable portions by tracing factor need a tracing-factor master that does not stand.`, 'Choose fixed percentages (PERCENTAGE), fixed portions (PORTION) or fixed amounts (FIXED_AMOUNT).');
  }
  const from = p.costElementFrom ?? null;
  const to = p.costElementTo ?? null;
  if ((from === null) !== (to === null)) fail('A cost element range names both ends, or neither.', 'Fill both cost element fields, or clear both.');
  if (from !== null && to !== null && from > to) fail(`The cost element range ${from}–${to} is inverted.`, 'Put the lower account first.');
  return withTenant(p.client, async (tx) => {
    await judge(tx, p.client, p.controllingArea, options.authorization, ALLOCATION_DEFINE_CAPABILITY);
    if (!(await cycleRow(tx, p.client, p.controllingArea, p.cycleCode))) fail(`Cycle ${p.cycleCode} does not stand in Controlling Area ${p.controllingArea}.`, 'Create the cycle first.');
    const where = and(eq(costAllocationSegment.client, p.client), eq(costAllocationSegment.controllingArea, p.controllingArea),
      eq(costAllocationSegment.cycleCode, p.cycleCode), eq(costAllocationSegment.segmentNumber, p.segmentNumber));
    const [standing] = await tx.select().from(costAllocationSegment).where(where).limit(1);
    const values = { name: p.name, senderRule: p.senderRule, receiverRule: p.receiverRule, costElementFrom: from, costElementTo: to };
    if (standing) {
      await tx.update(costAllocationSegment).set({ ...values, changedBy: p.changedBy, changedAt: new Date() }).where(where);
    } else {
      await tx.insert(costAllocationSegment).values({ client: p.client, controllingArea: p.controllingArea, cycleCode: p.cycleCode, segmentNumber: p.segmentNumber, ...values, createdBy: p.changedBy });
    }
    await recordChange(tx, {
      client: p.client, objectClass: ALLOCATION_OBJECT_CLASS, objectKey: `${p.controllingArea}/${p.cycleCode}/${p.segmentNumber}`,
      changeType: standing ? 'CHANGE' : 'CREATE', changedBy: p.changedBy, transactionCode: ALLOCATION_DEFINE_CAPABILITY, reason: p.reason,
      before: standing ? { name: standing.name, receiverRule: standing.receiverRule, costElementFrom: standing.costElementFrom, costElementTo: standing.costElementTo } : undefined,
      after: { name: values.name, receiverRule: values.receiverRule, costElementFrom: from, costElementTo: to },
    });
    return (await cycleView(tx, p.client, p.controllingArea, p.cycleCode))!.segments.find((s) => s.segmentNumber === p.segmentNumber)!;
  });
}

/**
 * Set one sender or receiver item: a cost centre or a group, never both. Naming neither removes the
 * item. Receivers carry a weight (≥ 0).
 */
async function setNode(raw: SetNodeInput, kind: 'sender' | 'receiver', options: Authority): Promise<void> {
  const p = parse(setNodeSchema, raw);
  const table = kind === 'sender' ? costAllocationSender : costAllocationReceiver;
  const centre = p.costCenter ?? null;
  const group = p.groupName ?? null;
  if (centre && group) fail(`A ${kind} names a cost centre or a group, not both.`, 'Clear one of the two fields.');
  let weight: string | null = null;
  if (kind === 'receiver' && (centre || group)) {
    try {
      const scaled = toScaled(p.weight ?? '');
      if (scaled < 0n) throw new Error('negative');
      weight = fromScaled(scaled);
    } catch {
      fail(`The receiver weight "${p.weight ?? ''}" is not a non-negative number.`, 'Enter a weight: a percentage, a portion or an amount, as the segment rule asks.');
    }
  }
  return withTenant(p.client, async (tx) => {
    await judge(tx, p.client, p.controllingArea, options.authorization, ALLOCATION_DEFINE_CAPABILITY);
    const [segment] = await tx.select().from(costAllocationSegment).where(and(
      eq(costAllocationSegment.client, p.client), eq(costAllocationSegment.controllingArea, p.controllingArea),
      eq(costAllocationSegment.cycleCode, p.cycleCode), eq(costAllocationSegment.segmentNumber, p.segmentNumber),
    )).limit(1);
    if (!segment) fail(`Segment ${p.segmentNumber} of cycle ${p.cycleCode} does not stand.`, 'Define the segment first.');
    if (centre) await assertCentreStands(tx, p.client, p.controllingArea, centre);
    if (group) await assertGroupStands(tx, p.client, p.controllingArea, group);
    const where = and(eq(table.client, p.client), eq(table.controllingArea, p.controllingArea), eq(table.cycleCode, p.cycleCode),
      eq(table.segmentNumber, p.segmentNumber), eq(table.itemNumber, p.itemNumber));
    const [standing] = await tx.select().from(table).where(where).limit(1);
    const key = `${p.controllingArea}/${p.cycleCode}/${p.segmentNumber}/${kind}/${p.itemNumber}`;
    const describe = (r: { costCenter: string | null; groupName: string | null; weight?: unknown } | undefined) =>
      r ? { costCenter: r.costCenter, groupName: r.groupName, ...(kind === 'receiver' ? { weight: r.weight === undefined || r.weight === null ? null : String(r.weight) } : {}) } : undefined;
    if (!centre && !group) {
      if (!standing) return;
      await tx.delete(table).where(where);
      await recordChange(tx, { client: p.client, objectClass: ALLOCATION_OBJECT_CLASS, objectKey: key, changeType: 'DELETE', changedBy: p.changedBy, transactionCode: ALLOCATION_DEFINE_CAPABILITY, reason: p.reason, before: describe(standing as never) });
      return;
    }
    const values = { costCenter: centre, groupName: group, ...(kind === 'receiver' ? { weight: weight! } : {}) };
    if (standing) {
      await tx.update(table).set({ ...values, changedBy: p.changedBy, changedAt: new Date() } as never).where(where);
    } else {
      await tx.insert(table).values({ client: p.client, controllingArea: p.controllingArea, cycleCode: p.cycleCode, segmentNumber: p.segmentNumber, itemNumber: p.itemNumber, ...values, createdBy: p.changedBy } as never);
    }
    await recordChange(tx, {
      client: p.client, objectClass: ALLOCATION_OBJECT_CLASS, objectKey: key, changeType: standing ? 'CHANGE' : 'CREATE',
      changedBy: p.changedBy, transactionCode: ALLOCATION_DEFINE_CAPABILITY, reason: p.reason,
      before: describe(standing as never), after: values,
    });
  });
}

export const setSender = (raw: SetNodeInput, options: Authority = {}) => setNode(raw, 'sender', options);
export const setReceiver = (raw: SetNodeInput, options: Authority = {}) => setNode(raw, 'receiver', options);

/** Remove a segment (with its senders and receivers), or — without a segment number — the whole cycle. */
export async function deleteCycle(raw: RemoveInput, options: Authority = {}): Promise<{ deleted: true }> {
  const p = parse(removeSchema, raw);
  return withTenant(p.client, async (tx) => {
    await judge(tx, p.client, p.controllingArea, options.authorization, ALLOCATION_DEFINE_CAPABILITY);
    const view = await cycleView(tx, p.client, p.controllingArea, p.cycleCode);
    if (!view) fail(`Cycle ${p.cycleCode} does not stand in Controlling Area ${p.controllingArea}.`);
    if (p.segmentNumber !== undefined) {
      if (!view.segments.some((s) => s.segmentNumber === p.segmentNumber)) fail(`Segment ${p.segmentNumber} of cycle ${p.cycleCode} does not stand.`);
      await tx.delete(costAllocationSegment).where(and(eq(costAllocationSegment.client, p.client), eq(costAllocationSegment.controllingArea, p.controllingArea),
        eq(costAllocationSegment.cycleCode, p.cycleCode), eq(costAllocationSegment.segmentNumber, p.segmentNumber)));
    } else {
      const runs = (await tx.execute(sql`select count(*)::int as n from cost_allocation_run where client = ${p.client} and controlling_area = ${p.controllingArea} and cycle_code = ${p.cycleCode}`)) as unknown as Array<{ n: number }>;
      if (Number(runs[0]?.n ?? 0) > 0) {
        fail(`Cycle ${p.cycleCode} has been executed ${runs[0]!.n} time(s); a cycle with runs is history and is not deleted.`, 'Set it inactive instead.');
      }
      await tx.delete(costAllocationCycle).where(and(eq(costAllocationCycle.client, p.client), eq(costAllocationCycle.controllingArea, p.controllingArea), eq(costAllocationCycle.cycleCode, p.cycleCode)));
    }
    await recordChange(tx, {
      client: p.client, objectClass: ALLOCATION_OBJECT_CLASS,
      objectKey: p.segmentNumber !== undefined ? `${p.controllingArea}/${p.cycleCode}/${p.segmentNumber}` : `${p.controllingArea}/${p.cycleCode}`,
      changeType: 'DELETE', changedBy: p.changedBy, transactionCode: ALLOCATION_DEFINE_CAPABILITY, reason: p.reason,
      before: { name: view.name },
    });
    return { deleted: true as const };
  });
}

// ── The pure allocation ─────────────────────────────────────────────────────

/** numerator / denominator, half away from zero (both non-negative here). */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/**
 * Split `total` among receivers by rule, exactly: the parts always sum to the total, any rounding
 * residual going to the largest receiver (the first of equals). PERCENTAGE weights must sum to 100
 * (within one hundredth); PORTION weights are relative and must not sum to zero; FIXED_AMOUNT weights
 * are the amounts and must sum to the total. Shares are rounded to `decimals` — the currency's
 * precision, so every share is an amount the ledger accepts — and returned as scale-4 strings.
 */
export function allocateAmount(total: string, rule: ReceiverRule, weights: string[], decimals = 4): string[] {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) fail(`A currency cannot carry ${decimals} decimals here.`);
  const unit = 10n ** BigInt(4 - decimals);
  if (toScaled(total) % unit !== 0n) fail(`The amount ${total} has more than ${decimals} decimal places.`);
  const t = toScaled(total) / unit;
  const w = weights.map((x) => toScaled(x));
  if (w.length === 0) fail('A segment needs at least one receiver.', 'Add a receiver to the segment.');
  if (w.some((x) => x < 0n)) fail('A receiver weight cannot be negative.', 'Correct the weights.');
  const sumW = w.reduce((s, x) => s + x, 0n);
  let shares: bigint[];
  if (rule === 'PERCENTAGE') {
    // 100 at scale 4 is 1_000_000; within one hundredth is ±100.
    if (sumW < 999_900n || sumW > 1_000_100n) fail(`The percentages sum to ${fromScaled(sumW)}, not 100.`, 'Make the receiver percentages add up to 100.');
    shares = w.map((x) => divideHalfUp(t * x, 1_000_000n));
  } else if (rule === 'PORTION') {
    if (sumW === 0n) fail('The portions sum to zero; there is nothing to apportion to.', 'Give at least one receiver a positive portion.');
    shares = w.map((x) => divideHalfUp(t * x, sumW));
  } else if (rule === 'FIXED_AMOUNT') {
    if (sumW !== t * unit) fail(`The fixed amounts sum to ${fromScaled(sumW)}, but the senders send ${fromScaled(t * unit)}.`, 'Make the fixed amounts add up to the amount sent.');
    if (w.some((x) => x % unit !== 0n)) fail(`A fixed amount has more than ${decimals} decimal places.`, `Enter the amounts to ${decimals} decimal places.`);
    shares = w.map((x) => x / unit);
  } else {
    fail(`Receiver rule ${String(rule)} is not built.`, 'Choose PERCENTAGE, PORTION or FIXED_AMOUNT.');
  }
  const residual = t - shares.reduce((s, x) => s + x, 0n);
  if (residual !== 0n) {
    let largest = 0;
    shares.forEach((x, i) => { if (x > shares[largest]!) largest = i; });
    shares[largest] = shares[largest]! + residual;
  }
  if (shares.reduce((s, x) => s + x, 0n) !== t) fail('The shares do not sum to the total after rounding.', 'This is a defect, not a data problem; report it.');
  return shares.map((x) => fromScaled(x * unit));
}

// ── Execution (KSU5) ────────────────────────────────────────────────────────

export interface AssessmentLineView { costCenter: string; name: string; amount: string; weight?: string }
export interface AssessmentSegmentView {
  segmentNumber: number;
  name: string;
  receiverRule: string;
  total: string;
  senders: AssessmentLineView[];
  receivers: AssessmentLineView[];
}
export interface AssessmentPreview {
  controllingArea: string;
  cycleCode: string;
  fiscalYear: number;
  period: number;
  postingDate: string;
  companyCode: string;
  currency: string;
  assessmentAccount: string;
  assessedTotal: string;
  iterations: number;
  segments: AssessmentSegmentView[];
}
export interface AssessmentRunView extends AssessmentPreview {
  runId: string;
  documentNumber: string;
  displayNumber: string;
  documentFiscalYear: number;
}

interface ResolvedSegment {
  segmentNumber: number;
  name: string;
  receiverRule: ReceiverRule;
  costElementFrom: string | null;
  costElementTo: string | null;
  senders: string[];
  receivers: Array<{ costCenter: string; weight: string }>;
}

/**
 * One pass of the assessment: each segment's senders' net cost, split among its receivers. Pure:
 * the costs are handed in. Iteration (centres serving each other) would call it again with the
 * previous pass's output folded into the costs.
 */
export function allocatePass(segments: ResolvedSegment[], costOf: (centre: string, segment: ResolvedSegment) => bigint, decimals = 4) {
  return segments.map((segment) => {
    const senders = segment.senders.map((centre) => ({ centre, amount: costOf(centre, segment) }));
    const total = senders.reduce((s, x) => s + x.amount, 0n);
    const shares = total === 0n ? segment.receivers.map(() => '0.0000') : allocateAmount(fromScaled(total), segment.receiverRule, segment.receivers.map((r) => r.weight), decimals);
    return { segment, senders, total, shares };
  });
}

async function resolveNodes(tx: Tx, client: string, area: string, nodes: Array<{ costCenter: string | null; groupName: string | null }>): Promise<string[]> {
  const centreKeys = ((await tx.execute(sql`select distinct cost_center from cost_center where client = ${client} and controlling_area = ${area} order by 1`)) as unknown as Array<{ cost_center: string }>).map((r) => r.cost_center);
  const out: string[] = [];
  for (const node of nodes) {
    if (node.costCenter) {
      if (!out.includes(node.costCenter)) out.push(node.costCenter);
      continue;
    }
    const group = node.groupName!;
    const stands = (await tx.execute(sql`select 1 from cost_center_group where client = ${client} and controlling_area = ${area} and group_name = ${group}`)) as unknown as unknown[];
    if (stands.length === 0) fail(`Cost Centre Group ${group} does not stand in Controlling Area ${area}.`, 'Maintain the group (KSH1) or change the cycle.');
    const leaves = ((await tx.execute(sql`
      select val_sign, val_option, val_from, val_to, display_order from cost_center_group_leaf
       where client = ${client} and controlling_area = ${area} and group_name = ${group}
    `)) as unknown as Array<{ val_sign: string; val_option: string; val_from: string; val_to: string; display_order: number }>)
      .map((l): GroupLeafRow => ({ valSign: String(l.val_sign).trim(), valOption: String(l.val_option).trim(), valFrom: l.val_from, valTo: l.val_to, displayOrder: Number(l.display_order) }));
    const members = resolveGroupMembers(centreKeys, leaves);
    if (members.length === 0) fail(`Cost Centre Group ${group} resolves to no cost centre.`, 'Maintain the group so it names at least one centre, or change the cycle.');
    for (const m of members) if (!out.includes(m)) out.push(m);
  }
  return out;
}

async function prepare(tx: Tx, p: z.infer<typeof runSchema>) {
  const area = p.controllingArea;
  const context = await planningContext(p.client, area, p.fiscalYear);
  if (!context) fail(`Controlling Area ${area} is not defined in this tenant.`, 'Choose a controlling area that stands.');
  const window = context.periods.find((w) => w.period === p.period);
  if (!window) fail(`Fiscal period ${p.period} is not defined by fiscal year variant ${context.fiscalYearVariant} for ${p.fiscalYear}.`, 'Choose a period the variant defines (OB29).');

  const view = await cycleView(tx, p.client, area, p.cycleCode);
  if (!view) fail(`Cycle ${p.cycleCode} does not stand in Controlling Area ${area}.`, `Define it at ${ALLOCATION_CYCLE_ROUTE}.`);
  if (!view.isActive) fail(`Cycle ${p.cycleCode} is inactive.`, 'Set it active before running it.');
  if (window.end < view.validFrom || window.end > view.validTo) {
    fail(`Cycle ${p.cycleCode} is valid ${view.validFrom} to ${view.validTo}; period ${p.period}/${p.fiscalYear} ends ${window.end}.`, 'Run a period inside the cycle\'s validity, or extend it.');
  }
  if (view.category !== 'ASSESSMENT') {
    fail(`Cycle ${p.cycleCode} is a distribution cycle. Distribution is not built; only assessment runs today.`, 'Define an assessment cycle for this allocation.');
  }
  if (view.segments.length === 0) fail(`Cycle ${p.cycleCode} has no segment.`, 'Define at least one segment with senders and receivers.');

  const [live] = await tx.select().from(costAllocationRun).where(and(
    eq(costAllocationRun.client, p.client), eq(costAllocationRun.controllingArea, area), eq(costAllocationRun.cycleCode, p.cycleCode),
    eq(costAllocationRun.fiscalYear, p.fiscalYear), eq(costAllocationRun.period, p.period), eq(costAllocationRun.status, 'EXECUTED'),
  )).limit(1);
  if (live) {
    fail(`Cycle ${p.cycleCode} already ran for ${p.period}/${p.fiscalYear} as document ${live.documentNumber} (run ${live.runId}).`, 'A correction is a reversal of that document, then cancelling the run, then a new run.');
  }

  // Senders and receivers per segment, resolved; one segment per sender; nobody sends to themselves.
  const resolved: ResolvedSegment[] = [];
  const senderSegment = new Map<string, number>();
  for (const s of view.segments) {
    if (!(RECEIVER_RULES as readonly string[]).includes(s.receiverRule)) fail(`Segment ${s.segmentNumber} uses receiver rule ${s.receiverRule}, which is not built.`, 'Choose PERCENTAGE, PORTION or FIXED_AMOUNT.');
    if (s.senders.length === 0) fail(`Segment ${s.segmentNumber} (${s.name}) names no sender.`, 'Add a sender cost centre or group.');
    if (s.receivers.length === 0) fail(`Segment ${s.segmentNumber} (${s.name}) names no receiver.`, 'Add a receiver cost centre or group.');
    const senders = await resolveNodes(tx, p.client, area, s.senders);
    const receivers: Array<{ costCenter: string; weight: string }> = [];
    for (const r of s.receivers) {
      for (const centre of await resolveNodes(tx, p.client, area, [r])) {
        const existing = receivers.find((x) => x.costCenter === centre);
        if (existing) existing.weight = fromScaled(toScaled(existing.weight) + toScaled(r.weight ?? '0'));
        else receivers.push({ costCenter: centre, weight: r.weight ?? '0' });
      }
    }
    for (const centre of senders) {
      const earlier = senderSegment.get(centre);
      if (earlier !== undefined) {
        fail(`Cost Centre ${centre} is a sender in segment ${earlier} and segment ${s.segmentNumber} of cycle ${p.cycleCode}; it would be relieved twice for the same cost.`, 'Name each sender in one segment only (check group memberships).');
      }
      senderSegment.set(centre, s.segmentNumber);
      if (receivers.some((r) => r.costCenter === centre)) {
        fail(`Cost Centre ${centre} is both a sender and a receiver in segment ${s.segmentNumber} of cycle ${p.cycleCode}.`, 'A centre cannot assess itself; remove it from one side.');
      }
    }
    resolved.push({
      segmentNumber: s.segmentNumber, name: s.name, receiverRule: s.receiverRule as ReceiverRule,
      costElementFrom: s.costElementFrom, costElementTo: s.costElementTo, senders, receivers,
    });
  }

  // Every centre valid on the posting date, unlocked, and in one company code.
  const centres = [...new Set(resolved.flatMap((s) => [...s.senders, ...s.receivers.map((r) => r.costCenter)]))];
  const masters = (await tx.execute(sql`
    select cost_center, name, company_code, valid_from::text as valid_from, valid_to::text as valid_to, is_posting_locked
      from cost_center where client = ${p.client} and controlling_area = ${area} and cost_center in (${list(centres)})
  `)) as unknown as Array<{ cost_center: string; name: string; company_code: string | null; valid_from: string; valid_to: string; is_posting_locked: boolean }>;
  const names = new Map<string, string>();
  const companies = new Map<string, string[]>();
  const all = await areaCompanies(tx, p.client, area);
  for (const centre of centres) {
    const row = masters.find((m) => m.cost_center === centre && day(m.valid_from) <= window.end && day(m.valid_to) >= window.end);
    if (!row) fail(`Cost Centre ${centre} is not valid in period ${p.period}/${p.fiscalYear} (it does not stand on ${window.end}).`, 'Extend the centre\'s validity, or take it out of the cycle.');
    if (row.is_posting_locked) fail(`Cost Centre ${centre} is locked for posting in period ${p.period}/${p.fiscalYear}.`, 'Unlock it (KS02), or take it out of the cycle.');
    names.set(centre, row.name);
    const company = row.company_code ? String(row.company_code).trim() : (all.length === 1 ? all[0]! : null);
    if (!company) fail(`Cost Centre ${centre} names no company code, and Controlling Area ${area} has several.`, 'Give the centre its company code (KS02).');
    companies.set(company, [...(companies.get(company) ?? []), centre]);
  }
  if (companies.size > 1) {
    fail(
      `Cycle ${p.cycleCode} spans company codes ${[...companies.keys()].sort().map((c) => `${c} (${companies.get(c)!.join(', ')})`).join('; ')}; one assessment document belongs to one company, and no cross-company clearing account stands.`,
      'Split the cycle by company code.',
    );
  }
  const companyCode = [...companies.keys()][0]!;
  const company = await getCompanyCode(tx, p.client, companyCode);
  if (!company?.chartOfAccounts || !company.fiscalYearVariant || !company.postingPeriodVariant) {
    fail(`Company code ${companyCode} is missing its chart of accounts, fiscal year variant or posting period variant.`, 'Complete it in Company Codes (CFG.ORG.COMPANYCODE.DEFINE).');
  }
  const companyCurrency = String(company.currency).trim();
  if (companyCurrency !== context.currency) {
    fail(`Company code ${companyCode} keeps its books in ${companyCurrency}, Controlling Area ${area} in ${context.currency}; an assessment does not convert currencies.`, 'Assess within a company whose currency is the controlling area\'s.');
  }

  // The period: the last day, as the posting engine will derive it, and open.
  const postingDate = window.end;
  const position = await derivePosition(tx, p.client, company.fiscalYearVariant, postingDate);
  if (position.fiscalYear !== p.fiscalYear || position.period !== p.period) {
    fail(`Period ${p.period}/${p.fiscalYear} ends ${postingDate}, which company code ${companyCode} places in ${position.period}/${position.fiscalYear}.`, 'Assess an ordinary period of the company\'s fiscal year.');
  }
  const open = await checkPostingAllowed(tx, p.client, company.postingPeriodVariant, 'S', position);
  if (!open.allowed) fail(`Period ${p.period} of fiscal year ${p.fiscalYear} is closed for posting: ${open.reason}`, open.remedy ?? 'Open the period (FIN.CLOSE.PERIOD).');

  // The assessment account, named by the tenant for the company's chart.
  const det = (await tx.execute(sql`
    select gl_account from account_determination
     where client = ${p.client} and chart_of_accounts = ${company.chartOfAccounts} and event = ${ASSESSMENT_EVENT}
       and valuation_class = '' and general_modifier = '' limit 1
  `)) as unknown as Array<{ gl_account: string }>;
  if (!det[0]) {
    fail(`No account is determined for posting event ${ASSESSMENT_EVENT} in chart ${company.chartOfAccounts}.`, 'Name the assessment account at /config/account-determination.');
  }
  const account = det[0].gl_account;

  // The senders' net balance in the period, company currency, POSTED or REVERSED documents.
  const senders = [...senderSegment.keys()];
  const balances = (await tx.execute(sql`
    select l.cost_center, l.gl_account,
           sum(case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end)::text as net
      from journal_entry_line l
      join journal_entry e on e.client = l.client and e.company_code = l.company_code
                          and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
     where l.client = ${p.client} and l.company_code = ${companyCode}
       and e.fiscal_year = ${p.fiscalYear} and e.posting_period = ${p.period}
       and e.status in ('POSTED', 'REVERSED')
       and l.cost_center in (${list(senders)})
       and l.gl_account <> ${account}
     group by l.cost_center, l.gl_account
  `)) as unknown as Array<{ cost_center: string; gl_account: string; net: string }>;
  const costOf = (centre: string, segment: ResolvedSegment) => balances
    .filter((b) => b.cost_center === centre && (segment.costElementFrom === null || (b.gl_account >= segment.costElementFrom && b.gl_account <= segment.costElementTo!)))
    .reduce((s, b) => s + toScaled(b.net), 0n);

  const decimalRows = (await tx.execute(sql`select decimal_places from currency where code = ${context.currency} limit 1`)) as unknown as Array<{ decimal_places: number }>;
  const pass = allocatePass(resolved, costOf, decimalRows[0] ? Number(decimalRows[0].decimal_places) : 2);
  for (const r of pass) {
    const negative = r.senders.find((x) => x.amount < 0n);
    if (negative) {
      fail(`Cost Centre ${negative.centre} carries a net credit of ${fromScaled(-negative.amount)} in period ${p.period}/${p.fiscalYear} (segment ${r.segment.segmentNumber}); there is no cost to assess and nothing to carry the arrears.`, 'Check the period\'s postings on the centre, or take it out of the cycle.');
    }
  }
  const total = pass.reduce((s, r) => s + r.total, 0n);
  if (total === 0n) {
    fail(`Cycle ${p.cycleCode} finds no assessable cost in period ${p.period}/${p.fiscalYear}: its senders carry no net cost.`, 'Run a period in which the senders carry cost.');
  }

  const preview: AssessmentPreview = {
    controllingArea: area, cycleCode: p.cycleCode, fiscalYear: p.fiscalYear, period: p.period, postingDate,
    companyCode, currency: context.currency, assessmentAccount: account, assessedTotal: fromScaled(total), iterations: 1,
    segments: pass.map((r) => ({
      segmentNumber: r.segment.segmentNumber, name: r.segment.name, receiverRule: r.segment.receiverRule, total: fromScaled(r.total),
      senders: r.senders.map((x) => ({ costCenter: x.centre, name: names.get(x.centre) ?? '', amount: fromScaled(x.amount) })),
      receivers: r.segment.receivers.map((x, i) => ({ costCenter: x.costCenter, name: names.get(x.costCenter) ?? '', amount: r.shares[i]!, weight: x.weight })),
    })),
  };

  // The document: every line on the assessment account, every line with its cost centre.
  const label = p.cycleCode.slice(0, 18);
  const lines: GlDocumentLineInput[] = [];
  for (const s of preview.segments) {
    for (const x of s.senders) {
      if (toScaled(x.amount) > 0n) lines.push({ glAccount: account, debitCredit: 'H', amount: x.amount, costCenter: x.costCenter, assignment: label, lineText: s.name.slice(0, 50) });
    }
    for (const x of s.receivers) {
      if (toScaled(x.amount) > 0n) lines.push({ glAccount: account, debitCredit: 'S', amount: x.amount, costCenter: x.costCenter, assignment: label, lineText: (x.name || x.costCenter).slice(0, 50) });
    }
  }
  const totals = computeTotals(lines);
  if (totals.debit !== totals.credit) fail(`The assessment does not balance: debits ${totals.debit}, credits ${totals.credit}.`, 'This is a defect, not a data problem; report it.');
  return { preview, lines, counts: { segments: preview.segments.length, senders: senders.length, receivers: new Set(resolved.flatMap((s) => s.receivers.map((r) => r.costCenter))).size } };
}

function translate(error: unknown): never {
  if (error instanceof GlDocumentError || error instanceof PostingError || error instanceof NumberRangeError) throw new AllocationCycleError(error.message, (error as { remedy?: string }).remedy);
  if (error instanceof PeriodError) throw new AllocationCycleError(error.message, error.remedy);
  throw error;
}

/** Everything a run would post, without posting. */
export async function previewAssessment(raw: RunAssessmentInput, options: Authority = {}): Promise<AssessmentPreview> {
  const p = parse(runSchema, raw);
  try {
    return await withTenant(p.client, async (tx) => {
      await judge(tx, p.client, p.controllingArea, options.authorization, ALLOCATION_EXECUTE_CAPABILITY);
      return (await prepare(tx, p)).preview;
    });
  } catch (error) {
    return translate(error);
  }
}

/** Run an assessment cycle for one period: one AL document, and its run row, together. */
export async function runAssessment(raw: RunAssessmentInput, options: Authority = {}): Promise<AssessmentRunView> {
  const p = parse(runSchema, raw);
  try {
    return await withTenant(p.client, async (tx) => {
      await judge(tx, p.client, p.controllingArea, options.authorization, ALLOCATION_EXECUTE_CAPABILITY);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`allocation:${p.client}:${p.controllingArea}:${p.cycleCode}:${p.fiscalYear}:${p.period}`}, 0))`);
      const { preview, lines, counts } = await prepare(tx, p);
      // A re-run after a cancelled run must not replay the old document: the key counts the runs.
      const prior = (await tx.execute(sql`
        select count(*)::int as n from cost_allocation_run
         where client = ${p.client} and controlling_area = ${p.controllingArea} and cycle_code = ${p.cycleCode}
           and fiscal_year = ${p.fiscalYear} and period = ${p.period}
      `)) as unknown as Array<{ n: number }>;
      const attempt = Number(prior[0]?.n ?? 0) + 1;
      const requestKey = `ALLOC-${p.cycleCode}-${p.fiscalYear}-${p.period}${attempt > 1 ? `-${attempt}` : ''}`;
      const runId = randomUUID();
      const posted = await postGlDocument({
        client: p.client,
        changedBy: p.changedBy,
        requestKey,
        companyCode: preview.companyCode,
        documentDate: preview.postingDate,
        postingDate: preview.postingDate,
        documentType: ALLOCATION_DOCUMENT_TYPE,
        currency: preview.currency,
        reference: `AL-${p.cycleCode}-${p.period}`.slice(0, 16),
        headerText: `Assessment ${p.cycleCode} ${p.fiscalYear}/${p.period}`.slice(0, 25),
        lines,
        onPosted: async (inner, document) => {
          const now = new Date();
          await inner.insert(costAllocationRun).values({
            client: p.client, runId, controllingArea: p.controllingArea, cycleCode: p.cycleCode,
            fiscalYear: p.fiscalYear, period: p.period, status: 'EXECUTED', currency: preview.currency,
            companyCode: preview.companyCode, assessmentAccount: preview.assessmentAccount, assessedTotal: preview.assessedTotal,
            segmentCount: counts.segments, senderCount: counts.senders, receiverCount: counts.receivers, iterations: 1,
            documentNumber: document.documentNumber, documentFiscalYear: document.fiscalYear, requestKey,
            executedBy: p.changedBy, executedAt: now, createdBy: p.changedBy,
          });
          await recordChange(inner, {
            client: p.client, objectClass: ALLOCATION_RUN_OBJECT_CLASS, objectKey: runId, changeType: 'CREATE',
            changedBy: p.changedBy, transactionCode: ALLOCATION_EXECUTE_CAPABILITY, reason: p.reason,
            after: { cycle: p.cycleCode, period: `${p.period}/${p.fiscalYear}`, document: document.documentNumber, assessedTotal: preview.assessedTotal },
          });
        },
      }, { tx, authorization: options.authorization });
      return { ...preview, runId, documentNumber: posted.documentNumber, displayNumber: posted.displayNumber, documentFiscalYear: posted.fiscalYear };
    });
  } catch (error) {
    return translate(error);
  }
}

/**
 * Cancel an executed run so the period can be assessed again. Refused unless its document stands
 * reversed: the ledger effect is undone by reversal, the run is only released.
 */
export async function cancelAssessmentRun(raw: CancelRunInput, options: Authority = {}): Promise<RunRow> {
  const p = parse(cancelSchema, raw);
  return withTenant(p.client, async (tx) => {
    const [run] = await tx.select().from(costAllocationRun).where(and(eq(costAllocationRun.client, p.client), eq(costAllocationRun.runId, p.runId))).limit(1);
    if (!run) fail(`Assessment run ${p.runId} does not exist.`);
    await judge(tx, p.client, run.controllingArea, options.authorization, ALLOCATION_EXECUTE_CAPABILITY);
    if (run.status === 'CANCELLED') fail(`Assessment run ${p.runId} is already cancelled.`);
    const doc = (await tx.execute(sql`
      select status from journal_entry where client = ${p.client} and company_code = ${run.companyCode}
         and document_number = ${run.documentNumber} and fiscal_year = ${run.documentFiscalYear}
    `)) as unknown as Array<{ status: string }>;
    if (doc[0]?.status !== 'REVERSED') {
      fail(`Assessment run ${p.runId} cannot be cancelled while its document ${run.documentNumber} stands ${doc[0]?.status ?? 'missing'}.`, 'Reverse the document first (FB08, /finance/document-reversal), then cancel the run.');
    }
    const now = new Date();
    await tx.update(costAllocationRun).set({ status: 'CANCELLED', cancelledBy: p.changedBy, cancelledAt: now, cancelReason: p.reason, changedBy: p.changedBy, changedAt: now })
      .where(and(eq(costAllocationRun.client, p.client), eq(costAllocationRun.runId, p.runId)));
    await recordChange(tx, {
      client: p.client, objectClass: ALLOCATION_RUN_OBJECT_CLASS, objectKey: p.runId, changeType: 'CHANGE',
      changedBy: p.changedBy, transactionCode: ALLOCATION_EXECUTE_CAPABILITY, reason: p.reason,
      before: { status: 'EXECUTED' }, after: { status: 'CANCELLED' },
    });
    return (await listRunsTx(tx, p.client, run.controllingArea)).find((r) => r.runId === p.runId)!;
  });
}

export interface RunRow {
  runId: string;
  cycleCode: string;
  fiscalYear: number;
  period: number;
  status: string;
  assessedTotal: string;
  currency: string;
  documentNumber: string;
  displayNumber: string;
  iterations: number;
  executedBy: string;
  executedAt: string;
  cancelReason: string | null;
}

async function listRunsTx(tx: Tx, client: string, area: string): Promise<RunRow[]> {
  const rows = (await tx.execute(sql`
    select r.*, coalesce(nullif(e.display_number, ''), r.document_number) as display_number
      from cost_allocation_run r
      left join journal_entry e on e.client = r.client and e.company_code = r.company_code
                               and e.document_number = r.document_number and e.fiscal_year = r.document_fiscal_year
     where r.client = ${client} and r.controlling_area = ${area}
     order by r.fiscal_year desc, r.period desc, r.cycle_code, r.executed_at desc
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    runId: String(r.run_id), cycleCode: String(r.cycle_code), fiscalYear: Number(r.fiscal_year), period: Number(r.period),
    status: String(r.status), assessedTotal: String(r.assessed_total), currency: String(r.currency).trim(),
    documentNumber: String(r.document_number), displayNumber: String(r.display_number), iterations: Number(r.iterations),
    executedBy: String(r.executed_by), executedAt: r.executed_at instanceof Date ? r.executed_at.toISOString() : String(r.executed_at),
    cancelReason: (r.cancel_reason as string | null) ?? null,
  }));
}

export async function listRuns(client: string, controllingArea: string): Promise<RunRow[]> {
  return withTenant(client, (tx) => listRunsTx(tx, client, controllingArea.toUpperCase()));
}
