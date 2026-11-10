/**
 * Batch determination for sales — §5.5a.
 *
 * The question this answers is asked at the dock, not at a desk: **this delivery item is asking for
 * forty of a material, there are five batches of it in the store, and somebody has to take the
 * boxes off a shelf — which ones?**
 *
 * The package already carries a batch *search* strategy stack — condition tables, access sequences,
 * strategy types, allocations and strategies — and that stack is deliberately left alone. It answers
 * a different question. An operator in production asks *which batches match this characteristic*,
 * gets a list, and chooses from it. A picker in a warehouse does not choose: the delivery has
 * already committed to a quantity and the goods have to come from somewhere. Determination answers
 * that from stock, and it is driven by availability and by an order the tenant named rather than by
 * a characteristic somebody typed.
 *
 * Four things follow.
 *
 * **Nothing is seeded.** No rule is delivered, so a tenant that maintains none picks exactly as it
 * did the day before: with no batch named, as the picker has always done it. This is the same promise
 * the incompletion procedure makes (§5.1) and it is what lets a change like this be applied without
 * rejudging a single document.
 *
 * **A picker who names a batch keeps it.** Determination runs only where the pick names none. A clerk
 * who knows better than the rule is not overruled by it, and a correction to a pick is never
 * re-determined underneath the person making it.
 *
 * **A batch that is not free to use is not proposed.** A batch held in restricted use is a batch the
 * books will not let go, and proposing it would be promising stock that cannot be issued.
 *
 * **Determination is a proposal, not a commitment.** It reads stock as it stands at that instant. Two
 * pickers determining the same batch a second apart will be told the same thing, and the goods issue
 * is what decides — which is why nothing here writes a reservation.
 */
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';

import { type Tx, withTenant } from '../../platform/db/client';
import { batch, stockQuantity } from '../inventory/schema';
import { SORT_RULES, type SortRule } from './batch-sort-rules';

export const BATCH_DETERMINATION_ROUTE = '/config/batch-determination';
export const BATCH_DETERMINATION_CAPABILITY = 'CFG.SALES.BATCHDETERMINATION.DEFINE';

// The orders a tenant can name, and what each of them means, live in their own file so a client
// component can import them without taking the database driver with them.
export { SORT_RULES, SORT_RULE_MEANING, type SortRule } from './batch-sort-rules';

const key = (max: number) => z.string().trim().transform((s) => s.toUpperCase()).pipe(z.string().max(max));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.');

export const batchRuleInput = z.object({
  client: z.string().trim().length(4),
  changedBy: key(60),
  ruleNumber: key(10),
  name: z.string().trim().max(40).optional(),
  salesOrg: z.string().trim().max(4).optional(),
  distributionChannel: z.string().trim().max(2).optional(),
  customerNumber: z.string().trim().max(40).optional(),
  materialNumber: z.string().trim().max(40).optional(),
  plant: z.string().trim().max(10).optional(),
  sortRule: z.enum(SORT_RULES),
  isActive: z.boolean().optional(),
  validityFrom: isoDate,
  validityTo: isoDate,
});

export type BatchRuleInput = z.input<typeof batchRuleInput>;

export interface BatchRule {
  ruleNumber: string;
  name: string;
  salesOrg: string;
  distributionChannel: string;
  customerNumber: string;
  materialNumber: string;
  plant: string;
  sortRule: SortRule;
  isActive: boolean;
  validityFrom: string;
  validityTo: string;
}

export class BatchDeterminationError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'BatchDeterminationError';
    this.remedy = remedy;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Maintaining a rule
// ─────────────────────────────────────────────────────────────────────────────

/** The table, imported lazily so the module does not carry the sales schema where it is not wanted. */
async function ruleTable() {
  return (await import('./schema')).salesBatchDeterminationRule;
}

export async function saveBatchDeterminationRule(
  input: BatchRuleInput,
): Promise<{ ruleNumber: string; created: boolean }> {
  const parsed = batchRuleInput.parse(input);
  if (parsed.validityTo < parsed.validityFrom) {
    throw new BatchDeterminationError(
      `A rule stands from ${parsed.validityFrom} to ${parsed.validityTo}, and it cannot end before it begins.`,
      'Name the period the rule answers for.',
    );
  }
  const table = await ruleTable();
  const values = {
    client: parsed.client,
    ruleNumber: parsed.ruleNumber,
    name: (parsed.name ?? '').trim() || parsed.sortRule,
    salesOrg: (parsed.salesOrg ?? '').trim().toUpperCase(),
    distributionChannel: (parsed.distributionChannel ?? '').trim().toUpperCase(),
    customerNumber: (parsed.customerNumber ?? '').trim().toUpperCase(),
    materialNumber: (parsed.materialNumber ?? '').trim().toUpperCase(),
    plant: (parsed.plant ?? '').trim().toUpperCase(),
    sortRule: parsed.sortRule,
    isActive: parsed.isActive ?? true,
    validityFrom: parsed.validityFrom,
    validityTo: parsed.validityTo,
    createdBy: parsed.changedBy,
  };
  return withTenant(parsed.client, async (tx) => {
    const [existing] = await tx.select({ ruleNumber: table.ruleNumber }).from(table).where(and(
      eq(table.client, parsed.client), eq(table.ruleNumber, parsed.ruleNumber),
    )).limit(1);
    if (existing) {
      await tx.update(table).set({
        ...values,
        changedBy: parsed.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(table.client, parsed.client), eq(table.ruleNumber, parsed.ruleNumber),
      ));
      return { ruleNumber: parsed.ruleNumber, created: false };
    }
    await tx.insert(table).values(values);
    return { ruleNumber: parsed.ruleNumber, created: true };
  });
}

export async function listBatchDeterminationRules(client: string): Promise<BatchRule[]> {
  const table = await ruleTable();
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(table)
      .where(eq(table.client, client))
      .orderBy(asc(table.materialNumber), asc(table.customerNumber), asc(table.ruleNumber));
    return rows.map((row) => ({
      ruleNumber: row.ruleNumber,
      name: row.name,
      salesOrg: row.salesOrg,
      distributionChannel: row.distributionChannel,
      customerNumber: row.customerNumber,
      materialNumber: row.materialNumber,
      plant: row.plant,
      sortRule: row.sortRule as SortRule,
      isActive: row.isActive,
      validityFrom: row.validityFrom,
      validityTo: row.validityTo,
    }));
  });
}

/**
 * The rule that answers for this item, where one does.
 *
 * The most specific rule that answers wins, and a rule naming a *different* value is not a candidate
 * at all — the wrong customer's rule is not a fallback, it is somebody else's instruction.
 */
async function resolveRule(
  tx: Tx,
  client: string,
  ask: {
    salesOrg: string; distributionChannel: string; customerNumber: string;
    materialNumber: string; plant: string; documentDate: string;
  },
): Promise<BatchRule | null> {
  const table = await ruleTable();
  const rows = await tx.select().from(table).where(and(
    eq(table.client, client),
    eq(table.isActive, true),
    lte(table.validityFrom, ask.documentDate),
    gte(table.validityTo, ask.documentDate),
  ));
  const candidates = rows.filter((row) => (
    (row.salesOrg === '' || row.salesOrg === ask.salesOrg)
    && (row.distributionChannel === '' || row.distributionChannel === ask.distributionChannel)
    && (row.customerNumber === '' || row.customerNumber === ask.customerNumber)
    && (row.materialNumber === '' || row.materialNumber === ask.materialNumber)
    && (row.plant === '' || row.plant === ask.plant)
  ));
  if (!candidates.length) return null;
  const specificity = (row: (typeof rows)[number]) => (
    (row.materialNumber ? 16 : 0)
    + (row.customerNumber ? 8 : 0)
    + (row.plant ? 4 : 0)
    + (row.distributionChannel ? 2 : 0)
    + (row.salesOrg ? 1 : 0)
  );
  const best = candidates.sort((a, b) => specificity(b) - specificity(a)
    || a.ruleNumber.localeCompare(b.ruleNumber))[0];
  return {
    ruleNumber: best.ruleNumber,
    name: best.name,
    salesOrg: best.salesOrg,
    distributionChannel: best.distributionChannel,
    customerNumber: best.customerNumber,
    materialNumber: best.materialNumber,
    plant: best.plant,
    sortRule: best.sortRule as SortRule,
    isActive: best.isActive,
    validityFrom: best.validityFrom,
    validityTo: best.validityTo,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The determination itself
// ─────────────────────────────────────────────────────────────────────────────

export interface BatchProposal {
  storageLocation: string;
  batchNumber: string;
  quantity: string;
  /** What stands in this batch at this location, which is more than what was proposed when it is last. */
  available: string;
}

export interface BatchDetermination {
  /** The rule that answered, or null where no rule stands — in which case nothing was determined. */
  rule: BatchRule | null;
  sortRule: SortRule | null;
  proposals: BatchProposal[];
  requested: string;
  /** What the proposals cover. Less than what was asked for when the store does not hold it. */
  covered: string;
  shortfall: string;
  /** Batches that stand but were not proposed, and why: restricted, or empty. */
  skipped: Array<{ storageLocation: string; batchNumber: string; quantity: string; why: string }>;
}

const round3 = (value: number) => Math.round((value + Number.EPSILON) * 1000) / 1000;

/**
 * Which batches this quantity comes from, in the order the rule names.
 *
 * The answer walks the stock one batch at a time and stops when the quantity is covered, so a
 * proposal is never for more than was asked for and the last one is often for less than its batch
 * holds. Where the store does not hold the whole quantity, the answer is short and says so — a
 * determination that quietly claimed forty from a shelf holding thirty would be worse than one that
 * said thirty.
 */
export async function determineBatches(
  client: string,
  input: {
    materialNumber: string;
    plant: string;
    quantity: number;
    documentDate: string;
    storageLocation?: string;
    salesOrg?: string;
    distributionChannel?: string;
    customerNumber?: string;
  },
): Promise<BatchDetermination> {
  return withTenant(client, (tx) => determineBatchesOn(tx, client, input));
}

/**
 * The same determination, inside a transaction the caller already holds.
 *
 * The delivery reads it this way, because the pick it is about to write and the stock it is reading
 * have to be one act: a determination taken on another connection would be reading a store that the
 * pick has not yet changed, which is the same promise the availability check makes.
 */
export async function determineBatchesOn(
  tx: Tx,
  client: string,
  input: {
    materialNumber: string;
    plant: string;
    quantity: number;
    documentDate: string;
    storageLocation?: string;
    salesOrg?: string;
    distributionChannel?: string;
    customerNumber?: string;
  },
): Promise<BatchDetermination> {
  {
    const rule = await resolveRule(tx, client, {
      salesOrg: (input.salesOrg ?? '').trim().toUpperCase(),
      distributionChannel: (input.distributionChannel ?? '').trim().toUpperCase(),
      customerNumber: (input.customerNumber ?? '').trim().toUpperCase(),
      materialNumber: input.materialNumber.trim().toUpperCase(),
      plant: input.plant.trim().toUpperCase(),
      documentDate: input.documentDate,
    });
    if (!rule) {
      return {
        rule: null, sortRule: null, proposals: [], requested: round3(input.quantity).toString(),
        covered: '0', shortfall: round3(input.quantity).toString(), skipped: [],
      };
    }
    return propose(tx, client, rule, input);
  }
}

async function propose(
  tx: Tx,
  client: string,
  rule: BatchRule,
  input: {
    materialNumber: string;
    plant: string;
    quantity: number;
    storageLocation?: string;
  },
): Promise<BatchDetermination> {
  const materialNumber = input.materialNumber.trim().toUpperCase();
  const plant = input.plant.trim().toUpperCase();
  const storageLocation = (input.storageLocation ?? '').trim().toUpperCase();

  const stock = await tx.select({
    storageLocation: stockQuantity.storageLocation,
    batchNumber: stockQuantity.batchNumber,
    quantity: stockQuantity.quantity,
  }).from(stockQuantity).where(and(
    eq(stockQuantity.client, client),
    eq(stockQuantity.materialNumber, materialNumber),
    eq(stockQuantity.plant, plant),
    eq(stockQuantity.stockType, 'UNRESTRICTED'),
    storageLocation ? eq(stockQuantity.storageLocation, storageLocation) : undefined,
  ));

  // The batches themselves, for the two things stock cannot say: when the batch was made, and
  // whether it is free to use. A batch may stand at plant level or at material level depending on the
  // level it was created at, so the row that names this plant is preferred and the other is the one
  // that answered for every plant.
  const masters = await tx.select({
    batchNumber: batch.batchNumber,
    plant: batch.plant,
    restrictedUse: batch.restrictedUse,
    manufactureDate: batch.manufactureDate,
    shelfLifeExpirationDate: batch.shelfLifeExpirationDate,
    createdAt: batch.createdAt,
  }).from(batch).where(and(
    eq(batch.client, client), eq(batch.materialNumber, materialNumber),
  ));
  const masterOf = new Map<string, (typeof masters)[number]>();
  for (const row of masters) {
    const standing = masterOf.get(row.batchNumber);
    if (!standing || (standing.plant !== plant && row.plant === plant)) masterOf.set(row.batchNumber, row);
  }

  const usable: Array<{ storageLocation: string; batchNumber: string; quantity: number }> = [];
  const skipped: BatchDetermination['skipped'] = [];
  for (const row of stock) {
    const quantity = Number(row.quantity ?? 0);
    if (quantity <= 0) {
      skipped.push({
        storageLocation: row.storageLocation, batchNumber: row.batchNumber,
        quantity: round3(quantity).toString(), why: 'empty',
      });
      continue;
    }
    // A batch in restricted use is a batch the books will not let go. Proposing it would be
    // promising stock that cannot be issued.
    if ((masterOf.get(row.batchNumber)?.restrictedUse ?? '').trim().toUpperCase() === 'X') {
      skipped.push({
        storageLocation: row.storageLocation, batchNumber: row.batchNumber,
        quantity: round3(quantity).toString(), why: 'restricted',
      });
      continue;
    }
    usable.push({ storageLocation: row.storageLocation, batchNumber: row.batchNumber, quantity });
  }

  // The order. A rule that cannot separate two batches falls back to batch number, because an
  // unstable order is worse than a plain one: two runs of the same pick would answer differently.
  const master = (row: { batchNumber: string }) => masterOf.get(row.batchNumber);
  const ordered = [...usable].sort((a, b) => {
    if (rule.sortRule === 'EXPIRY') {
      const left = master(a)?.shelfLifeExpirationDate ?? null;
      const right = master(b)?.shelfLifeExpirationDate ?? null;
      if (left && right && left !== right) return left < right ? -1 : 1;
      if (left && !right) return -1;
      if (!left && right) return 1;
    } else if (rule.sortRule === 'FIFO' || rule.sortRule === 'LIFO') {
      const left = master(a)?.createdAt ?? null;
      const right = master(b)?.createdAt ?? null;
      if (left && right && left.getTime() !== right.getTime()) {
        return rule.sortRule === 'FIFO' ? left.getTime() - right.getTime() : right.getTime() - left.getTime();
      }
    }
    return a.batchNumber.localeCompare(b.batchNumber) || a.storageLocation.localeCompare(b.storageLocation);
  });

  let wanted = input.quantity;
  const proposals: BatchProposal[] = [];
  for (const row of ordered) {
    if (wanted <= 1e-9) break;
    const take = Math.min(row.quantity, wanted);
    proposals.push({
      storageLocation: row.storageLocation,
      batchNumber: row.batchNumber,
      quantity: round3(take).toString(),
      available: round3(row.quantity).toString(),
    });
    wanted -= take;
  }
  const requested = round3(input.quantity);
  const covered = round3(input.quantity - Math.max(wanted, 0));
  return {
    rule,
    sortRule: rule.sortRule,
    proposals,
    requested: requested.toString(),
    covered: covered.toString(),
    shortfall: round3(Math.max(wanted, 0)).toString(),
    skipped,
  };
}

/**
 * What the whole delivery should be picked from, item by item.
 *
 * Read as a proposal for a screen to fill in and for a picker to confirm, not as a decision made
 * behind their back: the confirmation is the act, and it records the batches it actually took.
 */
export async function determineBatchesForDelivery(
  client: string,
  deliveryNumber: string,
): Promise<Array<{
  lineNumber: number;
  materialNumber: string;
  plant: string;
  openQuantity: string;
  determination: BatchDetermination;
}>> {
  const { delivery, deliveryLine } = await import('./schema');
  const { salesOrder, salesOrderLine } = await import('./schema');
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(delivery).where(and(
      eq(delivery.client, client), eq(delivery.deliveryNumber, deliveryNumber.trim().toUpperCase()),
    )).limit(1);
    if (!header) throw new BatchDeterminationError(`Delivery ${deliveryNumber} does not exist.`);
    const lines = await tx.select().from(deliveryLine).where(and(
      eq(deliveryLine.client, client), eq(deliveryLine.deliveryNumber, header.deliveryNumber),
    )).orderBy(asc(deliveryLine.lineNumber));
    const [order] = header.orderNumber
      ? await tx.select().from(salesOrder).where(and(
        eq(salesOrder.client, client), eq(salesOrder.orderNumber, header.orderNumber),
      )).limit(1)
      : [undefined];
    const out = [];
    for (const line of lines) {
      const open = Number(line.deliveryQuantity) - Number(line.pickedQuantity);
      if (open <= 1e-9) continue;
      out.push({
        lineNumber: line.lineNumber,
        materialNumber: line.materialNumber,
        plant: line.plant,
        openQuantity: round3(open).toString(),
        determination: await propose(tx, client, (await resolveRule(tx, client, {
          salesOrg: header.salesOrg,
          distributionChannel: header.distributionChannel,
          customerNumber: order?.customerNumber ?? '',
          materialNumber: line.materialNumber,
          plant: line.plant,
          documentDate: header.deliveryDate,
        })) ?? {
          ruleNumber: '', name: '', salesOrg: '', distributionChannel: '', customerNumber: '',
          materialNumber: '', plant: '', sortRule: 'FIFO' as SortRule, isActive: false,
          validityFrom: header.deliveryDate, validityTo: header.deliveryDate,
        }, {
          materialNumber: line.materialNumber, plant: line.plant, quantity: open,
        }),
      });
    }
    return out;
  });
}
