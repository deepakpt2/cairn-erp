/**
 * Sales orders — CAIRN.md §11.2 row 3, the first link of the order-to-invoice chain (VA01 create,
 * VA02 change, VA03 display).
 *
 * The order is the customer's commitment: an ordered quantity, a price the standing condition records
 * answered for, and the credit determination the save itself raised. It reserves no stock and posts
 * no accounting document, so neither the FI periods nor the material period control is consulted here;
 * those belong to the goods issue that follows the outbound delivery.
 *
 * What the save judges, in order: the sales area stands and is active; the company code stands, since
 * the tax code is keyed by its country; the customer is a business partner in the customer role; the
 * customer's sales-area data stands, is maintained and is not blocked, and brings the pricing
 * procedure with it; every material is extended to the plant named on the item and is not flagged for
 * deletion there; the quantity carries no more decimals than the unit allows; the unit converts to the
 * material's base unit by a standing rate, never by a silent one-to-one; the price comes from a
 * condition record valid for the order date, never from a figure typed into the form; and a tax code
 * the item names stands in the company's country.
 *
 * A credit block does not destroy the order. The determination that says BLOCKED stands against the
 * number, that determination is what a follow-on document reads, and releasing it is the separate
 * authorized act in `releaseSalesOrderCredit` and on /finance/credit-release.
 */
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { unitOfMeasure } from '../../platform/tables/reference';
import { bpRole, businessPartner } from '../foundation/business-partner-schema';
import { companyCode, plant, salesArea } from '../foundation/schema';
import { material } from '../inventory/schema';
import { toBaseQuantity, UnitConversionError } from '../inventory/unit-conversion';
import {
  checkSalesDocumentCredit, listCreditDeterminations, releaseDocument,
  type CreditDeterminationView, type ReleaseOutcome,
} from '../finance/credit';
import { customerCredit } from '../finance/schema';
import { evaluateIncompletion } from './incompletion';
import { recordSalesOutputs } from './output';
import { type DocumentPartners, documentPartners, resolvePartners, writeDocumentPartners } from './partners';
import { DeliveringPlantError, deliveringPlantFor } from './delivering-plant';
import { billedOf, deliveredOf, fulfillmentDocumentsOf, orderLineProgress } from './fulfillment-quantities';
import { PricingError, assertMaterialAtPlant, resolveCustomerSalesData } from './pricing';
import { MaterialSalesError, assertMaterialSalesArea } from './material-sales';
import {
  AvailabilityError, ORDER_CHECKING_RULE, confirmOrderLines, writeScheduleLines,
} from './availability';
import { salesOrder, salesOrderLine, salesOrderSchedule } from './schema';
import { DOCUMENT_TYPE_REMEDY, STANDARD_ORDER_TYPE, salesDocumentTypeFor } from './document-type';
import {
  PricingProcedureError, STANDARD_DOCUMENT_PRICING_PROCEDURE, type PricedDocument, priceDocument,
  writeDocumentConditions,
} from './pricing-procedure';

export const SALES_ORDER_CAPABILITY = 'SALES.ORDER.CREATE';
export const SALES_ORDER_RELEASE_CAPABILITY = 'SALES.ORDER.RELEASE';
export const SALES_ORDER_OBJECT_CLASS = 'sales_order';
export const SALES_ORDER_ROUTE = '/sales/orders';

export class SalesOrderError extends Error {
  remedy: string;
  constructor(message: string, remedy = 'Correct the document and save it again.') {
    super(message);
    this.name = 'SalesOrderError';
    this.remedy = remedy;
  }
}

const key = (max: number) => z.string().trim().transform((s) => s.toUpperCase()).pipe(z.string().min(1).max(max));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.');
const optionalKey = (max: number) => z.union([z.undefined(), z.literal(''), z.string().trim().transform((s) => s.toUpperCase()).pipe(z.string().max(max))]);

export const orderLineInput = z.object({
  /** Present only to address an existing item on a change; a new item leaves it out. */
  lineNumber: z.union([z.undefined(), z.coerce.number().int().positive()]),
  materialNumber: key(40),
  /**
   * Where the goods come from. Left out — and blank — the master answers: the customer's sales
   * area first, then the material's own sales view. Named, it stands, because a person who chose
   * a plant did not choose it by accident.
   */
  plant: optionalKey(10),
  orderQuantity: z.coerce.number().gt(0),
  /** Absent means the material's base unit. */
  quantityUnit: optionalKey(6),
  taxCode: optionalKey(4),
  profitCenter: optionalKey(20),
  requestedDeliveryDate: z.union([z.undefined(), isoDate]),
});

const documentFields = {
  client: key(4),
  changedBy: z.string().trim().min(1).max(60),
  salesOrg: key(4),
  distributionChannel: key(2),
  division: key(2),
  customerNumber: key(40),
  companyCode: key(10),
  currency: key(3),
  orderDate: isoDate,
  requestedDate: z.union([z.undefined(), isoDate]),
  purchaseOrderReference: optionalKey(20),
  headerText: z.union([z.undefined(), z.string().trim().max(100)]),
  /** Needed only when the customer is monitored in more than one area. */
  creditControlArea: optionalKey(4),
  requestKey: z.union([z.undefined(), z.string().trim().min(8).max(64)]),
  /**
   * An order's items, as many as the order has. This was a hundred and the grid that typed them was
   * ten, and the two disagreed about how large a large order was; the grid grows now (§5.4), so the
   * service stands at the number a sales order has always been allowed to carry.
   */
  lines: z.array(orderLineInput).min(1).max(999),
};

export const orderCreateInput = z.object(documentFields);

/**
 * A change submits the items it wants to stand, by their numbers. An item that is neither submitted
 * nor rejected is a refusal, not a deletion: a dropped line must be a decision with a reason.
 */
export const orderChangeInput = z.object({
  ...documentFields,
  orderNumber: key(20),
  expectedVersion: z.coerce.number().int().positive(),
  rejectLines: z.array(z.object({ lineNumber: z.coerce.number().int().positive(), reason: key(4) })).default([]),
});

export type OrderCreateInput = z.infer<typeof orderCreateInput>;
export type OrderChangeInput = z.infer<typeof orderChangeInput>;

function round2(value: number): string {
  if (!Number.isFinite(value)) throw new SalesOrderError('A value did not scale to a number.');
  return (Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2);
}

/** The decimals the typed figure carries, after the zeros that only pad it out. */
function decimalsOf(quantity: string): number {
  const [, fraction = ''] = quantity.split('.');
  return fraction.replace(/0+$/, '').length;
}

async function requireOne<T>(row: T | undefined, missing: string, remedy: string): Promise<T> {
  if (!row) throw new SalesOrderError(missing, remedy);
  return row;
}

/**
 * The credit control area the order is judged in. The company code's assignment decides, as it does for
 * the receivable; only when the company carries no area does the customer's own single area answer, and
 * a document may name an area only when the customer is monitored in it.
 */
export async function creditAreaFor(
  tx: Tx, client: string, customerNumber: string, company: string, named?: string,
): Promise<string> {
  const [companyRow] = await tx.select({ area: companyCode.creditControlArea }).from(companyCode)
    .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, company))).limit(1);
  if (companyRow?.area) {
    if (named && named !== companyRow.area) {
      throw new SalesOrderError(
        `Company code ${company} judges credit in area ${companyRow.area}, not in ${named}.`,
        'Order without naming an area, or move the company code to the area you meant.',
      );
    }
    return companyRow.area;
  }
  const rows = await tx.select({ area: customerCredit.creditControlArea }).from(customerCredit)
    .where(and(eq(customerCredit.client, client), eq(customerCredit.customer, customerNumber)));
  void company;
  const areas = [...new Set(rows.map((r) => r.area))];
  if (named) {
    if (!areas.includes(named)) {
      throw new SalesOrderError(
        `Customer ${customerNumber} is not monitored in credit control area ${named}.`,
        'Maintain the credit record for that area at /finance/credit, or save without naming an area.',
      );
    }
    return named;
  }
  if (areas.length === 0) {
    throw new SalesOrderError(
      `Customer ${customerNumber} stands in no credit control area, so the order cannot be judged for credit.`,
      `Maintain the credit record for the customer at /finance/credit, or assign a credit control area to company code ${company}. An unjudged customer is not a customer without a block.`,
    );
  }
  if (areas.length > 1) {
    throw new SalesOrderError(
      `Customer ${customerNumber} is monitored in ${areas.length} credit control areas; the order must name one.`,
      'Name the credit control area on the order, or assign one to the company code so every order there is judged in it.',
    );
  }
  return areas[0];
}

interface PricedLine {
  lineNumber: number;
  materialNumber: string;
  plant: string;
  orderQuantity: string;
  quantityUnit: string;
  baseQuantity: string;
  netPrice: string;
  priceUnit: number;
  netAmount: string;
  taxCode: string | null;
  taxRate: string;
  taxAmount: string;
  profitCenter: string | null;
  requestedDeliveryDate: string | null;
  conditionNumber: string;
}

/**
 * Judge and price every submitted item. The numbers are the document's: an item that will not pass is
 * a refusal of the whole save, so a partial set never stands.
 */
async function priceLines(
  tx: Tx,
  client: string,
  input: {
    salesOrg: string; distributionChannel: string; division: string; customerNumber: string;
    companyCode: string; currency: string; orderDate: string; lines: z.infer<typeof orderLineInput>[];
    /** The pricing procedure the document type carries, and the one the customer's data carries. */
    documentPricingProcedure: string; customerPricingProcedure?: string | null;
  },
  firstLineNumber: number,
): Promise<{ lines: PricedLine[]; priced: PricedDocument }> {
  const judged: Array<{ line: z.infer<typeof orderLineInput>; plant: string; lineNumber: number; quantity: string; unit: string; baseQuantity: number }> = [];
  let fallbackNumber = firstLineNumber;
  // The first pass judges: a material that does not stand, a plant that does not carry it, a unit or a
  // quantity that will not do. Nothing is priced until every item has passed, so a refusal is never a
  // half-priced document.
  // The goods are going to the ship-to where the customer names one, and it is the ship-to's master
  // that says where they come from. A customer whose partners cannot be read yet is not refused
  // here: the plant falls back to the sold-to, and the save is judged by the checks that follow.
  const shipTo = await resolvePartners(tx, client, {
    partnerNumber: input.customerNumber, salesOrg: input.salesOrg,
    distributionChannel: input.distributionChannel, division: input.division,
  }).then((partners) => partners.shipTo).catch(() => input.customerNumber);

  for (const line of input.lines) {
    const [materialRow] = await tx.select().from(material).where(and(
      eq(material.client, client), eq(material.materialNumber, line.materialNumber),
    )).limit(1);
    await requireOne(
      materialRow,
      `Material ${line.materialNumber} does not stand in this client.`,
      'The sales view of a material does not create it; maintain the material first.',
    );
    // Where the goods come from. The item may name a plant, and a plant a person named is not
    // second-guessed. Where it names none, the master answers — the customer's sales area first,
    // then the material's own sales view — and where neither stands the refusal names both
    // screens rather than borrowing a plant from somewhere.
    const namedPlant = (line.plant ?? '').trim().toUpperCase();
    const plant = namedPlant || await deliveringPlantFor(tx, client, {
      shipTo, soldTo: input.customerNumber, materialNumber: line.materialNumber,
      salesOrg: input.salesOrg, distributionChannel: input.distributionChannel,
      division: input.division,
    }).then((answer) => answer.plant).catch((error: unknown) => {
      if (error instanceof DeliveringPlantError) throw new SalesOrderError(error.message, error.remedy);
      throw error;
    });
    const atPlant = await assertMaterialAtPlant(tx, client, line.materialNumber, plant).catch((error: PricingError) => {
      throw new SalesOrderError(error.message, error.remedy);
    });
    // The plant says the warehouse can carry the material; the sales view says it may be sold here.
    // Both are needed, and neither answers for the other: a material extended to every plant is not
    // thereby offered in every sales area.
    const forSale = await assertMaterialSalesArea(tx, client, {
      materialNumber: line.materialNumber,
      salesOrg: input.salesOrg,
      distributionChannel: input.distributionChannel,
    }).catch((error: MaterialSalesError) => {
      throw new SalesOrderError(error.message, error.remedy);
    });

    // The unit the material is sold in stands over its base unit: a material maintained to be sold in
    // boxes is ordered in boxes unless the item says otherwise.
    const unit = (line.quantityUnit || forSale.salesUnit || materialRow.baseUnit || '').trim().toUpperCase();
    if (!unit) {
      throw new SalesOrderError(
        `Material ${line.materialNumber} carries no base unit, so no order unit can be inferred.`,
        'Maintain the material base unit, or state the order unit on the item.',
      );
    }
    const [unitRow] = await tx.select().from(unitOfMeasure).where(eq(unitOfMeasure.code, unit)).limit(1);
    await requireOne(
      unitRow,
      `Unit of measure ${unit} does not stand in the system.`,
      'State a unit that exists; an unknown unit is not read as the base unit.',
    );
    const raw = String(line.orderQuantity);
    if (decimalsOf(raw) > unitRow.decimalPlaces) {
      throw new SalesOrderError(
        `Quantity ${raw} carries more decimals than unit ${unit} allows (${unitRow.decimalPlaces}).`,
        `Enter the quantity with at most ${unitRow.decimalPlaces} decimal place(s) for ${unit}.`,
      );
    }

    // The rate that stands now is written into the order, so the item keeps the quantity it meant even
    // after the conversion is changed.
    let baseQuantity: number;
    try {
      const conversion = await toBaseQuantity(tx, client, {
        materialNumber: line.materialNumber, quantity: Number(raw), entryUnit: unit,
      });
      baseQuantity = conversion.baseQuantity;
    } catch (error) {
      if (error instanceof UnitConversionError) throw new SalesOrderError(error.message, error.remedy);
      throw error;
    }

    const lineNumber = line.lineNumber ?? fallbackNumber;
    fallbackNumber = lineNumber + 10;
    judged.push({ line, plant, lineNumber, quantity: raw, unit, baseQuantity });
    void atPlant;
  }

  // The second pass prices, and it prices through the procedure: the price, whatever discounts and
  // charges the tenant configured, and the tax on the value that survived them. One call for the whole
  // document, because a procedure is a rule about a document and not about a line.
  let priced: PricedDocument;
  try {
    priced = await priceDocument(tx, {
      client,
      salesOrg: input.salesOrg,
      distributionChannel: input.distributionChannel,
      division: input.division,
      customerNumber: input.customerNumber,
      companyCode: input.companyCode,
      currency: input.currency,
      documentDate: input.orderDate,
      documentPricingProcedure: input.documentPricingProcedure,
      customerPricingProcedure: input.customerPricingProcedure,
      items: judged.map((entry) => ({
        lineNumber: entry.lineNumber,
        materialNumber: entry.line.materialNumber,
        plant: entry.plant,
        quantity: Number(entry.quantity),
        taxCode: entry.line.taxCode ?? null,
      })),
    });
  } catch (error) {
    if (error instanceof PricingProcedureError) throw new SalesOrderError(error.message, error.remedy);
    throw error;
  }
  const byLine = new Map(priced.items.map((item) => [item.lineNumber, item]));

  const pricedLines: PricedLine[] = [];
  for (const entry of judged) {
    const item = byLine.get(entry.lineNumber);
    if (!item) {
      throw new SalesOrderError(
        `Item ${entry.lineNumber} was judged and then answered with no price.`,
        'The procedure priced fewer items than it was given; reprice the document.',
      );
    }
    pricedLines.push({
      lineNumber: entry.lineNumber,
      materialNumber: entry.line.materialNumber,
      plant: entry.plant,
      orderQuantity: Number(entry.quantity).toFixed(3),
      quantityUnit: entry.unit,
      baseQuantity: entry.baseQuantity.toFixed(3),
      // The net unit price: the value that survived the discounts and the charges, per price unit. The
      // conditions beside the line say how it was reached.
      netPrice: item.netPrice,
      priceUnit: item.priceUnit,
      netAmount: item.netAmount,
      taxCode: entry.line.taxCode || null,
      taxRate: item.taxRate,
      taxAmount: item.taxAmount,
      profitCenter: entry.line.profitCenter || null,
      requestedDeliveryDate: entry.line.requestedDeliveryDate ?? null,
      conditionNumber: item.conditionNumber,
    });
  }
  return { lines: pricedLines, priced };
}

export interface SalesOrderView {
  orderNumber: string;
  documentType: string;
  salesOrg: string;
  distributionChannel: string;
  division: string;
  customerNumber: string;
  companyCode: string;
  currency: string;
  orderDate: string;
  requestedDate: string | null;
  purchaseOrderReference: string | null;
  headerText: string | null;
  status: string;
  /** Why this document is held from billing; null when it stands released. */
  billingBlock: string | null;
  /**
   * What this order answers, for an order that was raised against another document: a returns order
   * names the invoice the goods were billed on, and a credit memo request names the invoice the
   * complaint is about. Both are null on an order that was raised against nothing.
   */
  referenceDocumentType: string | null;
  referenceDocumentNumber: string | null;
  netValue: string;
  taxValue: string;
  grossValue: string;
  version: number;
  createdBy: string;
  lines: Array<{
    lineNumber: number;
    materialNumber: string;
    plant: string;
    orderQuantity: string;
    quantityUnit: string;
    baseQuantity: string;
    netPrice: string;
    priceUnit: number;
    netAmount: string;
    taxCode: string | null;
    taxRate: string;
    taxAmount: string;
    profitCenter: string | null;
    requestedDeliveryDate: string | null;
    conditionNumber: string;
    status: string;
    rejectionReason: string | null;
    /**
     * What the availability check confirmed against this item — the promise the plant made. Null is
     * not zero: it is an item that was never checked.
     */
    confirmedQuantity: string | null;
    /**
     * What the chain has taken off this item: what has gone out, and what has been billed (§5.4).
     *
     * Both are read from the documents that stand rather than from a counter on the line, and both
     * come from `fulfillment-quantities.ts` — the module the delivery and the billing services refuse
     * things from. An order that called a line open when the delivery service calls it drawn down
     * would be worse than an order that said nothing at all, which is why there is one author of this
     * arithmetic and this screen is not it.
     */
    deliveredQuantity: string;
    billedQuantity: string;
    /** What is still to come: what was ordered less what has gone out. */
    openQuantity: string;
    /**
     * The schedule lines of this item: what the customer asked for and by when, and what the check
     * confirmed against it. Empty on an item raised before the check stood.
     */
    schedule: Array<{
      scheduleNumber: number;
      requestedDate: string;
      requestedQuantity: string;
      confirmedQuantity: string;
      confirmedDate: string | null;
    }>;
  }>;
  /** The determination that stands against this number, or null when none has been raised. */
  credit: CreditDeterminationView | null;
  /**
   * Who this order is made with. Written when the order was created and never re-derived, so an order
   * read in a year still names the customer it was shipped to and the customer that was billed for it,
   * whatever that customer's master says now.
   */
  partners: DocumentPartners;
}

function mapHeader(row: typeof salesOrder.$inferSelect): Omit<SalesOrderView, 'lines' | 'credit' | 'partners'> {
  return {
    orderNumber: row.orderNumber,
    documentType: row.documentType,
    salesOrg: row.salesOrg,
    distributionChannel: row.distributionChannel,
    division: row.division,
    customerNumber: row.customerNumber,
    companyCode: row.companyCode,
    currency: row.currency,
    orderDate: row.orderDate,
    requestedDate: row.requestedDate,
    purchaseOrderReference: row.purchaseOrderReference,
    headerText: row.headerText,
    status: row.status,
    billingBlock: row.billingBlock,
    referenceDocumentType: row.referenceDocumentType,
    referenceDocumentNumber: row.referenceDocumentNumber,
    netValue: row.netValue,
    taxValue: row.taxValue,
    grossValue: row.grossValue,
    version: row.version,
    createdBy: row.createdBy,
  };
}

async function readCredit(client: string, orderNumber: string): Promise<CreditDeterminationView | null> {
  const rows = await listCreditDeterminations(client, {
    documentFrom: orderNumber, documentTo: orderNumber, blockedOnly: false, includeReleased: true,
  });
  return rows[0] ?? null;
}

async function loadDocument(tx: Tx, client: string, orderNumber: string): Promise<Omit<SalesOrderView, 'credit'> | null> {
  const [header] = await tx.select().from(salesOrder).where(and(
    eq(salesOrder.client, client), eq(salesOrder.orderNumber, orderNumber),
  )).limit(1);
  if (!header) return null;
  const lines = await tx.select().from(salesOrderLine)
    .where(and(eq(salesOrderLine.client, client), eq(salesOrderLine.orderNumber, orderNumber)))
    .orderBy(asc(salesOrderLine.lineNumber));
  // What the plant promised, read from the schedule lines the check wrote. An item raised before the
  // check stood carries none, and reads as it always did: nothing confirmed, nothing withheld.
  const schedule = await tx.select().from(salesOrderSchedule).where(and(
    eq(salesOrderSchedule.client, client), eq(salesOrderSchedule.orderNumber, orderNumber),
  )).orderBy(asc(salesOrderSchedule.orderLineNumber), asc(salesOrderSchedule.scheduleNumber));
  const scheduleOf = new Map<number, Array<(typeof schedule)[number]>>();
  for (const row of schedule) {
    const bucket = scheduleOf.get(row.orderLineNumber) ?? [];
    bucket.push(row);
    scheduleOf.set(row.orderLineNumber, bucket);
  }
  // What the deliveries and the billing documents have already taken off each item. Read here, on
  // every read of the order, so the quantities a planner sees are the quantities the chain will act
  // on — and so the backlog in the analysis (§5.3) and the screen in front of the planner are the
  // same arithmetic rather than two readings of it.
  const progress = await orderLineProgress(tx, client, orderNumber);
  // An order raised before the partners stood carries none, and reads as the four-in-one customer it
  // always was: the number on its header.
  const partners = await resolvePartners(tx, client, {
    partnerNumber: header.customerNumber, salesOrg: header.salesOrg,
    distributionChannel: header.distributionChannel, division: header.division,
  });
  const written = await documentPartners(tx, client, 'ORDER', orderNumber);
  return {
    ...mapHeader(header),
    partners: written ?? { soldTo: partners.soldTo, shipTo: partners.shipTo, billTo: partners.billTo, payer: partners.payer },
    lines: lines.map((l) => ({
      lineNumber: l.lineNumber,
      materialNumber: l.materialNumber,
      plant: l.plant,
      orderQuantity: l.orderQuantity,
      quantityUnit: l.quantityUnit,
      baseQuantity: l.baseQuantity,
      netPrice: l.netPrice,
      priceUnit: l.priceUnit,
      netAmount: l.netAmount,
      taxCode: l.taxCode,
      taxRate: l.taxRate,
      taxAmount: l.taxAmount,
      profitCenter: l.profitCenter,
      requestedDeliveryDate: l.requestedDeliveryDate,
      conditionNumber: l.conditionNumber,
      status: l.status,
      rejectionReason: l.rejectionReason,
      confirmedQuantity: l.confirmedQuantity,
      deliveredQuantity: String(deliveredOf(progress, l.lineNumber)),
      billedQuantity: String(billedOf(progress, l.lineNumber)),
      openQuantity: String(Math.max(Number(l.orderQuantity) - deliveredOf(progress, l.lineNumber), 0)),
      schedule: (scheduleOf.get(l.lineNumber) ?? []).map((row) => ({
        scheduleNumber: row.scheduleNumber,
        requestedDate: row.requestedDate,
        requestedQuantity: row.requestedQuantity,
        confirmedQuantity: row.confirmedQuantity,
        confirmedDate: row.confirmedDate,
      })),
    })),
  };
}

/** Read one order with the credit determination that stands against it. */
export async function getSalesOrder(client: string, orderNumber: string): Promise<SalesOrderView | null> {
  const document = await withTenant(client, (tx) => loadDocument(tx, client, orderNumber));
  if (!document) return null;
  return { ...document, credit: await readCredit(client, orderNumber) };
}

export interface CreateSalesOrderResult extends SalesOrderView {
  /** True when the submission replayed a request that had already created this order. */
  replayed: boolean;
  /** A create always raises a determination, so the caller never has to look one up. */
  credit: NonNullable<SalesOrderView['credit']>;
}

/**
 * Ask the plant what it can promise for these items.
 *
 * A confirmation is not a decision somebody makes on a screen. It is the answer the availability
 * check returns, asked once per material and plant and consumed in the order the items stand in, so
 * the first order to ask is the first to be promised. It is written down at the moment it was asked
 * because a document read in a month must still say what the plant promised on the day, not what it
 * happens to hold now.
 *
 * A material that carries no checking group is confirmed in full: it was never to be checked, and a
 * promise of nothing to a customer nobody configured a check for is a broken promise made by a
 * configuration the tenant never asked for.
 */
async function confirmQuantities(
  tx: Tx,
  client: string,
  input: {
    orderNumber: string; salesOrg: string; distributionChannel: string;
    /** What has already gone out against an item, in the unit it was ordered in. */
    delivered: (lineNumber: number) => number;
    lines: PricedLine[]; fallbackDate: string;
    /** A change re-asks the check for an order whose own promise must not be counted against it. */
    excludeSelf?: boolean;
  },
): Promise<Map<number, number>> {
  return confirmOrderLines(tx, client, {
    salesOrg: input.salesOrg,
    distributionChannel: input.distributionChannel,
    checkingRule: ORDER_CHECKING_RULE,
    ...(input.excludeSelf ? { exclude: { orderNumber: input.orderNumber } } : {}),
    lines: input.lines.map((line) => ({
      lineNumber: line.lineNumber,
      materialNumber: line.materialNumber,
      plant: line.plant,
      orderQuantity: Number(line.orderQuantity),
      baseQuantity: Number(line.baseQuantity),
      requestedDate: line.requestedDeliveryDate ?? input.fallbackDate,
      deliveredQuantity: input.delivered(line.lineNumber),
    })),
  }).catch((error) => {
    // A scope the check cannot count, a group that does not stand: the refusal names the screen the
    // configuration is missing from, because "unavailable" is not an answer a plant can act on.
    if (error instanceof AvailabilityError) throw new SalesOrderError(error.message, error.remedy);
    throw error;
  });
}

/** Record what was asked for and what was promised, on the schedule lines the delivery reads. */
async function recordSchedule(
  tx: Tx,
  input: {
    client: string; orderNumber: string; changedBy: string;
    lines: PricedLine[]; confirmed: Map<number, number>; fallbackDate: string;
  },
): Promise<void> {
  await writeScheduleLines(tx, {
    client: input.client, orderNumber: input.orderNumber, changedBy: input.changedBy,
    lines: input.lines.map((line) => ({
      lineNumber: line.lineNumber,
      requestedQuantity: Number(line.orderQuantity),
      confirmedQuantity: input.confirmed.get(line.lineNumber) ?? Number(line.orderQuantity),
      requestedDate: line.requestedDeliveryDate ?? input.fallbackDate,
    })),
  });
}

/**
 * Create the order and raise its credit determination. The determination is written by the credit
 * engine, in its own transaction, after the document stands: the engine is the only writer of that
 * table, and a block is a judgement about the document rather than a column of it.
 */
export async function createSalesOrder(input: OrderCreateInput): Promise<CreateSalesOrderResult> {
  const parsed = orderCreateInput.parse(input);
  const created = await withTenant(parsed.client, async (tx) => {
    const area = await requireOne(await (async () => {
      const [row] = await tx.select().from(salesArea).where(and(
        eq(salesArea.client, parsed.client),
        eq(salesArea.salesOrg, parsed.salesOrg),
        eq(salesArea.distributionChannel, parsed.distributionChannel),
        eq(salesArea.division, parsed.division),
      )).limit(1);
      return row;
    })(), `Sales area ${parsed.salesOrg}/${parsed.distributionChannel}/${parsed.division} does not stand.`,
      'Define the sales area before ordering into it.');
    if (!area.isActive) {
      throw new SalesOrderError(
        `Sales area ${parsed.salesOrg}/${parsed.distributionChannel}/${parsed.division} is not active.`,
        'Activate the sales area or order into one that is active.',
      );
    }

    const [partner] = await tx.select().from(businessPartner).where(and(
      eq(businessPartner.client, parsed.client), eq(businessPartner.partnerNumber, parsed.customerNumber),
    )).limit(1);
    await requireOne(partner, `Customer ${parsed.customerNumber} does not stand as a business partner.`,
      'Maintain the business partner first.');
    const [role] = await tx.select().from(bpRole).where(and(
      eq(bpRole.client, parsed.client),
      eq(bpRole.partnerNumber, parsed.customerNumber),
      eq(bpRole.roleCode, 'CUSTOMER'),
    )).limit(1);
    if (!role) {
      throw new SalesOrderError(`Business partner ${parsed.customerNumber} is not maintained in the customer role.`,
        'Extend the partner with the FL customer role, then order.');
    }

    let customer: Awaited<ReturnType<typeof resolveCustomerSalesData>>;
    try {
      customer = await resolveCustomerSalesData(tx, parsed.client, parsed.customerNumber,
      parsed.salesOrg, parsed.distributionChannel, parsed.division);
    } catch (error) {
      if (error instanceof PricingError) throw new SalesOrderError(error.message, error.remedy);
      throw error;
    }
    if (customer.isBlocked) {
      throw new SalesOrderError(
        `Customer ${parsed.customerNumber} is blocked for the sales area ${parsed.salesOrg}/${parsed.distributionChannel}/${parsed.division}.`,
        'Lift the order block on the customer sales area, then save again.',
      );
    }
    if (customer.salesStatus === 'INCOMPLETE') {
      throw new SalesOrderError(
        `Customer ${parsed.customerNumber} is incomplete in that sales area, so no order may be entered against it.`,
        'Complete the customer sales-area data; an incomplete master is not a warning.',
      );
    }

    const creditArea = await creditAreaFor(tx, parsed.client, parsed.customerNumber, parsed.companyCode, parsed.creditControlArea);

    // The document type is configuration now (9226), and it stands before the pricing because it carries
    // the pricing procedure key the procedure is determined by — what the order is called, where its
    // number comes from, and how it is priced are three facts on the same row.
    const orderType = await salesDocumentTypeFor(tx, parsed.client, STANDARD_ORDER_TYPE);
    if (!orderType) {
      throw new SalesOrderError(
        `Sales document type ${STANDARD_ORDER_TYPE} does not stand for this tenant, so no order number can be drawn and no sales order can be created.`,
        DOCUMENT_TYPE_REMEDY,
      );
    }

    const { lines, priced } = await priceLines(tx, parsed.client, {
      salesOrg: parsed.salesOrg, distributionChannel: parsed.distributionChannel, division: parsed.division,
      customerNumber: parsed.customerNumber, companyCode: parsed.companyCode, currency: parsed.currency,
      orderDate: parsed.orderDate, lines: parsed.lines,
      documentPricingProcedure: orderType.pricingProcedure,
      customerPricingProcedure: customer.pricingProcedure,
    }, 10);
    const netValue = round2(lines.reduce((sum, l) => sum + Number(l.netAmount), 0));
    const taxValue = round2(lines.reduce((sum, l) => sum + Number(l.taxAmount), 0));
    const grossValue = round2(Number(netValue) + Number(taxValue));

    if (parsed.requestKey) {
      const [existing] = await tx.select({ orderNumber: salesOrder.orderNumber }).from(salesOrder)
        .where(and(eq(salesOrder.client, parsed.client), eq(salesOrder.requestKey, parsed.requestKey))).limit(1);
      // A replay returns the document the first attempt created, and re-runs no part of the save.
      if (existing) {
        return { orderNumber: existing.orderNumber, replayed: true, creditArea, orderDate: parsed.orderDate };
      }
    }

    // A type that does not stand is a refusal, not a fallback: the number range is on the row, and
    // inventing one would draw a number from an interval nothing is watching.
    let number: string;
    try {
      const drawn = await allocateNumber(tx, {
        client: parsed.client, objectCode: orderType.numberRangeObject, companyCode: '*',
        subObject: orderType.numberRangeSubObject, fiscalYear: 0, allocatedBy: parsed.changedBy,
      });
      number = drawn.display;
    } catch {
      throw new SalesOrderError(
        `No active internal ${orderType.numberRangeObject} number range stands for sub-object ${orderType.numberRangeSubObject} of sales document type ${orderType.documentType}, so no order number can be drawn.`,
        'Define or unblock the interval on the number ranges screen, then save again.',
      );
    }

    await tx.insert(salesOrder).values({
      client: parsed.client,
      orderNumber: number,
      documentType: orderType.documentType,
      salesOrg: parsed.salesOrg,
      distributionChannel: parsed.distributionChannel,
      division: parsed.division,
      customerNumber: parsed.customerNumber,
      companyCode: parsed.companyCode,
        currency: parsed.currency,
      orderDate: parsed.orderDate,
      requestedDate: parsed.requestedDate ?? null,
      purchaseOrderReference: parsed.purchaseOrderReference || null,
      headerText: parsed.headerText || null,
      status: 'OPEN',
      netValue,
      taxValue,
      grossValue,
      requestKey: parsed.requestKey ?? null,
      createdBy: parsed.changedBy,
    });

    // What the plant can promise. Asked before the items are written, because the answer is part of
    // what an order is: an order that says ten where the plant can supply six is not an order for ten.
    const confirmed = await confirmQuantities(tx, parsed.client, {
      orderNumber: number, salesOrg: parsed.salesOrg, distributionChannel: parsed.distributionChannel,
      delivered: () => 0, lines, fallbackDate: parsed.requestedDate ?? parsed.orderDate,
    });

    for (const line of lines) {
      await tx.insert(salesOrderLine).values({
        client: parsed.client, orderNumber: number, ...line, status: 'OPEN',
        confirmedQuantity: confirmed.get(line.lineNumber)?.toFixed(3) ?? null,
        createdBy: parsed.changedBy,
      });
    }
    await recordSchedule(tx, {
      client: parsed.client, orderNumber: number, changedBy: parsed.changedBy, lines, confirmed,
      fallbackDate: parsed.requestedDate ?? parsed.orderDate,
    });

    // Who it is made with. The order carries the partners it was created with, determined once and
    // written down: the ship-to the delivery will be raised for, the bill-to the invoice will be
    // addressed to, and the payer whose receivable it will raise.
    const partners = await resolvePartners(tx, parsed.client, {
      partnerNumber: parsed.customerNumber, salesOrg: parsed.salesOrg,
      distributionChannel: parsed.distributionChannel, division: parsed.division,
    });
    await writeDocumentPartners(tx, {
      client: parsed.client, documentCategory: 'ORDER', documentNumber: number,
      partners, changedBy: parsed.changedBy,
    });

    // What priced it. The line carries the totals; the conditions carry the arithmetic, step by step, so
    // a document read years from now can still say where its figures came from.
    await writeDocumentConditions(tx, {
      client: parsed.client, documentCategory: 'ORDER', documentNumber: number,
      currency: parsed.currency,
      items: priced.items.map((item) => ({ lineNumber: item.lineNumber, conditions: item.conditions })),
      headerConditions: priced.headerConditions,
      steps: priced.steps,
      changedBy: parsed.changedBy,
    });

    await recordChange(tx, {
      client: parsed.client, objectClass: SALES_ORDER_OBJECT_CLASS, objectKey: number, changeType: 'CREATE',
      changedBy: parsed.changedBy,
      after: {
        customer: parsed.customerNumber,
        salesArea: `${parsed.salesOrg}/${parsed.distributionChannel}/${parsed.division}`,
        items: lines.length, netValue, taxValue, grossValue,
      },
    });
    // What it is missing. Judged here, inside the transaction that wrote the order and after every
    // part of it stands, for the same reason the output is: an order never stands without the
    // statement about its completeness. A type assigned no procedure is complete, which is what
    // every order in the books is until a tenant configures otherwise.
    await evaluateIncompletion(tx, {
      client: parsed.client, changedBy: parsed.changedBy,
      documentCategory: 'ORDER', documentNumber: number, documentType: orderType.documentType,
      objectClass: SALES_ORDER_OBJECT_CLASS,
    });
    // What the customer receives. Determined here, inside the transaction that wrote the order, so
    // an order never stands with its confirmation missing because the process died between the two.
    // It earns nothing unless a condition record says it does: no record, no output.
    await recordSalesOutputs(tx, {
      client: parsed.client, changedBy: parsed.changedBy,
      documentCategory: 'SALES_ORDER', documentNumber: number,
    });

    return { orderNumber: number, replayed: false, creditArea, orderDate: parsed.orderDate };
  });

  const view = await getSalesOrder(parsed.client, created.orderNumber);
  if (!view) throw new SalesOrderError(`Sales order ${created.orderNumber} could not be read back.`);
  const credit = await checkSalesDocumentCredit({
    client: parsed.client, changedBy: parsed.changedBy, salesDocument: created.orderNumber,
    documentDate: created.orderDate, salesOrg: parsed.salesOrg, customer: parsed.customerNumber,
    creditControlArea: created.creditArea, orderValue: view.grossValue, orderCurrency: parsed.currency,
  });
  return { ...view, credit, replayed: created.replayed };
}

/**
 * Change an open order. Every submitted item is re-priced from the records that stood on the day the
 * document was raised, not from the records that stand today: a price list maintained on Monday does
 * not move an order written on Friday, and a document read years from now still says what it said the
 * day it was written. The header totals move with it, and the credit determination is re-raised
 * against the new value — so an order that was inside its limit when it was created and is outside it
 * after a quantity change carries the block that the new value deserves.
 */
export async function changeSalesOrder(input: OrderChangeInput): Promise<SalesOrderView> {
  const parsed = orderChangeInput.parse(input);
  const changed = await withTenant(parsed.client, async (tx) => {
    const [before] = await tx.select().from(salesOrder).where(and(
      eq(salesOrder.client, parsed.client), eq(salesOrder.orderNumber, parsed.orderNumber),
    )).limit(1);
    await requireOne(before, `Sales order ${parsed.orderNumber} does not exist.`, 'Read the order before changing it.');
    if (before.status !== 'OPEN') {
      throw new SalesOrderError(
        `Sales order ${parsed.orderNumber} stands ${before.status}; only an open order can be changed.`,
        'Re-opening is not a transition the order offers — create a new order.',
      );
    }
    if (before.version !== parsed.expectedVersion) {
      throw new SalesOrderError(
        `Sales order ${parsed.orderNumber} changed since it was read (version ${before.version}, expected ${parsed.expectedVersion}).`,
        'Reload the order and apply the change to what stands now.',
      );
    }
    if (parsed.customerNumber !== before.customerNumber || parsed.salesOrg !== before.salesOrg
      || parsed.distributionChannel !== before.distributionChannel || parsed.division !== before.division) {
      throw new SalesOrderError(
        'The sold-to, sales organization, distribution channel and division of an order are not changed. Create a new order.',
        'A partner or organization change is a new commitment, not an edit of this one.',
      );
    }

    // What the chain downstream has already done is what freezes an item. A quantity that has gone out cannot
    // be re-ordered underneath the delivery that carried it, an item that has been delivered cannot be rejected
    // as though it had never been asked for, and a price an invoice has already quoted cannot be re-read from a
    // condition record that has since moved. Nothing is copied onto the order line to make this readable: the
    // answer is summed from the delivery and billing documents that stand, which is the only author of it.
    const progress = await orderLineProgress(tx, parsed.client, parsed.orderNumber);
    const rejectedOnFulfillment = new Set(parsed.rejectLines.map((entry) => entry.lineNumber));
    const standing = await tx.select().from(salesOrderLine).where(and(
      eq(salesOrderLine.client, parsed.client), eq(salesOrderLine.orderNumber, parsed.orderNumber),
    ));
    for (const row of standing) {
      const delivered = deliveredOf(progress, row.lineNumber);
      if (delivered <= 0) continue;
      const submitted = parsed.lines.find((line) => line.lineNumber === row.lineNumber);
      if (!submitted || rejectedOnFulfillment.has(row.lineNumber)) {
        throw new SalesOrderError(
          `Item ${row.lineNumber} has ${delivered} ${row.quantityUnit.trim()} delivered on it, so it cannot be dropped from the order or rejected.`,
          'A delivered item stands as it is. Bill what went out, and enter a new order for anything more.',
        );
      }
      if (submitted.materialNumber !== row.materialNumber || Number(submitted.orderQuantity) !== Number(row.orderQuantity)) {
        throw new SalesOrderError(
          `Item ${row.lineNumber} has ${delivered} ${row.quantityUnit.trim()} delivered, so its material and its ordered quantity are frozen: the delivery and any invoice already quote them.`,
          'Cancel or extend the order with a new item, and change the delivery for what has gone out.',
        );
      }
    }

    let customer: Awaited<ReturnType<typeof resolveCustomerSalesData>>;
    try {
      customer = await resolveCustomerSalesData(tx, parsed.client, before.customerNumber,
      before.salesOrg, before.distributionChannel, before.division);
    } catch (error) {
      if (error instanceof PricingError) throw new SalesOrderError(error.message, error.remedy);
      throw error;
    }
    // The type this order carries is what names the pricing procedure key, as it does when the order is
    // created: a change is priced by the same rule that priced the original.
    const orderTypeOnChange = await salesDocumentTypeFor(tx, parsed.client, before.documentType);
    const { lines, priced: pricedOnChange } = await priceLines(tx, parsed.client, {
      salesOrg: before.salesOrg, distributionChannel: before.distributionChannel, division: before.division,
      customerNumber: before.customerNumber, companyCode: before.companyCode, currency: before.currency,
      orderDate: before.orderDate, lines: parsed.lines,
      documentPricingProcedure: orderTypeOnChange?.pricingProcedure ?? STANDARD_DOCUMENT_PRICING_PROCEDURE,
      customerPricingProcedure: customer.pricingProcedure,
    }, 10);

    const openRows = await tx.select({ lineNumber: salesOrderLine.lineNumber }).from(salesOrderLine)
      .where(and(eq(salesOrderLine.client, parsed.client), eq(salesOrderLine.orderNumber, parsed.orderNumber),
        eq(salesOrderLine.status, 'OPEN')));
    const rejected = new Map(parsed.rejectLines.map((r) => [r.lineNumber, r.reason]));
    for (const existing of openRows) {
      if (lines.some((l) => l.lineNumber === existing.lineNumber) || rejected.has(existing.lineNumber)) continue;
      throw new SalesOrderError(
        `Item ${existing.lineNumber} was neither submitted nor rejected.`,
        'An item is kept by submitting it again, or rejected with a reason. It is never dropped in silence.',
      );
    }
    for (const [lineNumber, reason] of rejected) {
      if (!openRows.some((r) => r.lineNumber === lineNumber)) {
        throw new SalesOrderError(
          `Item ${lineNumber} is not open, so it cannot be rejected.`,
          'Reload the order and reject an item that still stands open.',
        );
      }
      await tx.update(salesOrderLine)
        .set({ status: 'REJECTED', rejectionReason: reason, changedBy: parsed.changedBy, changedAt: new Date() })
        .where(and(eq(salesOrderLine.client, parsed.client), eq(salesOrderLine.orderNumber, parsed.orderNumber),
          eq(salesOrderLine.lineNumber, lineNumber)));
    }

    // What the plant can promise now, re-asked for what has not gone out. This order's own promise is
    // not counted against itself, and a quantity already delivered is not asked for twice: the check
    // answers for the six that are still owed, not for the four the plant has already shipped.
    const confirmedOnChange = await confirmQuantities(tx, parsed.client, {
      orderNumber: parsed.orderNumber, salesOrg: before.salesOrg,
      distributionChannel: before.distributionChannel, excludeSelf: true,
      delivered: (lineNumber) => deliveredOf(progress, lineNumber), lines,
      fallbackDate: parsed.requestedDate ?? before.requestedDate ?? before.orderDate,
    });

    for (const line of lines) {
      const [standing] = await tx.select({ status: salesOrderLine.status }).from(salesOrderLine)
        .where(and(eq(salesOrderLine.client, parsed.client), eq(salesOrderLine.orderNumber, parsed.orderNumber),
          eq(salesOrderLine.lineNumber, line.lineNumber)))
        .limit(1);
      if (!standing) {
        // A change may add an item; it may not rename or reuse one, and it may not drop one. An item it
        // adds is confirmed like any other: the check answers for what has not gone out.
        await tx.insert(salesOrderLine).values({
          client: parsed.client, orderNumber: parsed.orderNumber, ...line, status: 'OPEN',
          confirmedQuantity: confirmedOnChange.get(line.lineNumber)?.toFixed(3) ?? null,
          createdBy: parsed.changedBy,
        });
        continue;
      }
      if (standing.status === 'REJECTED') {
        throw new SalesOrderError(
          `Item ${line.lineNumber} is rejected, and a rejected item number is not reused.`,
          'Add the item under the next free number so the rejected line stays readable.',
        );
      }
      await tx.update(salesOrderLine).set({
        ...line,
        confirmedQuantity: confirmedOnChange.get(line.lineNumber)?.toFixed(3) ?? null,
        changedBy: parsed.changedBy, changedAt: new Date(),
      }).where(and(eq(salesOrderLine.client, parsed.client), eq(salesOrderLine.orderNumber, parsed.orderNumber),
        eq(salesOrderLine.lineNumber, line.lineNumber)));
    }
    await recordSchedule(tx, {
      client: parsed.client, orderNumber: parsed.orderNumber, changedBy: parsed.changedBy,
      lines, confirmed: confirmedOnChange,
      fallbackDate: parsed.requestedDate ?? before.requestedDate ?? before.orderDate,
    });

    // Who it is made with, re-determined: a customer's master may have named a payer since the order
    // was raised, and an order that is still open is judged by the master as it stands. What has
    // already gone out keeps the partners it was made with — the delivery and the invoice wrote theirs
    // down when they were created.
    const partners = await resolvePartners(tx, parsed.client, {
      partnerNumber: before.customerNumber, salesOrg: before.salesOrg,
      distributionChannel: before.distributionChannel, division: before.division,
    });
    await writeDocumentPartners(tx, {
      client: parsed.client, documentCategory: 'ORDER', documentNumber: parsed.orderNumber,
      partners, changedBy: parsed.changedBy,
    });

    // The conditions are rewritten, not deleted and re-inserted: a changed order keeps the steps it
    // was priced by, carrying the figures they hold now, and the role of the application holds no
    // DELETE on a document's history.
    await writeDocumentConditions(tx, {
      client: parsed.client, documentCategory: 'ORDER', documentNumber: parsed.orderNumber,
      currency: before.currency,
      items: pricedOnChange.items.map((item) => ({ lineNumber: item.lineNumber, conditions: item.conditions })),
      headerConditions: pricedOnChange.headerConditions,
      steps: pricedOnChange.steps,
      changedBy: parsed.changedBy,
    });

    // The header totals are read back from the items as they now stand, inside this transaction: a
    // rejected line prices nothing, and a line the change added is counted. Summing a computation of
    // the submitted set instead would leave a new item out of the value the order is judged at.
    const resulting = await tx.select().from(salesOrderLine).where(and(
      eq(salesOrderLine.client, parsed.client), eq(salesOrderLine.orderNumber, parsed.orderNumber),
    ));
    let netTotal = 0;
    let taxTotal = 0;
    for (const row of resulting) {
      if (row.status !== 'OPEN') continue;
      netTotal += Number(row.netAmount);
      taxTotal += Number(row.taxAmount);
    }
    const net = round2(netTotal);
    const tax = round2(taxTotal);
    const gross = round2(netTotal + taxTotal);

    const applied = await tx.update(salesOrder).set({
      netValue: net,
      taxValue: tax,
      grossValue: gross,
      headerText: parsed.headerText || before.headerText,
      purchaseOrderReference: parsed.purchaseOrderReference || before.purchaseOrderReference,
      requestedDate: parsed.requestedDate ?? before.requestedDate,
      version: before.version + 1,
      changedBy: parsed.changedBy,
      changedAt: new Date(),
    }).where(and(eq(salesOrder.client, parsed.client), eq(salesOrder.orderNumber, parsed.orderNumber),
      eq(salesOrder.version, parsed.expectedVersion))).returning({ orderNumber: salesOrder.orderNumber });
    if (!applied.length) {
      throw new SalesOrderError(
        `Sales order ${parsed.orderNumber} changed concurrently; nothing was written.`,
        'Reload the order and apply the change to what stands now.',
      );
    }
    await recordChange(tx, {
      client: parsed.client, objectClass: SALES_ORDER_OBJECT_CLASS, objectKey: parsed.orderNumber, changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      before: { netValue: before.netValue, grossValue: before.grossValue, openItems: openRows.length },
      after: { netValue: net, grossValue: gross, submittedItems: lines.length, rejectedItems: rejected.size },
    });
    // Re-judged against what the order now says. A change that filled in the field the log named
    // takes the entry with it, and a change that emptied one writes it.
    await evaluateIncompletion(tx, {
      client: parsed.client, changedBy: parsed.changedBy,
      documentCategory: 'ORDER', documentNumber: parsed.orderNumber, documentType: before.documentType,
      objectClass: SALES_ORDER_OBJECT_CLASS,
    });
    return { orderDate: before.orderDate };
  });

  const view = await getSalesOrder(parsed.client, parsed.orderNumber);
  if (!view) throw new SalesOrderError(`Sales order ${parsed.orderNumber} does not exist.`);
  const creditArea = view.credit?.creditControlArea
    ?? await withTenant(parsed.client, (tx) => creditAreaFor(tx, parsed.client, parsed.customerNumber, parsed.companyCode, parsed.creditControlArea));
  const credit = await checkSalesDocumentCredit({
    client: parsed.client, changedBy: parsed.changedBy, salesDocument: parsed.orderNumber,
    documentDate: view.orderDate, salesOrg: view.salesOrg, customer: view.customerNumber,
    creditControlArea: creditArea, orderValue: view.grossValue, orderCurrency: view.currency,
  });
  return { ...view, credit };
}

/**
 * Cancel an order. Once a delivery has read it, the cancellation refuses — that check arrives with the
 * delivery, and until then the order's own last word is the only one needed.
 */
export async function cancelSalesOrder(input: {
  client: string; changedBy: string; orderNumber: string; expectedVersion: number; reason?: string;
}): Promise<SalesOrderView> {
  const { client, changedBy, orderNumber, expectedVersion, reason } = input;
  await withTenant(client, async (tx) => {
    const [before] = await tx.select().from(salesOrder).where(and(
      eq(salesOrder.client, client), eq(salesOrder.orderNumber, orderNumber),
    )).limit(1);
    await requireOne(before, `Sales order ${orderNumber} does not exist.`, 'Read the order before cancelling it.');
    if (before.status !== 'OPEN') {
      throw new SalesOrderError(
        `Sales order ${orderNumber} stands ${before.status}; it is not cancelled twice.`,
        'A cancelled order stays cancelled; create a new order for a new commitment.',
      );
    }
    if (before.version !== expectedVersion) {
      throw new SalesOrderError(`Sales order ${orderNumber} changed since it was read.`, 'Reload the order first.');
    }
    // An order that has shipped is not un-bought. The deliveries are what make the commitment real, and a
    // cancellation that left them standing would strand stock that has gone out against an order that no longer
    // exists. Cancelled documents are not counted, so a delivery backed out in full frees the order again.
    const fulfilled = await fulfillmentDocumentsOf(tx, client, orderNumber);
    if (fulfilled.deliveries.length || fulfilled.billings.length) {
      throw new SalesOrderError(
        `Sales order ${orderNumber} cannot be cancelled while it is being fulfilled: ${[
          fulfilled.deliveries.length ? `delivery ${fulfilled.deliveries.join(', ')}` : '',
          fulfilled.billings.length ? `billing document ${fulfilled.billings.join(', ')}` : '',
        ].filter(Boolean).join(' and ')}.`,
        'Cancel the delivery while it has not been goods-issued, and the billing document before it, then cancel the order.',
      );
    }
    const applied = await tx.update(salesOrder).set({
      status: 'CANCELLED', version: before.version + 1, changedBy, changedAt: new Date(),
    }).where(and(eq(salesOrder.client, client), eq(salesOrder.orderNumber, orderNumber), eq(salesOrder.version, expectedVersion)))
      .returning({ orderNumber: salesOrder.orderNumber });
    if (!applied.length) {
      throw new SalesOrderError(
        `Sales order ${orderNumber} changed concurrently; nothing was written.`,
        'Reload the order first.',
      );
    }
    await recordChange(tx, {
      client, objectClass: SALES_ORDER_OBJECT_CLASS, objectKey: orderNumber, changeType: 'CHANGE', changedBy,
      reason: reason || 'Order cancelled in sales.',
      before: { status: before.status, grossValue: before.grossValue },
      after: { status: 'CANCELLED' },
    });
  });
  const view = await getSalesOrder(client, orderNumber);
  if (!view) throw new SalesOrderError(`Sales order ${orderNumber} does not exist.`);
  return view;
}

export async function listSalesOrderDocuments(
  client: string,
  filter: { customerNumber?: string; status?: string } = {},
): Promise<Array<{
  orderNumber: string; customerNumber: string; orderDate: string; status: string;
  currency: string; grossValue: string; blockedForCredit: boolean;
}>> {
  return withTenant(client, async (tx) => {
    const conditions = [eq(salesOrder.client, client)];
    if (filter.customerNumber) conditions.push(eq(salesOrder.customerNumber, filter.customerNumber.trim().toUpperCase()));
    if (filter.status) conditions.push(eq(salesOrder.status, filter.status));
    const rows = await tx.select().from(salesOrder).where(and(...conditions))
      .orderBy(sql`${salesOrder.createdAt} desc, ${salesOrder.orderNumber} desc`).limit(100);
    const blocked = new Set<string>();
    if (rows.length) {
      const determinations = await tx.execute(sql`
        select d.sales_document from credit_determination d
        join lateral (
          select status, created_at from credit_determination c
           where c.client = ${client} and c.sales_document = d.sales_document
           order by created_at desc, determination_id desc limit 1
        ) cur on true
        where d.client = ${client} and cur.status = 'BLOCKED'
        group by d.sales_document, cur.status
      `);
      for (const row of determinations as unknown as Array<{ sales_document: string }>) blocked.add(row.sales_document);
    }
    return rows.map((r) => ({
      orderNumber: r.orderNumber,
      customerNumber: r.customerNumber,
      orderDate: r.orderDate,
      status: r.status,
      currency: r.currency,
      grossValue: r.grossValue,
      blockedForCredit: blocked.has(r.orderNumber),
    }));
  });
}

/** What the order screen may offer: the sales areas, the companies and the plants of this client. */
export async function salesOrderChoices(client: string): Promise<{
  salesAreas: Array<{ salesOrg: string; distributionChannel: string; division: string; name: string; isActive: boolean }>;
  companies: Array<{ companyCode: string; country: string }>;
  plants: Array<{ plant: string; name: string }>;
}> {
  return withTenant(client, async (tx) => {
    const areas = await tx.select().from(salesArea).where(eq(salesArea.client, client)).orderBy(asc(salesArea.salesOrg));
    const companies = await tx.select({
      companyCode: companyCode.companyCode, country: companyCode.country,
    }).from(companyCode).where(eq(companyCode.client, client)).orderBy(asc(companyCode.companyCode));
    const plants = await tx.select({ plant: plant.plant, name: plant.name }).from(plant)
      .where(eq(plant.client, client)).orderBy(asc(plant.plant));
    return {
      salesAreas: areas.map((r) => ({
        salesOrg: r.salesOrg, distributionChannel: r.distributionChannel, division: r.division,
        name: r.name, isActive: r.isActive,
      })),
      companies,
      plants: plants.map((r) => ({ plant: r.plant, name: r.name })),
    };
  });
}

/**
 * Release the credit block that stands against an order. The credit engine judges it: a document that
 * is not blocked is not released, the exposure is re-read at the moment of release, and the override
 * capability plus a justification is what lets a block through.
 */
export async function releaseSalesOrderCredit(input: {
  client: string; changedBy: string; orderNumber: string; expectedVersion?: number;
  justification?: string; approvalRef?: string; canOverride: boolean;
}): Promise<ReleaseOutcome> {
  return releaseDocument({
    client: input.client,
    changedBy: input.changedBy,
    salesDocument: input.orderNumber,
    expectedVersion: input.expectedVersion,
    override: input.justification
      ? { justification: input.justification, approvalRef: input.approvalRef }
      : undefined,
    canOverride: input.canOverride,
  });
}
