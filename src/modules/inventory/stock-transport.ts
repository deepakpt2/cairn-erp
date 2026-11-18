/**
 * Stock transport order (STO) movements — ITEM-22. The stock transport order without delivery: a purchase-order-like
 * document from a receiving plant to a supplying plant, moved in two steps.
 *
 *   351  goods issue   supplying unrestricted  ->  stock in transit of the RECEIVING plant
 *   101  goods receipt transit                 ->  receiving unrestricted (the batch that stands in transit)
 *   102  reverses a 101 (back into transit)       352  reverses a 351 (back to the supplying plant)
 *
 * Transit is a plant-level quantity: `stock_quantity` carries it as stock type IN_TRANSIT with a blank
 * storage location. It is NOT physically available, and no destination storage location is invented before
 * the receipt names one.
 *
 * The ledger is `sto_transit_allocation`: one row per ORIGINAL 351 issue line, carrying the quantity, value,
 * currencies and rate as they stood at issue. A 101 consumes explicit allocations in a deterministic FIFO
 * (posting date, issue document, issue line) within the item and batch, so every receipt carries the value
 * of the issue it came from; a later price or rate change never rewrites it. Quantities are exact decimals
 * (scaled integers here, numeric in the database); the database CHECKs keep received + reversed <= issued.
 *
 * Accounting. A 351 inside one company posts one journal (inventory of the receiving plant against inventory
 * of the supplying plant) only when the two inventory accounts differ; otherwise the valuation movement is
 * preserved on the material document lines and the ledger. A 351 across companies ALWAYS posts two balanced
 * journals in one transaction: the sending company (clearing against its own plant's inventory) and the
 * receiving company (the receiving plant's own inventory account against its own clearing account), each
 * stamped with the trading partner and linked to the material document in `material_document_journal`.
 * A 101 never touches GR/IR: it moves stock inside the receiving valuation area, and a standard-priced
 * receiving plant books the difference between the carried value and its standard price to the
 * PRICE_DIFFERENCE account, in the receiving company, at the receipt.
 *
 * The STO is linked to its movements through `sto_*` columns on the material document line, never through
 * `purchase_order_number`, so supplier GR/IR, invoice verification, vendor evaluation and delivered
 * quantities cannot count them.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import {
  type ServiceAuthorityContext, refusePlantOutsideScopeInTx, verifyServiceAuthorityInTx,
} from '../../platform/auth/service-authority';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { getCompanyCode } from '../../platform/periods';
import { fromScaled, multiplyScaled, toScaled } from '../../platform/posting/decimal';
import { PostingError, postJournalEntry, reverseJournalEntry } from '../../platform/posting';
import { clearingAccountFor, IntercompanyError, rateToLocal } from '../finance/intercompany';
import { journalEntryLine } from '../finance/schema';
import { purchaseOrder, purchaseOrderItem } from '../purchasing/schema';
import { ReleaseError, assertDocumentReleased } from '../purchasing/release';
import { batchClassificationRefusal } from './batch-classification';
import { noteBatchControlUse } from './batch-control-use';
import { BatchPostingError, resolvePostingBatch } from './batch-posting';
import { lockRequestKey, postingFingerprint } from './balance-update';
import { recordOutputsForPostedDocument } from './material-document-output';
import { assertInventoryCountOpen, lockStockScope, PhysicalInventoryError } from './physical-inventory';
import {
  material, materialDocument, materialDocumentJournal, materialDocumentLine, materialPlant, materialValuation,
  movementType, stoTransitAllocation,
} from './schema';
import {
  judgePeriod, loadPlant, loadStorageLocation, resolveAccount, TRANSFER_POST_CAPABILITY,
  TransferPostingError,
} from './transfer-posting';
import { toBaseQuantity, UnitConversionError } from './unit-conversion';
import { IN_TRANSIT } from './stock-types';

export const STO_ISSUE_CAPABILITY = TRANSFER_POST_CAPABILITY;
export const STO_RECEIPT_CAPABILITY = 'INV.GR.POST';
export const STO_REVERSE_CAPABILITY = 'INV.REVERSE';
export const STO_DOCUMENT_TYPE = 'STOCK_TRANSPORT';

const MATERIAL_DOCUMENT_CLASS = 'material_document';
const ISSUE_JOURNAL_TYPE = 'WA';
const RECEIPT_JOURNAL_TYPE = 'WE';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The stored movement identities and the three-digit codes people know them by. */
export const STO_MOVEMENTS = {
  ISSUE: { movementType: 'STO_GI', code: '351', reversal: 'STO_GI_REV' },
  ISSUE_REV: { movementType: 'STO_GI_REV', code: '352', reversal: 'STO_GI' },
  RECEIPT: { movementType: 'STO_GR', code: '101', reversal: 'STO_GR_REV' },
  RECEIPT_REV: { movementType: 'STO_GR_REV', code: '102', reversal: 'STO_GR' },
} as const;

const DELIVERED_STO_MOVEMENTS = [
  { movementType: 'STO_GI', description: 'STO goods issue to transit (351)', direction: 'TRANSFER', reversalMovementType: 'STO_GI_REV', sourceStockType: 'UNRESTRICTED', destinationStockType: IN_TRANSIT },
  { movementType: 'STO_GI_REV', description: 'Reversal of STO goods issue (352)', direction: 'REVERSAL', reversalMovementType: 'STO_GI', sourceStockType: IN_TRANSIT, destinationStockType: 'UNRESTRICTED' },
  { movementType: 'STO_GR', description: 'STO goods receipt from transit (101)', direction: 'RECEIPT', reversalMovementType: 'STO_GR_REV', sourceStockType: IN_TRANSIT, destinationStockType: 'UNRESTRICTED' },
  { movementType: 'STO_GR_REV', description: 'Reversal of STO goods receipt (102)', direction: 'REVERSAL', reversalMovementType: 'STO_GR', sourceStockType: 'UNRESTRICTED', destinationStockType: IN_TRANSIT },
] as const;

/** Movements this service owns; a manually entered counter is refused by name elsewhere. */
export const STO_MOVEMENT_CODES = ['351', '352'] as const;

export class StockTransportError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'StockTransportError';
    this.remedy = remedy;
  }
}

/** Services this module borrows from raise their own typed errors; the caller sees one. */
async function adopt<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (caught) {
    if (caught instanceof StockTransportError) throw caught;
    if (
      caught instanceof TransferPostingError || caught instanceof PostingError
      || caught instanceof UnitConversionError || caught instanceof BatchPostingError
      || caught instanceof PhysicalInventoryError || caught instanceof IntercompanyError
      || caught instanceof ReleaseError
    ) {
      throw new StockTransportError(caught.message, (caught as { remedy?: string }).remedy);
    }
    throw caught;
  }
}

// ── Exact decimal helpers ────────────────────────────────────────────────────────────────────────────

const Q = 3;
const M = 4;

function q3(value: string | number): bigint {
  return toScaled(typeof value === 'number' ? value.toFixed(Q) : value, Q);
}
function m4(value: string | number): bigint {
  return toScaled(typeof value === 'number' ? value.toFixed(M) : value, M);
}
const qs = (value: bigint) => fromScaled(value, Q);
const ms = (value: bigint) => fromScaled(value, M);

/** n / d rounded half away from zero, for any sign of n and a positive d. */
function divRound(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new StockTransportError('A division by zero was attempted in a valuation.');
  const negative = n < 0n;
  const a = negative ? -n : n;
  const result = (a * 2n + d) / (2n * d);
  return negative ? -result : result;
}

/** A scale-4 amount rounded to a currency's decimal places (still carried at scale 4). */
function roundToDecimals(value4: bigint, decimals: number): bigint {
  if (decimals >= M) return value4;
  const factor = 10n ** BigInt(M - decimals);
  return divRound(value4, factor) * factor;
}

/** quantity x price / price unit, at the currency's decimals. Scale 3 x scale 4 / scale 3 = scale 4. */
function valueOf(quantity3: bigint, price4: bigint, priceUnit3: bigint, decimals: number): bigint {
  return roundToDecimals(divRound(quantity3 * price4, priceUnit3), decimals);
}

async function currencyDecimals(tx: Tx, currency: string): Promise<number> {
  const rows = await tx.execute(sql`select decimal_places from currency where code = ${currency} limit 1`) as unknown as Array<{ decimal_places: number }>;
  return rows[0] ? Number(rows[0].decimal_places) : 2;
}

function requireDate(value: string, label: string): void {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new StockTransportError(`${label} ${value || '(empty)'} is not a date.`, 'Enter the date as YYYY-MM-DD.');
  }
}

/** A quantity from a form or a caller: positive, at most three decimals, no exponent. */
function parseQuantity(raw: string | number, label: string): bigint {
  const text = typeof raw === 'number' ? String(raw) : String(raw ?? '').trim();
  if (!/^\d+(\.\d{1,3})?$/.test(text)) {
    throw new StockTransportError(
      `${label} ${text || '(empty)'} is not a quantity with at most three decimals.`,
      'Enter a positive quantity such as 10 or 2.5.',
    );
  }
  const value = q3(text);
  if (value <= 0n) throw new StockTransportError(`${label} must be greater than zero.`, 'Enter a quantity greater than zero.');
  return value;
}

// ── Locks, stock and valuation writes ───────────────────────────────────────────────────────────────

async function ensureMovements(tx: Tx, client: string, changedBy: string): Promise<void> {
  for (const m of DELIVERED_STO_MOVEMENTS) {
    await tx.insert(movementType).values({
      client, movementType: m.movementType, description: m.description, direction: m.direction,
      referenceCategory: 'STOCK_TRANSPORT', reversalMovementType: m.reversalMovementType,
      movementKind: 'PLANT', sourceStockType: m.sourceStockType, destinationStockType: m.destinationStockType,
      plantRule: 'DIFFERENT', locationRule: 'ANY', isTwoStep: false, valuationRelevant: true,
      negativeStockPolicy: 'LOCATION', createdBy: changedBy,
    }).onConflictDoNothing();
  }
}

async function requireAuthority(
  tx: Tx, client: string, authorization: ServiceAuthorityContext | undefined,
  capability: string, plants: readonly string[],
): Promise<void> {
  const authority = await verifyServiceAuthorityInTx(tx, client, authorization, capability);
  if (!authority.ok) throw new StockTransportError(authority.refusal.message, authority.refusal.remedy);
  for (const plantCode of new Set(plants)) {
    const refusal = await refusePlantOutsideScopeInTx(tx, client, plantCode, authority.restrictions);
    if (refusal) throw new StockTransportError(refusal.message, refusal.remedy);
  }
}

async function assertTenantScope(tx: Tx, client: string): Promise<void> {
  const [scope] = await tx.execute(sql<{ client: string | null }>`select current_setting('cairn.client', true) as client`);
  if (scope?.client !== client) {
    throw new StockTransportError('The stock transport transaction is not scoped to the requested tenant.');
  }
}

async function lockOrder(tx: Tx, client: string, orderNumber: string): Promise<void> {
  // The same key changeOrder takes, so an edit of the order and a movement against it serialise.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/purchase-order/${orderNumber}`}, 0))`);
}

interface StockKey { material: string; plant: string; location: string; stockType: string; batch: string }

async function stockHeld(tx: Tx, client: string, k: StockKey): Promise<bigint> {
  const rows = await tx.execute(sql`
    select quantity::text as quantity from stock_quantity
     where client = ${client} and material_number = ${k.material} and plant = ${k.plant}
       and storage_location = ${k.location} and stock_type = ${k.stockType} and batch_number = ${k.batch}
     for update
  `) as unknown as Array<{ quantity: string }>;
  return rows[0] ? q3(rows[0].quantity) : 0n;
}

async function moveStock(tx: Tx, client: string, by: string, k: StockKey, delta: bigint): Promise<void> {
  await tx.execute(sql`
    insert into stock_quantity (client, material_number, plant, storage_location, stock_type, batch_number, quantity, created_by)
    values (${client}, ${k.material}, ${k.plant}, ${k.location}, ${k.stockType}, ${k.batch}, ${qs(delta)}::numeric, ${by})
    on conflict (client, material_number, plant, storage_location, stock_type, batch_number)
    do update set quantity = stock_quantity.quantity + excluded.quantity, changed_by = ${by}, changed_at = now()
  `);
}

/** Quantity and value of one valuation area, exact. Moving average follows the new totals. */
async function bookValuation(
  tx: Tx, client: string, by: string, materialNumber: string, plant: string, quantityDelta: bigint, valueDelta: bigint,
): Promise<void> {
  const qd = qs(quantityDelta);
  const vd = ms(valueDelta);
  await tx.execute(sql`
    select 1 from material_valuation
     where client = ${client} and material_number = ${materialNumber} and valuation_area = ${plant} for update
  `);
  try {
    await tx.execute(sql`
      update material_valuation set
        moving_average_price = case
          when price_control = 'MOVING_AVERAGE' and total_stock_quantity + ${qd}::numeric > 0
          then round(((stock_value + ${vd}::numeric) / (total_stock_quantity + ${qd}::numeric)) * price_unit, 4)
          else moving_average_price end,
        total_stock_quantity = total_stock_quantity + ${qd}::numeric,
        stock_value = stock_value + ${vd}::numeric,
        changed_by = ${by}, changed_at = now()
       where client = ${client} and material_number = ${materialNumber} and valuation_area = ${plant}
    `);
  } catch (caught) {
    if (/material_valuation_values_ck/.test(String((caught as Error).message ?? '')) || (caught as { code?: string }).code === '23514') {
      throw new StockTransportError(
        `The valuation of ${materialNumber} in plant ${plant} cannot carry that movement: its quantity or value would turn negative.`,
        'Check the plant valuation against the stock before posting.',
      );
    }
    throw caught;
  }
}

async function markPlanning(tx: Tx, client: string, by: string, materialNumber: string, plant: string, reason: string): Promise<void> {
  await tx.execute(sql`
    insert into planning_file (client, material_number, plant, net_change, reason, last_changed_by)
    values (${client}, ${materialNumber}, ${plant}, true, ${reason}, ${by})
    on conflict (client, material_number, plant)
    do update set net_change = true, reason = excluded.reason, last_changed_at = now(), last_changed_by = excluded.last_changed_by
  `);
}

// ── Order and transit read model ────────────────────────────────────────────────────────────────────

export interface TransitAllocationView {
  issueDocument: string;
  issueLine: number;
  batch: string;
  postingDate: string;
  issued: string;
  received: string;
  reversed: string;
  inTransit: string;
  sourceCurrency: string;
  issueValue: string;
  receivingCurrency: string;
  transitValue: string;
  exchangeRate: string;
}

export interface StoItemStatus {
  itemNumber: number;
  materialNumber: string;
  orderUnit: string;
  baseUnit: string;
  orderedQuantity: string;
  orderedBase: string;
  netIssued: string;
  netReceived: string;
  inTransit: string;
  issueable: string;
  receiptPending: string;
  receivingPlant: string;
  storageLocation: string | null;
  batch: string;
  markedForDeletion: boolean;
  allocations: TransitAllocationView[];
}

export interface StoHistoryRow {
  materialDocumentNumber: string;
  movementType: string;
  code: string;
  postingDate: string;
  status: string;
  itemNumber: number | null;
  plant: string;
  quantity: string;
  unit: string;
  reversalOf: string | null;
  journals: Array<{ role: string; companyCode: string; journalDocumentNumber: string; fiscalYear: number }>;
}

export interface StoOrderStatus {
  orderNumber: string;
  companyCode: string;
  supplyingPlant: string;
  supplyingCompany: string;
  crossCompany: boolean;
  releaseStatus: string;
  items: StoItemStatus[];
  history: StoHistoryRow[];
  /** Journals of a company outside the viewer's scope are withheld, and counted. */
  withheldJournals: number;
}

interface LoadedItem {
  row: typeof purchaseOrderItem.$inferSelect;
  baseUnit: string;
  orderedBase: bigint;
  netIssued: bigint;
  netReceived: bigint;
}

async function orderedBaseOf(tx: Tx, client: string, row: typeof purchaseOrderItem.$inferSelect, baseUnit: string): Promise<bigint> {
  if (!row.materialNumber) throw new StockTransportError(`Item ${row.itemNumber} of order ${row.orderNumber} names no material.`);
  if (row.unit === baseUnit) return q3(row.quantity);
  const conversion = await adopt(() => toBaseQuantity(tx, client, {
    materialNumber: row.materialNumber!, quantity: Number(row.quantity), entryUnit: row.unit,
  }));
  return q3(conversion.baseQuantity);
}

async function itemTotals(tx: Tx, client: string, orderNumber: string, itemNumber: number) {
  const rows = await tx.execute(sql`
    select coalesce(sum(issued_quantity - reversed_quantity), 0)::text as net_issued,
           coalesce(sum(received_quantity), 0)::text as net_received
      from sto_transit_allocation
     where client = ${client} and order_number = ${orderNumber} and item_number = ${itemNumber}
  `) as unknown as Array<{ net_issued: string; net_received: string }>;
  return { netIssued: q3(rows[0]?.net_issued ?? '0'), netReceived: q3(rows[0]?.net_received ?? '0') };
}

/** The order and its items; `lock` takes the item rows FOR UPDATE in item order, after the order lock. */
async function loadStoForPosting(
  tx: Tx, client: string, orderNumber: string, itemNumbers: number[], lock: boolean,
) {
  if (lock) await lockOrder(tx, client, orderNumber);
  const [header] = await tx.select().from(purchaseOrder).where(and(
    eq(purchaseOrder.client, client), eq(purchaseOrder.orderNumber, orderNumber),
  ));
  if (!header) throw new StockTransportError(`Purchase order ${orderNumber || '(empty)'} does not exist.`, 'Check the order number.');
  if (header.documentType !== STO_DOCUMENT_TYPE || !header.supplyingPlant) {
    throw new StockTransportError(
      `Purchase order ${orderNumber} is not a stock transport order.`,
      'A supplier order is received on the goods receipt screen against the supplier; only a stock transport order moves through transit.',
    );
  }
  const wanted = [...new Set(itemNumbers)].sort((a, b) => a - b);
  const rows = lock
    ? await tx.execute(sql`
        select item_number from purchase_order_item
         where client = ${client} and order_number = ${orderNumber}
           and item_number in (${sql.join(wanted.map((n) => sql`${n}`), sql`, `)})
         order by item_number for update
      `) as unknown as Array<{ item_number: number }>
    : [];
  void rows;
  const items: LoadedItem[] = [];
  for (const itemNumber of wanted) {
    const [row] = await tx.select().from(purchaseOrderItem).where(and(
      eq(purchaseOrderItem.client, client), eq(purchaseOrderItem.orderNumber, orderNumber),
      eq(purchaseOrderItem.itemNumber, itemNumber),
    ));
    if (!row) throw new StockTransportError(`Item ${itemNumber} does not stand on order ${orderNumber}.`, 'Choose an item of the order.');
    const [mat] = await tx.select({ baseUnit: material.baseUnit }).from(material).where(and(
      eq(material.client, client), eq(material.materialNumber, row.materialNumber ?? ''),
    ));
    if (!mat?.baseUnit) throw new StockTransportError(`Material ${row.materialNumber ?? '(none)'} of item ${itemNumber} carries no base unit.`);
    const totals = await itemTotals(tx, client, orderNumber, itemNumber);
    items.push({ row, baseUnit: mat.baseUnit, orderedBase: await orderedBaseOf(tx, client, row, mat.baseUnit), ...totals });
  }
  return { header, items };
}

/** Is this order a stock transport order? A plain read for the screens that route by order type. */
export async function isStockTransportOrder(client: string, orderNumber: string): Promise<boolean> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select 1 from purchase_order where client = ${client} and order_number = ${orderNumber} and document_type = ${STO_DOCUMENT_TYPE}
    `) as unknown as unknown[];
    return rows.length > 0;
  });
}

/** Is this material document a stock transport movement (351/101/352/102)? */
export async function isStoMovement(client: string, documentNumber: string): Promise<boolean> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select 1 from material_document_line
       where client = ${client} and material_document_number = ${documentNumber} and sto_order_number is not null limit 1
    `) as unknown as unknown[];
    return rows.length > 0;
  });
}

/** Everything a screen shows about one STO: quantities per item, the ledger and the movement history. */
export async function getStoStatus(
  client: string, orderNumber: string, viewer?: { userId: string },
): Promise<StoOrderStatus | null> {
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(purchaseOrder).where(and(
      eq(purchaseOrder.client, client), eq(purchaseOrder.orderNumber, orderNumber),
    ));
    if (!header || header.documentType !== STO_DOCUMENT_TYPE || !header.supplyingPlant) return null;
    const itemRows = await tx.select().from(purchaseOrderItem).where(and(
      eq(purchaseOrderItem.client, client), eq(purchaseOrderItem.orderNumber, orderNumber),
    )).orderBy(purchaseOrderItem.itemNumber);
    const plantRows = await tx.execute(sql`
      select plant, company_code from plant where client = ${client}
    `) as unknown as Array<{ plant: string; company_code: string | null }>;
    const companyOf = (plant: string) => plantRows.find((p) => p.plant === plant)?.company_code ?? '';
    const releaseRows = await tx.execute(sql`
      select status from document_release
       where client = ${client} and document_category = 'PURCHASE_ORDER' and document_number = ${orderNumber}
    `) as unknown as Array<{ status: string }>;

    const allocations = await tx.select().from(stoTransitAllocation).where(and(
      eq(stoTransitAllocation.client, client), eq(stoTransitAllocation.orderNumber, orderNumber),
    )).orderBy(stoTransitAllocation.postingDate, stoTransitAllocation.issueDocument, stoTransitAllocation.issueLine);

    const items: StoItemStatus[] = [];
    for (const row of itemRows) {
      const [mat] = await tx.select({ baseUnit: material.baseUnit }).from(material).where(and(
        eq(material.client, client), eq(material.materialNumber, row.materialNumber ?? ''),
      ));
      const baseUnit = mat?.baseUnit ?? row.unit;
      const orderedBase = await orderedBaseOf(tx, client, row, baseUnit).catch(() => q3(row.quantity));
      const mine = allocations.filter((a) => a.itemNumber === row.itemNumber);
      const netIssued = mine.reduce((s, a) => s + q3(a.issuedQuantity) - q3(a.reversedQuantity), 0n);
      const netReceived = mine.reduce((s, a) => s + q3(a.receivedQuantity), 0n);
      const inTransit = netIssued - netReceived;
      const issueable = row.markedForDeletion || row.deliveryCompleted ? 0n : orderedBase - netIssued;
      items.push({
        itemNumber: row.itemNumber, materialNumber: row.materialNumber ?? '',
        orderUnit: row.unit, baseUnit, orderedQuantity: row.quantity, orderedBase: qs(orderedBase),
        netIssued: qs(netIssued), netReceived: qs(netReceived), inTransit: qs(inTransit),
        issueable: qs(issueable > 0n ? issueable : 0n), receiptPending: qs(inTransit),
        receivingPlant: row.plant, storageLocation: row.storageLocation, batch: row.batchNumber,
        markedForDeletion: row.markedForDeletion,
        allocations: mine.map((a) => ({
          issueDocument: a.issueDocument, issueLine: a.issueLine, batch: a.batchNumber, postingDate: a.postingDate,
          issued: a.issuedQuantity, received: a.receivedQuantity, reversed: a.reversedQuantity,
          inTransit: qs(q3(a.issuedQuantity) - q3(a.reversedQuantity) - q3(a.receivedQuantity)),
          sourceCurrency: a.sourceCurrency, issueValue: a.issueValue,
          receivingCurrency: a.receivingCurrency, transitValue: a.transitValue, exchangeRate: a.exchangeRate,
        })),
      });
    }

    let restrictions: Array<{ scopeType: string; scopeValue: string }> | null = null;
    if (viewer) {
      const { loadOrgRestrictions } = await import('../../platform/auth/session');
      restrictions = await loadOrgRestrictions(tx, client, viewer.userId);
    }
    const { hasOrgAccess } = await import('../../platform/auth/session');
    const mayView = (company: string) => restrictions === null
      || hasOrgAccess(restrictions as Parameters<typeof hasOrgAccess>[0], 'COMPANY_CODE', company);

    const lineRows = await tx.execute(sql`
      select l.material_document_number, l.line_number, l.movement_type, l.plant, l.base_quantity::text as quantity,
             l.base_unit, l.line_direction, l.sto_order_item, l.reversal_of_document,
             d.posting_date, d.status
        from material_document_line l
        join material_document d on d.client = l.client and d.material_document_number = l.material_document_number
       where l.client = ${client} and l.sto_order_number = ${orderNumber}
       order by d.posting_date, l.material_document_number, l.line_number
    `) as unknown as Array<{
      material_document_number: string; line_number: number; movement_type: string; plant: string; quantity: string;
      base_unit: string; line_direction: string; sto_order_item: number; reversal_of_document: string | null;
      posting_date: string; status: string;
    }>;
    const journalRows = await tx.select().from(materialDocumentJournal).where(eq(materialDocumentJournal.client, client));
    let withheld = 0;
    const history: StoHistoryRow[] = [];
    const seen = new Set<string>();
    for (const l of lineRows) {
      // One history row per document and item: the counted side of the movement.
      const counted = (l.movement_type === 'STO_GI' || l.movement_type === 'STO_GI_REV')
        ? (l.movement_type === 'STO_GI' ? l.line_direction === 'ISSUE' : l.line_direction === 'RECEIPT')
        : (l.movement_type === 'STO_GR' ? l.line_direction === 'RECEIPT' : l.line_direction === 'ISSUE');
      if (!counted) continue;
      const key = `${l.material_document_number}/${l.line_number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const journals = journalRows.filter((j) => j.materialDocumentNumber === l.material_document_number);
      const visible = journals.filter((j) => mayView(j.companyCode));
      withheld += journals.length - visible.length;
      history.push({
        materialDocumentNumber: l.material_document_number, movementType: l.movement_type,
        code: Object.values(STO_MOVEMENTS).find((m) => m.movementType === l.movement_type)?.code ?? l.movement_type,
        postingDate: l.posting_date, status: l.status, itemNumber: l.sto_order_item, plant: l.plant,
        quantity: l.quantity, unit: l.base_unit, reversalOf: l.reversal_of_document,
        journals: visible.map((j) => ({
          role: j.role, companyCode: j.companyCode, journalDocumentNumber: j.journalDocumentNumber, fiscalYear: j.fiscalYear,
        })),
      });
    }
    const supplyingCompany = companyOf(header.supplyingPlant);
    return {
      orderNumber, companyCode: header.companyCode, supplyingPlant: header.supplyingPlant, supplyingCompany,
      crossCompany: supplyingCompany !== header.companyCode,
      releaseStatus: releaseRows[0] ? header.releaseStatus : 'NOT_REQUIRED',
      items, history, withheldJournals: withheld,
    };
  });
}

/**
 * Recompute net issued / net received from the immutable material document lines and compare them with
 * the ledger. A mismatch means the ledger and the history disagree; it is reported, never repaired.
 */
export async function reconcileStoItem(
  client: string, orderNumber: string, itemNumber: number,
): Promise<{ historyIssued: string; historyReceived: string; ledgerIssued: string; ledgerReceived: string; reconciled: boolean }> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select coalesce(sum(case when movement_type = 'STO_GI' and line_direction = 'ISSUE' then base_quantity
                               when movement_type = 'STO_GI_REV' and line_direction = 'RECEIPT' then -base_quantity
                               else 0 end), 0)::text as issued,
             coalesce(sum(case when movement_type = 'STO_GR' and line_direction = 'RECEIPT' then base_quantity
                               when movement_type = 'STO_GR_REV' and line_direction = 'ISSUE' then -base_quantity
                               else 0 end), 0)::text as received
        from material_document_line
       where client = ${client} and sto_order_number = ${orderNumber} and sto_order_item = ${itemNumber}
    `) as unknown as Array<{ issued: string; received: string }>;
    const totals = await itemTotals(tx, client, orderNumber, itemNumber);
    const historyIssued = q3(rows[0]?.issued ?? '0');
    const historyReceived = q3(rows[0]?.received ?? '0');
    return {
      historyIssued: qs(historyIssued), historyReceived: qs(historyReceived),
      ledgerIssued: qs(totals.netIssued), ledgerReceived: qs(totals.netReceived),
      reconciled: historyIssued === totals.netIssued && historyReceived === totals.netReceived,
    };
  });
}

// ── Document view and request replay ────────────────────────────────────────────────────────────────

export interface StoDocumentView {
  materialDocumentNumber: string;
  documentYear: number;
  documentDate: string;
  postingDate: string;
  status: string;
  headerText: string | null;
  reversalOf: string | null;
  reversedBy: string | null;
  journalDocumentNumber: string | null;
  journals: Array<{ role: string; companyCode: string; journalDocumentNumber: string; fiscalYear: number }>;
  lines: Array<{
    lineNumber: number; lineDirection: string; movementType: string; materialNumber: string; plant: string;
    storageLocation: string | null; stockType: string; batch: string; quantity: string; unit: string; value: string;
    currency: string | null; orderNumber: string | null; itemNumber: number | null;
    issueDocument: string | null; issueLine: number | null;
  }>;
}

async function documentView(tx: Tx, client: string, number: string): Promise<StoDocumentView | null> {
  const [header] = await tx.select().from(materialDocument).where(and(
    eq(materialDocument.client, client), eq(materialDocument.materialDocumentNumber, number),
  ));
  if (!header) return null;
  const lines = await tx.select().from(materialDocumentLine).where(and(
    eq(materialDocumentLine.client, client), eq(materialDocumentLine.materialDocumentNumber, number),
  )).orderBy(materialDocumentLine.lineNumber);
  const journals = await tx.select().from(materialDocumentJournal).where(and(
    eq(materialDocumentJournal.client, client), eq(materialDocumentJournal.materialDocumentNumber, number),
  ));
  return {
    materialDocumentNumber: header.materialDocumentNumber, documentYear: header.documentYear,
    documentDate: header.documentDate, postingDate: header.postingDate, status: header.status,
    headerText: header.headerText, reversalOf: header.reversalOf, reversedBy: header.reversedBy,
    journalDocumentNumber: header.journalDocumentNumber,
    journals: journals.map((j) => ({
      role: j.role, companyCode: j.companyCode, journalDocumentNumber: j.journalDocumentNumber, fiscalYear: j.fiscalYear,
    })),
    lines: lines.map((l) => ({
      lineNumber: l.lineNumber, lineDirection: l.lineDirection, movementType: l.movementType,
      materialNumber: l.materialNumber, plant: l.plant, storageLocation: l.storageLocation, stockType: l.stockType,
      batch: l.batchNumber, quantity: l.baseQuantity, unit: l.baseUnit, value: l.value, currency: l.currency,
      orderNumber: l.stoOrderNumber, itemNumber: l.stoOrderItem,
      issueDocument: l.stoIssueDocument, issueLine: l.stoIssueLine,
    })),
  };
}

export async function getStoDocument(client: string, number: string): Promise<StoDocumentView | null> {
  return withTenant(client, (tx) => documentView(tx, client, number));
}

async function replayOrRefuse(tx: Tx, client: string, requestKey: string, fingerprint: string): Promise<StoDocumentView | null> {
  const [header] = await tx.select().from(materialDocument).where(and(
    eq(materialDocument.client, client), eq(materialDocument.requestKey, requestKey),
  ));
  if (!header) return null;
  if (header.requestFingerprint && header.requestFingerprint !== fingerprint) {
    throw new StockTransportError(
      `Request key ${requestKey} already posted ${header.materialDocumentNumber}, and this is a different posting: the stored request does not match this one.`,
      'Post with a fresh request key, or repeat the original request exactly.',
    );
  }
  return documentView(tx, client, header.materialDocumentNumber);
}

// ── Accounting ──────────────────────────────────────────────────────────────────────────────────────

interface JournalLine { glAccount: string; debitCredit: 'S' | 'H'; amount: string; amountLocal: string; material?: string; plant?: string; lineText?: string }

async function postLinkedJournal(
  tx: Tx, client: string, by: string, args: {
    materialDocument: string; role: 'SENDING' | 'RECEIVING' | 'PRICE_DIFFERENCE';
    company: { companyCode: string; currency: string; chartOfAccounts: string }; position: { fiscalYear: number; period: number };
    documentType: string; documentDate: string; postingDate: string; currency: string; exchangeRate: string;
    headerText?: string; reference: string; lines: JournalLine[]; tradingPartner?: string; transactionCode: string;
  },
): Promise<{ documentNumber: string; fiscalYear: number }> {
  const journal = await adopt(() => postJournalEntry(tx, {
    client, companyCode: args.company.companyCode, documentType: args.documentType,
    documentDate: args.documentDate, postingDate: args.postingDate,
    fiscalYear: args.position.fiscalYear, postingPeriod: args.position.period,
    currency: args.currency, localCurrency: args.company.currency, exchangeRate: args.exchangeRate,
    reference: args.reference, headerText: args.headerText, lines: args.lines,
    origin: { documentClass: MATERIAL_DOCUMENT_CLASS, documentKey: args.materialDocument },
    postedBy: by, transactionCode: args.transactionCode,
  }));
  if (args.tradingPartner) {
    await tx.update(journalEntryLine).set({ tradingPartnerCompany: args.tradingPartner }).where(and(
      eq(journalEntryLine.client, client),
      eq(journalEntryLine.documentNumber, journal.documentNumber),
      eq(journalEntryLine.fiscalYear, journal.fiscalYear),
    ));
  }
  return journal;
}

async function linkJournal(
  tx: Tx, client: string, by: string, materialDocumentNumber: string, role: string, companyCode: string,
  journal: { documentNumber: string; fiscalYear: number },
): Promise<void> {
  await tx.insert(materialDocumentJournal).values({
    client, materialDocumentNumber, role, companyCode,
    journalDocumentNumber: journal.documentNumber, fiscalYear: journal.fiscalYear, createdBy: by,
  });
}

/**
 * Reverse every accounting document a material document wrote, by its own links (and, for a document
 * that predates the link table, its single header journal). Each reversal runs the canonical reversal in
 * the original company, at the original amounts and rate. The trading partner is carried onto the
 * reversal's lines. Returns the reversal journals so the caller can link them under the same roles.
 */
async function reverseLinkedJournals(
  tx: Tx, client: string, by: string, original: typeof materialDocument.$inferSelect,
  postingDate: string, reason: string, transactionCode: string,
): Promise<Array<{ role: string; companyCode: string; documentNumber: string; fiscalYear: number }>> {
  const links = await tx.select().from(materialDocumentJournal).where(and(
    eq(materialDocumentJournal.client, client),
    eq(materialDocumentJournal.materialDocumentNumber, original.materialDocumentNumber),
  )).orderBy(materialDocumentJournal.role);
  const out: Array<{ role: string; companyCode: string; documentNumber: string; fiscalYear: number }> = [];
  for (const link of links) {
    const reversed = await adopt(() => reverseJournalEntry(tx, {
      client, documentNumber: link.journalDocumentNumber, fiscalYear: link.fiscalYear,
      reversalDate: postingDate, reason, reversedBy: by, transactionCode,
    }));
    // Carry the trading partner of each original line onto its mirror (lines mirror in order).
    await tx.execute(sql`
      update journal_entry_line r set trading_partner_company = o.trading_partner_company
        from journal_entry_line o
       where o.client = ${client} and o.document_number = ${link.journalDocumentNumber} and o.fiscal_year = ${link.fiscalYear}
         and r.client = ${client} and r.document_number = ${reversed.documentNumber} and r.fiscal_year = ${reversed.fiscalYear}
         and r.line_number = o.line_number and o.trading_partner_company is not null
    `);
    out.push({ role: link.role, companyCode: link.companyCode, documentNumber: reversed.documentNumber, fiscalYear: reversed.fiscalYear });
  }
  if (links.length === 0 && original.journalDocumentNumber) {
    throw new StockTransportError(
      `Material document ${original.materialDocumentNumber} carries a journal that is not linked to it.`,
      'The accounting of this document cannot be reversed safely; nothing was posted.',
    );
  }
  return out;
}

// ── 351 goods issue ─────────────────────────────────────────────────────────────────────────────────

export interface StoIssueItemInput {
  itemNumber: number;
  quantity: string | number;
  entryUnit?: string;
  storageLocation: string;
  batch?: string;
}

export interface PostStoIssueInput {
  client: string;
  changedBy: string;
  orderNumber: string;
  items: StoIssueItemInput[];
  postingDate: string;
  documentDate: string;
  headerText?: string;
  requestKey: string;
}

function validateCommon(input: { postingDate: string; documentDate: string; headerText?: string; requestKey: string; orderNumber: string }): void {
  requireDate(input.postingDate, 'The posting date');
  requireDate(input.documentDate, 'The document date');
  if ((input.headerText ?? '').length > 25) {
    throw new StockTransportError('The header text is longer than 25 characters.', 'Shorten the header text.');
  }
  if (!input.requestKey?.trim()) throw new StockTransportError('A request key is required.', 'Post through the screen, which supplies one.');
  if (!input.orderNumber?.trim()) throw new StockTransportError('A stock transport order number is required.', 'Enter the order number.');
}

export async function postStoIssue(
  input: PostStoIssueInput, options?: { authorization?: ServiceAuthorityContext },
): Promise<StoDocumentView> {
  validateCommon(input);
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new StockTransportError('Name at least one item to issue.', 'Enter the item number and the quantity to issue.');
  }
  const duplicate = input.items.map((i) => `${i.itemNumber}|${(i.batch ?? '').trim().toUpperCase()}|${i.storageLocation.trim()}`);
  if (new Set(duplicate).size !== duplicate.length) {
    throw new StockTransportError('An item is named twice with the same location and batch.', 'Combine the quantities into one line.');
  }
  const parsed = input.items.map((i) => ({ ...i, quantityScaled: parseQuantity(i.quantity, `Quantity for item ${i.itemNumber}`) }));
  return withTenant(input.client, (tx) => adopt(() => postStoIssueInTx(tx, input, parsed, options?.authorization)));
}

async function postStoIssueInTx(
  tx: Tx, input: PostStoIssueInput,
  items: Array<StoIssueItemInput & { quantityScaled: bigint }>,
  authorization: ServiceAuthorityContext | undefined,
): Promise<StoDocumentView> {
  const client = input.client;
  const by = input.changedBy;
  await assertTenantScope(tx, client);
  const authority = await verifyServiceAuthorityInTx(tx, client, authorization, STO_ISSUE_CAPABILITY);
  if (!authority.ok) throw new StockTransportError(authority.refusal.message, authority.refusal.remedy);
  await lockRequestKey(tx, client, input.requestKey);
  const fingerprint = postingFingerprint([
    'STO-GI', input.orderNumber.trim(), input.postingDate, input.documentDate, input.headerText ?? '',
    ...items.map((i) => `${i.itemNumber}|${qs(i.quantityScaled)}|${i.entryUnit ?? ''}|${i.storageLocation.trim()}|${(i.batch ?? '').trim().toUpperCase()}`).sort(),
  ]);
  const replay = await replayOrRefuse(tx, client, input.requestKey, fingerprint);
  if (replay) return replay;

  await ensureMovements(tx, client, by);
  // Pre-read for the lock scope: the materials are the order items'. The order is read again, locked.
  const preRows = await tx.execute(sql`
    select i.material_number, po.supplying_plant, i.plant from purchase_order_item i
      join purchase_order po on po.client = i.client and po.order_number = i.order_number
     where i.client = ${client} and i.order_number = ${input.orderNumber}
       and i.item_number in (${sql.join(items.map((i) => sql`${i.itemNumber}`), sql`, `)})
  `) as unknown as Array<{ material_number: string; supplying_plant: string | null; plant: string }>;
  if (preRows.length === 0) {
    throw new StockTransportError(`Purchase order ${input.orderNumber} or the named items do not exist.`, 'Check the order and item numbers.');
  }
  const plants = preRows.flatMap((r) => [r.plant, r.supplying_plant ?? '']).filter(Boolean);
  for (const plantCode of new Set(plants)) {
    const refusal = await refusePlantOutsideScopeInTx(tx, client, plantCode, authority.restrictions);
    if (refusal) throw new StockTransportError(refusal.message, refusal.remedy);
  }
  await lockStockScope(tx, client, preRows.map((r) => r.material_number), 'EXCLUSIVE');
  const { header, items: loaded } = await loadStoForPosting(tx, client, input.orderNumber, items.map((i) => i.itemNumber), true);
  const supplyingPlant = header.supplyingPlant!;

  await assertDocumentReleased(tx, client, 'PURCHASE_ORDER', input.orderNumber, 'Stock transport order');

  // Item and plant facts come from the order, never from the request.
  const supplying = await loadPlantFor(tx, client, supplyingPlant, 'supplying');
  const sendingCompany = await companyFor(tx, client, supplying.companyCode);
  const sameCompany = supplying.companyCode === header.companyCode;
  const prepared: Array<{
    item: LoadedItem; input: StoIssueItemInput & { quantityScaled: bigint }; baseQty: bigint; batch: string;
    receiving: Awaited<ReturnType<typeof loadPlantFor>>; location: string;
    issuingValuation: typeof materialValuation.$inferSelect; receivingValuation: typeof materialValuation.$inferSelect;
    issueValue: bigint; transitValue: bigint; rate: string; sourceCurrency: string; receivingCurrency: string;
    issueAccount: string; receivingAccount: string; sourceDecimals: number;
  }> = [];
  const receivingCompanyRow = await companyFor(tx, client, header.companyCode);

  // One rate per document and currency pair, drawn once.
  let rateCache: string | null = null;
  const claimed = new Map<string, bigint>();

  for (const entry of items) {
    const item = loaded.find((l) => l.row.itemNumber === entry.itemNumber)!;
    if (item.row.markedForDeletion) {
      throw new StockTransportError(`Item ${item.row.itemNumber} of order ${input.orderNumber} is flagged for deletion.`, 'Cancel the deletion flag, or choose another item.');
    }
    if (item.row.deliveryCompleted) {
      throw new StockTransportError(`Item ${item.row.itemNumber} of order ${input.orderNumber} is marked delivery completed.`, 'Clear the delivery-completed indicator, or choose another item.');
    }
    const materialNumber = item.row.materialNumber!;
    let baseQty = entry.quantityScaled;
    const entryUnit = (entry.entryUnit ?? item.row.unit).trim() || item.row.unit;
    if (entryUnit !== item.baseUnit) {
      const conversion = await toBaseQuantity(tx, client, {
        materialNumber, quantity: Number(qs(entry.quantityScaled)), entryUnit,
      });
      const text = conversion.baseQuantity.toFixed(Q);
      if (Math.abs(Number(text) - conversion.baseQuantity) > 1e-9) {
        throw new StockTransportError(
          `${qs(entry.quantityScaled)} ${entryUnit} of ${materialNumber} does not convert to a base quantity of at most three decimals.`,
          'Enter a quantity that converts exactly, or issue in the base unit.',
        );
      }
      baseQty = q3(text);
    }
    if (item.orderedBase - item.netIssued < baseQty) {
      throw new StockTransportError(
        `Item ${item.row.itemNumber} of order ${input.orderNumber}: ordered ${qs(item.orderedBase)} ${item.baseUnit}, already issued ${qs(item.netIssued)}, issueable ${qs(item.orderedBase - item.netIssued > 0n ? item.orderedBase - item.netIssued : 0n)}; ${qs(baseQty)} was asked.`,
        'Issue no more than the open quantity. An over-issue is not supported; raise the order quantity first.',
      );
    }
    const receiving = await loadPlantFor(tx, client, item.row.plant, 'receiving');
    if (receiving.companyCode !== header.companyCode) {
      throw new StockTransportError(
        `Receiving plant ${item.row.plant} of item ${item.row.itemNumber} no longer belongs to company ${header.companyCode} of the order.`,
        'Correct the plant assignment or the order, then issue again.',
      );
    }
    if (item.row.plant === supplyingPlant) {
      throw new StockTransportError('The supplying and the receiving plant are the same.', 'A stock transport order moves between two plants.');
    }
    for (const [plantCode, role] of [[supplyingPlant, 'supplying'], [item.row.plant, 'receiving']] as const) {
      const [ext] = await tx.select().from(materialPlant).where(and(
        eq(materialPlant.client, client), eq(materialPlant.materialNumber, materialNumber), eq(materialPlant.plant, plantCode),
      ));
      if (!ext || ext.markedForDeletion) {
        throw new StockTransportError(
          `Material ${materialNumber} is not usable in ${role} plant ${plantCode}.`,
          `Extend the material to plant ${plantCode} (and clear any deletion flag), then issue.`,
        );
      }
    }
    const issuingValuation = await valuationOf(tx, client, materialNumber, supplyingPlant, 'supplying');
    const receivingValuation = await valuationOf(tx, client, materialNumber, item.row.plant, 'receiving');

    const issuingLocation = await adopt(() => loadStorageLocation(tx, client, supplyingPlant, entry.storageLocation, 'issuing'));
    const batch = await adopt(() => resolvePostingBatch(tx, {
      client, materialNumber, plant: supplyingPlant, batch: entry.batch, postingDate: input.postingDate,
    }));
    await adopt(() => resolvePostingBatch(tx, {
      client, materialNumber, plant: item.row.plant, batch: entry.batch, postingDate: input.postingDate,
    }));
    for (const [plantCode, location] of [[supplyingPlant, issuingLocation.storageLocation], [item.row.plant, null]] as const) {
      await adopt(() => assertInventoryCountOpen(tx, client, { materialNumber, plant: plantCode, storageLocation: location, batch }));
    }

    // Stock: the issuing side must cover everything claimed from this location, unless it permits a negative.
    const stockKey: StockKey = { material: materialNumber, plant: supplyingPlant, location: issuingLocation.storageLocation, stockType: 'UNRESTRICTED', batch };
    const claimKey = `${materialNumber}|${issuingLocation.storageLocation}|${batch}`;
    const total = (claimed.get(claimKey) ?? 0n) + baseQty;
    claimed.set(claimKey, total);
    const held = await stockHeld(tx, client, stockKey);
    if (held < total && !issuingLocation.allowNegativeStock) {
      throw new StockTransportError(
        `Stock of ${materialNumber} (UNRESTRICTED) in storage location ${issuingLocation.storageLocation} of plant ${supplyingPlant} is ${qs(held)}, short of the ${qs(total)} to issue.`,
        'Reduce the quantity to what stands, or release negative stock on the issuing storage location.',
      );
    }

    // Valuation at the moment of issue: the supplying plant's price control, never a vendor price.
    const sourceCurrency = issuingValuation.currency.trim();
    const receivingCurrency = receivingValuation.currency.trim();
    if (sourceCurrency !== sendingCompany.currency) {
      throw new StockTransportError(
        `The valuation of ${materialNumber} in plant ${supplyingPlant} is kept in ${sourceCurrency}, not in the company currency ${sendingCompany.currency} of company ${supplying.companyCode}.`,
        'Align the plant valuation currency with its company, then issue.',
      );
    }
    if (receivingCurrency !== receivingCompanyRow.currency) {
      throw new StockTransportError(
        `The valuation of ${materialNumber} in plant ${item.row.plant} is kept in ${receivingCurrency}, not in the company currency ${receivingCompanyRow.currency} of company ${header.companyCode}.`,
        'Align the plant valuation currency with its company, then issue.',
      );
    }
    const decimals = await currencyDecimals(tx, sourceCurrency);
    const price = issuingValuation.priceControl === 'STANDARD' ? m4(issuingValuation.standardPrice) : m4(issuingValuation.movingAveragePrice);
    let issueValue = valueOf(baseQty, price, q3(issuingValuation.priceUnit), decimals);
    const bookQty = q3(issuingValuation.totalStockQuantity);
    const bookValue = m4(issuingValuation.stockValue);
    // The valuation cannot give up more than it carries: the last unit takes the whole remaining value.
    if (baseQty >= bookQty || issueValue > bookValue) issueValue = bookValue;

    let rate = '1.00000000';
    let transitValue = issueValue;
    if (sourceCurrency !== receivingCurrency) {
      if (sameCompany) {
        throw new StockTransportError(
          'The two plants of one company are valued in different currencies.',
          'Plants of one company code are valued in its currency; correct the plant valuation.',
        );
      }
      if (rateCache === null) {
        const found = await adopt(() => rateToLocal(tx, client, sourceCurrency, receivingCurrency, input.postingDate));
        if (found === null) {
          throw new StockTransportError(
            `No AVERAGE exchange rate stands from ${sourceCurrency} to ${receivingCurrency} on or before ${input.postingDate}.`,
            'Maintain the exchange rate, then issue. Nothing was posted.',
          );
        }
        rateCache = found.toFixed(8);
      }
      rate = rateCache;
      transitValue = roundToDecimals(multiplyScaled(issueValue, rate, M), await currencyDecimals(tx, receivingCurrency));
    }

    const issueAccount = await adopt(() => resolveAccount(tx, client, sendingCompany.chartOfAccounts, 'INVENTORY', issuingValuation.valuationClass ?? ''));
    const receivingAccount = await adopt(() => resolveAccount(tx, client, receivingCompanyRow.chartOfAccounts, 'INVENTORY', receivingValuation.valuationClass ?? ''));
    await assertPostable(tx, client, sendingCompany, issueAccount, 'inventory');
    await assertPostable(tx, client, receivingCompanyRow, receivingAccount, 'inventory');

    prepared.push({
      item, input: entry, baseQty, batch, receiving, location: issuingLocation.storageLocation,
      issuingValuation, receivingValuation, issueValue, transitValue, rate, sourceCurrency, receivingCurrency,
      issueAccount, receivingAccount, sourceDecimals: decimals,
    });
  }

  // Both periods are judged before anything is written (material period here, FI period in the posting).
  const sendingPeriod = await adopt(() => judgePeriod(tx, client, supplyingPlant, input.postingDate));
  const receivingPeriod = sameCompany
    ? sendingPeriod
    : await adopt(() => judgePeriod(tx, client, prepared[0].item.row.plant, input.postingDate));

  const refused = await batchClassificationRefusal(tx, client, STO_MOVEMENTS.ISSUE.movementType);
  if (refused) throw new StockTransportError(refused.message, refused.remedy);

  const allocated = await allocateNumber(tx, { client, objectCode: 'MATDOC', allocatedBy: by });
  const number = allocated.display;

  // ── Accounting ────────────────────────────────────────────────────────────────
  const journalLinks: Array<{ role: 'SENDING' | 'RECEIVING'; company: string; journal: { documentNumber: string; fiscalYear: number } }> = [];
  const reference = `STO ${input.orderNumber}`;
  if (!sameCompany) {
    const [pair] = await tx.execute(sql`
      select sending_clearing_gl, receiving_clearing_gl from intercompany_clearing_config
       where client = ${client} and sending_company_code = ${supplying.companyCode} and receiving_company_code = ${header.companyCode}
    `) as unknown as Array<{ sending_clearing_gl: string | null; receiving_clearing_gl: string | null }>;
    const sendingClearing = await adopt(() => clearingAccountFor(tx, client, supplying.companyCode, pair?.sending_clearing_gl ?? null));
    const receivingClearing = await adopt(() => clearingAccountFor(tx, client, header.companyCode, pair?.receiving_clearing_gl ?? null));
    await assertPostable(tx, client, sendingCompany, sendingClearing, 'clearing');
    await assertPostable(tx, client, receivingCompanyRow, receivingClearing, 'clearing');
    const rate = prepared[0].rate;
    const sourceCurrency = prepared[0].sourceCurrency;
    // Sending company: Dr clearing (it is owed the value), Cr the supplying plant's own inventory.
    const sendTotal = prepared.reduce((s, p) => s + p.issueValue, 0n);
    const sendingLines: JournalLine[] = [
      { glAccount: sendingClearing, debitCredit: 'S', amount: ms(sendTotal), amountLocal: ms(sendTotal), lineText: `STO clearing with ${header.companyCode}` },
      ...prepared.map((p) => ({
        glAccount: p.issueAccount, debitCredit: 'H' as const, amount: ms(p.issueValue), amountLocal: ms(p.issueValue),
        material: p.item.row.materialNumber!, plant: supplyingPlant, lineText: `STO ${input.orderNumber}/${p.item.row.itemNumber}`,
      })),
    ];
    const sendJournal = await postLinkedJournal(tx, client, by, {
      materialDocument: number, role: 'SENDING', company: sendingCompany, position: sendingPeriod.position,
      documentType: ISSUE_JOURNAL_TYPE, documentDate: input.documentDate, postingDate: input.postingDate,
      currency: sourceCurrency, exchangeRate: '1', headerText: input.headerText, reference, lines: sendingLines,
      tradingPartner: header.companyCode, transactionCode: STO_ISSUE_CAPABILITY,
    });
    // Receiving company: Dr the receiving plant's OWN inventory account, Cr its clearing. Documented rounding:
    // each item's local value is rounded once; the clearing line carries the sum, so the document balances
    // in transaction and in local currency alike.
    const localTotal = prepared.reduce((s, p) => s + p.transitValue, 0n);
    const receivingLines: JournalLine[] = [
      ...prepared.map((p) => ({
        glAccount: p.receivingAccount, debitCredit: 'S' as const, amount: ms(p.issueValue), amountLocal: ms(p.transitValue),
        material: p.item.row.materialNumber!, plant: p.item.row.plant, lineText: `STO ${input.orderNumber}/${p.item.row.itemNumber} in transit`,
      })),
      { glAccount: receivingClearing, debitCredit: 'H', amount: ms(sendTotal), amountLocal: ms(localTotal), lineText: `STO clearing with ${supplying.companyCode}` },
    ];
    const receiveJournal = await postLinkedJournal(tx, client, by, {
      materialDocument: number, role: 'RECEIVING', company: receivingCompanyRow, position: receivingPeriod.position,
      documentType: ISSUE_JOURNAL_TYPE, documentDate: input.documentDate, postingDate: input.postingDate,
      currency: sourceCurrency, exchangeRate: rate, headerText: input.headerText, reference, lines: receivingLines,
      tradingPartner: supplying.companyCode, transactionCode: STO_ISSUE_CAPABILITY,
    });
    journalLinks.push({ role: 'SENDING', company: supplying.companyCode, journal: sendJournal });
    journalLinks.push({ role: 'RECEIVING', company: header.companyCode, journal: receiveJournal });
  } else {
    const differing = prepared.filter((p) => p.issueAccount !== p.receivingAccount && p.issueValue !== 0n);
    if (differing.length > 0) {
      const lines: JournalLine[] = differing.flatMap((p) => [
        { glAccount: p.receivingAccount, debitCredit: 'S' as const, amount: ms(p.issueValue), amountLocal: ms(p.issueValue), material: p.item.row.materialNumber!, plant: p.item.row.plant, lineText: `STO ${input.orderNumber}/${p.item.row.itemNumber} in transit` },
        { glAccount: p.issueAccount, debitCredit: 'H' as const, amount: ms(p.issueValue), amountLocal: ms(p.issueValue), material: p.item.row.materialNumber!, plant: supplyingPlant },
      ]);
      const journal = await postLinkedJournal(tx, client, by, {
        materialDocument: number, role: 'SENDING', company: sendingCompany, position: sendingPeriod.position,
        documentType: ISSUE_JOURNAL_TYPE, documentDate: input.documentDate, postingDate: input.postingDate,
        currency: prepared[0].sourceCurrency, exchangeRate: '1', headerText: input.headerText, reference, lines,
        transactionCode: STO_ISSUE_CAPABILITY,
      });
      journalLinks.push({ role: 'SENDING', company: supplying.companyCode, journal });
    }
  }

  await tx.insert(materialDocument).values({
    client, materialDocumentNumber: number, documentYear: sendingPeriod.position.fiscalYear,
    documentDate: input.documentDate, postingDate: input.postingDate, headerText: input.headerText ?? null,
    status: 'POSTED', journalDocumentNumber: journalLinks[0]?.journal.documentNumber ?? null,
    requestKey: input.requestKey, requestFingerprint: fingerprint, createdBy: by,
  });
  for (const link of journalLinks) await linkJournal(tx, client, by, number, link.role, link.company, link.journal);

  // ── Lines, ledger, stock, valuation ──────────────────────────────────────────
  let lineNumber = 0;
  for (const p of prepared) {
    const materialNumber = p.item.row.materialNumber!;
    const entryUnit = (p.input.entryUnit ?? p.item.row.unit).trim() || p.item.row.unit;
    const issueLineNumber = ++lineNumber;
    const transitLineNumber = ++lineNumber;
    const common = {
      client, materialDocumentNumber: number, materialNumber, batchNumber: p.batch,
      entryQuantity: qs(p.input.quantityScaled), entryUnit, baseQuantity: qs(p.baseQty), baseUnit: p.item.baseUnit,
      priceUnit: '1', stoOrderNumber: input.orderNumber, stoOrderItem: p.item.row.itemNumber,
      stoIssueDocument: number, stoIssueLine: issueLineNumber, createdBy: by,
      itemText: `STO ${input.orderNumber}/${p.item.row.itemNumber} issue`,
    };
    await tx.insert(materialDocumentLine).values({
      ...common, lineNumber: issueLineNumber, movementType: STO_MOVEMENTS.ISSUE.movementType, lineDirection: 'ISSUE',
      plant: supplyingPlant, storageLocation: p.location, stockType: 'UNRESTRICTED',
      unitPrice: ms(divRound(p.issueValue * 1000n, p.baseQty)), currency: p.sourceCurrency, value: ms(p.issueValue),
    });
    await tx.insert(materialDocumentLine).values({
      ...common, lineNumber: transitLineNumber, movementType: STO_MOVEMENTS.ISSUE.movementType, lineDirection: 'RECEIPT',
      plant: p.item.row.plant, storageLocation: '', stockType: IN_TRANSIT,
      unitPrice: ms(divRound(p.transitValue * 1000n, p.baseQty)), currency: p.receivingCurrency, value: ms(p.transitValue),
    });
    await tx.insert(stoTransitAllocation).values({
      client, issueDocument: number, issueLine: issueLineNumber, orderNumber: input.orderNumber,
      itemNumber: p.item.row.itemNumber, materialNumber, supplyingPlant, receivingPlant: p.item.row.plant,
      batchNumber: p.batch, baseUnit: p.item.baseUnit, postingDate: input.postingDate,
      issuedQuantity: qs(p.baseQty), sendingCompany: supplying.companyCode, receivingCompany: header.companyCode,
      sourceCurrency: p.sourceCurrency, issueValue: ms(p.issueValue),
      receivingCurrency: p.receivingCurrency, transitValue: ms(p.transitValue), exchangeRate: p.rate, createdBy: by,
    });
    await moveStock(tx, client, by, { material: materialNumber, plant: supplyingPlant, location: p.location, stockType: 'UNRESTRICTED', batch: p.batch }, -p.baseQty);
    await moveStock(tx, client, by, { material: materialNumber, plant: p.item.row.plant, location: '', stockType: IN_TRANSIT, batch: p.batch }, p.baseQty);
    await bookValuation(tx, client, by, materialNumber, supplyingPlant, -p.baseQty, -p.issueValue);
    await bookValuation(tx, client, by, materialNumber, p.item.row.plant, p.baseQty, p.transitValue);
    await markPlanning(tx, client, by, materialNumber, supplyingPlant, `STO ${input.orderNumber} goods issue`);
    await markPlanning(tx, client, by, materialNumber, p.item.row.plant, `STO ${input.orderNumber} goods issue`);
  }

  await recordChange(tx, {
    client, objectClass: MATERIAL_DOCUMENT_CLASS, objectKey: number, changeType: 'CREATE', changedBy: by,
    transactionCode: STO_ISSUE_CAPABILITY,
    after: {
      movement: '351', order: input.orderNumber, crossCompany: !sameCompany,
      journals: journalLinks.map((l) => `${l.role}:${l.journal.documentNumber}`), status: 'POSTED',
    },
  });
  await noteBatchControlUse(tx, client, number, by);
  await recordOutputsForPostedDocument(tx, client, number, by);
  return (await documentView(tx, client, number))!;
}


/**
 * An account the STO posts to must exist in the company's chart, be extended to the company and not be
 * blocked for posting. The posting engine does not judge this, and a posting to an account the company
 * cannot use is refused here, before anything is written.
 */
async function assertPostable(
  tx: Tx, client: string, company: { companyCode: string; chartOfAccounts: string }, account: string, label: string,
): Promise<void> {
  const rows = await tx.execute(sql`
    select a.is_blocked_posting as chart_blocked, c.is_blocked_posting as company_blocked, c.gl_account as extended
      from gl_account a
      left join gl_account_company c on c.client = a.client and c.company_code = ${company.companyCode} and c.gl_account = a.account_number
     where a.client = ${client} and a.chart_of_accounts = ${company.chartOfAccounts} and a.account_number = ${account}
  `) as unknown as Array<{ chart_blocked: boolean; company_blocked: boolean | null; extended: string | null }>;
  if (!rows[0]) {
    throw new StockTransportError(`The ${label} account ${account} does not exist in the chart of accounts of company ${company.companyCode}.`, 'Maintain the account determination, then post.');
  }
  if (!rows[0].extended) {
    throw new StockTransportError(`The ${label} account ${account} is not extended to company ${company.companyCode}.`, 'Extend the account to the company code, then post.');
  }
  if (rows[0].chart_blocked || rows[0].company_blocked) {
    throw new StockTransportError(`The ${label} account ${account} is blocked for posting in company ${company.companyCode}.`, 'Unblock the account or change the account determination, then post.');
  }
}

async function loadPlantFor(tx: Tx, client: string, plantCode: string, role: string) {
  const [row] = await tx.execute(sql`
    select plant, company_code, is_storage_site from plant where client = ${client} and plant = ${plantCode}
  `) as unknown as Array<{ plant: string; company_code: string | null; is_storage_site: boolean }>;
  if (!row) throw new StockTransportError(`Plant ${plantCode} does not exist.`, `Enter a ${role} plant that stands in the enterprise structure.`);
  if (!row.company_code) throw new StockTransportError(`Plant ${plantCode} carries no company code.`, 'Assign the plant to a company code.');
  if (!row.is_storage_site) throw new StockTransportError(`Plant ${plantCode} is not a storage site.`, 'Choose a plant that carries storage locations.');
  return { plant: row.plant, companyCode: row.company_code };
}

async function companyFor(tx: Tx, client: string, companyCodeKey: string) {
  const company = await getCompanyCode(tx, client, companyCodeKey);
  if (!company || !company.isActive) {
    throw new StockTransportError(`Company code ${companyCodeKey} does not stand or is inactive.`, 'Maintain the company code, then post.');
  }
  if (!company.chartOfAccounts?.trim() || !company.currency?.trim() || !company.fiscalYearVariant) {
    throw new StockTransportError(`Company code ${companyCodeKey} lacks a chart of accounts, a currency or a fiscal-year variant.`, 'Complete the company code, then post.');
  }
  return { companyCode: companyCodeKey, chartOfAccounts: company.chartOfAccounts.trim(), currency: company.currency.trim(), isActive: true };
}

async function valuationOf(tx: Tx, client: string, materialNumber: string, plantCode: string, role: string) {
  const [valuation] = await tx.select().from(materialValuation).where(and(
    eq(materialValuation.client, client), eq(materialValuation.materialNumber, materialNumber),
    eq(materialValuation.valuationArea, plantCode),
  ));
  if (!valuation?.valuationClass) {
    throw new StockTransportError(
      `Material ${materialNumber} carries no valuation in ${role} plant ${plantCode}.`,
      'Complete the material valuation data, then post.',
    );
  }
  return valuation;
}

// ── 101 goods receipt ───────────────────────────────────────────────────────────────────────────────

export interface StoReceiptLineInput {
  itemNumber: number;
  quantity: string | number;
  entryUnit?: string;
  storageLocation: string;
  batch?: string;
}

export interface PostStoReceiptInput {
  client: string;
  changedBy: string;
  orderNumber: string;
  lines: StoReceiptLineInput[];
  postingDate: string;
  documentDate: string;
  headerText?: string;
  requestKey: string;
}

export async function postStoReceipt(
  input: PostStoReceiptInput, options?: { authorization?: ServiceAuthorityContext },
): Promise<StoDocumentView> {
  validateCommon(input);
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new StockTransportError('Enter a quantity to receive on at least one item.', 'Enter the quantity received from transit.');
  }
  const keys = input.lines.map((l) => `${l.itemNumber}|${(l.batch ?? '').trim().toUpperCase()}|${l.storageLocation.trim()}`);
  if (new Set(keys).size !== keys.length) {
    throw new StockTransportError('An item is named twice with the same location and batch.', 'Combine the quantities into one line.');
  }
  const parsed = input.lines.map((l) => ({ ...l, quantityScaled: parseQuantity(l.quantity, `Quantity for item ${l.itemNumber}`) }));
  return withTenant(input.client, (tx) => adopt(() => postStoReceiptInTx(tx, input, parsed, options?.authorization)));
}

async function postStoReceiptInTx(
  tx: Tx, input: PostStoReceiptInput,
  lines: Array<StoReceiptLineInput & { quantityScaled: bigint }>,
  authorization: ServiceAuthorityContext | undefined,
): Promise<StoDocumentView> {
  const client = input.client;
  const by = input.changedBy;
  await assertTenantScope(tx, client);
  const authority = await verifyServiceAuthorityInTx(tx, client, authorization, STO_RECEIPT_CAPABILITY);
  if (!authority.ok) throw new StockTransportError(authority.refusal.message, authority.refusal.remedy);
  await lockRequestKey(tx, client, input.requestKey);
  const fingerprint = postingFingerprint([
    'STO-GR', input.orderNumber.trim(), input.postingDate, input.documentDate, input.headerText ?? '',
    ...lines.map((l) => `${l.itemNumber}|${qs(l.quantityScaled)}|${l.entryUnit ?? ''}|${l.storageLocation.trim()}|${(l.batch ?? '').trim().toUpperCase()}`).sort(),
  ]);
  const replay = await replayOrRefuse(tx, client, input.requestKey, fingerprint);
  if (replay) return replay;
  await ensureMovements(tx, client, by);

  const preRows = await tx.execute(sql`
    select i.material_number, i.plant from purchase_order_item i
     where i.client = ${client} and i.order_number = ${input.orderNumber}
       and i.item_number in (${sql.join(lines.map((l) => sql`${l.itemNumber}`), sql`, `)})
  `) as unknown as Array<{ material_number: string; plant: string }>;
  if (preRows.length === 0) throw new StockTransportError(`Purchase order ${input.orderNumber} or the named items do not exist.`, 'Check the order and item numbers.');
  for (const plantCode of new Set(preRows.map((r) => r.plant))) {
    const refusal = await refusePlantOutsideScopeInTx(tx, client, plantCode, authority.restrictions);
    if (refusal) throw new StockTransportError(refusal.message, refusal.remedy);
  }
  await lockStockScope(tx, client, preRows.map((r) => r.material_number), 'EXCLUSIVE');
  const { header, items } = await loadStoForPosting(tx, client, input.orderNumber, lines.map((l) => l.itemNumber), true);
  const receivingCompany = await companyFor(tx, client, header.companyCode);

  interface Piece {
    line: StoReceiptLineInput & { quantityScaled: bigint }; item: LoadedItem; location: string; batch: string;
    alloc: typeof stoTransitAllocation.$inferSelect; part: bigint; partValue: bigint; diff: bigint; stdValue: bigint;
    valuation: typeof materialValuation.$inferSelect; baseUnit: string; entryUnit: string; entryPart: string;
  }
  const pieces: Piece[] = [];
  const claimedStock = new Map<string, bigint>();

  for (const line of lines) {
    const item = items.find((i) => i.row.itemNumber === line.itemNumber)!;
    const materialNumber = item.row.materialNumber!;
    const plantCode = item.row.plant;
    if (item.row.markedForDeletion) {
      throw new StockTransportError(`Item ${item.row.itemNumber} of order ${input.orderNumber} is flagged for deletion.`, 'Cancel the deletion flag first.');
    }
    await loadPlantFor(tx, client, plantCode, 'receiving');
    const location = await adopt(() => loadStorageLocation(tx, client, plantCode, line.storageLocation, 'receiving'));
    let baseQty = line.quantityScaled;
    const entryUnit = (line.entryUnit ?? item.row.unit).trim() || item.row.unit;
    if (entryUnit !== item.baseUnit) {
      const conversion = await toBaseQuantity(tx, client, { materialNumber, quantity: Number(qs(line.quantityScaled)), entryUnit });
      const text = conversion.baseQuantity.toFixed(Q);
      if (Math.abs(Number(text) - conversion.baseQuantity) > 1e-9) {
        throw new StockTransportError(`${qs(line.quantityScaled)} ${entryUnit} does not convert to a base quantity of at most three decimals.`, 'Receive in the base unit.');
      }
      baseQty = q3(text);
    }
    const typedBatch = (line.batch ?? '').trim().toUpperCase();
    const outstanding = await tx.select().from(stoTransitAllocation).where(and(
      eq(stoTransitAllocation.client, client), eq(stoTransitAllocation.orderNumber, input.orderNumber),
      eq(stoTransitAllocation.itemNumber, item.row.itemNumber),
      sql`${stoTransitAllocation.issuedQuantity} - ${stoTransitAllocation.reversedQuantity} - ${stoTransitAllocation.receivedQuantity} > 0`,
    )).orderBy(stoTransitAllocation.postingDate, stoTransitAllocation.issueDocument, stoTransitAllocation.issueLine).for('update');
    const batches = [...new Set(outstanding.map((a) => a.batchNumber))];
    if (outstanding.length === 0) {
      throw new StockTransportError(
        `Nothing is in transit for item ${item.row.itemNumber} of order ${input.orderNumber}.`,
        'Issue the goods (351) first; a receipt takes only what stands in transit.',
      );
    }
    let batch = typedBatch;
    if (!batch && batches.length === 1) batch = batches[0];
    if (!batch && batches.length > 1) {
      throw new StockTransportError(
        `Item ${item.row.itemNumber} stands in transit in several batches (${batches.map((b) => b || '(none)').join(', ')}).`,
        'Name the batch you are receiving.',
      );
    }
    await adopt(() => resolvePostingBatch(tx, { client, materialNumber, plant: plantCode, batch, postingDate: input.postingDate }));
    const usable = outstanding.filter((a) => a.batchNumber === batch);
    const available = usable.reduce((s, a) => s + q3(a.issuedQuantity) - q3(a.reversedQuantity) - q3(a.receivedQuantity) - (consumed(pieces, a)), 0n);
    if (available < baseQty) {
      throw new StockTransportError(
        `Item ${item.row.itemNumber}${batch ? ` batch ${batch}` : ''}: ${qs(available > 0n ? available : 0n)} ${item.baseUnit} stands in transit, ${qs(baseQty)} was asked.`,
        'Receive no more than stands in transit, in a batch that was issued.',
      );
    }
    await adopt(() => assertInventoryCountOpen(tx, client, { materialNumber, plant: plantCode, storageLocation: location.storageLocation, batch }));
    const valuation = await valuationOf(tx, client, materialNumber, plantCode, 'receiving');
    const decimals = await currencyDecimals(tx, valuation.currency.trim());
    // Deterministic FIFO: oldest posting date, then issue document and line.
    let remaining = baseQty;
    for (const alloc of usable) {
      if (remaining === 0n) break;
      const open = q3(alloc.issuedQuantity) - q3(alloc.reversedQuantity) - q3(alloc.receivedQuantity) - consumed(pieces, alloc);
      if (open <= 0n) continue;
      const part = remaining < open ? remaining : open;
      remaining -= part;
      // The last receipt of an allocation takes the value left; earlier ones take a rounded share.
      const finalPart = part === open;
      const alreadyValue = m4(alloc.receivedValue) + consumedValue(pieces, alloc);
      const partValue = finalPart
        ? m4(alloc.transitValue) - alreadyValue
        : roundToDecimals(divRound(m4(alloc.transitValue) * part, q3(alloc.issuedQuantity)), decimals);
      const stdValue = valuation.priceControl === 'STANDARD'
        ? valueOf(part, m4(valuation.standardPrice), q3(valuation.priceUnit), decimals)
        : partValue;
      pieces.push({
        line, item, location: location.storageLocation, batch, alloc, part, partValue,
        diff: stdValue - partValue, stdValue, valuation, baseUnit: item.baseUnit, entryUnit,
        entryPart: entryUnit === item.baseUnit ? qs(part) : qs(divRound(line.quantityScaled * part * 1000n, baseQty) / 1000n),
      });
      void stdValue;
    }
    const stockKey = `${materialNumber}|${plantCode}|${IN_TRANSIT}|${batch}`;
    const heldTransit = await stockHeld(tx, client, { material: materialNumber, plant: plantCode, location: '', stockType: IN_TRANSIT, batch });
    const claimTotal = (claimedStock.get(stockKey) ?? 0n) + baseQty;
    claimedStock.set(stockKey, claimTotal);
    if (heldTransit < claimTotal) {
      throw new StockTransportError(
        `The transit stock of ${materialNumber}${batch ? ` batch ${batch}` : ''} in plant ${plantCode} is ${qs(heldTransit)}, short of ${qs(claimTotal)}; the ledger and the stock disagree.`,
        'Do not post; ask the stock administrator to reconcile the transit stock.',
      );
    }
  }

  const { company, position } = await adopt(() => judgePeriod(tx, client, items[0].row.plant, input.postingDate));
  const refused = await batchClassificationRefusal(tx, client, STO_MOVEMENTS.RECEIPT.movementType);
  if (refused) throw new StockTransportError(refused.message, refused.remedy);
  const allocated = await allocateNumber(tx, { client, objectCode: 'MATDOC', allocatedBy: by });
  const number = allocated.display;

  // A standard-priced receiving plant books the difference at the receipt, in the receiving company.
  const diffPieces = pieces.filter((p) => p.diff !== 0n);
  const journalLinks: Array<{ role: string; company: string; journal: { documentNumber: string; fiscalYear: number } }> = [];
  if (diffPieces.length > 0) {
    const lines2: JournalLine[] = [];
    for (const p of diffPieces) {
      const inventory = await adopt(() => resolveAccount(tx, client, receivingCompany.chartOfAccounts, 'INVENTORY', p.valuation.valuationClass ?? ''));
      const price = await adopt(() => resolveAccount(tx, client, receivingCompany.chartOfAccounts, 'PRICE_DIFFERENCE', p.valuation.valuationClass ?? ''));
      await assertPostable(tx, client, receivingCompany, inventory, 'inventory');
      await assertPostable(tx, client, receivingCompany, price, 'price difference');
      const abs = p.diff < 0n ? -p.diff : p.diff;
      const up = p.diff > 0n;
      lines2.push(
        { glAccount: inventory, debitCredit: up ? 'S' : 'H', amount: ms(abs), amountLocal: ms(abs), material: p.item.row.materialNumber!, plant: p.item.row.plant, lineText: `STO ${input.orderNumber}/${p.item.row.itemNumber} price difference` },
        { glAccount: price, debitCredit: up ? 'H' : 'S', amount: ms(abs), amountLocal: ms(abs), material: p.item.row.materialNumber!, plant: p.item.row.plant },
      );
    }
    const journal = await postLinkedJournal(tx, client, by, {
      materialDocument: number, role: 'PRICE_DIFFERENCE', company: receivingCompany, position,
      documentType: RECEIPT_JOURNAL_TYPE, documentDate: input.documentDate, postingDate: input.postingDate,
      currency: company.currency, exchangeRate: '1', headerText: input.headerText, reference: `STO ${input.orderNumber}`,
      lines: lines2, transactionCode: STO_RECEIPT_CAPABILITY,
    });
    journalLinks.push({ role: 'PRICE_DIFFERENCE', company: header.companyCode, journal });
  }

  await tx.insert(materialDocument).values({
    client, materialDocumentNumber: number, documentYear: position.fiscalYear,
    documentDate: input.documentDate, postingDate: input.postingDate, headerText: input.headerText ?? null,
    status: 'POSTED', journalDocumentNumber: journalLinks[0]?.journal.documentNumber ?? null,
    requestKey: input.requestKey, requestFingerprint: fingerprint, createdBy: by,
  });
  for (const link of journalLinks) await linkJournal(tx, client, by, number, link.role, link.company, link.journal);

  let lineNumber = 0;
  for (const p of pieces) {
    const materialNumber = p.item.row.materialNumber!;
    const plantCode = p.item.row.plant;
    const currency = p.valuation.currency.trim();
    const common = {
      client, materialDocumentNumber: number, materialNumber, plant: plantCode, batchNumber: p.batch,
      entryQuantity: p.entryPart, entryUnit: p.entryUnit, baseQuantity: qs(p.part), baseUnit: p.baseUnit,
      priceUnit: '1', currency, stoOrderNumber: input.orderNumber, stoOrderItem: p.item.row.itemNumber,
      stoIssueDocument: p.alloc.issueDocument, stoIssueLine: p.alloc.issueLine, createdBy: by,
      itemText: `STO ${input.orderNumber}/${p.item.row.itemNumber} receipt`,
    };
    await tx.insert(materialDocumentLine).values({
      ...common, lineNumber: ++lineNumber, movementType: STO_MOVEMENTS.RECEIPT.movementType, lineDirection: 'ISSUE',
      storageLocation: '', stockType: IN_TRANSIT, unitPrice: ms(divRound(p.partValue * 1000n, p.part)), value: ms(p.partValue),
    });
    await tx.insert(materialDocumentLine).values({
      ...common, lineNumber: ++lineNumber, movementType: STO_MOVEMENTS.RECEIPT.movementType, lineDirection: 'RECEIPT',
      storageLocation: p.location, stockType: 'UNRESTRICTED',
      unitPrice: ms(divRound((p.partValue + p.diff) * 1000n, p.part)), value: ms(p.partValue + p.diff),
    });
    await tx.update(stoTransitAllocation).set({
      receivedQuantity: sql`${stoTransitAllocation.receivedQuantity} + ${qs(p.part)}::numeric`,
      receivedValue: sql`${stoTransitAllocation.receivedValue} + ${ms(p.partValue)}::numeric`,
      changedBy: by, changedAt: new Date(),
    }).where(and(
      eq(stoTransitAllocation.client, client), eq(stoTransitAllocation.issueDocument, p.alloc.issueDocument),
      eq(stoTransitAllocation.issueLine, p.alloc.issueLine),
    ));
    await moveStock(tx, client, by, { material: materialNumber, plant: plantCode, location: '', stockType: IN_TRANSIT, batch: p.batch }, -p.part);
    await moveStock(tx, client, by, { material: materialNumber, plant: plantCode, location: p.location, stockType: 'UNRESTRICTED', batch: p.batch }, p.part);
    // The goods stay inside one valuation area: only a standard-price difference changes its value.
    if (p.diff !== 0n) await bookValuation(tx, client, by, materialNumber, plantCode, 0n, p.diff);
    await markPlanning(tx, client, by, materialNumber, plantCode, `STO ${input.orderNumber} goods receipt`);
  }

  await recordChange(tx, {
    client, objectClass: MATERIAL_DOCUMENT_CLASS, objectKey: number, changeType: 'CREATE', changedBy: by,
    transactionCode: STO_RECEIPT_CAPABILITY,
    after: { movement: '101', order: input.orderNumber, journals: journalLinks.map((l) => l.journal.documentNumber), status: 'POSTED' },
  });
  await noteBatchControlUse(tx, client, number, by);
  await recordOutputsForPostedDocument(tx, client, number, by);
  return (await documentView(tx, client, number))!;
}

function consumed(pieces: Array<{ alloc: { issueDocument: string; issueLine: number }; part: bigint }>, a: { issueDocument: string; issueLine: number }): bigint {
  return pieces.filter((p) => p.alloc.issueDocument === a.issueDocument && p.alloc.issueLine === a.issueLine)
    .reduce((s, p) => s + p.part, 0n);
}
function consumedValue(pieces: Array<{ alloc: { issueDocument: string; issueLine: number }; partValue: bigint }>, a: { issueDocument: string; issueLine: number }): bigint {
  return pieces.filter((p) => p.alloc.issueDocument === a.issueDocument && p.alloc.issueLine === a.issueLine)
    .reduce((s, p) => s + p.partValue, 0n);
}

// ── 352 / 102 reversal ──────────────────────────────────────────────────────────────────────────────

export interface ReverseStoInput {
  client: string;
  changedBy: string;
  materialDocumentNumber: string;
  postingDate: string;
  documentDate: string;
  headerText?: string;
  requestKey: string;
  /** Selected lines. Only the whole document is supported; a subset is refused before any write. */
  lines?: number[];
}

/** Is this one of the STO documents this service owns? Cheap check for the generic reversal. */
export async function stoDocumentKind(tx: Tx, client: string, number: string): Promise<'ISSUE' | 'RECEIPT' | null> {
  const rows = await tx.execute(sql`
    select distinct movement_type from material_document_line
     where client = ${client} and material_document_number = ${number} and sto_order_number is not null
  `) as unknown as Array<{ movement_type: string }>;
  const types = rows.map((r) => r.movement_type);
  if (types.includes('STO_GI')) return 'ISSUE';
  if (types.includes('STO_GR')) return 'RECEIPT';
  if (types.length > 0) return null;
  return null;
}

export async function reverseStoDocument(
  input: ReverseStoInput, options?: { authorization?: ServiceAuthorityContext },
): Promise<StoDocumentView> {
  requireDate(input.postingDate, 'The posting date');
  requireDate(input.documentDate, 'The document date');
  if ((input.headerText ?? '').length > 25) {
    throw new StockTransportError('The header text is longer than 25 characters.', 'Shorten the header text.');
  }
  return withTenant(input.client, (tx) => adopt(() => reverseStoDocumentInTx(tx, input, options?.authorization)));
}

export async function reverseStoDocumentInTx(
  tx: Tx, input: ReverseStoInput, authorization: ServiceAuthorityContext | undefined,
): Promise<StoDocumentView> {
  const client = input.client;
  const by = input.changedBy;
  await assertTenantScope(tx, client);
  const fingerprint = postingFingerprint([
    'STO-REV', input.materialDocumentNumber.trim(), input.postingDate, input.documentDate, input.headerText ?? '',
    ...(input.lines ?? []).map(String).sort(),
  ]);
  const authority = await verifyServiceAuthorityInTx(tx, client, authorization, STO_REVERSE_CAPABILITY);
  if (!authority.ok) throw new StockTransportError(authority.refusal.message, authority.refusal.remedy);
  await lockRequestKey(tx, client, input.requestKey);
  const replay = await replayOrRefuse(tx, client, input.requestKey, fingerprint);
  if (replay) return replay;
  await ensureMovements(tx, client, by);

  const [original] = await tx.select().from(materialDocument).where(and(
    eq(materialDocument.client, client), eq(materialDocument.materialDocumentNumber, input.materialDocumentNumber),
  ));
  if (!original) throw new StockTransportError(`Material document ${input.materialDocumentNumber || '(empty)'} does not exist.`, 'Check the document number.');
  const kind = await stoDocumentKind(tx, client, input.materialDocumentNumber);
  if (!kind) {
    throw new StockTransportError(`Material document ${input.materialDocumentNumber} is not a stock transport order goods issue or receipt.`, 'Reverse it on the material document reversal screen.');
  }
  if (original.reversalOf) {
    throw new StockTransportError(`Material document ${input.materialDocumentNumber} is itself a reversal.`, 'Reverse the original document, never its reversal.');
  }
  const lines = await tx.select().from(materialDocumentLine).where(and(
    eq(materialDocumentLine.client, client), eq(materialDocumentLine.materialDocumentNumber, input.materialDocumentNumber),
  )).orderBy(materialDocumentLine.lineNumber);
  if (input.lines && input.lines.length > 0 && input.lines.length !== lines.length) {
    throw new StockTransportError(
      'A stock transport movement is reversed as a whole document. A partial-line reversal is not supported: it could not keep the paired quantities, values and both companies\' journals consistent.',
      'Reverse the whole document, then post the quantity you want again.',
    );
  }
  const orderNumber = lines[0].stoOrderNumber!;
  const itemNumbers = [...new Set(lines.map((l) => l.stoOrderItem!))];
  const plantsTouched = [...new Set(lines.map((l) => l.plant))];
  if (kind === 'ISSUE') {
    // A 352 undoes accounting in the sending and the receiving company: the actor needs both.
    const [orderRow] = await tx.select().from(purchaseOrder).where(and(eq(purchaseOrder.client, client), eq(purchaseOrder.orderNumber, orderNumber)));
    if (orderRow?.supplyingPlant) plantsTouched.push(orderRow.supplyingPlant);
  }
  for (const plantCode of new Set(plantsTouched)) {
    const refusal = await refusePlantOutsideScopeInTx(tx, client, plantCode, authority.restrictions);
    if (refusal) throw new StockTransportError(refusal.message, refusal.remedy);
  }
  await lockStockScope(tx, client, lines.map((l) => l.materialNumber), 'EXCLUSIVE');
  await lockOrder(tx, client, orderNumber);
  await tx.execute(sql`
    select 1 from purchase_order_item where client = ${client} and order_number = ${orderNumber}
       and item_number in (${sql.join(itemNumbers.map((n) => sql`${n}`), sql`, `)}) order by item_number for update
  `);
  const [locked] = await tx.select().from(materialDocument).where(and(
    eq(materialDocument.client, client), eq(materialDocument.materialDocumentNumber, input.materialDocumentNumber),
  )).for('update');
  if (locked.status === 'REVERSED') {
    throw new StockTransportError(`Material document ${input.materialDocumentNumber} has already been reversed by ${locked.reversedBy}.`, 'A document is reversed once.');
  }
  const counterType = kind === 'ISSUE' ? STO_MOVEMENTS.ISSUE_REV.movementType : STO_MOVEMENTS.RECEIPT_REV.movementType;
  const refused = await batchClassificationRefusal(tx, client, counterType);
  if (refused) throw new StockTransportError(refused.message, refused.remedy);

  // Checks, before any write.
  const allocRows = await tx.select().from(stoTransitAllocation).where(and(
    eq(stoTransitAllocation.client, client), eq(stoTransitAllocation.orderNumber, orderNumber),
  )).for('update');
  const allocOf = (doc: string, line: number) => allocRows.find((a) => a.issueDocument === doc && a.issueLine === line);

  for (const line of lines) {
    await adopt(() => assertInventoryCountOpen(tx, client, {
      materialNumber: line.materialNumber, plant: line.plant, storageLocation: line.storageLocation ?? null, batch: line.batchNumber,
    }));
  }
  const claims = new Map<string, bigint>();
  if (kind === 'ISSUE') {
    for (const line of lines.filter((l) => l.lineDirection === 'ISSUE')) {
      const alloc = allocOf(input.materialDocumentNumber, line.lineNumber);
      if (!alloc) throw new StockTransportError(`The transit ledger holds no allocation for line ${line.lineNumber}.`, 'The document cannot be reversed safely.');
      if (q3(alloc.receivedQuantity) > 0n) {
        const receipts = await tx.execute(sql`
          select distinct l.material_document_number from material_document_line l
            join material_document d on d.client = l.client and d.material_document_number = l.material_document_number
           where l.client = ${client} and l.sto_issue_document = ${alloc.issueDocument} and l.sto_issue_line = ${alloc.issueLine}
             and l.movement_type = 'STO_GR' and d.status <> 'REVERSED'
        `) as unknown as Array<{ material_document_number: string }>;
        throw new StockTransportError(
          `${qs(q3(alloc.receivedQuantity))} of line ${line.lineNumber} has already been received (${receipts.map((r) => r.material_document_number).join(', ') || 'receipt'}); the goods issue cannot be reversed while that stock has left transit.`,
          'Reverse the goods receipt (102) first, then reverse the goods issue (352).',
        );
      }
      if (q3(alloc.reversedQuantity) > 0n) {
        throw new StockTransportError(`Line ${line.lineNumber} has already been reversed.`, 'A line is reversed once.');
      }
      const key = `${line.materialNumber}|${alloc.receivingPlant}|${alloc.batchNumber}`;
      claims.set(key, (claims.get(key) ?? 0n) + q3(line.baseQuantity));
      const held = await stockHeld(tx, client, { material: line.materialNumber, plant: alloc.receivingPlant, location: '', stockType: IN_TRANSIT, batch: alloc.batchNumber });
      if (held < claims.get(key)!) {
        throw new StockTransportError(`The transit stock of ${line.materialNumber} in plant ${alloc.receivingPlant} is ${qs(held)}, short of ${qs(claims.get(key)!)}.`, 'The ledger and the stock disagree; reconcile before reversing.');
      }
    }
  } else {
    for (const line of lines.filter((l) => l.lineDirection === 'RECEIPT')) {
      const alloc = allocOf(line.stoIssueDocument!, line.stoIssueLine!);
      if (!alloc) throw new StockTransportError(`The transit ledger holds no allocation for line ${line.lineNumber}.`, 'The document cannot be reversed safely.');
      if (q3(alloc.reversedQuantity) > 0n || q3(alloc.receivedQuantity) < q3(line.baseQuantity)) {
        throw new StockTransportError(`The receipt on line ${line.lineNumber} is no longer fully recorded against its issue.`, 'The ledger and the document disagree; reconcile before reversing.');
      }
      const key = `${line.materialNumber}|${line.plant}|${line.storageLocation ?? ''}|${line.batchNumber}`;
      claims.set(key, (claims.get(key) ?? 0n) + q3(line.baseQuantity));
      const held = await stockHeld(tx, client, { material: line.materialNumber, plant: line.plant, location: line.storageLocation ?? '', stockType: 'UNRESTRICTED', batch: line.batchNumber });
      if (held < claims.get(key)!) {
        throw new StockTransportError(
          `Stock of ${line.materialNumber}${line.batchNumber ? ` batch ${line.batchNumber}` : ''} in plant ${line.plant} storage location ${line.storageLocation ?? ''} is ${qs(held)}, short of the ${qs(claims.get(key)!)} the reversal takes back into transit.`,
          'The received stock has been consumed; the receipt can no longer be reversed.',
        );
      }
    }
  }

  const periodPlants = kind === 'ISSUE'
    ? [...new Set(plantsTouched)]
    : [...new Set(lines.map((l) => l.plant))];
  let position: { fiscalYear: number; period: number } | null = null;
  const judgedCompanies = new Set<string>();
  for (const plantCode of periodPlants) {
    const [p] = await tx.execute(sql`select company_code from plant where client = ${client} and plant = ${plantCode}`) as unknown as Array<{ company_code: string }>;
    if (judgedCompanies.has(p.company_code)) continue;
    judgedCompanies.add(p.company_code);
    const judged = await adopt(() => judgePeriod(tx, client, plantCode, input.postingDate));
    position ??= judged.position;
  }

  const allocated = await allocateNumber(tx, { client, objectCode: 'MATDOC', allocatedBy: by });
  const number = allocated.display;

  // Accounting: the original's own documents, in their own companies, at their own amounts.
  const reversedJournals = await reverseLinkedJournals(
    tx, client, by, original, input.postingDate, `Reversal of material document ${input.materialDocumentNumber}`, STO_REVERSE_CAPABILITY,
  );
  await tx.insert(materialDocument).values({
    client, materialDocumentNumber: number, documentYear: position!.fiscalYear,
    documentDate: input.documentDate, postingDate: input.postingDate,
    headerText: input.headerText ?? `Reversal of ${input.materialDocumentNumber}`, status: 'POSTED',
    journalDocumentNumber: reversedJournals[0]?.documentNumber ?? null, reversalOf: input.materialDocumentNumber,
    requestKey: input.requestKey, requestFingerprint: fingerprint, createdBy: by,
  });
  for (const j of reversedJournals) await linkJournal(tx, client, by, number, j.role, j.companyCode, j);

  let lineNumber = 0;
  for (const line of lines) {
    const direction = line.lineDirection === 'ISSUE' ? 'RECEIPT' : 'ISSUE';
    const delta = direction === 'RECEIPT' ? q3(line.baseQuantity) : -q3(line.baseQuantity);
    await tx.insert(materialDocumentLine).values({
      client, materialDocumentNumber: number, lineNumber: ++lineNumber, movementType: counterType, lineDirection: direction,
      materialNumber: line.materialNumber, plant: line.plant, storageLocation: line.storageLocation, stockType: line.stockType,
      batchNumber: line.batchNumber, entryQuantity: line.entryQuantity, entryUnit: line.entryUnit,
      baseQuantity: line.baseQuantity, baseUnit: line.baseUnit, unitPrice: line.unitPrice, priceUnit: line.priceUnit,
      currency: line.currency, value: line.value, reversalOfDocument: input.materialDocumentNumber, reversalOfLine: line.lineNumber,
      stoOrderNumber: line.stoOrderNumber, stoOrderItem: line.stoOrderItem,
      stoIssueDocument: line.stoIssueDocument, stoIssueLine: line.stoIssueLine,
      itemText: `Reversal of ${input.materialDocumentNumber}`, createdBy: by,
    });
    await moveStock(tx, client, by, {
      material: line.materialNumber, plant: line.plant, location: line.storageLocation ?? '',
      stockType: line.stockType, batch: line.batchNumber,
    }, delta);
  }
  if (kind === 'ISSUE') {
    for (const line of lines.filter((l) => l.lineDirection === 'ISSUE')) {
      const alloc = allocOf(input.materialDocumentNumber, line.lineNumber)!;
      // Original quantity and value, never today's price or rate.
      await bookValuation(tx, client, by, line.materialNumber, alloc.supplyingPlant, q3(alloc.issuedQuantity), m4(alloc.issueValue));
      await bookValuation(tx, client, by, line.materialNumber, alloc.receivingPlant, -q3(alloc.issuedQuantity), -m4(alloc.transitValue));
      await tx.update(stoTransitAllocation).set({ reversedQuantity: alloc.issuedQuantity, changedBy: by, changedAt: new Date() }).where(and(
        eq(stoTransitAllocation.client, client), eq(stoTransitAllocation.issueDocument, alloc.issueDocument),
        eq(stoTransitAllocation.issueLine, alloc.issueLine),
      ));
      await markPlanning(tx, client, by, line.materialNumber, alloc.supplyingPlant, `STO ${orderNumber} goods issue reversal`);
      await markPlanning(tx, client, by, line.materialNumber, alloc.receivingPlant, `STO ${orderNumber} goods issue reversal`);
    }
  } else {
    // Pairs of lines per piece: the transit line (ISSUE) carries the allocated value, the receipt line adds the difference.
    for (const line of lines.filter((l) => l.lineDirection === 'RECEIPT')) {
      const transitLine = lines.find((l) => l.lineDirection === 'ISSUE' && l.stoIssueDocument === line.stoIssueDocument
        && l.stoIssueLine === line.stoIssueLine && l.lineNumber === line.lineNumber - 1)!;
      const diff = m4(line.value) - m4(transitLine.value);
      if (diff !== 0n) await bookValuation(tx, client, by, line.materialNumber, line.plant, 0n, -diff);
      await tx.update(stoTransitAllocation).set({
        receivedQuantity: sql`${stoTransitAllocation.receivedQuantity} - ${line.baseQuantity}::numeric`,
        receivedValue: sql`${stoTransitAllocation.receivedValue} - ${transitLine.value}::numeric`,
        changedBy: by, changedAt: new Date(),
      }).where(and(
        eq(stoTransitAllocation.client, client), eq(stoTransitAllocation.issueDocument, line.stoIssueDocument!),
        eq(stoTransitAllocation.issueLine, line.stoIssueLine!),
      ));
      await markPlanning(tx, client, by, line.materialNumber, line.plant, `STO ${orderNumber} goods receipt reversal`);
    }
  }
  await tx.update(materialDocument).set({
    status: 'REVERSED', reversedBy: number, changedBy: by, changedAt: new Date(),
  }).where(and(
    eq(materialDocument.client, client), eq(materialDocument.materialDocumentNumber, input.materialDocumentNumber),
  ));
  await recordChange(tx, {
    client, objectClass: MATERIAL_DOCUMENT_CLASS, objectKey: number, changeType: 'CREATE', changedBy: by,
    transactionCode: STO_REVERSE_CAPABILITY,
    after: {
      movement: kind === 'ISSUE' ? '352' : '102', reversalOf: input.materialDocumentNumber, order: orderNumber,
      journals: reversedJournals.map((j) => `${j.role}:${j.documentNumber}`), status: 'POSTED',
    },
  });
  await noteBatchControlUse(tx, client, number, by);
  await recordOutputsForPostedDocument(tx, client, number, by);
  return (await documentView(tx, client, number))!;
}
