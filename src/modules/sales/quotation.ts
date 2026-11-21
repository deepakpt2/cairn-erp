/**
 * Sales quotations — VA21 create, VA22 change, VA23 display.
 *
 * A quotation is the answer a salesperson gives before the customer has committed: the same items, the
 * same price, a date until which it holds — and nothing that binds the company. It posts nothing, it
 * consumes no availability, it creates no receivable and it is judged for no credit. When the customer
 * says yes an order is raised from it by the ordinary order service.
 *
 * It lives in three tables of its own. The availability check counts what has been promised to others
 * through `sales_order_schedule` joined to `sales_order`; a quotation written there would take stock
 * from the customer who actually orders it. The schedule it keeps is the answer the check gave, written
 * to `sales_quotation_schedule` and never read by that join.
 *
 * Expiry is a fact about `valid_to`, computed when the quotation is read. It is never written back: there
 * is no job that could write it, and a status that is only true until midnight would be a rumour.
 */
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';

import { hasOrgAccess } from '../../platform/auth/session';
import {
  type ServiceAuthorityContext, refusePlantOutsideScopeInTx, verifyServiceAuthorityInTx,
} from '../../platform/auth/service-authority';
import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { bpRole, businessPartner } from '../foundation/business-partner-schema';
import { salesArea } from '../foundation/schema';
import { AvailabilityError, ORDER_CHECKING_RULE, planOrderLines, type LinePlan } from './availability';
import { DOCUMENT_TYPE_REMEDY, STANDARD_QUOTATION_TYPE, salesDocumentTypeFor } from './document-type';
import { writeDocumentPartners, resolvePartners, documentPartners, type DocumentPartners } from './partners';
import { PricingError, resolveCustomerSalesData } from './pricing';
import { STANDARD_DOCUMENT_PRICING_PROCEDURE, writeDocumentConditions } from './pricing-procedure';
import {
  type CreateSalesOrderResult, SALES_ORDER_CREATE_CAPABILITY, SalesOrderError, createSalesOrder,
  isoDate, key, optionalKey, orderLineInput, priceLines, round2, salesOrderChoices,
} from './sales-order';
import { plantsAllow } from '../../platform/auth/scope-actor';
import { salesActor, salesAreaReachable, salesDocumentReachable } from './sales-scope';
import { salesOrder, salesQuotation, salesQuotationLine, salesQuotationSchedule } from './schema';

export const SALES_QUOTATION_CAPABILITY = 'SALES.QUOTATION.CREATE';
/** The order exports both names for its authority; the quotation does the same. */
export const SALES_QUOTATION_CREATE_CAPABILITY = SALES_QUOTATION_CAPABILITY;
export const SALES_QUOTATION_ROUTE = '/sales/quotations';
export const SALES_QUOTATION_OBJECT_CLASS = 'sales_quotation';
/** What an order stores in `reference_document_type` when it is raised from a quotation. */
export const QUOTATION_REFERENCE_TYPE = 'AG';
export { STANDARD_QUOTATION_TYPE };

export class SalesQuotationError extends Error {
  remedy: string;
  constructor(message: string, remedy = 'Correct the quotation and save it again.') {
    super(message);
    this.name = 'SalesQuotationError';
    this.remedy = remedy;
  }
}

/** The item of a quotation is the item of an order: one schema, so there is one vocabulary for an item. */
export const quotationLineInput = orderLineInput;

const quotationFields = {
  client: key(4),
  changedBy: z.string().trim().min(1).max(60),
  salesOrg: key(4),
  distributionChannel: key(2),
  division: key(2),
  customerNumber: key(40),
  companyCode: key(10),
  currency: key(3),
  quotationDate: isoDate,
  /** Required: a quotation without an end date is a rumour. */
  validTo: isoDate,
  requestedDate: z.union([z.undefined(), isoDate]),
  purchaseOrderReference: optionalKey(20),
  headerText: z.union([z.undefined(), z.string().trim().max(100)]),
  requestKey: z.union([z.undefined(), z.string().trim().min(8).max(64)]),
  lines: z.array(quotationLineInput).min(1).max(999),
};

export const quotationCreateInput = z.object(quotationFields);

export const quotationChangeInput = z.object({
  ...quotationFields,
  quotationNumber: key(20),
  expectedVersion: z.coerce.number().int().positive(),
  rejectLines: z.array(z.object({ lineNumber: z.coerce.number().int().positive(), reason: key(4) })).default([]),
});

export type QuotationCreateInput = z.input<typeof quotationCreateInput>;
export type QuotationChangeInput = z.input<typeof quotationChangeInput> & { authorization: ServiceAuthorityContext | undefined };

const todayOf = () => new Date().toISOString().slice(0, 10);

export interface QuotationLineView {
  lineNumber: number;
  materialNumber: string;
  plant: string;
  quotationQuantity: string;
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
  /** What the check would confirm. Null is "never checked", not zero. */
  confirmedQuantity: string | null;
  schedule: Array<{
    scheduleNumber: number; requestedDate: string; requestedQuantity: string;
    confirmedQuantity: string; confirmedDate: string | null;
  }>;
}

export interface QuotationView {
  quotationNumber: string;
  documentType: string;
  salesOrg: string;
  distributionChannel: string;
  division: string;
  customerNumber: string;
  companyCode: string;
  currency: string;
  quotationDate: string;
  validTo: string;
  requestedDate: string | null;
  purchaseOrderReference: string | null;
  headerText: string | null;
  status: string;
  rejectionReason: string | null;
  /** True when the quotation is open and its valid-to date has passed. Computed on read, never stored. */
  isExpired: boolean;
  /** The orders raised from this quotation, read from the reference each order carries. */
  ordersRaised: string[];
  netValue: string;
  taxValue: string;
  grossValue: string;
  version: number;
  createdBy: string;
  partners: DocumentPartners;
  lines: QuotationLineView[];
}

export interface CreateQuotationResult extends QuotationView {
  /** True when the submission replayed a request that had already created this quotation. */
  replayed: boolean;
}

async function ordersRaisedFrom(tx: Tx, client: string, quotationNumbers: string[]): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  if (quotationNumbers.length === 0) return found;
  const rows = await tx.select({
    orderNumber: salesOrder.orderNumber, reference: salesOrder.referenceDocumentNumber,
  }).from(salesOrder).where(and(
    eq(salesOrder.client, client),
    eq(salesOrder.referenceDocumentType, QUOTATION_REFERENCE_TYPE),
    sql`${salesOrder.referenceDocumentNumber} in (${sql.join(quotationNumbers.map((n) => sql`${n}`), sql`, `)})`,
  )).orderBy(asc(salesOrder.orderNumber));
  for (const row of rows) {
    if (!row.reference) continue;
    found.set(row.reference, [...(found.get(row.reference) ?? []), row.orderNumber]);
  }
  return found;
}

const expiredOn = (status: string, validTo: string, today: string) => status === 'OPEN' && today > validTo;

async function loadQuotation(tx: Tx, client: string, quotationNumber: string, today: string): Promise<QuotationView | null> {
  const [header] = await tx.select().from(salesQuotation).where(and(
    eq(salesQuotation.client, client), eq(salesQuotation.quotationNumber, quotationNumber),
  )).limit(1);
  if (!header) return null;
  const lines = await tx.select().from(salesQuotationLine).where(and(
    eq(salesQuotationLine.client, client), eq(salesQuotationLine.quotationNumber, quotationNumber),
  )).orderBy(asc(salesQuotationLine.lineNumber));
  const schedule = await tx.select().from(salesQuotationSchedule).where(and(
    eq(salesQuotationSchedule.client, client), eq(salesQuotationSchedule.quotationNumber, quotationNumber),
  )).orderBy(asc(salesQuotationSchedule.quotationLineNumber), asc(salesQuotationSchedule.scheduleNumber));
  const scheduleOf = new Map<number, typeof schedule>();
  for (const row of schedule) scheduleOf.set(row.quotationLineNumber, [...(scheduleOf.get(row.quotationLineNumber) ?? []), row]);
  const written = await documentPartners(tx, client, 'QUOTATION', quotationNumber);
  const resolved = written ?? await resolvePartners(tx, client, {
    partnerNumber: header.customerNumber, salesOrg: header.salesOrg,
    distributionChannel: header.distributionChannel, division: header.division,
  }).then((p) => ({ soldTo: p.soldTo, shipTo: p.shipTo, billTo: p.billTo, payer: p.payer }))
    .catch(() => ({ soldTo: header.customerNumber, shipTo: header.customerNumber, billTo: header.customerNumber, payer: header.customerNumber }));
  const orders = await ordersRaisedFrom(tx, client, [quotationNumber]);
  return {
    quotationNumber: header.quotationNumber,
    documentType: header.documentType,
    salesOrg: header.salesOrg,
    distributionChannel: header.distributionChannel,
    division: header.division,
    customerNumber: header.customerNumber,
    companyCode: header.companyCode,
    currency: header.currency,
    quotationDate: header.quotationDate,
    validTo: header.validTo,
    requestedDate: header.requestedDate,
    purchaseOrderReference: header.purchaseOrderReference,
    headerText: header.headerText,
    status: header.status,
    rejectionReason: header.rejectionReason,
    isExpired: expiredOn(header.status, header.validTo, today),
    ordersRaised: orders.get(quotationNumber) ?? [],
    netValue: header.netValue,
    taxValue: header.taxValue,
    grossValue: header.grossValue,
    version: header.version,
    createdBy: header.createdBy,
    partners: resolved,
    lines: lines.map((l) => ({
      lineNumber: l.lineNumber,
      materialNumber: l.materialNumber,
      plant: l.plant,
      quotationQuantity: l.quotationQuantity,
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

/** The session actor for a quotation read or write: live quotation capability and an explicit Company Code scope. */
function quotationActor(tx: Tx, client: string, authorization: ServiceAuthorityContext | undefined) {
  return salesActor(tx, client, authorization, [SALES_QUOTATION_CAPABILITY], (m, r) => new SalesQuotationError(m, r));
}

/** Company, sales area and every plant of the quotation are inside the actor's reach. A missing quotation is not. */
async function quotationInReach(
  tx: Tx, client: string, actor: Awaited<ReturnType<typeof quotationActor>>, quotationNumber: string,
): Promise<boolean> {
  const [header] = await tx.select({
    companyCode: salesQuotation.companyCode, salesOrg: salesQuotation.salesOrg,
    distributionChannel: salesQuotation.distributionChannel, division: salesQuotation.division,
  }).from(salesQuotation).where(and(eq(salesQuotation.client, client), eq(salesQuotation.quotationNumber, quotationNumber))).limit(1);
  if (!header) return false;
  const lines = await tx.select({ plant: salesQuotationLine.plant }).from(salesQuotationLine)
    .where(and(eq(salesQuotationLine.client, client), eq(salesQuotationLine.quotationNumber, quotationNumber)));
  return salesDocumentReachable(actor, { ...header, plants: lines.map((l) => l.plant) });
}

function quotationMissing(quotationNumber: string, remedy: string) {
  return new SalesQuotationError(`Quotation ${quotationNumber} does not exist.`, remedy);
}

/**
 * Read one quotation. Outside the actor's company, sales area or plant reach it is absent, as a missing one.
 * `today` is injectable because expiry is a date comparison the tests must be able to move.
 */
export async function getQuotation(
  client: string, quotationNumber: string, authorization: ServiceAuthorityContext | undefined, today?: string,
): Promise<QuotationView | null> {
  return withTenant(client, async (tx) => {
    const actor = await quotationActor(tx, client, authorization);
    if (!(await quotationInReach(tx, client, actor, quotationNumber))) return null;
    return loadQuotation(tx, client, quotationNumber, today ?? todayOf());
  });
}

/** Seeding and walkthroughs only: no session, no scope. Never imported from `src/app`. */
export async function getQuotationForProvisioning(client: string, quotationNumber: string, today?: string): Promise<QuotationView | null> {
  return withTenant(client, (tx) => loadQuotation(tx, client, quotationNumber, today ?? todayOf()));
}

type PricedForQuotation = Awaited<ReturnType<typeof priceLines>>['lines'];

/**
 * Ask the plant what it could promise for these items. The plan is the order's own (`planOrderLines`,
 * under the rule the quotation type names, blank meaning the order rule), and `exclude` is omitted: a
 * quotation holds no promise that could be counted against itself. Nothing the plan returns reaches
 * `sales_order_schedule`; the caller writes the quotation's own rows.
 */
async function planQuotationLines(
  tx: Tx, client: string,
  input: { salesOrg: string; distributionChannel: string; lines: PricedForQuotation; fallbackDate: string; rule: string | null | undefined },
): Promise<Map<number, LinePlan>> {
  const named = (input.rule ?? '').trim().toUpperCase();
  return planOrderLines(tx, client, {
    salesOrg: input.salesOrg,
    distributionChannel: input.distributionChannel,
    checkingRule: named || ORDER_CHECKING_RULE,
    ...(named ? { ruleNamed: true } : {}),
    // PricedLine hands back strings and the check takes numbers: converted here, or every confirmation is zero.
    lines: input.lines.map((line) => ({
      lineNumber: line.lineNumber,
      materialNumber: line.materialNumber,
      plant: line.plant,
      orderQuantity: Number(line.orderQuantity),
      baseQuantity: Number(line.baseQuantity),
      requestedDate: line.requestedDeliveryDate ?? input.fallbackDate,
    })),
  }).catch((error) => {
    if (error instanceof AvailabilityError) throw new SalesQuotationError(error.message, error.remedy);
    throw error;
  });
}

const round3 = (value: number) => (Math.round((value + Number.EPSILON) * 1000) / 1000).toFixed(3);

/**
 * The quotation's own schedule rows. Mirrors the order's writer, into the quotation's table: schedule
 * number 10, the date the plan stood at, upserted on the key because a changed quotation re-runs the
 * check and the application role holds no DELETE.
 */
async function writeQuotationSchedule(
  tx: Tx,
  input: { client: string; quotationNumber: string; changedBy: string; lines: PricedForQuotation; plans: Map<number, LinePlan>; fallbackDate: string },
): Promise<void> {
  for (const line of input.lines) {
    const plan = input.plans.get(line.lineNumber);
    const requested = Number(line.orderQuantity);
    const confirmed = plan ? plan.confirmedQuantity : requested;
    const requestedDate = line.requestedDeliveryDate ?? input.fallbackDate;
    const confirmedDate = plan ? plan.confirmedDate : (confirmed > 0 ? requestedDate : null);
    const values = {
      requestedDate, requestedQuantity: round3(requested), confirmedQuantity: round3(confirmed), confirmedDate,
    };
    await tx.insert(salesQuotationSchedule).values({
      client: input.client, quotationNumber: input.quotationNumber, quotationLineNumber: line.lineNumber,
      scheduleNumber: 10, ...values, createdBy: input.changedBy,
    }).onConflictDoUpdate({
      target: [
        salesQuotationSchedule.client, salesQuotationSchedule.quotationNumber,
        salesQuotationSchedule.quotationLineNumber, salesQuotationSchedule.scheduleNumber,
      ],
      set: { ...values, changedBy: input.changedBy, changedAt: new Date() },
    });
  }
}

/** One priced line as a quotation row — by name, field by field, never by spreading the priced line. */
function lineRow(client: string, quotationNumber: string, line: PricedForQuotation[number], plan: LinePlan | undefined) {
  return {
    client,
    quotationNumber,
    lineNumber: line.lineNumber,
    materialNumber: line.materialNumber,
    plant: line.plant,
    quotationQuantity: line.orderQuantity,
    quantityUnit: line.quantityUnit,
    baseQuantity: line.baseQuantity,
    confirmedQuantity: plan ? plan.confirmedQuantity.toFixed(3) : null,
    netPrice: line.netPrice,
    priceUnit: line.priceUnit,
    netAmount: line.netAmount,
    taxCode: line.taxCode,
    taxRate: line.taxRate,
    taxAmount: line.taxAmount,
    profitCenter: line.profitCenter,
    requestedDeliveryDate: line.requestedDeliveryDate,
    conditionNumber: line.conditionNumber,
  };
}

function assertDates(quotationDate: string, validTo: string, requestedDate: string | null | undefined): void {
  if (validTo < quotationDate) {
    throw new SalesQuotationError(
      `The quotation is valid to ${validTo}, which is before the day it is given (${quotationDate}).`,
      'Enter a valid-to date on or after the quotation date.',
    );
  }
  if (requestedDate && requestedDate < quotationDate) {
    throw new SalesQuotationError(
      `The requested date ${requestedDate} is before the quotation date ${quotationDate}.`,
      'Enter the date the customer wants the goods on or after the quotation date.',
    );
  }
}

async function requireAuthority(tx: Tx, client: string, authorization: ServiceAuthorityContext | undefined, capability: string) {
  const authority = await verifyServiceAuthorityInTx(tx, client, authorization, capability);
  if (!authority.ok) throw new SalesQuotationError(authority.refusal.message, authority.refusal.remedy);
  return authority;
}

export async function createQuotation(
  input: QuotationCreateInput,
  options: { authorization?: ServiceAuthorityContext } = {},
): Promise<CreateQuotationResult> {
  const parsed = quotationCreateInput.parse(input);
  const created = await withTenant(parsed.client, async (tx) => {
    const authority = await requireAuthority(tx, parsed.client, options.authorization, SALES_QUOTATION_CAPABILITY);
    if (!hasOrgAccess(authority.restrictions, 'COMPANY_CODE', parsed.companyCode)) {
      throw new SalesQuotationError(
        `Your Company Code scope does not cover company code ${parsed.companyCode}.`,
        'Ask an administrator to extend your Company Code scope, then repeat the action.',
      );
    }
    if (!salesAreaReachable(authority, parsed) || !plantsAllow(authority, parsed.lines.flatMap((l) => (l.plant ? [l.plant] : [])))) {
      throw new SalesQuotationError(
        `Your sales area or plant scope does not cover sales area ${parsed.salesOrg}/${parsed.distributionChannel}/${parsed.division} and these plants.`,
        'Ask an administrator to extend your scope, then repeat the action.',
      );
    }
    assertDates(parsed.quotationDate, parsed.validTo, parsed.requestedDate);

    const [area] = await tx.select().from(salesArea).where(and(
      eq(salesArea.client, parsed.client), eq(salesArea.salesOrg, parsed.salesOrg),
      eq(salesArea.distributionChannel, parsed.distributionChannel), eq(salesArea.division, parsed.division),
    )).limit(1);
    if (!area) {
      throw new SalesQuotationError(
        `Sales area ${parsed.salesOrg}/${parsed.distributionChannel}/${parsed.division} does not stand.`,
        'Define the sales area before quoting into it.',
      );
    }
    if (!area.isActive) {
      throw new SalesQuotationError(
        `Sales area ${parsed.salesOrg}/${parsed.distributionChannel}/${parsed.division} is not active.`,
        'Activate the sales area or quote into one that is active.',
      );
    }
    const [partner] = await tx.select().from(businessPartner).where(and(
      eq(businessPartner.client, parsed.client), eq(businessPartner.partnerNumber, parsed.customerNumber),
    )).limit(1);
    if (!partner) {
      throw new SalesQuotationError(`Customer ${parsed.customerNumber} does not stand as a business partner.`, 'Maintain the business partner first.');
    }
    const [role] = await tx.select().from(bpRole).where(and(
      eq(bpRole.client, parsed.client), eq(bpRole.partnerNumber, parsed.customerNumber), eq(bpRole.roleCode, 'CUSTOMER'),
    )).limit(1);
    if (!role) {
      throw new SalesQuotationError(
        `Business partner ${parsed.customerNumber} is not maintained in the customer role.`,
        'Extend the partner with the FL customer role, then quote.',
      );
    }
    let customer: Awaited<ReturnType<typeof resolveCustomerSalesData>>;
    try {
      customer = await resolveCustomerSalesData(tx, parsed.client, parsed.customerNumber,
        parsed.salesOrg, parsed.distributionChannel, parsed.division);
    } catch (error) {
      if (error instanceof PricingError) throw new SalesQuotationError(error.message, error.remedy);
      throw error;
    }
    if (customer.isBlocked) {
      throw new SalesQuotationError(
        `Customer ${parsed.customerNumber} is blocked for the sales area ${parsed.salesOrg}/${parsed.distributionChannel}/${parsed.division}.`,
        'Lift the order block on the customer sales area, then save again.',
      );
    }
    if (customer.salesStatus === 'INCOMPLETE') {
      throw new SalesQuotationError(
        `Customer ${parsed.customerNumber} is incomplete in that sales area, so no quotation may be given against it.`,
        'Complete the customer sales-area data; an incomplete master is not a warning.',
      );
    }

    const type = await salesDocumentTypeFor(tx, parsed.client, STANDARD_QUOTATION_TYPE);
    if (!type) {
      throw new SalesQuotationError(
        `Sales document type ${STANDARD_QUOTATION_TYPE} does not stand for this tenant, so no quotation number can be drawn and no quotation can be created.`,
        DOCUMENT_TYPE_REMEDY,
      );
    }

    // No credit area, no credit determination: a quotation creates no receivable.
    let priced: Awaited<ReturnType<typeof priceLines>>;
    try {
      priced = await priceLines(tx, parsed.client, {
        salesOrg: parsed.salesOrg, distributionChannel: parsed.distributionChannel, division: parsed.division,
        customerNumber: parsed.customerNumber, companyCode: parsed.companyCode, currency: parsed.currency,
        orderDate: parsed.quotationDate, lines: parsed.lines,
        documentPricingProcedure: type.pricingProcedure, customerPricingProcedure: customer.pricingProcedure,
      }, 10);
    } catch (error) {
      if (error instanceof SalesOrderError) throw new SalesQuotationError(error.message, error.remedy);
      throw error;
    }
    const { lines, priced: pricedDocument } = priced;
    const netValue = round2(lines.reduce((sum, l) => sum + Number(l.netAmount), 0));
    const taxValue = round2(lines.reduce((sum, l) => sum + Number(l.taxAmount), 0));
    const grossValue = round2(Number(netValue) + Number(taxValue));

    for (const shipFrom of [...new Set(lines.map((line) => line.plant).filter(Boolean))].sort()) {
      const outOfScope = await refusePlantOutsideScopeInTx(tx, parsed.client, shipFrom, authority.restrictions);
      if (outOfScope) throw new SalesQuotationError(outOfScope.message, outOfScope.remedy);
    }

    if (parsed.requestKey) {
      const [existing] = await tx.select({ quotationNumber: salesQuotation.quotationNumber }).from(salesQuotation)
        .where(and(eq(salesQuotation.client, parsed.client), eq(salesQuotation.requestKey, parsed.requestKey))).limit(1);
      if (existing) return { quotationNumber: existing.quotationNumber, replayed: true };
    }

    let number: string;
    try {
      const drawn = await allocateNumber(tx, {
        client: parsed.client, objectCode: type.numberRangeObject, companyCode: '*',
        subObject: type.numberRangeSubObject, fiscalYear: 0, allocatedBy: parsed.changedBy,
      });
      number = drawn.display;
    } catch {
      throw new SalesQuotationError(
        `No active internal ${type.numberRangeObject} number range stands for sub-object ${type.numberRangeSubObject} of sales document type ${type.documentType}, so no quotation number can be drawn.`,
        'Define or unblock the interval on the number ranges screen, then save again.',
      );
    }

    await tx.insert(salesQuotation).values({
      client: parsed.client,
      quotationNumber: number,
      documentType: type.documentType,
      salesOrg: parsed.salesOrg,
      distributionChannel: parsed.distributionChannel,
      division: parsed.division,
      customerNumber: parsed.customerNumber,
      companyCode: parsed.companyCode,
      currency: parsed.currency,
      quotationDate: parsed.quotationDate,
      validTo: parsed.validTo,
      requestedDate: parsed.requestedDate ?? null,
      purchaseOrderReference: parsed.purchaseOrderReference || null,
      headerText: parsed.headerText || null,
      status: 'OPEN',
      netValue, taxValue, grossValue,
      requestKey: parsed.requestKey ?? null,
      createdBy: parsed.changedBy,
    });

    const fallbackDate = parsed.requestedDate ?? parsed.quotationDate;
    const plans = await planQuotationLines(tx, parsed.client, {
      salesOrg: parsed.salesOrg, distributionChannel: parsed.distributionChannel,
      lines, fallbackDate, rule: type.availabilityCheckRule,
    });
    for (const line of lines) {
      await tx.insert(salesQuotationLine).values({
        ...lineRow(parsed.client, number, line, plans.get(line.lineNumber)),
        status: 'OPEN', createdBy: parsed.changedBy,
      });
    }
    await writeQuotationSchedule(tx, { client: parsed.client, quotationNumber: number, changedBy: parsed.changedBy, lines, plans, fallbackDate });

    const partners = await resolvePartners(tx, parsed.client, {
      partnerNumber: parsed.customerNumber, salesOrg: parsed.salesOrg,
      distributionChannel: parsed.distributionChannel, division: parsed.division,
    });
    await writeDocumentPartners(tx, {
      client: parsed.client, documentCategory: 'QUOTATION', documentNumber: number, partners, changedBy: parsed.changedBy,
    });
    await writeDocumentConditions(tx, {
      client: parsed.client, documentCategory: 'QUOTATION', documentNumber: number, currency: parsed.currency,
      items: pricedDocument.items.map((item) => ({ lineNumber: item.lineNumber, conditions: item.conditions })),
      headerConditions: pricedDocument.headerConditions, steps: pricedDocument.steps, changedBy: parsed.changedBy,
    });
    await recordChange(tx, {
      client: parsed.client, objectClass: SALES_QUOTATION_OBJECT_CLASS, objectKey: number, changeType: 'CREATE',
      changedBy: parsed.changedBy,
      after: {
        customer: parsed.customerNumber,
        salesArea: `${parsed.salesOrg}/${parsed.distributionChannel}/${parsed.division}`,
        validTo: parsed.validTo, items: lines.length, netValue, taxValue, grossValue,
      },
    });
    // No incompletion, no output: a quotation has none of the four functions incompletion blocks, and the
    // printed quotation is a separate increment.
    return { quotationNumber: number, replayed: false };
  });
  const view = await getQuotationForProvisioning(parsed.client, created.quotationNumber);
  if (!view) throw new SalesQuotationError(`Quotation ${created.quotationNumber} could not be read back.`);
  return { ...view, replayed: created.replayed };
}

/**
 * Change an open quotation. Items are re-priced from the records that stood on the day the quotation was
 * given, not today's; the check is asked again and the schedule rows rewritten. An item that is neither
 * submitted nor rejected is a refusal, not a deletion. There is no delivered-quantity guard — nothing is
 * delivered against a quotation — and no credit re-determination.
 */
export async function changeQuotation(input: QuotationChangeInput): Promise<QuotationView> {
  const parsed = quotationChangeInput.parse(input);
  await withTenant(parsed.client, async (tx) => {
    const actor = await quotationActor(tx, parsed.client, input.authorization);
    if (!(await quotationInReach(tx, parsed.client, actor, parsed.quotationNumber))) {
      throw quotationMissing(parsed.quotationNumber, 'Read the quotation before changing it.');
    }
    const [before] = await tx.select().from(salesQuotation).where(and(
      eq(salesQuotation.client, parsed.client), eq(salesQuotation.quotationNumber, parsed.quotationNumber),
    )).limit(1);
    if (!before) {
      throw new SalesQuotationError(`Quotation ${parsed.quotationNumber} does not exist.`, 'Read the quotation before changing it.');
    }
    if (before.status !== 'OPEN') {
      throw new SalesQuotationError(
        `Quotation ${parsed.quotationNumber} stands ${before.status}; only an open quotation can be changed.`,
        'A rejected quotation is not re-opened — create a new quotation.',
      );
    }
    if (before.version !== parsed.expectedVersion) {
      throw new SalesQuotationError(
        `Quotation ${parsed.quotationNumber} changed since it was read (version ${before.version}, expected ${parsed.expectedVersion}).`,
        'Reload the quotation and apply the change to what stands now.',
      );
    }
    if (parsed.customerNumber !== before.customerNumber || parsed.salesOrg !== before.salesOrg
      || parsed.distributionChannel !== before.distributionChannel || parsed.division !== before.division) {
      throw new SalesQuotationError(
        'The sold-to, sales organization, distribution channel and division of a quotation are not changed. Create a new quotation.',
        'A partner or organization change is a new answer, not an edit of this one.',
      );
    }
    if (parsed.quotationDate !== before.quotationDate) {
      throw new SalesQuotationError(
        `The day a quotation is given is not changed (it was given on ${before.quotationDate}).`,
        'Change the valid-to date to move how long it holds, or create a new quotation.',
      );
    }
    assertDates(before.quotationDate, parsed.validTo, parsed.requestedDate ?? before.requestedDate);
    parsed.changedBy = actor.username;

    const customer = await resolveCustomerSalesData(tx, parsed.client, before.customerNumber,
      before.salesOrg, before.distributionChannel, before.division).catch((error: unknown) => {
      if (error instanceof PricingError) throw new SalesQuotationError(error.message, error.remedy);
      throw error;
    });
    const type = await salesDocumentTypeFor(tx, parsed.client, before.documentType);
    let priced: Awaited<ReturnType<typeof priceLines>>;
    try {
      priced = await priceLines(tx, parsed.client, {
        salesOrg: before.salesOrg, distributionChannel: before.distributionChannel, division: before.division,
        customerNumber: before.customerNumber, companyCode: before.companyCode, currency: before.currency,
        orderDate: before.quotationDate, lines: parsed.lines,
        documentPricingProcedure: type?.pricingProcedure ?? STANDARD_DOCUMENT_PRICING_PROCEDURE,
        customerPricingProcedure: customer.pricingProcedure,
      }, 10);
    } catch (error) {
      if (error instanceof SalesOrderError) throw new SalesQuotationError(error.message, error.remedy);
      throw error;
    }
    const { lines, priced: pricedDocument } = priced;

    const openRows = await tx.select({ lineNumber: salesQuotationLine.lineNumber }).from(salesQuotationLine)
      .where(and(eq(salesQuotationLine.client, parsed.client), eq(salesQuotationLine.quotationNumber, parsed.quotationNumber),
        eq(salesQuotationLine.status, 'OPEN')));
    const rejected = new Map(parsed.rejectLines.map((r) => [r.lineNumber, r.reason]));
    for (const existing of openRows) {
      if (lines.some((l) => l.lineNumber === existing.lineNumber) || rejected.has(existing.lineNumber)) continue;
      throw new SalesQuotationError(
        `Item ${existing.lineNumber} was neither submitted nor rejected.`,
        'An item is kept by submitting it again, or rejected with a reason. It is never dropped in silence.',
      );
    }
    for (const [lineNumber, reason] of rejected) {
      if (!openRows.some((r) => r.lineNumber === lineNumber)) {
        throw new SalesQuotationError(
          `Item ${lineNumber} is not open, so it cannot be rejected.`,
          'Reload the quotation and reject an item that still stands open.',
        );
      }
      await tx.update(salesQuotationLine)
        .set({ status: 'REJECTED', rejectionReason: reason, changedBy: parsed.changedBy, changedAt: new Date() })
        .where(and(eq(salesQuotationLine.client, parsed.client), eq(salesQuotationLine.quotationNumber, parsed.quotationNumber),
          eq(salesQuotationLine.lineNumber, lineNumber)));
    }

    const fallbackDate = parsed.requestedDate ?? before.requestedDate ?? before.quotationDate;
    // A line rejected in this very change is not asked for again, and is not priced into the totals.
    const kept = lines.filter((line) => !rejected.has(line.lineNumber));
    const plans = await planQuotationLines(tx, parsed.client, {
      salesOrg: before.salesOrg, distributionChannel: before.distributionChannel,
      lines: kept, fallbackDate, rule: type?.availabilityCheckRule,
    });
    for (const line of lines) {
      const [standing] = await tx.select({ status: salesQuotationLine.status }).from(salesQuotationLine)
        .where(and(eq(salesQuotationLine.client, parsed.client), eq(salesQuotationLine.quotationNumber, parsed.quotationNumber),
          eq(salesQuotationLine.lineNumber, line.lineNumber))).limit(1);
      if (rejected.has(line.lineNumber)) continue;
      const row = lineRow(parsed.client, parsed.quotationNumber, line, plans.get(line.lineNumber));
      if (!standing) {
        await tx.insert(salesQuotationLine).values({ ...row, status: 'OPEN', createdBy: parsed.changedBy });
        continue;
      }
      if (standing.status === 'REJECTED') {
        throw new SalesQuotationError(
          `Item ${line.lineNumber} is rejected, and a rejected item number is not reused.`,
          'Add the item under the next free number so the rejected line stays readable.',
        );
      }
      const { client: _c, quotationNumber: _q, lineNumber: _l, ...changes } = row;
      void _c; void _q; void _l;
      await tx.update(salesQuotationLine).set({ ...changes, changedBy: parsed.changedBy, changedAt: new Date() })
        .where(and(eq(salesQuotationLine.client, parsed.client), eq(salesQuotationLine.quotationNumber, parsed.quotationNumber),
          eq(salesQuotationLine.lineNumber, line.lineNumber)));
    }
    await writeQuotationSchedule(tx, {
      client: parsed.client, quotationNumber: parsed.quotationNumber, changedBy: parsed.changedBy,
      lines: kept, plans, fallbackDate,
    });

    const partners = await resolvePartners(tx, parsed.client, {
      partnerNumber: before.customerNumber, salesOrg: before.salesOrg,
      distributionChannel: before.distributionChannel, division: before.division,
    });
    await writeDocumentPartners(tx, {
      client: parsed.client, documentCategory: 'QUOTATION', documentNumber: parsed.quotationNumber,
      partners, changedBy: parsed.changedBy,
    });
    await writeDocumentConditions(tx, {
      client: parsed.client, documentCategory: 'QUOTATION', documentNumber: parsed.quotationNumber, currency: before.currency,
      items: pricedDocument.items.filter((item) => !rejected.has(item.lineNumber))
        .map((item) => ({ lineNumber: item.lineNumber, conditions: item.conditions })),
      headerConditions: pricedDocument.headerConditions, steps: pricedDocument.steps, changedBy: parsed.changedBy,
    });

    const resulting = await tx.select().from(salesQuotationLine).where(and(
      eq(salesQuotationLine.client, parsed.client), eq(salesQuotationLine.quotationNumber, parsed.quotationNumber),
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
    const applied = await tx.update(salesQuotation).set({
      netValue: net, taxValue: tax, grossValue: gross,
      validTo: parsed.validTo,
      headerText: parsed.headerText || before.headerText,
      purchaseOrderReference: parsed.purchaseOrderReference || before.purchaseOrderReference,
      requestedDate: parsed.requestedDate ?? before.requestedDate,
      version: before.version + 1, changedBy: parsed.changedBy, changedAt: new Date(),
    }).where(and(eq(salesQuotation.client, parsed.client), eq(salesQuotation.quotationNumber, parsed.quotationNumber),
      eq(salesQuotation.version, parsed.expectedVersion))).returning({ quotationNumber: salesQuotation.quotationNumber });
    if (!applied.length) {
      throw new SalesQuotationError(
        `Quotation ${parsed.quotationNumber} changed concurrently; nothing was written.`,
        'Reload the quotation and apply the change to what stands now.',
      );
    }
    await recordChange(tx, {
      client: parsed.client, objectClass: SALES_QUOTATION_OBJECT_CLASS, objectKey: parsed.quotationNumber, changeType: 'CHANGE',
      changedBy: parsed.changedBy,
      before: { netValue: before.netValue, grossValue: before.grossValue, validTo: before.validTo, openItems: openRows.length },
      after: { netValue: net, grossValue: gross, validTo: parsed.validTo, submittedItems: lines.length, rejectedItems: rejected.size },
    });
  });
  const view = await getQuotationForProvisioning(parsed.client, parsed.quotationNumber);
  if (!view) throw new SalesQuotationError(`Quotation ${parsed.quotationNumber} does not exist.`);
  return view;
}

export interface QuotationListRow {
  quotationNumber: string; customerNumber: string; quotationDate: string; validTo: string; status: string;
  isExpired: boolean; currency: string; grossValue: string; ordersRaised: string[];
}

/** Newest first, a hundred at most, as the order list. No credit column: a quotation has no credit state. */
export async function listQuotations(
  client: string,
  filter: { customerNumber?: string; status?: string; openOnly?: boolean; today?: string } = {},
  authorization?: ServiceAuthorityContext,
): Promise<QuotationListRow[]> {
  return withTenant(client, async (tx) => {
    const actor = await quotationActor(tx, client, authorization);
    const today = filter.today ?? todayOf();
    const conditions = [eq(salesQuotation.client, client)];
    if (filter.customerNumber) conditions.push(eq(salesQuotation.customerNumber, filter.customerNumber.trim().toUpperCase()));
    if (filter.status) conditions.push(eq(salesQuotation.status, filter.status));
    if (filter.openOnly) conditions.push(eq(salesQuotation.status, 'OPEN'));
    const candidates = await tx.select().from(salesQuotation).where(and(...conditions))
      .orderBy(sql`${salesQuotation.createdAt} desc, ${salesQuotation.quotationNumber} desc`);
    const plantRows = await tx.select({ n: salesQuotationLine.quotationNumber, plant: salesQuotationLine.plant })
      .from(salesQuotationLine).where(eq(salesQuotationLine.client, client));
    const plantsOf = new Map<string, string[]>();
    for (const r of plantRows) plantsOf.set(r.n, [...(plantsOf.get(r.n) ?? []), r.plant]);
    const rows = candidates.filter((q) => salesDocumentReachable(actor, { ...q, plants: plantsOf.get(q.quotationNumber) ?? [] })).slice(0, 100);
    const orders = await ordersRaisedFrom(tx, client, rows.map((r) => r.quotationNumber));
    return rows.map((r) => ({
      quotationNumber: r.quotationNumber,
      customerNumber: r.customerNumber,
      quotationDate: r.quotationDate,
      validTo: r.validTo,
      status: r.status,
      isExpired: expiredOn(r.status, r.validTo, today),
      currency: r.currency,
      grossValue: r.grossValue,
      ordersRaised: orders.get(r.quotationNumber) ?? [],
    }));
  });
}

/** End a quotation with a reason. A 4-character code with no master behind it, as an order item's. */
export async function rejectQuotation(input: {
  client: string; changedBy: string; quotationNumber: string; expectedVersion: number; reason: string;
  authorization: ServiceAuthorityContext | undefined;
}): Promise<QuotationView> {
  const parsed = z.object({
    client: key(4), changedBy: z.string().trim().min(1).max(60), quotationNumber: key(20),
    expectedVersion: z.coerce.number().int().positive(),
    reason: z.string().trim().transform((s) => s.toUpperCase()).pipe(z.string().min(1, 'A rejection needs a reason code.').max(4)),
  }).safeParse(input);
  if (!parsed.success) {
    throw new SalesQuotationError(
      parsed.error.issues[0]?.message ?? 'The rejection is not valid.',
      'Give a reason code of one to four characters, and the version you read.',
    );
  }
  const data = parsed.data;
  await withTenant(data.client, async (tx) => {
    const actor = await quotationActor(tx, data.client, input.authorization);
    if (!(await quotationInReach(tx, data.client, actor, data.quotationNumber))) {
      throw quotationMissing(data.quotationNumber, 'Read the quotation before rejecting it.');
    }
    data.changedBy = actor.username;
    const [before] = await tx.select().from(salesQuotation).where(and(
      eq(salesQuotation.client, data.client), eq(salesQuotation.quotationNumber, data.quotationNumber),
    )).limit(1);
    if (!before) throw new SalesQuotationError(`Quotation ${data.quotationNumber} does not exist.`, 'Read the quotation before rejecting it.');
    if (before.status !== 'OPEN') {
      throw new SalesQuotationError(
        `Quotation ${data.quotationNumber} already stands ${before.status}.`,
        'A rejected quotation is not rejected twice and is not re-opened.',
      );
    }
    if (before.version !== data.expectedVersion) {
      throw new SalesQuotationError(
        `Quotation ${data.quotationNumber} changed since it was read (version ${before.version}, expected ${data.expectedVersion}).`,
        'Reload the quotation and decide again on what stands now.',
      );
    }
    const applied = await tx.update(salesQuotation).set({
      status: 'REJECTED', rejectionReason: data.reason, version: before.version + 1,
      changedBy: data.changedBy, changedAt: new Date(),
    }).where(and(eq(salesQuotation.client, data.client), eq(salesQuotation.quotationNumber, data.quotationNumber),
      eq(salesQuotation.version, data.expectedVersion))).returning({ quotationNumber: salesQuotation.quotationNumber });
    if (!applied.length) {
      throw new SalesQuotationError(`Quotation ${data.quotationNumber} changed concurrently; nothing was written.`, 'Reload the quotation and decide again.');
    }
    await recordChange(tx, {
      client: data.client, objectClass: SALES_QUOTATION_OBJECT_CLASS, objectKey: data.quotationNumber, changeType: 'CHANGE',
      changedBy: data.changedBy, reason: data.reason,
      before: { status: before.status, rejectionReason: null },
      after: { status: 'REJECTED', rejectionReason: data.reason },
    });
  });
  const view = await getQuotationForProvisioning(data.client, data.quotationNumber);
  if (!view) throw new SalesQuotationError(`Quotation ${data.quotationNumber} does not exist.`);
  return view;
}

export interface QuotationOrderResult {
  quotationNumber: string;
  orderNumber: string;
  /** Orders that had already been raised from this quotation before this one. */
  alreadyRaised: string[];
  replayed: boolean;
  order: CreateSalesOrderResult;
}

/**
 * Raise a sales order from a quotation. The order is created by the ordinary order service and is an
 * ordinary order: priced from the records standing on the order date (the quotation's price is not
 * carried — a quotation made in January is an order in June), checked for availability, judged for
 * credit, completeness and output. It names the quotation as its predecessor, and it keeps the item
 * numbers the quotation carried, with rejected items left behind.
 *
 * The order commits in its own transaction; the quotation's change document follows it. The order is the
 * durable record of the link (`ordersRaised` is read from the reference it carries), so a missing audit
 * row never rolls an order back. A replayed request writes no second change document.
 */
export async function createOrderFromQuotation(
  input: {
    client: string; changedBy: string; quotationNumber: string; expectedVersion: number;
    orderDate: string; requestedDate?: string; requestKey: string; today?: string;
  },
  options: { authorization?: ServiceAuthorityContext } = {},
): Promise<QuotationOrderResult> {
  const client = key(4).parse(input.client);
  const quotationNumber = key(20).parse(input.quotationNumber);
  const today = input.today ?? todayOf();

  // Both authorities: the screen that was reached, and the document about to be created.
  await withTenant(client, async (tx) => {
    const actor = await quotationActor(tx, client, options.authorization);
    if (!(await quotationInReach(tx, client, actor, quotationNumber))) {
      throw quotationMissing(quotationNumber, 'Read the quotation before raising an order from it.');
    }
    await requireAuthority(tx, client, options.authorization, SALES_QUOTATION_CAPABILITY);
    const orderAuthority = await verifyServiceAuthorityInTx(tx, client, options.authorization, SALES_ORDER_CREATE_CAPABILITY);
    if (!orderAuthority.ok) {
      throw new SalesQuotationError(
        `Raising an order from a quotation creates a sales order, and you do not hold ${SALES_ORDER_CREATE_CAPABILITY}. ${orderAuthority.refusal.message}`,
        `Ask for ${SALES_ORDER_CREATE_CAPABILITY}. The quotation capability alone does not let you create an order.`,
      );
    }
  });

  const quotation = await getQuotationForProvisioning(client, quotationNumber, today);
  if (!quotation) {
    throw new SalesQuotationError(`Quotation ${quotationNumber} does not exist.`, 'Read the quotation before raising an order from it.');
  }
  const replay = await withTenant(client, async (tx) => {
    const [existing] = await tx.select({ orderNumber: salesOrder.orderNumber }).from(salesOrder)
      .where(and(eq(salesOrder.client, client), eq(salesOrder.requestKey, input.requestKey))).limit(1);
    return existing?.orderNumber ?? null;
  });
  if (replay) {
    // The same submission pressed twice: the order that exists is the answer, and nothing else is run.
    const order = await createSalesOrder(orderInputFrom(quotation, input, client), { authorization: options.authorization });
    return {
      quotationNumber, orderNumber: order.orderNumber, replayed: true, order,
      alreadyRaised: quotation.ordersRaised.filter((n) => n !== order.orderNumber),
    };
  }
  if (quotation.status !== 'OPEN') {
    throw new SalesQuotationError(
      `Quotation ${quotationNumber} stands ${quotation.status}${quotation.rejectionReason ? ` (${quotation.rejectionReason})` : ''}, so no order is raised from it.`,
      'Only an open quotation is copied. Create a new quotation if the customer has changed their mind.',
    );
  }
  if (quotation.isExpired) {
    throw new SalesQuotationError(
      `Quotation ${quotationNumber} was valid to ${quotation.validTo} and has expired, so no order is raised from it.`,
      'Extend the valid-to date by changing the quotation, or create a new quotation.',
    );
  }
  if (quotation.version !== input.expectedVersion) {
    throw new SalesQuotationError(
      `Quotation ${quotationNumber} changed since it was read (version ${quotation.version}, expected ${input.expectedVersion}).`,
      'Reload the quotation and raise the order from what stands now.',
    );
  }
  if (!quotation.lines.some((l) => l.status === 'OPEN')) {
    throw new SalesQuotationError(
      `Quotation ${quotationNumber} has no open items, so there is nothing to copy.`,
      'Every item was rejected. Create a new quotation.',
    );
  }

  const order = await createSalesOrder(orderInputFrom(quotation, input, client), { authorization: options.authorization });
  if (!order.replayed) {
    // The audit row follows the order and never undoes it.
    await withTenant(client, (tx) => recordChange(tx, {
      client, objectClass: SALES_QUOTATION_OBJECT_CLASS, objectKey: quotationNumber, changeType: 'CHANGE',
      changedBy: input.changedBy,
      before: { ordersRaised: quotation.ordersRaised.length },
      after: { orderNumber: order.orderNumber, ordersRaised: quotation.ordersRaised.length + 1 },
      fieldLabels: { orderNumber: 'Order raised' },
    })).catch(() => undefined);
  }
  return { quotationNumber, orderNumber: order.orderNumber, replayed: order.replayed, order, alreadyRaised: quotation.ordersRaised };
}

function orderInputFrom(
  quotation: QuotationView,
  input: { changedBy: string; orderDate: string; requestedDate?: string; requestKey: string },
  client: string,
) {
  return {
    client,
    changedBy: input.changedBy,
    salesOrg: quotation.salesOrg,
    distributionChannel: quotation.distributionChannel,
    division: quotation.division,
    customerNumber: quotation.customerNumber,
    companyCode: quotation.companyCode,
    currency: quotation.currency,
    orderDate: input.orderDate,
    requestedDate: input.requestedDate ?? quotation.requestedDate ?? undefined,
    purchaseOrderReference: quotation.purchaseOrderReference ?? undefined,
    headerText: quotation.headerText ?? undefined,
    referenceDocumentType: QUOTATION_REFERENCE_TYPE,
    referenceDocumentNumber: quotation.quotationNumber,
    requestKey: input.requestKey,
    lines: quotation.lines.filter((l) => l.status === 'OPEN').map((l) => ({
      lineNumber: l.lineNumber,
      materialNumber: l.materialNumber,
      plant: l.plant,
      orderQuantity: Number(l.quotationQuantity),
      quantityUnit: l.quantityUnit.trim(),
      taxCode: l.taxCode ?? undefined,
      profitCenter: l.profitCenter ?? undefined,
      requestedDeliveryDate: l.requestedDeliveryDate ?? undefined,
    })),
  };
}

/** What the screen may offer: the same sales areas, companies and plants the order screen offers. */
export const quotationChoices = salesOrderChoices;
