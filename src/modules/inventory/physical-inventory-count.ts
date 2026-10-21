/**
 * Physical inventory count entry — SCR-147 / MI04 (INV.PHYINV.COUNT).
 *
 * A count records what a person saw. It posts nothing: no material document, no journal, no stock
 * balance moves, and the difference it computes is a number held for MI20 to review and MI07 to
 * post. That is the whole distinction this module exists to keep, and the package states it three
 * times in three sections.
 *
 * Two decisions from the contract are load-bearing here and are repeated at the points they act:
 *
 *   · **Zero is a state, not a number.** `countedQuantity` stays null until somebody counts; a
 *     zero-count line carries the flag and a real zero. A null is "nobody has looked".
 *   · **The book quantity is frozen, not re-read.** MI01 stores it with the basis it was taken on;
 *     a correction recomputes the difference against that same snapshot, so a count cannot drift
 *     into measuring itself against stock that moved after it.
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { changeHistory, recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { material, physicalInventoryDocument, physicalInventoryItem } from './schema';
import { toBaseQuantity, UnitConversionError } from './unit-conversion';
import { recomputePostingStatus } from './physical-inventory-posting-status';

export const PHYSICAL_INVENTORY_COUNT_CAPABILITY = 'INV.PHYINV.COUNT';
export const PHYSICAL_INVENTORY_COUNT_CORRECT_CAPABILITY = 'INV.PHYINV.COUNT.CORRECT';
export const PHYSICAL_INVENTORY_COUNT_ROUTE = '/inventory/physical-inventory-count';
export const PHYSICAL_INVENTORY_COUNT_ALIASES = ['MI04'] as const;

/** Statuses in which a count may still be entered or corrected (§15/§16). */
const COUNTABLE_STATUSES = ['CREATED', 'PARTIALLY_COUNTED', 'COUNTED', 'PARTIALLY_POSTED'] as const;

const ITEM_OBJECT_CLASS = 'physical_inventory_item';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class PhysicalInventoryCountError extends Error {
  readonly remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'PhysicalInventoryCountError';
    this.remedy = remedy;
  }
}

const round3 = (value: number) => Math.round((value + Number.EPSILON) * 1000) / 1000;

/** The wire shape, judged at the boundary (§19). The service judges the business behind it. */
const lineSchema = z.object({
  itemNumber: z.number().int().positive(),
  /** Absent with `zeroCount` set means "counted, and it was zero". Absent with neither is refused. */
  quantity: z.number().finite().nonnegative().optional(),
  entryUnit: z.string().trim().max(16).optional(),
  zeroCount: z.boolean().optional(),
  countDate: z.string().regex(ISO_DATE, 'is not a date').optional(),
  itemText: z.string().trim().max(60).optional(),
  /** §13: the version the counter read. A stale submission is refused, never silently applied. */
  expectedVersion: z.number().int().positive().optional(),
});

const submissionSchema = z.object({
  documentNumber: z.string().trim().min(1).max(24),
  fiscalYear: z.number().int().min(2000).max(2999),
  countDate: z.string().regex(ISO_DATE, 'is not a date'),
  counterName: z.string().trim().max(35).optional(),
  requestKey: z.string().trim().min(1).max(64),
  reason: z.string().trim().max(200).optional(),
  lines: z.array(lineSchema).min(1).max(500),
});

export interface SubmitCountsInput {
  client: string;
  changedBy: string;
  documentNumber: string;
  fiscalYear: number;
  countDate: string;
  counterName?: string;
  requestKey: string;
  reason?: string;
  lines: Array<{
    itemNumber: number;
    quantity?: number;
    entryUnit?: string;
    zeroCount?: boolean;
    countDate?: string;
    itemText?: string;
    expectedVersion?: number;
  }>;
}

export interface CountItemView {
  itemNumber: number;
  materialNumber: string;
  description: string;
  stockType: string;
  plant: string;
  storageLocation: string | null;
  bookQuantity: string;
  bookUnit: string;
  bookBasis: string | null;
  baseUnit: string;
  countedQuantity: string | null;
  entryUnit: string | null;
  baseQuantity: string | null;
  zeroCount: boolean;
  differenceQuantity: string | null;
  countStatus: string;
  countDate: string | null;
  counterName: string | null;
  itemText: string | null;
  version: number;
}

export interface CountStatusSummary {
  items: number;
  counted: number;
  uncounted: number;
  recountRequired: number;
  uncountedItems: number[];
}

export interface CountDocumentView {
  documentNumber: string;
  fiscalYear: number;
  companyCode: string;
  plant: string;
  storageLocation: string | null;
  plannedCountDate: string;
  postingBlock: boolean;
  status: string;
  version: number;
  /** §15: whether a count may be entered now, and if not, why in the words a person needs. */
  eligible: boolean;
  ineligibleReason: string | null;
  counts: CountStatusSummary;
  items: CountItemView[];
}

interface ItemRow {
  itemNumber: number;
  materialNumber: string;
  stockType: string;
  countedQuantity: string | null;
  entryUnit: string | null;
  countedBaseQuantity: string | null;
  zeroCountFlag: boolean;
  counterName: string | null;
  countDate: string | null;
  bookQuantitySnapshot: string | null;
  bookQuantityUnit: string | null;
  bookQuantityBasis: string | null;
  differenceQuantity: string | null;
  countStatus: string;
  postingStatus: string;
  itemText: string | null;
  version: number;
}

function summaryOf(items: ItemRow[]): CountStatusSummary {
  const counted = items.filter((i) => i.countStatus === 'COUNTED').length;
  const recount = items.filter((i) => i.countStatus === 'RECOUNT_REQUIRED').length;
  return {
    items: items.length,
    counted,
    uncounted: items.length - counted - recount,
    recountRequired: recount,
    uncountedItems: items.filter((i) => i.countStatus === 'UNCOUNTED').map((i) => i.itemNumber),
  };
}

/** The header status a document deserves, from its items alone (§15: never from one item). */
function statusOf(items: ItemRow[]): string {
  if (items.length === 0) return 'CREATED';
  const counted = items.filter((i) => i.countStatus === 'COUNTED').length;
  if (counted === 0) return 'CREATED';
  if (counted === items.length) return 'COUNTED';
  return 'PARTIALLY_COUNTED';
}

function requireDate(value: string, label: string): string {
  const trimmed = value.trim();
  if (!ISO_DATE.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    throw new PhysicalInventoryCountError(
      `${label} ${value || '(empty)'} is not a date.`,
      'Enter the date as YYYY-MM-DD.',
    );
  }
  return trimmed;
}

/**
 * §17: the count date is not a posting date.
 *
 * A count of last month's stock is a legitimate correction of the record even when the financial
 * period is closed — counting and posting a difference are separate events — so the FI period is
 * not consulted here. That judgement belongs to MI07, at its own posting date. What is refused is
 * a count date in the future: nobody has counted stock that has not happened yet.
 */
function judgeCountDate(value: string, label: string, today: string): string {
  const date = requireDate(value, label);
  if (date > today) {
    throw new PhysicalInventoryCountError(
      `${label} ${date} lies in the future.`,
      'Count what stands on the day the count is taken.',
    );
  }
  return date;
}

async function loadDocument(
  tx: Tx, client: string, documentNumber: string, fiscalYear: number,
) {
  const [header] = await tx.select().from(physicalInventoryDocument).where(and(
    eq(physicalInventoryDocument.client, client),
    eq(physicalInventoryDocument.inventoryDocumentNumber, documentNumber),
    eq(physicalInventoryDocument.fiscalYear, fiscalYear),
  ));
  return header ?? null;
}

async function loadItems(
  tx: Tx, client: string, documentNumber: string, fiscalYear: number,
): Promise<ItemRow[]> {
  const rows = await tx.select().from(physicalInventoryItem).where(and(
    eq(physicalInventoryItem.client, client),
    eq(physicalInventoryItem.inventoryDocumentNumber, documentNumber),
    eq(physicalInventoryItem.fiscalYear, fiscalYear),
  )).orderBy(physicalInventoryItem.itemNumber);
  return rows as unknown as ItemRow[];
}

function ineligibleReasonFor(status: string): string | null {
  if ((COUNTABLE_STATUSES as readonly string[]).includes(status)) return null;
  if (status === 'CANCELLED') {
    return 'The count document was cancelled, so it carries no quantities to answer for.';
  }
  if (status === 'POSTED') {
    return 'The differences for this document have been posted; a posted count is corrected by the controlled reversal or recount workflow, not by editing it here.';
  }
  if (status === 'DIFFERENCES_REVIEWED') {
    return 'The differences for this document have been reviewed and closed; reopen the review before correcting the count.';
  }
  return `The document stands in status ${status}, which does not permit count entry.`;
}

/** What the count screen reads: the document, its items, and where the count has got to. */
export async function getCountDocument(
  client: string,
  keys: { documentNumber: string; fiscalYear: number },
): Promise<CountDocumentView | null> {
  return withTenant(client, async (tx) => viewOf(tx, client, keys.documentNumber, keys.fiscalYear));
}

async function viewOf(
  tx: Tx, client: string, documentNumber: string, fiscalYear: number,
): Promise<CountDocumentView | null> {
  const header = await loadDocument(tx, client, documentNumber, fiscalYear);
  if (!header) return null;
  const items = await loadItems(tx, client, documentNumber, fiscalYear);

  const plantRows = await tx.execute(sql`
    select company_code from plant where client = ${client} and plant = ${header.plant}
  `) as unknown as Array<{ company_code: string }>;
  const companyCode = plantRows[0]?.company_code ?? '';

  const described: CountItemView[] = [];
  for (const item of items) {
    const [master] = await tx.select({
      description: material.description, baseUnit: material.baseUnit,
    }).from(material).where(and(
      eq(material.client, client), eq(material.materialNumber, item.materialNumber),
    ));
    const baseUnit = master?.baseUnit ?? item.bookQuantityUnit ?? '';
    described.push({
      itemNumber: item.itemNumber,
      materialNumber: item.materialNumber,
      description: master?.description ?? '',
      stockType: item.stockType,
      plant: header.plant,
      storageLocation: header.storageLocation,
      bookQuantity: item.bookQuantitySnapshot ?? '0',
      bookUnit: item.bookQuantityUnit ?? baseUnit,
      bookBasis: item.bookQuantityBasis,
      baseUnit,
      countedQuantity: item.countedQuantity,
      entryUnit: item.entryUnit,
      baseQuantity: item.countedBaseQuantity,
      zeroCount: item.zeroCountFlag,
      differenceQuantity: item.differenceQuantity,
      countStatus: item.countStatus,
      countDate: item.countDate,
      counterName: item.counterName,
      itemText: item.itemText,
      version: item.version,
    });
  }

  return {
    documentNumber: header.inventoryDocumentNumber,
    fiscalYear: header.fiscalYear,
    companyCode,
    plant: header.plant,
    storageLocation: header.storageLocation,
    plannedCountDate: header.plannedCountDate,
    postingBlock: header.postingBlock,
    status: header.status,
    version: header.version,
    eligible: ineligibleReasonFor(header.status) === null,
    ineligibleReason: ineligibleReasonFor(header.status),
    counts: summaryOf(items),
    items: described,
  };
}

export interface CountDocumentRow {
  documentNumber: string;
  fiscalYear: number;
  plant: string;
  storageLocation: string | null;
  plannedCountDate: string;
  status: string;
  postingBlock: boolean;
  counts: CountStatusSummary;
}

/** §19.1 — search. Tenant-scoped by construction, optionally narrowed by plant or status. */
export async function searchCountDocuments(
  client: string,
  filter: { plant?: string; status?: string } = {},
): Promise<CountDocumentRow[]> {
  return withTenant(client, async (tx) => {
    const headers = await tx.select().from(physicalInventoryDocument).where(and(
      eq(physicalInventoryDocument.client, client),
      filter.plant ? eq(physicalInventoryDocument.plant, filter.plant) : sql`true`,
      filter.status ? eq(physicalInventoryDocument.status, filter.status) : sql`true`,
    )).orderBy(physicalInventoryDocument.inventoryDocumentNumber);

    const rows: CountDocumentRow[] = [];
    for (const header of headers) {
      const items = await loadItems(tx, client, header.inventoryDocumentNumber, header.fiscalYear);
      rows.push({
        documentNumber: header.inventoryDocumentNumber,
        fiscalYear: header.fiscalYear,
        plant: header.plant,
        storageLocation: header.storageLocation,
        plannedCountDate: header.plannedCountDate,
        status: header.status,
        postingBlock: header.postingBlock,
        counts: summaryOf(items),
      });
    }
    return rows;
  });
}

/** The book quantity for an item that carries no snapshot — measured now, and said to be. */
async function liveBookQuantity(
  tx: Tx, client: string, header: { plant: string; storageLocation: string | null },
  item: ItemRow,
): Promise<{ quantity: number; unit: string }> {
  const rows = await tx.execute(sql`
    select coalesce(sum(s.quantity), 0)::text as quantity, min(m.base_unit) as unit
      from stock_quantity s
      join material m on m.client = s.client and m.material_number = s.material_number
     where s.client = ${client} and s.material_number = ${item.materialNumber}
       and s.plant = ${header.plant} and s.stock_type = ${item.stockType}
       and (${header.storageLocation}::text is null or s.storage_location = ${header.storageLocation}::text)
  `) as unknown as Array<{ quantity: string; unit: string }>;
  return { quantity: Number(rows[0]?.quantity ?? 0), unit: rows[0]?.unit ?? '' };
}

/**
 * Submit one or more counts (§12/§13).
 *
 * One transaction: the header and its items are locked in a fixed order, every line is judged
 * before any is written, and a single bad line takes the whole submission with it. Nothing here
 * writes stock, a material document or a journal — a test reads all three back afterwards.
 */
export async function submitCounts(input: SubmitCountsInput): Promise<CountDocumentView> {
  const parsed = submissionSchema.safeParse({
    documentNumber: input.documentNumber,
    fiscalYear: input.fiscalYear,
    countDate: input.countDate,
    counterName: input.counterName,
    requestKey: input.requestKey,
    reason: input.reason,
    lines: input.lines,
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new PhysicalInventoryCountError(
      `The count submission is not valid: ${first.path.join('.') || 'payload'} ${first.message}.`,
      'Correct the line and submit again.',
    );
  }
  const submission = parsed.data;
  const today = new Date().toISOString().slice(0, 10);
  const countDate = judgeCountDate(submission.countDate, 'The count date', today);

  // Duplicate item numbers would make the second silently win; refuse before the lock.
  const seen = new Set<number>();
  for (const line of submission.lines) {
    if (seen.has(line.itemNumber)) {
      throw new PhysicalInventoryCountError(
        `Item ${line.itemNumber} appears twice in one submission.`,
        'Submit each item once.',
      );
    }
    seen.add(line.itemNumber);
    if (line.zeroCount && line.quantity !== undefined && line.quantity > 0) {
      throw new PhysicalInventoryCountError(
        `Item ${line.itemNumber} is submitted as a zero count and as ${line.quantity} at once.`,
        'A zero count is a count of zero; clear the quantity or the flag.',
      );
    }
    if (!line.zeroCount && line.quantity === undefined) {
      throw new PhysicalInventoryCountError(
        `Item ${line.itemNumber} carries no quantity and no zero count.`,
        'Enter the counted quantity, or record an explicit zero.',
      );
    }
  }

  return withTenant(input.client, async (tx) => {
    // Header first, then items in a fixed order, so two counters serialise instead of deadlocking.
    await tx.execute(sql`
      select 1 from physical_inventory_document
       where client = ${input.client} and inventory_document_number = ${submission.documentNumber}
         and fiscal_year = ${submission.fiscalYear}
       for update
    `);
    const header = await loadDocument(tx, input.client, submission.documentNumber, submission.fiscalYear);
    if (!header) {
      throw new PhysicalInventoryCountError(
        `Physical inventory document ${submission.documentNumber} for fiscal year ${submission.fiscalYear} does not exist.`,
        'Check the document number and the fiscal year.',
      );
    }
    const blocked = ineligibleReasonFor(header.status);
    if (blocked) throw new PhysicalInventoryCountError(blocked);

    await tx.execute(sql`
      select 1 from physical_inventory_item
       where client = ${input.client} and inventory_document_number = ${submission.documentNumber}
         and fiscal_year = ${submission.fiscalYear}
       order by item_number
       for update
    `);
    const items = await loadItems(tx, input.client, submission.documentNumber, submission.fiscalYear);
    const byNumber = new Map(items.map((i) => [i.itemNumber, i]));

    // Judge everything before writing anything: a bulk submission lands whole or not at all.
    const judged: Array<{
      item: ItemRow;
      baseQuantity: number;
      entryUnit: string;
      entryQuantity: number;
      zero: boolean;
      date: string;
      bookQuantity: number;
      bookUnit: string;
      bookBasis: string | null;
      difference: number;
      itemText: string | null;
    }> = [];

    for (const line of submission.lines) {
      const item = byNumber.get(line.itemNumber);
      if (!item) {
        throw new PhysicalInventoryCountError(
          `Item ${line.itemNumber} does not belong to document ${submission.documentNumber}.`,
          'Count the items the document carries.',
        );
      }
      if (item.countStatus === 'RECOUNT_REQUIRED') {
        throw new PhysicalInventoryCountError(
          `Item ${item.itemNumber} is marked for recount, which this round does not carry.`,
          'Clear the recount requirement, then count the item.',
        );
      }
      if (item.postingStatus === 'POSTED') {
        const postedZero = line.zeroCount === true;
        const postedQuantity = postedZero ? 0 : Number(line.quantity);
        const storedQuantity = item.countedQuantity === null ? null : Number(item.countedQuantity);
        const unchanged = postedZero === item.zeroCountFlag
          && storedQuantity !== null
          && Math.abs(storedQuantity - postedQuantity) <= 0.0005;
        // The count form resubmits every filled row. An unchanged posted row is not an edit, and
        // refusing it would make a remaining uncounted item unreachable once anything is posted.
        if (!unchanged) {
          throw new PhysicalInventoryCountError(
            `Item ${item.itemNumber} has had its difference posted, and a posted count is not edited here.`,
            'Reverse the posting, then count again. This screen does not post and does not reverse.',
          );
        }
        continue;
      }
      const [master] = await tx.select({ baseUnit: material.baseUnit }).from(material).where(and(
        eq(material.client, input.client), eq(material.materialNumber, item.materialNumber),
      ));
      const baseUnit = master?.baseUnit ?? '';
      if (!baseUnit) {
        throw new PhysicalInventoryCountError(
          `Material ${item.materialNumber} carries no base unit, so a count cannot be expressed in it.`,
          'Complete the material master, then count.',
        );
      }

      const zero = line.zeroCount === true;
      const entryQuantity = zero ? 0 : Number(line.quantity);
      const entryUnit = (line.entryUnit ?? baseUnit).trim() || baseUnit;

      let baseQuantity = entryQuantity;
      if (entryUnit !== baseUnit) {
        try {
          const converted = await toBaseQuantity(tx, input.client, {
            materialNumber: item.materialNumber, quantity: entryQuantity, entryUnit,
          });
          baseQuantity = converted.baseQuantity;
        } catch (caught) {
          if (caught instanceof UnitConversionError) {
            throw new PhysicalInventoryCountError(caught.message, caught.remedy);
          }
          throw caught;
        }
      }
      baseQuantity = round3(baseQuantity);

      if (line.expectedVersion !== undefined && line.expectedVersion !== item.version) {
        throw new PhysicalInventoryCountError(
          `Item ${item.itemNumber} was changed after you read it: it now stands at version ${item.version}` +
            `${item.countedQuantity !== null ? `, counted ${Number(item.countedBaseQuantity ?? 0).toFixed(3)} ${baseUnit}` : ', uncounted'}.`,
          'Read the count again and submit the quantity you intend.',
        );
      }

      // §11: the frozen book quantity, never today's stock. A document that predates SCR-147 has
      // no snapshot, so it is measured once, here, and the basis says so.
      let bookQuantity = Number(item.bookQuantitySnapshot ?? 0);
      let bookUnit = item.bookQuantityUnit ?? baseUnit;
      let bookBasis = item.bookQuantityBasis;
      if (item.bookQuantitySnapshot === null) {
        const live = await liveBookQuantity(tx, input.client, header, item);
        bookQuantity = round3(live.quantity);
        bookUnit = live.unit || baseUnit;
        bookBasis = 'COUNT_TIME';
      }

      judged.push({
        item, baseQuantity, entryUnit, entryQuantity, zero,
        date: judgeCountDate(line.countDate ?? countDate, `The count date of item ${item.itemNumber}`, today),
        bookQuantity, bookUnit, bookBasis,
        difference: round3(baseQuantity - bookQuantity),
        itemText: line.itemText ?? item.itemText ?? null,
      });
    }

    // From here on everything is a write; the transaction is the boundary (§12.14).
    for (const row of judged) {
      await tx.update(physicalInventoryItem).set({
        countedQuantity: row.entryQuantity.toFixed(3),
        entryUnit: row.entryUnit,
        countedBaseQuantity: row.baseQuantity.toFixed(3),
        zeroCountFlag: row.zero,
        countDate: row.date,
        counterName: submission.counterName ?? null,
        bookQuantitySnapshot: row.bookQuantity.toFixed(3),
        bookQuantityUnit: row.bookUnit,
        bookQuantityBasis: row.bookBasis,
        differenceQuantity: row.difference.toFixed(3),
        countStatus: 'COUNTED',
        itemText: row.itemText,
        version: row.item.version + 1,
        changedBy: input.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(physicalInventoryItem.client, input.client),
        eq(physicalInventoryItem.inventoryDocumentNumber, submission.documentNumber),
        eq(physicalInventoryItem.fiscalYear, submission.fiscalYear),
        eq(physicalInventoryItem.itemNumber, row.item.itemNumber),
      ));

      await recordChange(tx, {
        client: input.client,
        objectClass: ITEM_OBJECT_CLASS,
        objectKey: `${submission.documentNumber}/${submission.fiscalYear}/${row.item.itemNumber}`,
        changeType: row.item.countStatus === 'COUNTED' ? 'CHANGE' : 'CREATE',
        changedBy: input.changedBy,
        transactionCode: PHYSICAL_INVENTORY_COUNT_CAPABILITY,
        reason: submission.reason,
        correlationId: submission.requestKey,
        before: row.item.countStatus === 'COUNTED' ? {
          countedQuantity: row.item.countedQuantity,
          entryUnit: row.item.entryUnit,
          countedBaseQuantity: row.item.countedBaseQuantity,
          zeroCountFlag: row.item.zeroCountFlag,
          countDate: row.item.countDate,
          counterName: row.item.counterName,
          differenceQuantity: row.item.differenceQuantity,
          countStatus: row.item.countStatus,
        } : undefined,
        after: {
          countedQuantity: row.entryQuantity.toFixed(3),
          entryUnit: row.entryUnit,
          countedBaseQuantity: row.baseQuantity.toFixed(3),
          zeroCountFlag: row.zero,
          countDate: row.date,
          counterName: submission.counterName ?? null,
          bookQuantitySnapshot: row.bookQuantity.toFixed(3),
          differenceQuantity: row.difference.toFixed(3),
          countStatus: 'COUNTED',
        },
        fieldLabels: {
          countedQuantity: 'Counted quantity',
          countedBaseQuantity: 'Counted (base unit)',
          differenceQuantity: 'Provisional difference',
          zeroCountFlag: 'Zero count',
          countStatus: 'Count status',
          counterName: 'Counter',
          countDate: 'Count date',
        },
      });
    }

    // §15: the header follows all its items, never the one that was just counted.
    const after = await loadItems(tx, input.client, submission.documentNumber, submission.fiscalYear);
    if (after.some((item) => item.postingStatus === 'POSTED') || header.status === 'PARTIALLY_POSTED' || header.status === 'POSTED') {
      await recomputePostingStatus(tx, input.client, submission.documentNumber, submission.fiscalYear, input.changedBy);
    } else {
    const nextStatus = statusOf(after);
    if (nextStatus !== header.status) {
      await tx.update(physicalInventoryDocument).set({
        status: nextStatus,
        version: header.version + 1,
        changedBy: input.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(physicalInventoryDocument.client, input.client),
        eq(physicalInventoryDocument.inventoryDocumentNumber, submission.documentNumber),
        eq(physicalInventoryDocument.fiscalYear, submission.fiscalYear),
      ));
      await recordChange(tx, {
        client: input.client,
        objectClass: 'physical_inventory_document',
        objectKey: `${submission.documentNumber}/${submission.fiscalYear}`,
        changeType: 'CHANGE',
        changedBy: input.changedBy,
        transactionCode: PHYSICAL_INVENTORY_COUNT_CAPABILITY,
        reason: submission.reason,
        correlationId: submission.requestKey,
        before: { status: header.status },
        after: { status: nextStatus },
        fieldLabels: { status: 'Document status' },
      });
    }

    }
    return (await viewOf(tx, input.client, submission.documentNumber, submission.fiscalYear))!;
  });
}

export interface ClearCountInput {
  client: string;
  changedBy: string;
  documentNumber: string;
  fiscalYear: number;
  itemNumber: number;
  reason: string;
  requestKey: string;
  expectedVersion?: number;
}

/**
 * Clear an erroneous count (§16, §5).
 *
 * The item returns to `UNCOUNTED` — not to zero — and the history keeps the quantity that was
 * cleared, because a correction that erases its own evidence is not an audit trail.
 */
export async function clearCount(input: ClearCountInput): Promise<CountDocumentView> {
  if (!input.reason.trim()) {
    throw new PhysicalInventoryCountError(
      'Clearing a count needs a reason.',
      'State why the count is being cleared; the audit trail keeps it.',
    );
  }
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`
      select 1 from physical_inventory_document
       where client = ${input.client} and inventory_document_number = ${input.documentNumber}
         and fiscal_year = ${input.fiscalYear}
       for update
    `);
    const header = await loadDocument(tx, input.client, input.documentNumber, input.fiscalYear);
    if (!header) {
      throw new PhysicalInventoryCountError(
        `Physical inventory document ${input.documentNumber} for fiscal year ${input.fiscalYear} does not exist.`,
      );
    }
    const blocked = ineligibleReasonFor(header.status);
    if (blocked) throw new PhysicalInventoryCountError(blocked);

    const items = await loadItems(tx, input.client, input.documentNumber, input.fiscalYear);
    const item = items.find((i) => i.itemNumber === input.itemNumber);
    if (!item) {
      throw new PhysicalInventoryCountError(
        `Item ${input.itemNumber} does not belong to document ${input.documentNumber}.`,
      );
    }
    if (item.countStatus !== 'COUNTED') {
      throw new PhysicalInventoryCountError(
        `Item ${item.itemNumber} carries no count to clear.`,
        'Only a counted item can be cleared.',
      );
    }
    if (item.postingStatus === 'POSTED') {
      throw new PhysicalInventoryCountError(
        `Item ${item.itemNumber} has had its difference posted, and a posted count is not cleared here.`,
        'Reverse the posting first. Clearing a posted count would leave the ledger behind.',
      );
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== item.version) {
      throw new PhysicalInventoryCountError(
        `Item ${item.itemNumber} was changed after you read it: it now stands at version ${item.version}.`,
        'Read the count again before clearing it.',
      );
    }

    await tx.update(physicalInventoryItem).set({
      countedQuantity: null,
      entryUnit: null,
      countedBaseQuantity: null,
      zeroCountFlag: false,
      countDate: null,
      counterName: null,
      differenceQuantity: null,
      countStatus: 'UNCOUNTED',
      version: item.version + 1,
      changedBy: input.changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(physicalInventoryItem.client, input.client),
      eq(physicalInventoryItem.inventoryDocumentNumber, input.documentNumber),
      eq(physicalInventoryItem.fiscalYear, input.fiscalYear),
      eq(physicalInventoryItem.itemNumber, input.itemNumber),
    ));

    await recordChange(tx, {
      client: input.client,
      objectClass: ITEM_OBJECT_CLASS,
      objectKey: `${input.documentNumber}/${input.fiscalYear}/${input.itemNumber}`,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: PHYSICAL_INVENTORY_COUNT_CORRECT_CAPABILITY,
      reason: input.reason,
      correlationId: input.requestKey,
      before: {
        countedQuantity: item.countedQuantity,
        countedBaseQuantity: item.countedBaseQuantity,
        entryUnit: item.entryUnit,
        zeroCountFlag: item.zeroCountFlag,
        countDate: item.countDate,
        differenceQuantity: item.differenceQuantity,
        countStatus: item.countStatus,
      },
      after: { countedQuantity: null, countedBaseQuantity: null, countStatus: 'UNCOUNTED' },
      fieldLabels: {
        countedQuantity: 'Counted quantity',
        countedBaseQuantity: 'Counted (base unit)',
        countStatus: 'Count status',
      },
    });

    const after = await loadItems(tx, input.client, input.documentNumber, input.fiscalYear);
    if (after.some((item) => item.postingStatus === 'POSTED') || header.status === 'PARTIALLY_POSTED' || header.status === 'POSTED') {
      await recomputePostingStatus(tx, input.client, input.documentNumber, input.fiscalYear, input.changedBy);
    } else {
    const nextStatus = statusOf(after);
    if (nextStatus !== header.status) {
      await tx.update(physicalInventoryDocument).set({
        status: nextStatus,
        version: header.version + 1,
        changedBy: input.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(physicalInventoryDocument.client, input.client),
        eq(physicalInventoryDocument.inventoryDocumentNumber, input.documentNumber),
        eq(physicalInventoryDocument.fiscalYear, input.fiscalYear),
      ));
    }

    }
    return (await viewOf(tx, input.client, input.documentNumber, input.fiscalYear))!;
  });
}

export interface CountHistoryEntry {
  itemNumber: number;
  changedAt: Date;
  changedBy: string;
  changeType: string;
  reason: string | null;
  correlationId: string | null;
  fields: Array<{ field: string; fieldLabel: string; oldValue: string | null; newValue: string | null }>;
}

/** §19.6 — the count history, read from the change log rather than a second record of it. */
export async function getCountHistory(
  client: string,
  keys: { documentNumber: string; fiscalYear: number; itemNumber?: number },
): Promise<CountHistoryEntry[]> {
  return withTenant(client, async (tx) => {
    const itemNumbers = keys.itemNumber
      ? [keys.itemNumber]
      : (await loadItems(tx, client, keys.documentNumber, keys.fiscalYear)).map((i) => i.itemNumber);

    const entries: CountHistoryEntry[] = [];
    for (const itemNumber of itemNumbers) {
      const documents = await changeHistory(
        tx, client, ITEM_OBJECT_CLASS, `${keys.documentNumber}/${keys.fiscalYear}/${itemNumber}`,
      ) as unknown as Array<{
        changedAt: Date; changedBy: string; changeType: string; reason: string | null;
        correlationId: string | null;
        items: Array<{ fieldName: string; fieldLabel: string; oldValue: string | null; newValue: string | null }>;
      }>;
      for (const doc of documents) {
        entries.push({
          itemNumber,
          changedAt: doc.changedAt,
          changedBy: doc.changedBy,
          changeType: doc.changeType,
          reason: doc.reason,
          correlationId: doc.correlationId ?? null,
          fields: doc.items.map((field) => ({
            field: field.fieldName,
            fieldLabel: field.fieldLabel,
            oldValue: field.oldValue,
            newValue: field.newValue,
          })),
        });
      }
    }
    return entries.sort((a, b) => (a.changedAt < b.changedAt ? 1 : -1));
  });
}

/** §19.8 — the aggregate status and the items still owed a count. */
export async function getCountStatus(
  client: string,
  keys: { documentNumber: string; fiscalYear: number },
): Promise<CountStatusSummary | null> {
  return withTenant(client, async (tx) => {
    const header = await loadDocument(tx, client, keys.documentNumber, keys.fiscalYear);
    if (!header) return null;
    return summaryOf(await loadItems(tx, client, keys.documentNumber, keys.fiscalYear));
  });
}
