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
import { companyCode, plant, salesArea, taxCode } from '../foundation/schema';
import { material } from '../inventory/schema';
import { toBaseQuantity, UnitConversionError } from '../inventory/unit-conversion';
import {
  checkSalesDocumentCredit, listCreditDeterminations, releaseDocument,
  type CreditDeterminationView, type ReleaseOutcome,
} from '../finance/credit';
import { customerCredit } from '../finance/schema';
import { PricingError, assertMaterialAtPlant, itemNetAmount, priceItem, resolveCustomerSalesData } from './pricing';
import { salesOrder, salesOrderLine } from './schema';

export const SALES_ORDER_CAPABILITY = 'SALES.ORDER.CREATE';
export const SALES_ORDER_RELEASE_CAPABILITY = 'SALES.ORDER.RELEASE';
export const SALES_ORDER_OBJECT_CLASS = 'sales_order';
export const SALES_ORDER_ROUTE = '/sales/orders';
/** The document type this round: standard order, whose number-range sub-object is OR. */
export const SALES_ORDER_TYPE = { code: 'OR', name: 'Standard order', rangeSubObject: 'OR' } as const;

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
  plant: key(10),
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
  lines: z.array(orderLineInput).min(1).max(100),
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
async function creditAreaFor(
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

async function countryOf(tx: Tx, client: string, company: string): Promise<string> {
  const [row] = await tx.select({ country: companyCode.country }).from(companyCode)
    .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, company))).limit(1);
  if (!row) {
    throw new SalesOrderError(`Company code ${company} does not stand.`, 'Name a company code that exists.');
  }
  return row.country;
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
  },
  firstLineNumber: number,
): Promise<PricedLine[]> {
  const priced: PricedLine[] = [];
  let fallbackNumber = firstLineNumber;
  for (const line of input.lines) {
    const [materialRow] = await tx.select().from(material).where(and(
      eq(material.client, client), eq(material.materialNumber, line.materialNumber),
    )).limit(1);
    await requireOne(
      materialRow,
      `Material ${line.materialNumber} does not stand in this client.`,
      'The sales view of a material does not create it; maintain the material first.',
    );
    const atPlant = await assertMaterialAtPlant(tx, client, line.materialNumber, line.plant).catch((error: PricingError) => {
      throw new SalesOrderError(error.message, error.remedy);
    });

    const unit = (line.quantityUnit || materialRow.baseUnit || '').trim().toUpperCase();
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

    let price: Awaited<ReturnType<typeof priceItem>>;
    try {
      price = await priceItem(tx, client, {
        salesOrg: input.salesOrg,
        distributionChannel: input.distributionChannel,
        division: input.division,
        customerNumber: input.customerNumber,
        materialNumber: line.materialNumber,
        documentDate: input.orderDate,
        currency: input.currency,
      });
    } catch (error) {
      if (error instanceof PricingError) throw new SalesOrderError(error.message, error.remedy);
      throw error;
    }
    const netAmount = itemNetAmount(raw, price);

    let taxRate = '0.0000';
    let taxAmount = '0.00';
    if (line.taxCode) {
      const country = await countryOf(tx, client, input.companyCode);
      const [code] = await tx.select().from(taxCode).where(and(
        eq(taxCode.client, client), eq(taxCode.country, country), eq(taxCode.taxCode, line.taxCode),
      )).limit(1);
      await requireOne(
        code,
        `Tax code ${line.taxCode} does not stand for country ${country}, the country of company code ${input.companyCode}.`,
        'Maintain the tax code in that country, or leave the item free of tax if that is what the customer is billed at.',
      );
      taxRate = Number(code.ratePercent).toFixed(4);
      taxAmount = round2((Number(netAmount) * Number(code.ratePercent)) / 100);
    }

    const lineNumber = line.lineNumber ?? fallbackNumber;
    fallbackNumber = lineNumber + 10;
    priced.push({
      lineNumber,
      materialNumber: line.materialNumber,
      plant: line.plant,
      orderQuantity: Number(raw).toFixed(3),
      quantityUnit: unit,
      baseQuantity: baseQuantity.toFixed(3),
      netPrice: Number(price.netPrice).toFixed(4),
      priceUnit: price.priceUnit,
      netAmount,
      taxCode: line.taxCode || null,
      taxRate,
      taxAmount,
      profitCenter: line.profitCenter || null,
      requestedDeliveryDate: line.requestedDeliveryDate ?? null,
      conditionNumber: price.conditionNumber,
    });
    void atPlant;
  }
  return priced;
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
  }>;
  /** The determination that stands against this number, or null when none has been raised. */
  credit: CreditDeterminationView | null;
}

function mapHeader(row: typeof salesOrder.$inferSelect): Omit<SalesOrderView, 'lines' | 'credit'> {
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
  return {
    ...mapHeader(header),
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

    const country = await countryOf(tx, parsed.client, parsed.companyCode);
    void country;

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
    const lines = await priceLines(tx, parsed.client, {
      salesOrg: parsed.salesOrg, distributionChannel: parsed.distributionChannel, division: parsed.division,
      customerNumber: parsed.customerNumber, companyCode: parsed.companyCode, currency: parsed.currency,
      orderDate: parsed.orderDate, lines: parsed.lines,
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

    let number: string;
    try {
      const drawn = await allocateNumber(tx, {
        client: parsed.client, objectCode: 'SALESORD', companyCode: '*',
        subObject: SALES_ORDER_TYPE.rangeSubObject, fiscalYear: 0, allocatedBy: parsed.changedBy,
      });
      number = drawn.display;
    } catch {
      throw new SalesOrderError(
        `No active internal SALESORD number range stands for sub-object ${SALES_ORDER_TYPE.rangeSubObject}, so no order number can be drawn.`,
        'Define or unblock the interval on the number ranges screen, then save again.',
      );
    }

    await tx.insert(salesOrder).values({
      client: parsed.client,
      orderNumber: number,
      documentType: SALES_ORDER_TYPE.code,
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

    for (const line of lines) {
      await tx.insert(salesOrderLine).values({
        client: parsed.client, orderNumber: number, ...line, status: 'OPEN', createdBy: parsed.changedBy,
      });
    }

    await recordChange(tx, {
      client: parsed.client, objectClass: SALES_ORDER_OBJECT_CLASS, objectKey: number, changeType: 'CREATE',
      changedBy: parsed.changedBy,
      after: {
        customer: parsed.customerNumber,
        salesArea: `${parsed.salesOrg}/${parsed.distributionChannel}/${parsed.division}`,
        items: lines.length, netValue, taxValue, grossValue,
      },
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
 * Change an open order. Every submitted item is re-priced from the records that stand today, the
 * header totals move with it, and the credit determination is re-raised against the new value — so an
 * order that was inside its limit when it was created and is outside it after a quantity change
 * carries the block that the new value deserves.
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

    let customer: Awaited<ReturnType<typeof resolveCustomerSalesData>>;
    try {
      customer = await resolveCustomerSalesData(tx, parsed.client, before.customerNumber,
      before.salesOrg, before.distributionChannel, before.division);
    } catch (error) {
      if (error instanceof PricingError) throw new SalesOrderError(error.message, error.remedy);
      throw error;
    }
    const lines = await priceLines(tx, parsed.client, {
      salesOrg: before.salesOrg, distributionChannel: before.distributionChannel, division: before.division,
      customerNumber: before.customerNumber, companyCode: before.companyCode, currency: before.currency,
      orderDate: before.orderDate, lines: parsed.lines,
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

    for (const line of lines) {
      const [standing] = await tx.select({ status: salesOrderLine.status }).from(salesOrderLine)
        .where(and(eq(salesOrderLine.client, parsed.client), eq(salesOrderLine.orderNumber, parsed.orderNumber),
          eq(salesOrderLine.lineNumber, line.lineNumber)))
        .limit(1);
      if (!standing) {
        // A change may add an item; it may not rename or reuse one, and it may not drop one.
        await tx.insert(salesOrderLine).values({
          client: parsed.client, orderNumber: parsed.orderNumber, ...line, status: 'OPEN', createdBy: parsed.changedBy,
        });
        continue;
      }
      if (standing.status === 'REJECTED') {
        throw new SalesOrderError(
          `Item ${line.lineNumber} is rejected, and a rejected item number is not reused.`,
          'Add the item under the next free number so the rejected line stays readable.',
        );
      }
      await tx.update(salesOrderLine).set({ ...line, changedBy: parsed.changedBy, changedAt: new Date() })
        .where(and(eq(salesOrderLine.client, parsed.client), eq(salesOrderLine.orderNumber, parsed.orderNumber),
          eq(salesOrderLine.lineNumber, line.lineNumber)));
    }

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
