/**
 * The outbound delivery, its picking, and the goods issue that closes it — VL01N, VL02N and the movement
 * posting they cause (CAIRN.md §11.2, §14.7, §14.8, §20).
 *
 * Three facts govern this file.
 *
 * **A delivery moves nothing.** Creating one reads the open quantities of an order and writes a document;
 * picking one records what the store confirmed. The only act that touches stock is the goods issue, and even
 * that does not post stock by itself — it runs the inventory goods-issue engine, which owns the movement, the
 * valuation and the journal (§5.1). Nothing here duplicates that: the delivery stores the material document
 * number the posting returned, and where it needs to know what actually moved it reads the ledger back.
 *
 * **An order is delivered in quantities, not in documents.** What a line may still carry is its ordered
 * quantity minus every delivery quantity that has not been cancelled. That figure is checked in the database
 * (`delivery_line_remaining_ck`), because two deliveries created in the same moment would otherwise both read
 * the same open space — and it is why the order line keeps no delivered counter of its own.
 *
 * **Credit is judged where §14.8 says, at delivery creation and at goods issue.** A block that already stands
 * against the order or the delivery refuses the delivery and refuses the movement. A breach discovered *at*
 * the movement is recorded against the delivery and refuses the billing release instead: the goods have left
 * the plant and the receivable has not been raised, so the next document is held, not the last one undone.
 */
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { unitOfMeasure } from '../../platform/tables/reference';
import { checkSalesDocumentCredit, listCreditDeterminations, type CreditDeterminationView } from '../finance/credit';
import { GoodsIssueError, postGoodsIssue } from '../inventory/goods-issue';
import { StorageLocationError, resolveStorageLocation, storageLocationRequired } from '../inventory/storage-location';
import { UnitConversionError } from '../inventory/unit-conversion';

import { delivery, deliveryLine, deliveryPicking, salesOrder, salesOrderLine } from './schema';
import { deliveredOf, orderLineProgress } from './fulfillment-quantities';
import { creditAreaFor } from './sales-order';

export const DELIVERY_CAPABILITY = 'SALES.DELIVERY.CREATE';
export const DELIVERY_PICK_CAPABILITY = 'SALES.DELIVERY.PICK';
export const DELIVERY_GOODS_ISSUE_CAPABILITY = 'SALES.GI.POST';
export const DELIVERY_ROUTE = '/sales/delivery';
export const DELIVERY_OBJECT_CLASS = 'delivery';
export const DELIVERY_TYPE = { code: 'LF', name: 'Outbound delivery', rangeSubObject: 'LF' } as const;
/** The movement that ships to a customer, named as the inventory engine's own scenario table names it. */
export const DELIVERY_GOODS_ISSUE_MOVEMENT = '601';

export class DeliveryError extends Error {
  remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'DeliveryError';
    this.remedy = remedy;
  }
}

const key = (max: number) => z.string().trim().transform((s) => s.toUpperCase()).pipe(z.string().min(1).max(max));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.');
const positiveQuantity = z.string().trim().regex(/^\d+\.\d{1,3}$|^\d+$/, 'Enter a quantity of at most three decimals.');
const signedQuantity = z.string().trim().regex(/^-?\d+(\.\d{1,3})?$/, 'Enter a quantity of at most three decimals.');
const optionalText = (max: number) =>
  z.union([z.undefined(), z.literal(''), z.string().trim().pipe(z.string().max(max))]);

export const deliveryItemInput = z.object({
  orderLineNumber: z.coerce.number().int().positive(),
  /** What this delivery carries of the order line, in the order line's own unit. */
  quantity: positiveQuantity,
});

export const deliveryCreateInput = z.object({
  client: z.string().trim().length(4),
  changedBy: key(60),
  orderNumber: key(20),
  deliveryDate: isoDate,
  goodsMovementDate: z.union([z.undefined(), z.literal(''), isoDate]).optional(),
  headerText: optionalText(100).optional(),
  items: z.array(deliveryItemInput).min(1, 'Name at least one order item to deliver.'),
  requestKey: optionalText(64).optional(),
});

export const deliveryPickItemInput = z.object({
  lineNumber: z.coerce.number().int().positive(),
  /** Signed: a confirmation states what came to the dock, a correction the negative of what was wrong. */
  quantity: signedQuantity,
  storageLocation: optionalText(10).optional(),
  batchNumber: optionalText(40).optional(),
  reason: optionalText(60).optional(),
});

export const deliveryPickInput = z.object({
  client: z.string().trim().length(4),
  changedBy: key(60),
  deliveryNumber: key(20),
  expectedVersion: z.coerce.number().int().positive().optional(),
  items: z.array(deliveryPickItemInput).min(1, 'Name the delivery item the pick confirms.'),
  requestKey: optionalText(64).optional(),
});

export const deliveryIssueInput = z.object({
  client: z.string().trim().length(4),
  changedBy: key(60),
  deliveryNumber: key(20),
  expectedVersion: z.coerce.number().int().positive(),
  postingDate: isoDate,
  documentDate: isoDate.optional(),
});

export const deliveryCancelInput = z.object({
  client: z.string().trim().length(4),
  changedBy: key(60),
  deliveryNumber: key(20),
  expectedVersion: z.coerce.number().int().positive(),
  reason: optionalText(60).optional(),
});

export type DeliveryCreateInput = z.infer<typeof deliveryCreateInput>;
export type DeliveryPickInput = z.infer<typeof deliveryPickInput>;
export type DeliveryIssueInput = z.infer<typeof deliveryIssueInput>;
export type DeliveryCancelInput = z.infer<typeof deliveryCancelInput>;

const round3 = (value: number) => (Math.round((value + Number.EPSILON) * 1000) / 1000).toFixed(3);
const round2 = (value: number) => (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);

/** The decimals the typed figure carries, after the zeros that only pad it out. */
function decimalsOf(value: string): number {
  const [, fraction = ''] = value.replace(/^-/, '').split('.');
  return fraction.replace(/0+$/, '').length;
}

/**
 * A quantity is refused when the unit's own scale cannot state it. The delivery converts nothing — the goods
 * issue converts against the rate that stands when the movement posts — so this is a question of what the
 * store can say, not of arithmetic.
 */
async function assertUnitScale(tx: Tx, client: string, unit: string, value: string, what: string): Promise<void> {
  // The order line keeps its unit in a blank-padded column, so the key is trimmed before it is read and
  // before it is spoken: 'UNT   ' is the same unit as 'UNT', and a message that shows the padding reads as
  // a broken form rather than as a refusal.
  const code = unit.trim();
  const [row] = await tx.select({ decimalPlaces: unitOfMeasure.decimalPlaces }).from(unitOfMeasure)
    .where(eq(unitOfMeasure.code, code)).limit(1);
  const allowed = row?.decimalPlaces ?? 3;
  if (decimalsOf(value) > allowed) {
    throw new DeliveryError(
      `${what} is ${value}, and unit ${code} is maintained to ${allowed} decimal${allowed === 1 ? '' : 's'}`
        + (row ? '.' : ' (no such unit of measure is maintained).'),
      'State the quantity at the unit\'s own scale.',
    );
  }
}

/**
 * The order's open space is judged by one writer at a time. The unique index on a billing document covers the
 * billing side; here an advisory lock is what keeps two deliveries from each reading the same remaining
 * quantity before either writes. It is the same idiom the accounting-invoice service uses for a customer.
 */
async function lockOrder(tx: Tx, client: string, orderNumber: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/sales-order/${orderNumber}`}, 0))`);
}

async function lockDelivery(tx: Tx, client: string, deliveryNumber: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/delivery/${deliveryNumber}`}, 0))`);
}

/** The determination that stands against a document — an order number or a delivery number, since both are
 * sales documents in the credit engine's own table (D-029). */
export async function standingDetermination(
  client: string, document: string,
): Promise<CreditDeterminationView | null> {
  const rows = await listCreditDeterminations(client, {
    documentFrom: document, documentTo: document, blockedOnly: false, includeReleased: true,
  });
  return rows[0] ?? null;
}

async function refuseStandingBlock(client: string, document: string, label: string, act: string): Promise<void> {
  const determination = await standingDetermination(client, document);
  if (determination?.status === 'BLOCKED') {
    throw new DeliveryError(
      `${label} is credit-blocked${determination.reason ? ` (${determination.reason})` : ''}: nothing was ${act}.`,
      'Release the blocked document at /finance/credit-release, then act again.',
    );
  }
}

export interface DeliveryView {
  deliveryNumber: string;
  documentType: string;
  orderNumber: string;
  salesOrg: string;
  distributionChannel: string;
  division: string;
  customerNumber: string;
  companyCode: string;
  plant: string;
  deliveryDate: string;
  goodsMovementDate: string | null;
  status: string;
  materialDocumentNumber: string | null;
  materialDocumentYear: number | null;
  headerText: string | null;
  version: number;
  createdBy: string;
  /** What the delivery is worth at the prices the order line carries — the figure the ladder judged. */
  value: string;
  lines: Array<{
    lineNumber: number;
    orderLineNumber: number;
    materialNumber: string;
    plant: string;
    quantityUnit: string;
    orderedQuantity: string;
    deliveredBefore: string;
    deliveryQuantity: string;
    remainingQuantity: string;
    pickedQuantity: string;
    goodsIssueQuantity: string;
    status: string;
    picks: Array<{
      pickNumber: number;
      quantityDelta: string;
      storageLocation: string;
      batchNumber: string;
      reason: string | null;
      createdBy: string;
      createdAt: string;
    }>;
  }>;
  credit: CreditDeterminationView | null;
}

function mapHeader(row: typeof delivery.$inferSelect): Omit<DeliveryView, 'lines' | 'credit' | 'value'> {
  return {
    deliveryNumber: row.deliveryNumber,
    documentType: row.documentType,
    orderNumber: row.orderNumber,
    salesOrg: row.salesOrg,
    distributionChannel: row.distributionChannel,
    division: row.division,
    customerNumber: row.customerNumber,
    companyCode: row.companyCode,
    plant: row.plant,
    deliveryDate: row.deliveryDate,
    goodsMovementDate: row.goodsMovementDate,
    status: row.status,
    materialDocumentNumber: row.materialDocumentNumber,
    materialDocumentYear: row.materialDocumentYear,
    headerText: row.headerText,
    version: row.version,
    createdBy: row.createdBy,
  };
}

/** The order-line share of value the delivery's quantities carry, read from the order lines themselves. */
async function deliveryValue(tx: Tx, client: string, deliveryNumber: string): Promise<string> {
  const rows = await tx.execute(sql`
    select coalesce(sum(dl.delivery_quantity * (l.net_amount + l.tax_amount) / nullif(l.order_quantity, 0)), 0)::text as value
      from delivery_line dl
      join sales_order_line l
        on l.client = dl.client and l.order_number = dl.order_number and l.line_number = dl.order_line_number
     where dl.client = ${client} and dl.delivery_number = ${deliveryNumber}
  `) as unknown as Array<{ value: string }>;
  return round2(Number(rows[0]?.value ?? '0'));
}

async function loadDelivery(tx: Tx, client: string, deliveryNumber: string): Promise<Omit<DeliveryView, 'credit'> | null> {
  const [header] = await tx.select().from(delivery).where(and(
    eq(delivery.client, client), eq(delivery.deliveryNumber, deliveryNumber),
  )).limit(1);
  if (!header) return null;

  const lines = await tx.select().from(deliveryLine).where(and(
    eq(deliveryLine.client, client), eq(deliveryLine.deliveryNumber, deliveryNumber),
  )).orderBy(asc(deliveryLine.lineNumber));
  const picks = await tx.select().from(deliveryPicking).where(and(
    eq(deliveryPicking.client, client), eq(deliveryPicking.deliveryNumber, deliveryNumber),
  )).orderBy(asc(deliveryPicking.lineNumber), asc(deliveryPicking.pickNumber));

  return {
    ...mapHeader(header),
    value: await deliveryValue(tx, client, deliveryNumber),
    lines: lines.map((line) => ({
      lineNumber: line.lineNumber,
      orderLineNumber: line.orderLineNumber,
      materialNumber: line.materialNumber,
      plant: line.plant,
      quantityUnit: line.quantityUnit,
      orderedQuantity: line.orderedQuantity,
      deliveredBefore: line.deliveredBefore,
      deliveryQuantity: line.deliveryQuantity,
      remainingQuantity: line.remainingQuantity,
      pickedQuantity: line.pickedQuantity,
      goodsIssueQuantity: line.goodsIssueQuantity,
      status: line.status,
      picks: picks
        .filter((pick) => pick.lineNumber === line.lineNumber)
        .map((pick) => ({
          pickNumber: pick.pickNumber,
          quantityDelta: pick.quantityDelta,
          storageLocation: pick.storageLocation,
          batchNumber: pick.batchNumber,
          reason: pick.reason,
          createdBy: pick.createdBy,
          createdAt: pick.createdAt.toISOString(),
        })),
    })),
  };
}

export async function getDelivery(client: string, deliveryNumber: string): Promise<DeliveryView | null> {
  const trimmed = deliveryNumber.trim().toUpperCase();
  const document = await withTenant(client, (tx) => loadDelivery(tx, client, trimmed));
  if (!document) return null;
  return { ...document, credit: await standingDetermination(client, trimmed) };
}

/**
 * The order lines a delivery can still be created from: open items of an open order, with what has already
 * gone out and what is left. A cancelled order, a rejected item and a fully delivered line are absent, because
 * none of them can answer a delivery.
 */
export async function listDeliverableOrderLines(
  client: string,
  filter: { orderNumber?: string; customerNumber?: string } = {},
): Promise<Array<{
  orderNumber: string;
  lineNumber: number;
  customerNumber: string;
  materialNumber: string;
  plant: string;
  quantityUnit: string;
  orderDate: string;
  requestedDeliveryDate: string | null;
  orderedQuantity: string;
  deliveredQuantity: string;
  remainingQuantity: string;
}>> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select o.order_number, o.customer_number, o.order_date, l.line_number, l.material_number, l.plant,
             l.quantity_unit, l.requested_delivery_date, l.order_quantity,
             coalesce(d.delivered, 0)::text as delivered
        from sales_order_line l
        join sales_order o on o.client = l.client and o.order_number = l.order_number
        left join (
          select dl.client, dl.order_number, dl.order_line_number, sum(dl.delivery_quantity) as delivered
            from delivery_line dl
            join delivery dd on dd.client = dl.client and dd.delivery_number = dl.delivery_number
           and dd.status <> 'CANCELLED'
           group by 1, 2, 3
        ) d on d.client = l.client and d.order_number = l.order_number and d.order_line_number = l.line_number
       where l.client = ${client}
         and o.status = 'OPEN'
         and l.status = 'OPEN'
         and l.order_quantity > coalesce(d.delivered, 0)
         and (${filter.orderNumber || null}::text is null or o.order_number = ${filter.orderNumber || null})
         and (${filter.customerNumber || null}::text is null or o.customer_number = ${filter.customerNumber || null})
       order by o.order_number, l.line_number
       limit 200
    `) as unknown as Array<{
      order_number: string; customer_number: string; order_date: string; line_number: number;
      material_number: string; plant: string; quantity_unit: string; requested_delivery_date: string | null;
      order_quantity: string; delivered: string;
    }>;
    return rows.map((row) => {
      const ordered = Number(row.order_quantity);
      const delivered = Number(row.delivered);
      return {
        orderNumber: row.order_number,
        lineNumber: row.line_number,
        customerNumber: row.customer_number,
        materialNumber: row.material_number,
        plant: row.plant,
        quantityUnit: row.quantity_unit,
        orderDate: row.order_date,
        requestedDeliveryDate: row.requested_delivery_date,
        orderedQuantity: round3(ordered),
        deliveredQuantity: round3(delivered),
        remainingQuantity: round3(ordered - delivered),
      };
    });
  });
}

export async function listDeliveries(
  client: string,
  filter: { orderNumber?: string; status?: string; deliveryNumber?: string } = {},
): Promise<Array<{
  deliveryNumber: string; orderNumber: string; customerNumber: string; plant: string;
  deliveryDate: string; status: string; materialDocumentNumber: string | null; value: string; version: number;
}>> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(delivery).where(and(
      eq(delivery.client, client),
      filter.orderNumber ? eq(delivery.orderNumber, filter.orderNumber) : undefined,
      filter.deliveryNumber ? eq(delivery.deliveryNumber, filter.deliveryNumber) : undefined,
      filter.status ? eq(delivery.status, filter.status) : undefined,
    )).orderBy(asc(delivery.deliveryNumber)).limit(200);
    const out: Array<{
      deliveryNumber: string; orderNumber: string; customerNumber: string; plant: string;
      deliveryDate: string; status: string; materialDocumentNumber: string | null; value: string; version: number;
    }> = [];
    for (const row of rows) {
      out.push({
        deliveryNumber: row.deliveryNumber,
        orderNumber: row.orderNumber,
        customerNumber: row.customerNumber,
        plant: row.plant,
        deliveryDate: row.deliveryDate,
        status: row.status,
        materialDocumentNumber: row.materialDocumentNumber,
        value: await deliveryValue(tx, client, row.deliveryNumber),
        version: row.version,
      });
    }
    return out;
  });
}

/**
 * Create a delivery from the open quantities of one order, at one plant.
 *
 * A smaller quantity than the order line has open is a partial delivery and leaves the order open for the
 * rest, which is all the model permits (§11.2). Zero, unknown, rejected and over-quantity items are refused
 * before anything is written, a delivery draws from one plant, and a repeated submission under the same
 * request key returns the document the first attempt created instead of creating a second one.
 */
export async function createDelivery(input: DeliveryCreateInput): Promise<DeliveryView & { replayed: boolean }> {
  const parsed = deliveryCreateInput.parse(input);
  const created = await withTenant(parsed.client, async (tx) => {
    const [order] = await tx.select().from(salesOrder).where(and(
      eq(salesOrder.client, parsed.client), eq(salesOrder.orderNumber, parsed.orderNumber),
    )).limit(1);
    if (!order) {
      throw new DeliveryError(
        `Sales order ${parsed.orderNumber} does not exist in this tenant.`,
        'Create the order at /sales/orders first.',
      );
    }
    if (order.status !== 'OPEN') {
      throw new DeliveryError(
        `Sales order ${parsed.orderNumber} stands ${order.status}; a ${order.status.toLowerCase()} order delivers nothing.`,
        'A cancelled order is not reopened by a delivery — create a new order.',
      );
    }

    if (parsed.requestKey) {
      const [existing] = await tx.select({ number: delivery.deliveryNumber }).from(delivery).where(and(
        eq(delivery.client, parsed.client), eq(delivery.requestKey, parsed.requestKey),
      )).limit(1);
      if (existing) {
        return { deliveryNumber: existing.number, replayed: true, order, creditArea: '', value: '0' };
      }
    }

    await lockOrder(tx, parsed.client, order.orderNumber);

    // The block that already stands is what refuses here; a breach this delivery itself causes is recorded and
    // refused at the billing release, because the goods have not left the plant yet.
    await refuseStandingBlock(parsed.client, order.orderNumber, `Sales order ${order.orderNumber}`, 'delivered');

    const progress = await orderLineProgress(tx, parsed.client, order.orderNumber);
    const orderLines = await tx.select().from(salesOrderLine).where(and(
      eq(salesOrderLine.client, parsed.client), eq(salesOrderLine.orderNumber, order.orderNumber),
    )).orderBy(asc(salesOrderLine.lineNumber));
    const byNumber = new Map(orderLines.map((line) => [line.lineNumber, line]));

    const items: Array<typeof deliveryLine.$inferInsert> = [];
    const seen = new Set<number>();
    let plant = '';
    let value = 0;
    for (const item of parsed.items) {
      if (seen.has(item.orderLineNumber)) {
        throw new DeliveryError(
          `Order item ${item.orderLineNumber} was named twice.`,
          'Enter each order item once on the delivery.',
        );
      }
      seen.add(item.orderLineNumber);
      const line = byNumber.get(item.orderLineNumber);
      if (!line) {
        throw new DeliveryError(
          `Sales order ${order.orderNumber} carries no item ${item.orderLineNumber}.`,
          'Deliver an item the order states.',
        );
      }
      if (line.status !== 'OPEN') {
        throw new DeliveryError(
          `Item ${item.orderLineNumber} is ${line.status.toLowerCase()}${line.rejectionReason ? ` (reason ${line.rejectionReason})` : ''}; a rejected item is not delivered.`,
          'Re-enter the item on the order to lift the rejection, or leave it rejected.',
        );
      }
      const already = deliveredOf(progress, item.orderLineNumber);
      const remaining = Number(line.orderQuantity) - already;
      const wanted = Number(item.quantity);
      if (!(wanted > 0)) {
        throw new DeliveryError(
          `Item ${item.orderLineNumber}: a delivery quantity of ${item.quantity} delivers nothing.`,
          'Enter the quantity the customer is to receive.',
        );
      }
      await assertUnitScale(tx, parsed.client, line.quantityUnit, item.quantity, `Item ${item.orderLineNumber}'s delivery quantity`);
      if (wanted > remaining + 1e-9) {
        throw new DeliveryError(
          `Item ${item.orderLineNumber} carries ${round3(remaining)} ${line.quantityUnit.trim()} open of ${line.orderQuantity} ordered, and ${item.quantity} was entered.`,
          'Reduce the quantity to what the order line still has open, or change the order first.',
        );
      }
      if (plant && line.plant !== plant) {
        throw new DeliveryError(
          `Item ${item.orderLineNumber} ships from plant ${line.plant}, and this is a plant ${plant} delivery.`,
          'Create one delivery per plant: a delivery loads from a single shipping point.',
        );
      }
      plant = line.plant;
      value += (wanted / Number(line.orderQuantity)) * (Number(line.netAmount) + Number(line.taxAmount));
      items.push({
        client: parsed.client,
        deliveryNumber: '', // replaced below, once the number is drawn
        lineNumber: (items.length + 1) * 10,
        orderNumber: order.orderNumber,
        orderLineNumber: line.lineNumber,
        materialNumber: line.materialNumber,
        plant: line.plant,
        quantityUnit: line.quantityUnit,
        orderedQuantity: line.orderQuantity,
        deliveredBefore: round3(already),
        deliveryQuantity: item.quantity,
        remainingQuantity: round3(remaining - wanted),
        createdBy: parsed.changedBy,
      });
    }

    let number: string;
    try {
      const drawn = await allocateNumber(tx, {
        client: parsed.client, objectCode: 'DELIVERY', companyCode: '*',
        subObject: DELIVERY_TYPE.rangeSubObject, fiscalYear: 0, allocatedBy: parsed.changedBy,
      });
      number = drawn.display;
    } catch {
      throw new DeliveryError(
        `No active internal DELIVERY number range stands for sub-object ${DELIVERY_TYPE.rangeSubObject}, so no delivery number can be drawn.`,
        'Define or unblock the interval on the number ranges screen, then save again.',
      );
    }

    await tx.insert(delivery).values({
      client: parsed.client,
      deliveryNumber: number,
      documentType: DELIVERY_TYPE.code,
      orderNumber: order.orderNumber,
      salesOrg: order.salesOrg,
      distributionChannel: order.distributionChannel,
      division: order.division,
      customerNumber: order.customerNumber,
      companyCode: order.companyCode,
      plant,
      deliveryDate: parsed.deliveryDate,
      goodsMovementDate: parsed.goodsMovementDate || null,
      headerText: parsed.headerText || null,
      status: 'OPEN',
      requestKey: parsed.requestKey || null,
      createdBy: parsed.changedBy,
    });

    for (const item of items) {
      await tx.insert(deliveryLine).values({ ...item, deliveryNumber: number });
    }

    await recordChange(tx, {
      client: parsed.client, objectClass: DELIVERY_OBJECT_CLASS, objectKey: number, changeType: 'CREATE',
      changedBy: parsed.changedBy,
      after: {
        order: order.orderNumber,
        plant,
        items: items.length,
        value: round2(value),
      },
    });
    const creditArea = await creditAreaFor(tx, parsed.client, order.customerNumber, order.companyCode);
    return { deliveryNumber: number, replayed: false, order, creditArea, value: round2(value) };
  });

  const view = await getDelivery(parsed.client, created.deliveryNumber);
  if (!view) throw new DeliveryError(`Delivery ${created.deliveryNumber} could not be read back.`);

  // The delivery is its own credit-relevant document: it enters the blocked worklist under its own number,
  // which is what lets a goods issue and a billing be refused on a block raised here (D-029).
  let credit = view.credit;
  if (!created.replayed) {
    credit = await checkSalesDocumentCredit({
      client: parsed.client, changedBy: parsed.changedBy, salesDocument: created.deliveryNumber,
      documentDate: parsed.deliveryDate, salesOrg: view.salesOrg, customer: view.customerNumber,
      creditControlArea: created.creditArea, orderValue: created.value, orderCurrency: created.order.currency,
    });
  }
  return { ...view, credit: credit ?? view.credit, replayed: created.replayed };
}

/**
 * Confirm picking on a delivery: one appended row per confirmation, and the line's picked quantity is the sum
 * of the rows as they now stand — read back from the history rather than accumulated from a form value.
 *
 * A confirmation beyond the delivery quantity is refused by name, and so is a correction that would take the
 * picked quantity below zero. The storage location is resolved by the inventory service that owns it, so an
 * unknown or unauthorized location never reaches a pick row. The batch is not judged here: the posting that
 * consumes it is the one place a batch is authoritative, and a second opinion here could only disagree with
 * it.
 */
export async function confirmDeliveryPicks(input: DeliveryPickInput): Promise<DeliveryView> {
  const parsed = deliveryPickInput.parse(input);
  // The pick is the act that readies a posting, so a block standing against the delivery stops it here and not
  // only at the movement: §14.8 counts picking among the points a blocked document must not pass.
  await refuseStandingBlock(parsed.client, parsed.deliveryNumber, `Delivery ${parsed.deliveryNumber}`, 'picked');
  await withTenant(parsed.client, async (tx) => {
    const [header] = await tx.select().from(delivery).where(and(
      eq(delivery.client, parsed.client), eq(delivery.deliveryNumber, parsed.deliveryNumber),
    )).limit(1);
    if (!header) throw new DeliveryError(`Delivery ${parsed.deliveryNumber} does not exist.`);
    if (header.status === 'GOODS_ISSUED') {
      throw new DeliveryError(
        `Delivery ${parsed.deliveryNumber} is goods-issued; a posted movement is not picked around.`,
        'Reverse the goods issue in Inventory, where the movement and its journal stand.',
      );
    }
    if (header.status === 'CANCELLED') {
      throw new DeliveryError(`Delivery ${parsed.deliveryNumber} stands CANCELLED and confirms nothing.`);
    }
    if (parsed.expectedVersion !== undefined && parsed.expectedVersion !== header.version) {
      throw new DeliveryError(
        `The delivery changed since it was read (version ${header.version}, expected ${parsed.expectedVersion}).`,
        'Reload the delivery, then confirm the pick.',
      );
    }
    await lockDelivery(tx, parsed.client, header.deliveryNumber);

    if (parsed.requestKey) {
      const [existing] = await tx.select({ number: deliveryPicking.pickNumber }).from(deliveryPicking).where(and(
        eq(deliveryPicking.client, parsed.client), eq(deliveryPicking.requestKey, parsed.requestKey),
      )).limit(1);
      // The same submission is already in the history, so it is not appended twice.
      if (existing) return;
    }

    const lines = await tx.select().from(deliveryLine).where(and(
      eq(deliveryLine.client, parsed.client), eq(deliveryLine.deliveryNumber, header.deliveryNumber),
    )).orderBy(asc(deliveryLine.lineNumber));
    const byNumber = new Map(lines.map((line) => [line.lineNumber, line]));
    const touched: number[] = [];

    for (const item of parsed.items) {
      const line = byNumber.get(item.lineNumber);
      if (!line) {
        throw new DeliveryError(
          `Delivery ${header.deliveryNumber} carries no item ${item.lineNumber}.`,
          'Pick an item the delivery states.',
        );
      }
      if (line.status === 'GOODS_ISSUED') {
        throw new DeliveryError(
          `Delivery item ${line.lineNumber} is goods-issued; its pick is settled.`,
          'Reverse the movement in Inventory to pick the item again.',
        );
      }
      const delta = Number(item.quantity);
      if (!Number.isFinite(delta) || delta === 0) {
        throw new DeliveryError(
          `Item ${line.lineNumber}: a pick of ${item.quantity} confirms nothing.`,
          'State what came to the dock, or a negative figure to correct a pick that was wrong.',
        );
      }
      await assertUnitScale(tx, parsed.client, line.quantityUnit, item.quantity, `Item ${line.lineNumber}'s picked quantity`);
      const next = Number(line.pickedQuantity) + delta;
      if (next < -1e-9) {
        throw new DeliveryError(
          `Item ${line.lineNumber} has ${line.pickedQuantity} ${line.quantityUnit.trim()} picked, and ${item.quantity} would take it below zero.`,
          'Correct no more than the picked quantity the delivery states.',
        );
      }
      if (next > Number(line.deliveryQuantity) + 1e-9) {
        throw new DeliveryError(
          `Item ${line.lineNumber} carries ${line.deliveryQuantity} ${line.quantityUnit.trim()} on this delivery; picking ${round3(next)} would confirm more than the delivery owes.`,
          'Reduce the picked quantity to the delivery quantity.',
        );
      }
      if (delta < 0 && !(item.reason ?? '').trim()) {
        throw new DeliveryError(
          `Item ${line.lineNumber}: a correction to a pick has to say why.`,
          'Name the reason; the pick history is append-only, so the reason is the record.',
        );
      }

      const storageLocation = await resolvePickLocation(tx, parsed.client, line, item.storageLocation, delta);
      const [pickNumber] = await tx.select({ value: sql<number>`coalesce(max(pick_number), 0) + 1` })
        .from(deliveryPicking).where(and(
          eq(deliveryPicking.client, parsed.client),
          eq(deliveryPicking.deliveryNumber, header.deliveryNumber),
          eq(deliveryPicking.lineNumber, line.lineNumber),
        ));

      await tx.insert(deliveryPicking).values({
        client: parsed.client,
        deliveryNumber: header.deliveryNumber,
        lineNumber: line.lineNumber,
        pickNumber: Number(pickNumber?.value ?? 1),
        quantityDelta: round3(delta),
        storageLocation,
        batchNumber: (item.batchNumber ?? '').trim().toUpperCase(),
        reason: (item.reason ?? '').trim() || null,
        requestKey: parsed.requestKey || null,
        createdBy: parsed.changedBy,
      });

      // The line's picked quantity is the history summed, never the form added: that is what makes a
      // correction and a confirmation leave the same answer.
      const standing = await tx.execute(sql`
        select coalesce(sum(quantity_delta), 0)::text as picked
          from delivery_picking
         where client = ${parsed.client} and delivery_number = ${header.deliveryNumber} and line_number = ${line.lineNumber}
      `) as unknown as Array<{ picked: string }>;
      const picked = round3(Number(standing[0]?.picked ?? 0));
      await tx.update(deliveryLine).set({
        pickedQuantity: picked,
        status: Number(picked) >= Number(line.deliveryQuantity) ? 'PICKED' : 'OPEN',
        changedBy: parsed.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(deliveryLine.client, parsed.client),
        eq(deliveryLine.deliveryNumber, header.deliveryNumber),
        eq(deliveryLine.lineNumber, line.lineNumber),
      ));
      touched.push(line.lineNumber);
    }
    if (!touched.length) return;

    const standing = await tx.select().from(deliveryLine).where(and(
      eq(deliveryLine.client, parsed.client), eq(deliveryLine.deliveryNumber, header.deliveryNumber),
    ));
    const complete = standing.every((line) => Number(line.pickedQuantity) >= Number(line.deliveryQuantity));
    const applied = await tx.update(delivery).set({
      status: complete ? 'PICKED' : 'OPEN',
      version: header.version + 1,
      changedBy: parsed.changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(delivery.client, parsed.client),
      eq(delivery.deliveryNumber, header.deliveryNumber),
      eq(delivery.version, header.version),
    )).returning({ number: delivery.deliveryNumber });
    if (!applied.length) {
      throw new DeliveryError('The delivery changed while the pick was being confirmed. Nothing was picked.');
    }
    await recordChange(tx, {
      client: parsed.client, objectClass: DELIVERY_OBJECT_CLASS, objectKey: header.deliveryNumber,
      changeType: 'CHANGE', changedBy: parsed.changedBy,
      before: { status: header.status, version: header.version },
      after: {
        status: complete ? 'PICKED' : 'OPEN', version: header.version + 1,
        itemsConfirmed: touched.join(', '),
      },
      fieldLabels: { itemsConfirmed: 'Items confirmed' },
    });
  });

  const view = await getDelivery(parsed.client, parsed.deliveryNumber);
  if (!view) throw new DeliveryError(`Delivery ${parsed.deliveryNumber} could not be read back.`);
  return view;
}

async function resolvePickLocation(
  tx: Tx, client: string, line: typeof deliveryLine.$inferSelect, typed: string | undefined, delta: number,
): Promise<string> {
  const trimmed = (typed ?? '').trim().toUpperCase();
  if (!trimmed) {
    throw new DeliveryError(
      `Delivery item ${line.lineNumber}: name the storage location the goods are picked from.`,
      'The store answers from a location, and the goods issue posts from the one the pick names.',
    );
  }
  // A correction moves no goods, so it is not held to a location the delivery has never used; the row it
  // answers already states one.
  const required = delta > 0
    ? await storageLocationRequired(tx, client, line.materialNumber, line.plant).catch(() => true)
    : false;
  try {
    const resolved = await resolveStorageLocation(tx, {
      client,
      plant: line.plant,
      typed: trimmed,
      documentDefault: null,
      applyPlantDefault: false,
      required,
      verb: 'Pick',
    });
    return resolved.storageLocation || trimmed;
  } catch (caught) {
    if (caught instanceof StorageLocationError) {
      throw new DeliveryError(`Delivery item ${line.lineNumber}: ${caught.message}`, caught.remedy);
    }
    throw caught;
  }
}

export interface DeliveryGoodsIssueResult {
  delivery: DeliveryView;
  materialDocumentNumber: string;
  materialDocumentYear: number;
  journalDocumentNumber: string | null;
  totalValue: string;
  /** Set when the movement itself breached the limit: the receivable is then held, not the movement undone. */
  creditBlockedForBilling: boolean;
}

/**
 * Post the goods issue of a picked delivery. The movement, the valuation, the journal, the delivery's status
 * and its link to the material document commit in one transaction, because the inventory engine is run
 * *inside* this transaction rather than beside it — the same shape a production confirmation uses.
 *
 * Nothing moves when the picks do not complete the delivery, when a block already stands against the delivery
 * or its order, or when the stock the movement needs is not there: the last refusal is the inventory engine's
 * own words, quoted rather than paraphrased, so a short shelf does not read as a broken screen.
 */
export async function postDeliveryGoodsIssue(input: DeliveryIssueInput): Promise<DeliveryGoodsIssueResult> {
  const parsed = deliveryIssueInput.parse(input);
  await refuseStandingBlock(parsed.client, parsed.deliveryNumber, `Delivery ${parsed.deliveryNumber}`, 'issued');
  const posted = await withTenant(parsed.client, async (tx) => {
    const [header] = await tx.select().from(delivery).where(and(
      eq(delivery.client, parsed.client), eq(delivery.deliveryNumber, parsed.deliveryNumber),
    )).limit(1);
    if (!header) throw new DeliveryError(`Delivery ${parsed.deliveryNumber} does not exist.`);
    if (header.status === 'GOODS_ISSUED') {
      throw new DeliveryError(
        `Delivery ${parsed.deliveryNumber} was already goods-issued with material document ${header.materialDocumentNumber}.`,
        'A posted movement is reversed in Inventory; it is not posted a second time.',
      );
    }
    if (header.status !== 'PICKED') {
      throw new DeliveryError(
        `Delivery ${parsed.deliveryNumber} stands ${header.status}; only a fully picked delivery can be goods-issued.`,
        'Confirm picking for every item first — an incomplete pick does not earn a movement.',
      );
    }
    if (header.version !== parsed.expectedVersion) {
      throw new DeliveryError(
        `The delivery changed since it was read (version ${header.version}, expected ${parsed.expectedVersion}).`,
        'Reload the delivery, then post the goods issue.',
      );
    }
    await refuseStandingBlock(parsed.client, header.orderNumber, `Sales order ${header.orderNumber}`, 'issued');
    await lockDelivery(tx, parsed.client, header.deliveryNumber);

    const lines = await tx.select().from(deliveryLine).where(and(
      eq(deliveryLine.client, parsed.client), eq(deliveryLine.deliveryNumber, header.deliveryNumber),
    )).orderBy(asc(deliveryLine.lineNumber));
    const short = lines.filter((line) => Number(line.pickedQuantity) < Number(line.deliveryQuantity));
    if (short.length) {
      throw new DeliveryError(
        `Delivery item ${short.map((line) => line.lineNumber).join(', ')} is picked ${short.map((line) => line.pickedQuantity).join(', ')} of ${short.map((line) => line.deliveryQuantity).join(', ')}; the movement posts what the store confirmed, so the pick has to be completed.`,
        'Confirm the remaining picked quantity, then post the goods issue.',
      );
    }

    // One movement line per (item, storage location, batch) the pick history states. The delivery line
    // carries no location of its own, so the history is the only answer to "from where".
    const scopes = await tx.execute(sql`
      select p.line_number, p.storage_location, p.batch_number, sum(p.quantity_delta)::text as quantity
        from delivery_picking p
       where p.client = ${parsed.client} and p.delivery_number = ${header.deliveryNumber}
       group by 1, 2, 3
      having sum(p.quantity_delta) <> 0
       order by p.line_number, p.storage_location, p.batch_number
    `) as unknown as Array<{
      line_number: number; storage_location: string; batch_number: string; quantity: string;
    }>;

    const byLine = new Map(lines.map((line) => [line.lineNumber, line]));
    const issueLines = scopes.flatMap((scope) => {
      const line = byLine.get(scope.line_number);
      if (!line) return [];
      const quantity = Number(scope.quantity);
      if (!(quantity > 0)) return [];
      return [{
        materialNumber: line.materialNumber,
        plant: line.plant,
        storageLocation: scope.storage_location || undefined,
        quantity,
        entryUnit: line.quantityUnit,
        batch: scope.batch_number || undefined,
      }];
    });
    if (!issueLines.length) {
      throw new DeliveryError(
        `Delivery ${header.deliveryNumber} states no positive quantity to issue.`,
        'Confirm picking first: the movement posts what the store confirmed.',
      );
    }

    let issue: Awaited<ReturnType<typeof postGoodsIssue>>;
    try {
      issue = await postGoodsIssue({
        client: parsed.client,
        changedBy: parsed.changedBy,
        movementTypeCode: DELIVERY_GOODS_ISSUE_MOVEMENT,
        postingDate: parsed.postingDate,
        documentDate: parsed.documentDate || parsed.postingDate,
        headerText: `SD ${header.deliveryNumber}`.slice(0, 25),
        // The movement's own replay key: a resubmission is answered with the document the first attempt
        // posted, so a shelf is never emptied twice by a form that was pressed twice.
        requestKey: `sd-gi-${parsed.client}-${header.deliveryNumber}`.slice(0, 64),
        lines: issueLines,
      }, 'SALES', { tx });
    } catch (caught) {
      if (caught instanceof GoodsIssueError || caught instanceof UnitConversionError) {
        throw new DeliveryError(caught.message, (caught as { remedy?: string }).remedy);
      }
      throw caught;
    }

    for (const line of lines) {
      const applied = await tx.update(deliveryLine).set({
        goodsIssueQuantity: line.deliveryQuantity,
        status: 'GOODS_ISSUED',
        changedBy: parsed.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(deliveryLine.client, parsed.client),
        eq(deliveryLine.deliveryNumber, header.deliveryNumber),
        eq(deliveryLine.lineNumber, line.lineNumber),
        eq(deliveryLine.status, 'PICKED'),
      )).returning({ number: deliveryLine.lineNumber });
      if (!applied.length) {
        throw new DeliveryError(
          `Delivery item ${line.lineNumber} changed while the goods issue was being posted. The movement was rolled back with it.`,
        );
      }
    }

    const applied = await tx.update(delivery).set({
      status: 'GOODS_ISSUED',
      goodsMovementDate: parsed.postingDate,
      materialDocumentNumber: issue.materialDocumentNumber,
      materialDocumentYear: issue.documentYear,
      version: header.version + 1,
      changedBy: parsed.changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(delivery.client, parsed.client),
      eq(delivery.deliveryNumber, header.deliveryNumber),
      eq(delivery.version, header.version),
    )).returning({ number: delivery.deliveryNumber });
    if (!applied.length) {
      throw new DeliveryError(
        'The delivery changed while the goods issue was being posted. The movement and its journal were rolled back with it.',
      );
    }

    await recordChange(tx, {
      client: parsed.client, objectClass: DELIVERY_OBJECT_CLASS, objectKey: header.deliveryNumber,
      changeType: 'CHANGE', changedBy: parsed.changedBy,
      before: { status: 'PICKED', version: header.version },
      after: {
        status: 'GOODS_ISSUED',
        version: header.version + 1,
        materialDocument: issue.materialDocumentNumber,
        journalDocument: issue.journalDocumentNumber ?? '',
        movementValue: issue.totalValue,
      },
      fieldLabels: {
        materialDocument: 'Material document', journalDocument: 'Accounting document',
        movementValue: 'Movement value',
      },
    });
    return { issue, header };
  });

  const view = await getDelivery(parsed.client, parsed.deliveryNumber);
  if (!view) throw new DeliveryError(`Delivery ${parsed.deliveryNumber} could not be read back.`);

  // The goods issue is the second check point §14.8 names. A breach it causes blocks the *receivable*: the
  // movement stands, the material has gone and no accounting act here reverses a posted movement.
  // The goods issue is the second check point the product document names. A breach it causes holds the
  // receivable rather than undoing the movement: the goods have left the plant, and no act on this screen
  // reverses a posted material document — that belongs to the inventory screen that owns it.
  let blockedForBilling = (await standingDetermination(parsed.client, view.deliveryNumber))?.status === 'BLOCKED';
  const judged = await withTenant(parsed.client, async (tx) => {
    const [order] = await tx.select().from(salesOrder).where(and(
      eq(salesOrder.client, parsed.client), eq(salesOrder.orderNumber, view.orderNumber),
    )).limit(1);
    if (!order) return null;
    const area = await creditAreaFor(tx, parsed.client, order.customerNumber, order.companyCode).catch(() => null);
    return area ? { area, currency: order.currency } : null;
  });
  if (judged) {
    const determination = await checkSalesDocumentCredit({
      client: parsed.client, changedBy: parsed.changedBy, salesDocument: view.deliveryNumber,
      documentDate: parsed.postingDate, salesOrg: view.salesOrg, customer: view.customerNumber,
      creditControlArea: judged.area, orderValue: view.value, orderCurrency: judged.currency,
    }).catch(() => null);
    if (determination) blockedForBilling = determination.status === 'BLOCKED';
  }

  return {
    delivery: { ...view, credit: await standingDetermination(parsed.client, view.deliveryNumber) },
    materialDocumentNumber: posted.issue.materialDocumentNumber,
    materialDocumentYear: posted.issue.documentYear,
    journalDocumentNumber: posted.issue.journalDocumentNumber,
    totalValue: posted.issue.totalValue,
    creditBlockedForBilling: blockedForBilling,
  };
}

/**
 * Cancel a delivery that has not gone out. A goods-issued delivery is not cancelled from here: the movement
 * posted stock and a journal, and the reversal belongs to the inventory screen that owns them. The order's
 * open quantities reappear on their own, because they were never copied onto the order line.
 */
export async function cancelDelivery(input: DeliveryCancelInput): Promise<DeliveryView> {
  const parsed = deliveryCancelInput.parse(input);
  await withTenant(parsed.client, async (tx) => {
    const [header] = await tx.select().from(delivery).where(and(
      eq(delivery.client, parsed.client), eq(delivery.deliveryNumber, parsed.deliveryNumber),
    )).limit(1);
    if (!header) throw new DeliveryError(`Delivery ${parsed.deliveryNumber} does not exist.`);
    if (header.status === 'CANCELLED') return;
    if (header.status === 'GOODS_ISSUED') {
      throw new DeliveryError(
        `Delivery ${parsed.deliveryNumber} is goods-issued under material document ${header.materialDocumentNumber}.`,
        'Reverse the goods issue in Inventory first; a cancelled delivery cannot take stock back on its own.',
      );
    }
    if (header.version !== parsed.expectedVersion) {
      throw new DeliveryError(
        `The delivery changed since it was read (version ${header.version}, expected ${parsed.expectedVersion}).`,
        'Reload the delivery, then cancel it.',
      );
    }
    await lockDelivery(tx, parsed.client, header.deliveryNumber);
    const [billed] = await tx.execute(sql`
      select bd.billing_number from billing_document bd
       where bd.client = ${parsed.client} and bd.delivery_number = ${header.deliveryNumber}
    `) as unknown as Array<{ billing_number: string }>;
    if (billed) {
      throw new DeliveryError(
        `Delivery ${parsed.deliveryNumber} already earned billing document ${billed.billing_number}; a billed delivery is not cancelled.`,
        'Cancel the billing document at /sales/billing, which reverses the receivable, then cancel the delivery.',
      );
    }
    const applied = await tx.update(delivery).set({
      status: 'CANCELLED', version: header.version + 1, changedBy: parsed.changedBy, changedAt: new Date(),
    }).where(and(
      eq(delivery.client, parsed.client),
      eq(delivery.deliveryNumber, header.deliveryNumber),
      eq(delivery.version, header.version),
    )).returning({ number: delivery.deliveryNumber });
    if (!applied.length) throw new DeliveryError('The delivery changed concurrently. Nothing was cancelled.');
    await recordChange(tx, {
      client: parsed.client, objectClass: DELIVERY_OBJECT_CLASS, objectKey: header.deliveryNumber,
      changeType: 'CHANGE', changedBy: parsed.changedBy,
      before: { status: header.status, version: header.version },
      after: { status: 'CANCELLED', version: header.version + 1, reason: (parsed.reason ?? '').trim() },
      fieldLabels: { reason: 'Cancellation reason' },
    });
  });
  const view = await getDelivery(parsed.client, parsed.deliveryNumber);
  if (!view) throw new DeliveryError(`Delivery ${parsed.deliveryNumber} could not be read back.`);
  return view;
}
