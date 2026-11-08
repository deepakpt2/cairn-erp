/**
 * The billing document a goods-issued delivery earns — VF01, VF02, VF04 and VF11 as search aliases of the one
 * screen (CAIRN.md §11.2, §14.7, §20).
 *
 * Two rules hold this file together.
 *
 * **The invoice states no price of its own.** The quantity is what the goods issue actually moved, and
 * everything after that is the order's: the unit price, the condition record, and — since 9238 — every
 * condition the order was priced by, scaled to the quantity that went out. A billing document does not look
 * a price up again, because a price looked up today is today's price; it bills the arithmetic the order
 * carries, which is what §11.2 asks for and what makes the two documents agree to the cent. An order that
 * predates the conditions is billed from its line as it always was, so no historic document moves.
 *
 * The tax code is judged by the same tax master the order was judged by, and by the rate the order's own
 * condition states where one stands — a tax looked up again would be today's rate on yesterday's goods.
 *
 * **The receivable is the accounting-invoice service's work.** This file does not post a journal, choose a
 * reconciliation account or compute a due date: it calls `postCustomerInvoice`, which owns all three, and keeps
 * the invoice number and journal document the call returned (§5.1). Because that service opens its own
 * transaction, the billing document is written first as OPEN and only becomes POSTED with the invoice it
 * created — so a refused posting leaves a document that can be retried under the same submission key rather
 * than a half-posted one, and the retry cannot raise a second receivable.
 *
 * One billing document per delivery, and one billing line per delivery line, are enforced by unique indexes, so
 * overbilling and double billing are structurally impossible rather than merely unlikely. A cancelled billing
 * keeps both rows, which is also why re-billing a cancelled document is refused here and belongs to the credit
 * memo path that has to be built first (DI-020).
 */
import { z } from 'zod';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { accountDetermination, companyCode as companyCodeTable, taxCode as taxCodeTable } from '../foundation/schema';
import {
  cancelCustomerInvoice, postCustomerInvoice, type CustomerInvoiceView,
} from '../finance/customer-invoice';

import { billingDocument, billingDocumentLine, delivery, deliveryLine, salesOrder, salesOrderLine } from './schema';
import { DOCUMENT_TYPE_REMEDY, STANDARD_BILLING_TYPE, salesDocumentTypeFor } from './document-type';
import {
  type PricedCondition, type StoredCondition, documentConditionsOf, roundAmount, scaleLineConditions,
  writeDocumentConditions,
} from './pricing-procedure';
import { standingDetermination } from './delivery';

export const BILLING_CAPABILITY = 'SALES.BILLING.CREATE';
export const BILLING_CANCEL_CAPABILITY = 'SALES.BILLING.CANCEL';
export const BILLING_ROUTE = '/sales/billing';
export const BILLING_OBJECT_CLASS = 'billing_document';
/** The revenue event the account is read from. A chart without it is a refusal, never a default. */
export const REVENUE_EVENT = 'SALES_REVENUE';

export class BillingError extends Error {
  remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'BillingError';
    this.remedy = remedy;
  }
}

const key = (max: number) => z.string().trim().transform((s) => s.toUpperCase()).pipe(z.string().min(1).max(max));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.');
const optionalText = (max: number) =>
  z.union([z.undefined(), z.literal(''), z.string().trim().pipe(z.string().max(max))]);

export const billingCreateInput = z.object({
  client: z.string().trim().length(4),
  changedBy: key(60),
  deliveryNumber: key(20),
  billingDate: isoDate,
  postingDate: z.union([z.undefined(), z.literal(''), isoDate]).optional(),
  requestKey: optionalText(64).optional(),
});

export const billingCancelInput = z.object({
  client: z.string().trim().length(4),
  changedBy: key(60),
  billingNumber: key(20),
  postingDate: isoDate,
  reason: optionalText(60).optional(),
  requestKey: optionalText(64).optional(),
});

export type BillingCreateInput = z.infer<typeof billingCreateInput>;
export type BillingCancelInput = z.infer<typeof billingCancelInput>;

const round2 = (value: number) => (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);

export interface BillingView {
  billingNumber: string;
  documentType: string;
  orderNumber: string;
  deliveryNumber: string;
  salesOrg: string;
  distributionChannel: string;
  division: string;
  customerNumber: string;
  companyCode: string;
  currency: string;
  billingDate: string;
  postingDate: string | null;
  status: string;
  netValue: string;
  taxValue: string;
  grossValue: string;
  customerInvoiceNumber: string | null;
  journalDocumentNumber: string | null;
  creditOf: string | null;
  cancellationOf: string | null;
  version: number;
  createdBy: string;
  lines: Array<{
    lineNumber: number;
    deliveryLineNumber: number;
    orderLineNumber: number;
    materialNumber: string;
    billingQuantity: string;
    netPrice: string;
    priceUnit: number;
    netAmount: string;
    taxCode: string | null;
    taxRate: string;
    taxAmount: string;
    conditionNumber: string;
  }>;
  credit: { status: string; blockReason?: string | null } | null;
}

function mapHeader(row: typeof billingDocument.$inferSelect): Omit<BillingView, 'lines' | 'credit'> {
  return {
    billingNumber: row.billingNumber,
    documentType: row.documentType,
    orderNumber: row.orderNumber,
    deliveryNumber: row.deliveryNumber,
    salesOrg: row.salesOrg,
    distributionChannel: row.distributionChannel,
    division: row.division,
    customerNumber: row.customerNumber,
    companyCode: row.companyCode,
    currency: row.currency,
    billingDate: row.billingDate,
    postingDate: row.postingDate,
    status: row.status,
    netValue: row.netValue,
    taxValue: row.taxValue,
    grossValue: row.grossValue,
    customerInvoiceNumber: row.customerInvoiceNumber,
    journalDocumentNumber: row.journalDocumentNumber,
    creditOf: row.creditOf,
    cancellationOf: row.cancellationOf,
    version: row.version,
    createdBy: row.createdBy,
  };
}

async function loadBilling(tx: Tx, client: string, billingNumber: string): Promise<BillingView | null> {
  const [header] = await tx.select().from(billingDocument).where(and(
    eq(billingDocument.client, client), eq(billingDocument.billingNumber, billingNumber),
  )).limit(1);
  if (!header) return null;
  const lines = await tx.select().from(billingDocumentLine).where(and(
    eq(billingDocumentLine.client, client), eq(billingDocumentLine.billingNumber, billingNumber),
  )).orderBy(asc(billingDocumentLine.lineNumber));
  return {
    ...mapHeader(header),
    lines: lines.map((line) => ({
      lineNumber: line.lineNumber,
      deliveryLineNumber: line.deliveryLineNumber,
      orderLineNumber: line.orderLineNumber,
      materialNumber: line.materialNumber,
      billingQuantity: line.billingQuantity,
      netPrice: line.netPrice,
      priceUnit: line.priceUnit,
      netAmount: line.netAmount,
      taxCode: line.taxCode,
      taxRate: line.taxRate,
      taxAmount: line.taxAmount,
      conditionNumber: line.conditionNumber,
    })),
    credit: null,
  };
}

export async function getBilling(client: string, billingNumber: string): Promise<BillingView | null> {
  const trimmed = billingNumber.trim().toUpperCase();
  const document = await withTenant(client, (tx) => loadBilling(tx, client, trimmed));
  if (!document) return null;
  const determination = await standingDetermination(client, document.deliveryNumber);
  return {
    ...document,
    credit: determination
      ? { status: determination.status, blockReason: determination.reason ?? null }
      : null,
  };
}

/**
 * The deliveries that have earned an invoice and have not yet had one: goods-issued, not cancelled, unbilled.
 * This is the due list VF04 works from, and it is the only set the screen offers to bill.
 */
export async function listBillableDeliveries(
  client: string,
  filter: { customerNumber?: string; deliveryNumber?: string } = {},
): Promise<Array<{
  deliveryNumber: string; orderNumber: string; customerNumber: string; plant: string;
  goodsMovementDate: string | null; materialDocumentNumber: string | null; value: string;
}>> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select d.delivery_number, d.order_number, d.customer_number, d.plant, d.goods_movement_date,
             d.material_document_number,
             coalesce(sum(dl.delivery_quantity * (l.net_amount + l.tax_amount) / nullif(l.order_quantity, 0)), 0)::text as value
        from delivery d
        join delivery_line dl on dl.client = d.client and dl.delivery_number = d.delivery_number
        join sales_order_line l
          on l.client = dl.client and l.order_number = dl.order_number and l.line_number = dl.order_line_number
        left join billing_document bd
          on bd.client = d.client
         and bd.delivery_number = d.delivery_number
         and bd.status <> 'CANCELLED'
         and bd.credit_of is null
         and bd.cancellation_of is null
       where d.client = ${client}
         and d.status = 'GOODS_ISSUED'
         and bd.billing_number is null
         and (${filter.customerNumber || null}::text is null or d.customer_number = ${filter.customerNumber || null})
         and (${filter.deliveryNumber || null}::text is null or d.delivery_number = ${filter.deliveryNumber || null})
       group by 1, 2, 3, 4, 5, 6
       order by d.delivery_number
       limit 200
    `) as unknown as Array<{
      delivery_number: string; order_number: string; customer_number: string; plant: string;
      goods_movement_date: string | null; material_document_number: string | null; value: string;
    }>;
    return rows.map((row) => ({
      deliveryNumber: row.delivery_number,
      orderNumber: row.order_number,
      customerNumber: row.customer_number,
      plant: row.plant,
      goodsMovementDate: row.goods_movement_date,
      materialDocumentNumber: row.material_document_number,
      value: round2(Number(row.value)),
    }));
  });
}

export async function listBillings(
  client: string,
  filter: { orderNumber?: string; customerNumber?: string; status?: string } = {},
): Promise<Array<{
  billingNumber: string; deliveryNumber: string; orderNumber: string; customerNumber: string;
  billingDate: string; status: string; grossValue: string; customerInvoiceNumber: string | null; version: number;
  creditOf: string | null; cancellationOf: string | null;
}>> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(billingDocument).where(and(
      eq(billingDocument.client, client),
      filter.orderNumber ? eq(billingDocument.orderNumber, filter.orderNumber) : undefined,
      filter.customerNumber ? eq(billingDocument.customerNumber, filter.customerNumber) : undefined,
      filter.status ? eq(billingDocument.status, filter.status) : undefined,
    )).orderBy(asc(billingDocument.billingNumber)).limit(200);
    return rows.map((row) => ({
      billingNumber: row.billingNumber,
      deliveryNumber: row.deliveryNumber,
      orderNumber: row.orderNumber,
      customerNumber: row.customerNumber,
      billingDate: row.billingDate,
      status: row.status,
      grossValue: row.grossValue,
      customerInvoiceNumber: row.customerInvoiceNumber,
      creditOf: row.creditOf,
      cancellationOf: row.cancellationOf,
      version: row.version,
    }));
  });
}

/** The revenue account the chart of accounts holds for a billed line. Absent configuration is a refusal. */
export async function revenueAccountFor(tx: Tx, client: string, company: string): Promise<string> {
  const [companyRow] = await tx.select({
    chart: companyCodeTable.chartOfAccounts, country: companyCodeTable.country,
  }).from(companyCodeTable).where(and(
    eq(companyCodeTable.client, client), eq(companyCodeTable.companyCode, company),
  )).limit(1);
  if (!companyRow?.chart) {
    throw new BillingError(
      `Company code ${company} carries no chart of accounts, so no revenue account can be read.`,
      'Complete the company code before billing.',
    );
  }
  const rows = await tx.select().from(accountDetermination).where(and(
    eq(accountDetermination.client, client),
    eq(accountDetermination.chartOfAccounts, companyRow.chart),
    eq(accountDetermination.event, REVENUE_EVENT),
  ));
  const row = rows.find((entry) => entry.generalModifier === '') ?? rows[0];
  if (!row) {
    throw new BillingError(
      `Account determination for ${REVENUE_EVENT} does not stand in chart ${companyRow.chart}.`,
      'Maintain the revenue account for that event on the account determination screen, then bill again.',
    );
  }
  return row.glAccount;
}

export interface BillingCreateResult {
  billing: BillingView;
  invoice: CustomerInvoiceView | null;
  /** False when the accounting-invoice service refused: the document stands OPEN and retries safely. */
  posted: boolean;
  /** Set when the delivery's credit determination is blocked: the document stands, the invoice is held. */
  heldForCredit: boolean;
  replayed: boolean;
}

/**
 * Bill a goods-issued delivery.
 *
 * The refusal ladder runs before anything is written: the delivery has to have gone out, no billing may
 * stand for it yet, the movement that shipped it must still stand (a reversed material document is not a
 * delivered quantity), and a credit block on the delivery or its order holds the invoice — the release is the
 * act that lets the receivable be raised, which is the point §14.8 makes about billing release.
 */
/**
 * What the billing transaction produced. `replayed` is a discriminant rather than a flag: a submission that
 * was already recorded carries no lines and no totals to post, and saying so in the type is what lets the
 * posting below read the customer, the company and the lines as facts instead of as things it must hope are
 * there.
 */
type BuiltBilling =
  | { billingNumber: string; replayed: true }
  | {
      billingNumber: string;
      replayed: false;
      held: boolean;
      invoice: InvoiceLine[];
      netTotal: string;
      taxTotal: string;
      grossTotal: string;
      companyCode: string;
      customerNumber: string;
      currency: string;
    };

export async function createBillingFromDelivery(input: BillingCreateInput): Promise<BillingCreateResult> {
  const parsed = billingCreateInput.parse(input);
  const built: BuiltBilling = await withTenant(parsed.client, async (tx) => {
    const [deliveryHeader] = await tx.select().from(delivery).where(and(
      eq(delivery.client, parsed.client), eq(delivery.deliveryNumber, parsed.deliveryNumber),
    )).limit(1);
    if (!deliveryHeader) {
      throw new BillingError(
        `Delivery ${parsed.deliveryNumber} does not exist in this tenant.`,
        'Create the delivery at /sales/delivery and post its goods issue first.',
      );
    }
    if (deliveryHeader.status === 'CANCELLED') {
      throw new BillingError(`Delivery ${parsed.deliveryNumber} stands CANCELLED; nothing was shipped to bill.`);
    }
    // An issue that has been reversed puts the delivery back where it stood before the movement, but it
    // is not a delivery that has never gone out: it is one whose goods came back. Say that, rather than
    // letting the status check answer "post the goods issue" about goods that were shipped and returned.
    if (deliveryHeader.materialDocumentNumber && !deliveryHeader.goodsIssueStands) {
      throw new BillingError(
        `The goods issue on material document ${deliveryHeader.materialDocumentNumber} has been reversed, so delivery ${deliveryHeader.deliveryNumber} has nothing delivered to bill.`,
        'Post the goods issue again, or cancel the delivery: a reversed issue is not billed.',
      );
    }
    if (deliveryHeader.status !== 'GOODS_ISSUED') {
      throw new BillingError(
        `Delivery ${parsed.deliveryNumber} stands ${deliveryHeader.status}; only a goods-issued delivery earns an invoice.`,
        'Post the goods issue at /sales/delivery first — a delivery that has not gone out bills nothing.',
      );
    }

    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${parsed.client}/delivery/${deliveryHeader.deliveryNumber}`}, 0))`);

    if (parsed.requestKey) {
      const [existing] = await tx.select({ number: billingDocument.billingNumber }).from(billingDocument).where(and(
        eq(billingDocument.client, parsed.client), eq(billingDocument.requestKey, parsed.requestKey),
      )).limit(1);
      if (existing) {
        return { billingNumber: existing.number, replayed: true };
      }
    }

    // A cancelled document no longer occupies the delivery's slot, and neither does a document that stands
    // against another one: the delivery is billable again, and the corrected document is a real one. This is
    // the same predicate as billing_document_delivery_live_uq, because a service that disagreed with the
    // index would refuse a document the database would have accepted, or the other way round.
    const [standing] = await tx.select({ number: billingDocument.billingNumber }).from(billingDocument).where(and(
      eq(billingDocument.client, parsed.client),
      eq(billingDocument.deliveryNumber, deliveryHeader.deliveryNumber),
      sql`${billingDocument.status} <> 'CANCELLED' and ${billingDocument.creditOf} is null and ${billingDocument.cancellationOf} is null`,
    )).limit(1);
    if (standing) {
      throw new BillingError(
        `Delivery ${deliveryHeader.deliveryNumber} is already billed as ${standing.number}.`,
        'A delivery earns one live billing document. Cancel it first, then bill the corrected value.',
      );
    }

    // A block anywhere on the chain holds the receivable: the goods have gone, so the movement stands, but no
    // invoice is raised over a block that has not been released.
    const deliveryBlock = await standingDetermination(parsed.client, deliveryHeader.deliveryNumber);
    const orderBlock = await standingDetermination(parsed.client, deliveryHeader.orderNumber);
    const held = deliveryBlock?.status === 'BLOCKED' || orderBlock?.status === 'BLOCKED';

    const lines = await tx.select().from(deliveryLine).where(and(
      eq(deliveryLine.client, parsed.client), eq(deliveryLine.deliveryNumber, deliveryHeader.deliveryNumber),
    )).orderBy(asc(deliveryLine.lineNumber));
    if (!lines.length) throw new BillingError(`Delivery ${deliveryHeader.deliveryNumber} carries no items.`);

    // A reversal that left part of the goods out: the delivery still stands issued, so the check above
    // does not fire, but the delivered quantity is unsettled. Reversal is by line, so the whole delivery
    // is held until it is settled — the same rule the inventory engine applies to its own open quantities.
    if (deliveryHeader.materialDocumentNumber) {
      const reversed = await tx.execute(sql`
        select count(*)::int as reversed
          from material_document_line rev
         where rev.client = ${parsed.client}
           and rev.reversal_of_document = ${deliveryHeader.materialDocumentNumber}
           and rev.material_number in (${sql.join(lines.map((line) => sql`${line.materialNumber}`), sql`, `)})
      `) as unknown as Array<{ reversed: number }>;
      if (Number(reversed[0]?.reversed ?? 0) > 0) {
        throw new BillingError(
          `Part of the goods issue on material document ${deliveryHeader.materialDocumentNumber} has been reversed, so the delivered quantity of delivery ${deliveryHeader.deliveryNumber} is not settled.`,
          'Re-post the movement or cancel the delivery in Inventory; a reversed issue is not billed.',
        );
      }
    }

    const orderNumbers = [...new Set(lines.map((line) => line.orderNumber))];
    const orderLines = await tx.select().from(salesOrderLine).where(and(
      eq(salesOrderLine.client, parsed.client), inArray(salesOrderLine.orderNumber, orderNumbers),
    ));
    const orderLineKey = (orderNumber: string, lineNumber: number) => `${orderNumber}|${lineNumber}`;
    const priced = new Map(orderLines.map((line) => [
      orderLineKey(line.orderNumber, line.lineNumber), line,
    ]));

    const [order] = await tx.select().from(salesOrder).where(and(
      eq(salesOrder.client, parsed.client), eq(salesOrder.orderNumber, deliveryHeader.orderNumber),
    )).limit(1);
    if (!order) throw new BillingError(`Sales order ${deliveryHeader.orderNumber} could not be read.`);
    const country = order.companyCode
      ? (await tx.select({ country: companyCodeTable.country }).from(companyCodeTable).where(and(
        eq(companyCodeTable.client, parsed.client), eq(companyCodeTable.companyCode, order.companyCode),
      )).limit(1))[0]?.country
      : undefined;
    const revenueAccount = await revenueAccountFor(tx, parsed.client, order.companyCode);
    // The conditions every order behind this delivery was priced by, so the invoice can bill the same
    // arithmetic rather than a price of its own. One read for all of them, inside this transaction: a
    // document that agrees with its order has to read the same row the order wrote.
    const orderConditionSets = new Map<string, StoredCondition[]>();
    for (const orderNumber of orderNumbers) {
      for (const condition of await documentConditionsOf(tx, parsed.client, 'ORDER', orderNumber)) {
        const rows = orderConditionSets.get(orderNumber) ?? [];
        rows.push(condition);
        orderConditionSets.set(orderNumber, rows);
      }
    }

    const items: Array<typeof billingDocumentLine.$inferInsert> = [];
    const billedLineConditions: Array<{ lineNumber: number; conditions: PricedCondition[] }> = [];
    const invoice: InvoiceLine[] = [];
    let netTotal = 0;
    let taxTotal = 0;
    for (const line of lines) {
      if (Number(line.goodsIssueQuantity) <= 0) {
        throw new BillingError(
          `Delivery item ${line.lineNumber} states no issued quantity, so there is nothing to bill on it.`,
          'A delivered line that was not issued is settled by the goods issue, not by an invoice.',
        );
      }
      const orderLine = priced.get(orderLineKey(line.orderNumber, line.orderLineNumber));
      if (!orderLine) {
        throw new BillingError(
          `Order ${line.orderNumber} item ${line.orderLineNumber} could not be read, so the billed price has no source.`,
          'A billing document prices from the order line the delivery names; nothing is defaulted.',
        );
      }
      const billed = Number(line.goodsIssueQuantity);
      const ordered = Number(orderLine.orderQuantity);
      // The conditions the order priced this line by, scaled to what actually went out. Where the order
      // carries none — a document created before 9238 — the line's own figures are billed, exactly as
      // they always were: a historic document is not moved by a rule it was never priced under.
      const standing = (orderConditionSets.get(line.orderNumber) ?? [])
        .filter((condition) => condition.lineNumber === line.orderLineNumber);
      const scaled = standing.length > 0
        ? scaleLineConditions(standing, ordered === 0 ? 0 : billed / ordered, {
          lineNumber: 0, quantity: billed,
        })
        : undefined;

      let netAmount: number;
      let taxAmount: number;
      let rate: number;
      let priceUnit = orderLine.priceUnit;
      let conditionNumber = orderLine.conditionNumber;
      let billedConditions = undefined as PricedCondition[] | undefined;
      if (scaled) {
        netAmount = Number(scaled.netAmount);
        taxAmount = Number(scaled.taxAmount);
        rate = Number(scaled.taxRate);
        priceUnit = scaled.priceUnit;
        conditionNumber = scaled.conditionNumber || orderLine.conditionNumber;
        billedConditions = scaled.conditions;
      } else {
        netAmount = (billed * Number(orderLine.netPrice)) / orderLine.priceUnit;
        // The tax code is judged by the tax master as it stands on the billing date — the same rule and the
        // same formula the order was priced by, so the invoice and this document cannot disagree about the
        // tax.
        rate = 0;
        if (orderLine.taxCode) {
          const [code] = await tx.select({ ratePercent: taxCodeTable.ratePercent }).from(taxCodeTable).where(and(
            eq(taxCodeTable.client, parsed.client), eq(taxCodeTable.country, country ?? ''),
            eq(taxCodeTable.taxCode, orderLine.taxCode),
          )).limit(1);
          if (!code) {
            throw new BillingError(
              `Tax code ${orderLine.taxCode} no longer stands for country ${country || '(none)'}, which item ${line.lineNumber} is billed under.`,
              'Maintain the tax code, or change the order line to a code that stands.',
            );
          }
          rate = Number(code.ratePercent);
        }
        taxAmount = rate ? Number(round2((netAmount * rate) / 100)) : 0;
      }
      netTotal += netAmount;
      taxTotal += taxAmount;
      const billingLineNumber = (items.length + 1) * 10;
      items.push({
        client: parsed.client,
        billingNumber: '',
        lineNumber: billingLineNumber,
        deliveryNumber: line.deliveryNumber,
        deliveryLineNumber: line.lineNumber,
        orderNumber: line.orderNumber,
        orderLineNumber: line.orderLineNumber,
        materialNumber: line.materialNumber,
        billingQuantity: line.goodsIssueQuantity,
        netPrice: roundAmount((Number(round2(netAmount)) * priceUnit) / (billed === 0 ? 1 : billed), 4),
        priceUnit,
        netAmount: round2(netAmount),
        taxCode: orderLine.taxCode,
        taxRate: rate.toFixed(4),
        taxAmount: round2(taxAmount),
        conditionNumber,
        createdBy: parsed.changedBy,
      });
      // What priced the invoice, beside the figures it states: an auditor reading it can name the record
      // the price came from without reading the order.
      if (billedConditions) {
        billedLineConditions.push({ lineNumber: billingLineNumber, conditions: billedConditions });
      }
      invoice.push({
        glAccount: revenueAccount,
        netAmount: Number(round2(netAmount)),
        taxCode: orderLine.taxCode || undefined,
        profitCenter: orderLine.profitCenter || undefined,
        lineText: `Delivery ${line.deliveryNumber} item ${line.lineNumber}`.slice(0, 50),
      });
    }

    // The document type is configuration now (9226); see the same note in sales-order.ts.
    const billingType = await salesDocumentTypeFor(tx, parsed.client, STANDARD_BILLING_TYPE);
    if (!billingType) {
      throw new BillingError(
        `Sales document type ${STANDARD_BILLING_TYPE} does not stand for this tenant, so no billing number can be drawn and no billing document can be created.`,
        DOCUMENT_TYPE_REMEDY,
      );
    }

    let number: string;
    try {
      const drawn = await allocateNumber(tx, {
        client: parsed.client, objectCode: billingType.numberRangeObject, companyCode: '*',
        subObject: billingType.numberRangeSubObject, fiscalYear: 0, allocatedBy: parsed.changedBy,
      });
      number = drawn.display;
    } catch {
      throw new BillingError(
        `No active internal ${billingType.numberRangeObject} number range stands for sub-object ${billingType.numberRangeSubObject} of sales document type ${billingType.documentType}, so no billing number can be drawn.`,
        'Define or unblock the interval on the number ranges screen, then bill again.',
      );
    }

    await tx.insert(billingDocument).values({
      client: parsed.client,
      billingNumber: number,
      documentType: billingType.documentType,
      orderNumber: order.orderNumber,
      deliveryNumber: deliveryHeader.deliveryNumber,
      salesOrg: deliveryHeader.salesOrg,
      distributionChannel: deliveryHeader.distributionChannel,
      division: deliveryHeader.division,
      customerNumber: deliveryHeader.customerNumber,
      companyCode: order.companyCode,
      currency: order.currency,
      billingDate: parsed.billingDate,
      postingDate: parsed.postingDate || null,
      status: 'OPEN',
      netValue: round2(netTotal),
      taxValue: round2(taxTotal),
      grossValue: round2(netTotal + taxTotal),
      referenceDocumentText: `Delivery ${deliveryHeader.deliveryNumber}`,
      requestKey: parsed.requestKey || null,
      createdBy: parsed.changedBy,
    });
    for (const item of items) {
      await tx.insert(billingDocumentLine).values({ ...item, billingNumber: number });
    }
    // The conditions the invoice was priced by: the order's own, at the quantity that went out. Written
    // here so the credit memo that gives part of it back can be proved to be the same price, and so an
    // invoice read years from still carries the arithmetic behind its figures.
    if (billedLineConditions.length > 0) {
      await writeDocumentConditions(tx, {
        client: parsed.client, documentCategory: 'BILLING', documentNumber: number,
        currency: order.currency, items: billedLineConditions, changedBy: parsed.changedBy,
      });
    }
    await recordChange(tx, {
      client: parsed.client, objectClass: BILLING_OBJECT_CLASS, objectKey: number, changeType: 'CREATE',
      changedBy: parsed.changedBy,
      after: {
        delivery: deliveryHeader.deliveryNumber,
        customer: deliveryHeader.customerNumber,
        items: items.length,
        netValue: round2(netTotal),
        taxValue: round2(taxTotal),
        grossValue: round2(netTotal + taxTotal),
        heldForCredit: held ? 'yes' : '',
      },
      fieldLabels: { heldForCredit: 'Held for credit' },
    });
    return {
      billingNumber: number,
      replayed: false,
      invoice,
      held,
      netTotal: round2(netTotal),
      taxTotal: round2(taxTotal),
      grossTotal: round2(netTotal + taxTotal),
      companyCode: order.companyCode,
      customerNumber: deliveryHeader.customerNumber,
      currency: order.currency,
    };
  });

  const view = await getBilling(parsed.client, built.billingNumber);
  if (!view) throw new BillingError(`Billing document ${built.billingNumber} could not be read back.`);
  if (built.replayed) {
    return { billing: view, invoice: null, posted: view.status === 'POSTED', heldForCredit: false, replayed: true };
  }
  if (view.status !== 'OPEN') {
    return { billing: view, invoice: null, posted: view.status === 'POSTED', heldForCredit: false, replayed: false };
  }
  if (built.held) {
    // The document stands, unbilled, and the release of the blocked document is what lets it post. Leaving it
    // OPEN is what makes that retry safe rather than a second invoice.
    return { billing: view, invoice: null, posted: false, heldForCredit: true, replayed: false };
  }

  const invoice = await postCustomerInvoice({
    client: parsed.client,
    changedBy: parsed.changedBy,
    customerNumber: built.customerNumber,
    companyCode: built.companyCode,
    documentDate: parsed.billingDate,
    postingDate: parsed.postingDate || parsed.billingDate,
    // The billing number is the invoice's reference: it is unique, and it is what makes the AR document
    // point back at the sales document that raised it.
    reference: built.billingNumber,
    currency: built.currency,
    grossAmount: Number(built.grossTotal),
    headerText: `Billing ${built.billingNumber}`.slice(0, 50),
    requestKey: `sd-bl-${parsed.client}-${built.billingNumber}`.slice(0, 64),
    lines: built.invoice,
  }).catch(async (caught: unknown) => {
    const error = caught as { message?: string; remedy?: string };
    throw new BillingError(
      `The billing document stands as ${built.billingNumber}, but the receivable was refused: ${error?.message ?? 'the accounting-invoice service would not post it.'}`,
      `${error?.remedy ?? 'Correct the customer or the accounting data, then bill again.'} The retry under the same submission raises no second invoice.`,
    );
  });

  await linkPostedInvoice(parsed.client, parsed.changedBy, built.billingNumber, invoice);

  return {
    billing: (await getBilling(parsed.client, built.billingNumber)) ?? view,
    invoice,
    posted: true,
    heldForCredit: false,
    replayed: false,
  };
}

interface InvoiceLine {
  glAccount: string;
  /** A number, because that is what the accounting-invoice service declares on its line input. */
  netAmount: number;
  taxCode?: string;
  profitCenter?: string;
  lineText?: string;
}

/**
 * Link a posted receivable back to the billing document that raised it, once, under the version the document
 * carried when the invoice was posted. Both the create path and the release-then-post path come through here,
 * so there is one author of the link and no second writer of `POSTED`.
 */
async function linkPostedInvoice(
  client: string,
  changedBy: string,
  billingNumber: string,
  invoice: CustomerInvoiceView,
): Promise<number> {
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(billingDocument).where(and(
      eq(billingDocument.client, client), eq(billingDocument.billingNumber, billingNumber),
    )).limit(1);
    if (!header) throw new BillingError(`Billing document ${billingNumber} disappeared.`);
    if (header.status !== 'OPEN') return header.version;
    const applied = await tx.update(billingDocument).set({
      status: 'POSTED',
      postingDate: invoice.postingDate,
      customerInvoiceNumber: invoice.invoiceNumber,
      journalDocumentNumber: invoice.journalDocumentNumber,
      taxValue: invoice.taxAmount,
      grossValue: invoice.grossAmount,
      version: header.version + 1,
      changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(billingDocument.client, client),
      eq(billingDocument.billingNumber, billingNumber),
      eq(billingDocument.version, header.version),
    )).returning({ version: billingDocument.version });
    if (!applied.length) {
      throw new BillingError(
        `The invoice stands as ${invoice.invoiceNumber}, but the billing document changed while it was being linked.`,
        'Read the billing document again: the receivable is posted and is not posted twice.',
      );
    }
    await recordChange(tx, {
      client, objectClass: BILLING_OBJECT_CLASS, objectKey: billingNumber,
      changeType: 'CHANGE', changedBy,
      before: { status: 'OPEN', version: header.version },
      after: {
        status: 'POSTED', version: header.version + 1,
        invoice: invoice.invoiceNumber, journal: invoice.journalDocumentNumber ?? '',
        dueDate: invoice.dueDate ?? '',
      },
      fieldLabels: { invoice: 'Customer invoice', journal: 'Accounting document', dueDate: 'Due date' },
    });
    return header.version + 1;
  });
}

/**
 * Post the invoice a standing billing document already earned — the act a release makes possible.
 *
 * Nothing is re-priced and no second number is drawn: the quantities, the prices and the condition provenance
 * are the rows the document already holds, and the receivable goes through the same accounting-invoice call
 * under the same request key, so a retry whose first attempt posted the invoice but lost the link-back raises
 * no second invoice. The revenue account is read from the chart again, because that is configuration and not
 * the document's own history; the profit centre is read from the order line the billed line names.
 */
async function postStandingBilling(input: {
  client: string; changedBy: string; billingNumber: string; billingDate: string; postingDate?: string;
}): Promise<BillingCreateResult> {
  const prepared = await withTenant(input.client, async (tx) => {
    const [header] = await tx.select().from(billingDocument).where(and(
      eq(billingDocument.client, input.client), eq(billingDocument.billingNumber, input.billingNumber),
    )).limit(1).for('update');
    if (!header) throw new BillingError(`Billing document ${input.billingNumber} does not exist.`);
    if (header.status !== 'OPEN') {
      return { post: false as const, held: false, header };
    }
    const deliveryBlock = await standingDetermination(input.client, header.deliveryNumber);
    const orderBlock = await standingDetermination(input.client, header.orderNumber);
    if (deliveryBlock?.status === 'BLOCKED' || orderBlock?.status === 'BLOCKED') {
      return { post: false as const, held: true, header };
    }
    const lines = await tx.select().from(billingDocumentLine).where(and(
      eq(billingDocumentLine.client, input.client), eq(billingDocumentLine.billingNumber, input.billingNumber),
    )).orderBy(asc(billingDocumentLine.lineNumber));
    if (!lines.length) throw new BillingError(`Billing document ${input.billingNumber} carries no items.`);
    const [order] = await tx.select().from(salesOrder).where(and(
      eq(salesOrder.client, input.client), eq(salesOrder.orderNumber, header.orderNumber),
    )).limit(1);
    if (!order) throw new BillingError(`Sales order ${header.orderNumber} could not be read.`);
    const revenueAccount = await revenueAccountFor(tx, input.client, header.companyCode);
    const orderLines = await tx.select().from(salesOrderLine).where(and(
      eq(salesOrderLine.client, input.client), eq(salesOrderLine.orderNumber, header.orderNumber),
    ));
    const invoice: InvoiceLine[] = lines.map((line) => {
      const orderLine = orderLines.find((row) => row.lineNumber === line.orderLineNumber);
      return {
        glAccount: revenueAccount,
        netAmount: Number(line.netAmount),
        taxCode: line.taxCode || undefined,
        profitCenter: orderLine?.profitCenter || undefined,
        lineText: `Delivery ${line.deliveryNumber} item ${line.deliveryLineNumber}`.slice(0, 50),
      };
    });
    return { post: true as const, held: false, header, invoice, currency: order.currency };
  });

  const view = await getBilling(input.client, input.billingNumber);
  if (!view) throw new BillingError(`Billing document ${input.billingNumber} could not be read back.`);
  if (!prepared.post) {
    return {
      billing: view, invoice: null, posted: view.status === 'POSTED',
      heldForCredit: prepared.held, replayed: true,
    };
  }

  const invoice = await postCustomerInvoice({
    client: input.client,
    changedBy: input.changedBy,
    customerNumber: prepared.header.customerNumber,
    companyCode: prepared.header.companyCode,
    // The standing document's own dates are authoritative on a retry: a later submission date must not move
    // the invoice's document date or its due date away from the billing document that was held.
    documentDate: prepared.header.billingDate,
    postingDate: prepared.header.postingDate || input.postingDate || prepared.header.billingDate,
    reference: prepared.header.billingNumber,
    currency: prepared.currency,
    grossAmount: Number(prepared.header.grossValue),
    headerText: `Billing ${prepared.header.billingNumber}`.slice(0, 50),
    requestKey: `sd-bl-${input.client}-${prepared.header.billingNumber}`.slice(0, 64),
    lines: prepared.invoice,
  }).catch((caught: unknown) => {
    const error = caught as { message?: string; remedy?: string };
    throw new BillingError(
      `The billing document stands as ${prepared.header.billingNumber}, but the receivable was refused: ${error?.message ?? 'the accounting-invoice service would not post it.'}`,
      `${error?.remedy ?? 'Correct the customer or the accounting data, then bill again.'} The retry under the same submission raises no second invoice.`,
    );
  });

  await linkPostedInvoice(input.client, input.changedBy, prepared.header.billingNumber, invoice);
  return {
    billing: (await getBilling(input.client, prepared.header.billingNumber)) ?? view,
    invoice,
    posted: true,
    heldForCredit: false,
    replayed: true,
  };
}

/**
 * Bill a delivery that is standing, held or already posted — the act the screen's button calls. When the
 * document was held for credit and the block has since been released, the same submission posts it; nothing
 * is re-priced and no second document is drawn.
 */
export async function postBillingDocument(
  input: BillingCreateInput,
): Promise<BillingCreateResult> {
  const parsed = billingCreateInput.parse(input);
  const existing = await withTenant(parsed.client, async (tx) => {
    const [row] = await tx.select({ number: billingDocument.billingNumber }).from(billingDocument).where(and(
      eq(billingDocument.client, parsed.client),
      eq(billingDocument.deliveryNumber, parsed.deliveryNumber),
      sql`${billingDocument.status} <> 'CANCELLED' and ${billingDocument.creditOf} is null and ${billingDocument.cancellationOf} is null`,
    )).limit(1);
    return row?.number ?? null;
  });
  // No live document stands, so a cancelled one is history rather than a door: the corrected document is
  // drawn here, which is what the billing due list offers once a cancellation has released the delivery.
  if (!existing) return createBillingFromDelivery(parsed);

  const view = await getBilling(parsed.client, existing);
  if (!view) throw new BillingError(`Billing document ${existing} could not be read.`);
  if (view.status === 'POSTED') {
    return { billing: view, invoice: null, posted: true, heldForCredit: false, replayed: true };
  }
  // An OPEN document is the one state that may still raise its invoice. Re-read the block, then post.
  const held = await standingDetermination(parsed.client, view.deliveryNumber);
  if (held?.status === 'BLOCKED') {
    return { billing: view, invoice: null, posted: false, heldForCredit: true, replayed: false };
  }
  return postStandingBilling({
    client: parsed.client,
    changedBy: parsed.changedBy,
    billingNumber: existing,
    billingDate: parsed.billingDate,
    postingDate: parsed.postingDate,
  });
}

/**
 * The document a cancellation creates: a billing document of the cancellation type the original's own type
 * names, carrying the original's value with the sign reversed and pointing at the invoice cancellation that
 * did the accounting.
 *
 * It carries no lines of its own. The revenue, the tax and the receivable were determined line by line when
 * the invoice was raised, and the accounting-invoice service mirrors that journal line for line when it
 * cancels — so a second set of lines here would be a second description of the same delivered quantities,
 * obliged to stay in step with the original for no reader's benefit. The credit memo that arrives with the
 * returns work will carry lines, because a credit memo describes goods rather than undoing a document.
 *
 * A second cancellation is not possible: `billing_document_cancellation_uq` holds one document per original.
 */
async function insertCancellationDocument(
  tx: Tx,
  input: {
    client: string;
    header: typeof billingDocument.$inferSelect;
    invoice: CustomerInvoiceView;
    changedBy: string;
    requestKey: string;
  },
): Promise<string> {
  const { client, header, invoice, changedBy, requestKey } = input;
  const negate = (value: string) => (-Number(value)).toFixed(4);

  const type = await salesDocumentTypeFor(tx, client, header.documentType);
  if (!type) {
    throw new BillingError(
      `Sales document type ${header.documentType} does not stand for this tenant, so billing document ${header.billingNumber} cannot be cancelled.`,
      DOCUMENT_TYPE_REMEDY,
    );
  }
  if (!type.cancellationDocumentType) {
    throw new BillingError(
      `Sales document type ${type.documentType} names no cancellation document type, so billing document ${header.billingNumber} has no document to cancel into.`,
      'Name the cancellation type for that document type in the sales document type configuration, then cancel again.',
    );
  }
  const cancellationType = await salesDocumentTypeFor(tx, client, type.cancellationDocumentType);
  if (!cancellationType) {
    throw new BillingError(
      `The cancellation type ${type.cancellationDocumentType} that ${type.documentType} names does not stand for this tenant, so billing document ${header.billingNumber} cannot be cancelled.`,
      'Add that type to the sales document type configuration, then cancel again.',
    );
  }

  let number: string;
  try {
    const drawn = await allocateNumber(tx, {
      client, objectCode: cancellationType.numberRangeObject, companyCode: '*',
      subObject: cancellationType.numberRangeSubObject, fiscalYear: 0, allocatedBy: changedBy,
    });
    number = drawn.display;
  } catch {
    throw new BillingError(
      `No active internal ${cancellationType.numberRangeObject} number range stands for sub-object ${cancellationType.numberRangeSubObject} of sales document type ${cancellationType.documentType}, so no cancellation document can be drawn.`,
      'Define or unblock the interval on the number ranges screen, then cancel again.',
    );
  }

  await tx.insert(billingDocument).values({
    client,
    billingNumber: number,
    documentType: cancellationType.documentType,
    orderNumber: header.orderNumber,
    deliveryNumber: header.deliveryNumber,
    salesOrg: header.salesOrg,
    distributionChannel: header.distributionChannel,
    division: header.division,
    customerNumber: header.customerNumber,
    companyCode: header.companyCode,
    currency: header.currency,
    billingDate: header.billingDate,
    postingDate: header.postingDate,
    status: 'POSTED',
    // Not a second sale: the same value, reversed.
    netValue: negate(header.netValue),
    taxValue: negate(header.taxValue),
    grossValue: negate(header.grossValue),
    customerInvoiceNumber: invoice.invoiceNumber,
    journalDocumentNumber: invoice.journalDocumentNumber,
    referenceDocumentText: `Cancellation of ${header.billingNumber}`.slice(0, 100),
    cancellationOf: header.billingNumber,
    requestKey,
    createdBy: changedBy,
  });

  await recordChange(tx, {
    client, objectClass: BILLING_OBJECT_CLASS, objectKey: number,
    changeType: 'CREATE', changedBy,
    after: {
      documentType: cancellationType.documentType,
      cancellationOf: header.billingNumber,
      value: negate(header.grossValue),
      invoice: invoice.invoiceNumber,
      journal: invoice.journalDocumentNumber ?? '',
    },
    fieldLabels: {
      cancellationOf: 'Cancels', value: 'Value reversed',
      invoice: 'Cancellation invoice', journal: 'Reversal journal',
    },
  });
  return number;
}

/**
 * Cancel a posted billing document. The receivable leaves the customer account the only way it can: through
 * the accounting-invoice service's own cancellation, which mirrors the journal.
 *
 * Two documents come out of this, as they do under VF11. The original stays behind as CANCELLED, because the
 * chain has to remember that this delivery was billed and undone. Beside it stands a cancellation document of
 * the type the original's own billing type names — `S1` for an `F2` — carrying the value reversed and linked
 * to the document it cancels. The delivery's slot is then free again, so a corrected billing document can be
 * created against the same delivery and the same order: the cancellation is the end of one document, not the
 * end of the delivery.
 *
 * An OPEN document has nothing to reverse and earns no cancellation document: it is marked CANCELLED and the
 * delivery is billable again.
 */
export async function cancelBillingDocument(
  input: BillingCancelInput,
): Promise<{ billing: BillingView; invoice: CustomerInvoiceView | null; cancellation: BillingView | null }> {
  const parsed = billingCancelInput.parse(input);
  const target = await withTenant(parsed.client, async (tx) => {
    const [header] = await tx.select().from(billingDocument).where(and(
      eq(billingDocument.client, parsed.client), eq(billingDocument.billingNumber, parsed.billingNumber),
    )).limit(1);
    if (!header) throw new BillingError(`Billing document ${parsed.billingNumber} does not exist.`);
    return {
      status: header.status,
      invoiceNumber: header.customerInvoiceNumber,
      deliveryNumber: header.deliveryNumber,
    };
  });

  let invoice: CustomerInvoiceView | null = null;
  if (target.status === 'CANCELLED') {
    // Already cancelled: a second call is not a second reversal. The document that did it is answered with,
    // so a caller who asks twice sees the same cancellation rather than a silent nothing.
    const standing = await withTenant(parsed.client, (tx) => tx
      .select({ number: billingDocument.billingNumber })
      .from(billingDocument)
      .where(and(
        eq(billingDocument.client, parsed.client),
        eq(billingDocument.cancellationOf, parsed.billingNumber),
      ))
      .limit(1));
    return {
      billing: (await getBilling(parsed.client, parsed.billingNumber))!,
      invoice: null,
      cancellation: standing[0]?.number ? await getBilling(parsed.client, standing[0].number) : null,
    };
  }
  if (target.status === 'POSTED') {
    if (!target.invoiceNumber) {
      throw new BillingError(
        `Billing document ${parsed.billingNumber} is posted without a customer invoice number.`,
        'The link is what a cancellation addresses; read the document and report the mismatch.',
      );
    }
    invoice = await cancelCustomerInvoice({
      client: parsed.client,
      changedBy: parsed.changedBy,
      invoiceNumber: target.invoiceNumber,
      postingDate: parsed.postingDate,
      requestKey: parsed.requestKey || `sd-bl-cancel-${parsed.client}-${parsed.billingNumber}`.slice(0, 64),
    }).catch((caught: unknown) => {
      const error = caught as { message?: string; remedy?: string };
      throw new BillingError(
        `The receivable refused the cancellation: ${error?.message ?? 'the accounting-invoice service would not mirror the journal.'}`,
        error?.remedy ?? 'Clear or reverse the incoming payment against the invoice first.',
      );
    });
  }

  let cancellationNumber: string | null = null;
  await withTenant(parsed.client, async (tx) => {
    const [header] = await tx.select().from(billingDocument).where(and(
      eq(billingDocument.client, parsed.client), eq(billingDocument.billingNumber, parsed.billingNumber),
    )).limit(1);
    if (!header || header.status === 'CANCELLED') return;
    // Only a posted document has a receivable to reverse, and only a reversal earns a cancellation document.
    if (invoice) {
      cancellationNumber = await insertCancellationDocument(tx, {
        client: parsed.client,
        header,
        invoice,
        changedBy: parsed.changedBy,
        requestKey: `${parsed.requestKey || `sd-bl-cancel-${parsed.client}-${parsed.billingNumber}`}-cancellation`.slice(0, 64),
      });
    }
    const applied = await tx.update(billingDocument).set({
      status: 'CANCELLED',
      version: header.version + 1,
      changedBy: parsed.changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(billingDocument.client, parsed.client),
      eq(billingDocument.billingNumber, parsed.billingNumber),
      eq(billingDocument.version, header.version),
    )).returning({ version: billingDocument.version });
    if (!applied.length) {
      throw new BillingError('The billing document changed while it was being cancelled. Reload and try again.');
    }
    await recordChange(tx, {
      client: parsed.client, objectClass: BILLING_OBJECT_CLASS, objectKey: parsed.billingNumber,
      changeType: 'CHANGE', changedBy: parsed.changedBy,
      before: { status: header.status, version: header.version },
      after: {
        status: 'CANCELLED', version: header.version + 1,
        reason: (parsed.reason ?? '').trim(),
        mirroredInvoice: invoice?.invoiceNumber ?? '',
        cancellation: cancellationNumber ?? '',
      },
      fieldLabels: {
        reason: 'Cancellation reason', mirroredInvoice: 'Cancellation invoice',
        cancellation: 'Cancellation document',
      },
    });
  });

  return {
    billing: (await getBilling(parsed.client, parsed.billingNumber))!,
    invoice,
    cancellation: cancellationNumber ? await getBilling(parsed.client, cancellationNumber) : null,
  };
}

/**
 * The document flow a reader asks for at the end of the chain: order, delivery, the material document that
 * moved the stock, the billing document and the receivable it raised, in the one read that proves the links.
 *
 * One row per billing document the delivery carries, and each row names what that document *is*: its type,
 * whether it stands or was cancelled, and — for a cancellation — the document it cancels. Without those three
 * a corrected chain is unreadable: an invoice, its cancellation and the corrected invoice are three rows of
 * the same delivery, and a reader shown only their numbers has to guess which is the live one. They are
 * returned in the order they were created, which is the order they happened in.
 */
export async function salesDocumentFlow(
  client: string,
  orderNumber: string,
): Promise<Array<{
  orderNumber: string;
  deliveryNumber: string | null;
  materialDocumentNumber: string | null;
  billingNumber: string | null;
  /** What the billing document is: F2 an invoice, S1 its cancellation, G2 a credit memo. */
  billingDocumentType: string | null;
  /** Whether that document stands or was cancelled. */
  billingStatus: string | null;
  /** The document this one cancels, on a cancellation row. */
  billingCancels: string | null;
  customerInvoiceNumber: string | null;
  status: string;
  issuedStands: boolean;
}>> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select d.delivery_number, d.material_document_number, d.status as delivery_status,
             bd.billing_number, bd.customer_invoice_number, bd.document_type, bd.status as billing_status,
             bd.cancellation_of,
             (select count(*) from material_document_line rev
               where rev.client = d.client and rev.reversal_of_document = d.material_document_number) as reversed_lines
        from delivery d
        left join billing_document bd on bd.client = d.client and bd.delivery_number = d.delivery_number
       where d.client = ${client} and d.order_number = ${orderNumber}
       order by d.delivery_number, bd.created_at, bd.billing_number
    `) as unknown as Array<{
      delivery_number: string; material_document_number: string | null; delivery_status: string;
      billing_number: string | null; customer_invoice_number: string | null; reversed_lines: number;
      document_type: string | null; billing_status: string | null; cancellation_of: string | null;
    }>;
    return rows.map((row) => ({
      orderNumber,
      deliveryNumber: row.delivery_number,
      materialDocumentNumber: row.material_document_number,
      billingNumber: row.billing_number,
      billingDocumentType: row.document_type,
      billingStatus: row.billing_status,
      billingCancels: row.cancellation_of,
      customerInvoiceNumber: row.customer_invoice_number,
      status: row.delivery_status,
      issuedStands: Number(row.reversed_lines) === 0,
    }));
  });
}

/** The unreversed-issue test the billing refusal uses, exposed for the screen's own wording. */
/**
 * Whether the goods issue this delivery posted still stands.
 *
 * It is the delivery's own fact now (9233): true from the moment the movement posts, false when that
 * movement is reversed. It used to be computed here by counting the material document's unreversed
 * lines — a screen doing arithmetic on another module's tables to answer a question the delivery
 * owns, and one that went on saying the goods were out after a reversal had put them back in the
 * plant. The fact is persisted where it belongs, and this reads it.
 */
export async function goodsIssueStands(client: string, deliveryNumber: string): Promise<boolean> {
  return withTenant(client, async (tx) => {
    const [row] = await tx.select({ stands: delivery.goodsIssueStands }).from(delivery).where(and(
      eq(delivery.client, client), eq(delivery.deliveryNumber, deliveryNumber),
    )).limit(1);
    return row?.stands ?? false;
  });
}
