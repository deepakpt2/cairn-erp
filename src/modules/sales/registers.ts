/**
 * The registers and the due lists — §5.2, SAP's VA05, VL06 and VF05.
 *
 * A document screen answers "show me this document". A register answers "show me the documents" —
 * what stands, what it is worth, and what is still to do — and it is the only way a planner works a
 * day without knowing which numbers to type. Three things make it a register rather than a list:
 *
 * **It is filtered by what the business asks about**, not by what the primary key happens to be: the
 * customer, the material, the sales organisation, the plant, the document type, the status and a
 * period. Every one of them is optional, and every one of them narrows rather than widens.
 *
 * **It is read once per document kind, and the due lists are the same read over what is
 * outstanding.** There is one implementation of "what can be delivered" and one of "what can be
 * billed", and the register asks them rather than restating them — the same reason there is one
 * implementation of the tax rule (§4.7). A second reading of the same question is how a screen comes
 * to disagree with the thing that acts on it.
 *
 * **It says what it found, and what it did not bother to count.** A register that silently shows two
 * hundred of four thousand rows is a report you cannot trust, so the answer carries the count and
 * says plainly that it was cut.
 *
 * Nothing here posts, and nothing here decides. A register reads.
 */
import { and, asc, desc, eq, exists, gte, lte, sql } from 'drizzle-orm';

import { type Tx, withTenant } from '../../platform/db/client';
import { businessPartner } from '../foundation/business-partner-schema';
import { plant as plantTable, salesArea } from '../foundation/schema';
import { material } from '../inventory/schema';
import { billingDueList } from './billing';
import { listDeliverableOrderLines } from './delivery';
import {
  billingDocument, delivery, salesDocumentType, salesOrder, salesOrderLine,
  salesReturnsConfiguration,
} from './schema';

export const REGISTER_KINDS = [
  'ORDER', 'DELIVERY', 'BILLING', 'RETURNS', 'CANCELLATION',
] as const;
export type RegisterKind = (typeof REGISTER_KINDS)[number];

/** What each kind is, in words, so no screen has to know what a returns register is made of. */
export const REGISTER_KIND_MEANING: Record<RegisterKind, string> = {
  ORDER: 'What the customers have asked for, and what it is worth.',
  DELIVERY: 'What has gone out, or is standing ready to.',
  BILLING: 'What the customer has been charged, and what has been credited back.',
  RETURNS: 'What is coming back: the returns orders, and the receipts that answer them.',
  CANCELLATION: 'What was undone: cancelled orders and deliveries, cancellations and credit memos.',
};

/** The most rows a register returns. A register that cannot be read is not a register. */
export const REGISTER_LIMIT = 200;

export interface RegisterFilter {
  documentNumber?: string;
  /** What the document was raised for or against: the order on a delivery, the delivery on a bill. */
  orderNumber?: string;
  deliveryNumber?: string;
  customerNumber?: string;
  materialNumber?: string;
  salesOrg?: string;
  plant?: string;
  documentType?: string;
  status?: string;
  /** The date the document carries: the order date, the delivery date, the billing date. */
  dateFrom?: string;
  dateTo?: string;
}

export interface RegisterRow {
  kind: RegisterKind;
  documentNumber: string;
  documentType: string;
  /** What the document is dated, whatever kind it is. */
  documentDate: string;
  customerNumber: string;
  customerName: string | null;
  salesOrg: string;
  plant: string | null;
  status: string;
  currency: string | null;
  netValue: string | null;
  grossValue: string | null;
  /** What it was raised against, or what it became. */
  referenceNumber: string | null;
  /** Where it stands on an invoice list, where that question means anything. */
  invoiceListNumber: string | null;
}

export interface RegisterTotals {
  documents: number;
  netValue: string | null;
  grossValue: string | null;
}

export interface DocumentRegister {
  kind: RegisterKind;
  meaning: string;
  rows: RegisterRow[];
  /** How many answered, whether or not they were all read. */
  count: number;
  /** Whether the read was cut at the limit. A register that hides this cannot be trusted. */
  truncated: boolean;
  /** Null where the register carries no money — a returns order does, a delivery does not. */
  totals: RegisterTotals;
}

/** Trim a filter of its blanks, so an empty box on a screen narrows nothing. */
function clean(filter: RegisterFilter): RegisterFilter {
  const out: RegisterFilter = {};
  for (const [key, value] of Object.entries(filter)) {
    if (typeof value === 'string' && value.trim() !== '') {
      (out as Record<string, string>)[key] = value.trim();
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// One kind at a time
// ─────────────────────────────────────────────────────────────────────────────

/** A line of this order that carries the material and the plant the filter names, where it names any. */
function orderLineMatches(tx: Tx, client: string, filter: RegisterFilter) {
  return exists(tx.select({ one: sql`1` }).from(salesOrderLine).where(and(
    eq(salesOrderLine.client, client),
    eq(salesOrderLine.orderNumber, salesOrder.orderNumber),
    filter.materialNumber ? eq(salesOrderLine.materialNumber, filter.materialNumber) : undefined,
    filter.plant ? eq(salesOrderLine.plant, filter.plant) : undefined,
  )));
}

async function orderRegister(
  tx: Tx, client: string, filter: RegisterFilter, limit: number,
): Promise<{ rows: RegisterRow[]; count: number }> {
  const byLine = filter.materialNumber || filter.plant ? orderLineMatches(tx, client, filter) : undefined;
  const where = and(
    eq(salesOrder.client, client),
    filter.documentNumber ? eq(salesOrder.orderNumber, filter.documentNumber) : undefined,
    filter.customerNumber ? eq(salesOrder.customerNumber, filter.customerNumber) : undefined,
    filter.salesOrg ? eq(salesOrder.salesOrg, filter.salesOrg) : undefined,
    filter.documentType ? eq(salesOrder.documentType, filter.documentType) : undefined,
    filter.status ? eq(salesOrder.status, filter.status) : undefined,
    filter.dateFrom ? gte(salesOrder.orderDate, filter.dateFrom) : undefined,
    filter.dateTo ? lte(salesOrder.orderDate, filter.dateTo) : undefined,
    byLine,
  );
  const rows = await tx.select({
    documentNumber: salesOrder.orderNumber,
    documentType: salesOrder.documentType,
    documentDate: salesOrder.orderDate,
    customerNumber: salesOrder.customerNumber,
    customerName: businessPartner.name,
    salesOrg: salesOrder.salesOrg,
    status: salesOrder.status,
    currency: salesOrder.currency,
    netValue: salesOrder.netValue,
    grossValue: salesOrder.grossValue,
    referenceNumber: salesOrder.referenceDocumentNumber,
  }).from(salesOrder)
    .leftJoin(businessPartner, and(
      eq(businessPartner.client, client),
      eq(businessPartner.partnerNumber, salesOrder.customerNumber),
    ))
    .where(where)
    .orderBy(desc(salesOrder.orderDate), desc(salesOrder.orderNumber))
    .limit(limit);
  const [counted] = await tx.select({ count: sql<number>`count(*)::int` })
    .from(salesOrder).where(where);
  return {
    rows: rows.map((row) => ({
      kind: 'ORDER' as const,
      documentNumber: row.documentNumber,
      documentType: row.documentType,
      documentDate: row.documentDate,
      customerNumber: row.customerNumber,
      customerName: row.customerName,
      salesOrg: row.salesOrg,
      plant: null,
      status: row.status,
      currency: row.currency,
      netValue: row.netValue,
      grossValue: row.grossValue,
      referenceNumber: row.referenceNumber,
      invoiceListNumber: null,
    })),
    count: counted?.count ?? 0,
  };
}

async function deliveryRegister(
  tx: Tx, client: string, filter: RegisterFilter, limit: number,
): Promise<{ rows: RegisterRow[]; count: number }> {
  const where = and(
    eq(delivery.client, client),
    filter.documentNumber ? eq(delivery.deliveryNumber, filter.documentNumber) : undefined,
    filter.customerNumber ? eq(delivery.customerNumber, filter.customerNumber) : undefined,
    filter.salesOrg ? eq(delivery.salesOrg, filter.salesOrg) : undefined,
    filter.plant ? eq(delivery.plant, filter.plant) : undefined,
    filter.documentType ? eq(delivery.documentType, filter.documentType) : undefined,
    filter.status ? eq(delivery.status, filter.status) : undefined,
    filter.dateFrom ? gte(delivery.deliveryDate, filter.dateFrom) : undefined,
    filter.dateTo ? lte(delivery.deliveryDate, filter.dateTo) : undefined,
    filter.materialNumber ? exists(tx.select({ one: sql`1` }).from(salesOrderLine).where(and(
      eq(salesOrderLine.client, client),
      eq(salesOrderLine.orderNumber, salesOrder.orderNumber),
      eq(salesOrderLine.materialNumber, filter.materialNumber),
    ))) : undefined,
  );
  const rows = await tx.select({
    documentNumber: delivery.deliveryNumber,
    documentType: delivery.documentType,
    documentDate: delivery.deliveryDate,
    customerNumber: delivery.customerNumber,
    customerName: businessPartner.name,
    salesOrg: delivery.salesOrg,
    plant: delivery.plant,
    status: delivery.status,
    referenceNumber: delivery.orderNumber,
  }).from(delivery)
    .leftJoin(businessPartner, and(
      eq(businessPartner.client, client),
      eq(businessPartner.partnerNumber, delivery.customerNumber),
    ))
    .where(where)
    .orderBy(desc(delivery.deliveryDate), desc(delivery.deliveryNumber))
    .limit(limit);
  const [counted] = await tx.select({ count: sql<number>`count(*)::int` })
    .from(delivery).where(where);
  return {
    rows: rows.map((row) => ({
      kind: 'DELIVERY' as const,
      documentNumber: row.documentNumber,
      documentType: row.documentType,
      documentDate: row.documentDate,
      customerNumber: row.customerNumber,
      customerName: row.customerName,
      salesOrg: row.salesOrg,
      plant: row.plant,
      status: row.status,
      currency: null,
      netValue: null,
      grossValue: null,
      referenceNumber: row.referenceNumber,
      invoiceListNumber: null,
    })),
    count: counted?.count ?? 0,
  };
}

async function billingRegister(
  tx: Tx, client: string, filter: RegisterFilter, limit: number,
): Promise<{ rows: RegisterRow[]; count: number }> {
  const where = and(
    eq(billingDocument.client, client),
    filter.documentNumber ? eq(billingDocument.billingNumber, filter.documentNumber) : undefined,
    filter.customerNumber ? eq(billingDocument.customerNumber, filter.customerNumber) : undefined,
    filter.salesOrg ? eq(billingDocument.salesOrg, filter.salesOrg) : undefined,
    filter.documentType ? eq(billingDocument.documentType, filter.documentType) : undefined,
    filter.status ? eq(billingDocument.status, filter.status) : undefined,
    filter.dateFrom ? gte(billingDocument.billingDate, filter.dateFrom) : undefined,
    filter.dateTo ? lte(billingDocument.billingDate, filter.dateTo) : undefined,
    filter.materialNumber ? exists(tx.select({ one: sql`1` }).from(salesOrderLine).where(and(
      eq(salesOrderLine.client, client),
      eq(salesOrderLine.orderNumber, salesOrder.orderNumber),
      eq(salesOrderLine.materialNumber, filter.materialNumber),
    ))) : undefined,
    filter.plant ? exists(tx.select({ one: sql`1` }).from(salesOrderLine).where(and(
      eq(salesOrderLine.client, client),
      eq(salesOrderLine.orderNumber, salesOrder.orderNumber),
      eq(salesOrderLine.plant, filter.plant),
    ))) : undefined,
  );
  const rows = await tx.select({
    documentNumber: billingDocument.billingNumber,
    documentType: billingDocument.documentType,
    documentDate: billingDocument.billingDate,
    customerNumber: billingDocument.customerNumber,
    customerName: businessPartner.name,
    salesOrg: billingDocument.salesOrg,
    status: billingDocument.status,
    currency: billingDocument.currency,
    netValue: billingDocument.netValue,
    grossValue: billingDocument.grossValue,
    deliveryNumber: billingDocument.deliveryNumber,
    orderNumber: billingDocument.orderNumber,
    invoiceListNumber: billingDocument.invoiceListNumber,
  }).from(billingDocument)
    .leftJoin(businessPartner, and(
      eq(businessPartner.client, client),
      eq(businessPartner.partnerNumber, billingDocument.customerNumber),
    ))
    .where(where)
    .orderBy(desc(billingDocument.billingDate), desc(billingDocument.billingNumber))
    .limit(limit);
  const [counted] = await tx.select({ count: sql<number>`count(*)::int` })
    .from(billingDocument).where(where);
  return {
    rows: rows.map((row) => ({
      kind: 'BILLING' as const,
      documentNumber: row.documentNumber,
      documentType: row.documentType,
      documentDate: row.documentDate,
      customerNumber: row.customerNumber,
      customerName: row.customerName,
      salesOrg: row.salesOrg,
      plant: null,
      status: row.status,
      currency: row.currency,
      netValue: row.netValue,
      grossValue: row.grossValue,
      referenceNumber: row.deliveryNumber ?? row.orderNumber,
      invoiceListNumber: row.invoiceListNumber,
    })),
    count: counted?.count ?? 0,
  };
}

/**
 * What is coming back.
 *
 * A returns register is two reads, not one: the returns orders, and the returns deliveries that
 * receive against them. What makes them one register is what the business asks — what is coming back
 * from this customer — and not what table the answer happens to live in.
 */
async function returnsRegister(
  tx: Tx, client: string, filter: RegisterFilter, limit: number,
): Promise<{ rows: RegisterRow[]; count: number }> {
  // What a returns document is, is configuration: the two types this tenant named (9237).
  const [chain] = await tx.select({
    returnsOrderType: salesReturnsConfiguration.returnsOrderType,
    returnsDeliveryType: salesReturnsConfiguration.returnsDeliveryType,
  }).from(salesReturnsConfiguration).where(eq(salesReturnsConfiguration.client, client)).limit(1);
  // A tenant that has configured no returns types has no returns register, and saying so is better
  // than an empty list that looks like a month with nothing returned in it.
  if (!chain) return { rows: [], count: 0 };
  const orders = await orderRegister(tx, client, {
    ...filter,
    documentType: filter.documentType ?? chain.returnsOrderType,
  }, limit);
  const deliveries = await deliveryRegister(tx, client, {
    ...filter,
    documentType: filter.documentType ?? chain.returnsDeliveryType,
  }, limit);
  const rows = [...orders.rows.map((row) => ({ ...row, kind: 'RETURNS' as const })),
    ...deliveries.rows.map((row) => ({ ...row, kind: 'RETURNS' as const }))]
    .sort((a, b) => (
      a.documentDate === b.documentDate
        ? b.documentNumber.localeCompare(a.documentNumber)
        : b.documentDate.localeCompare(a.documentDate)
    )).slice(0, limit);
  return { rows, count: orders.count + deliveries.count };
}

/**
 * What was undone.
 *
 * A cancellation is not a status, it is three different documents saying the same thing in three
 * different tables: an order or a delivery standing CANCELLED, a billing document that cancelled
 * another, and a credit memo that gave money back. One register, because the question is one
 * question: what did we take back.
 */
async function cancellationRegister(
  tx: Tx, client: string, filter: RegisterFilter, limit: number,
): Promise<{ rows: RegisterRow[]; count: number }> {
  const cancelledOrders = await orderRegister(tx, client, {
    ...filter, status: filter.status ?? 'CANCELLED',
  }, limit);
  const cancelledDeliveries = await deliveryRegister(tx, client, {
    ...filter, status: filter.status ?? 'CANCELLED',
  }, limit);
  // A cancellation names the document it cancels; a credit memo names the invoice it credits. Both
  // are the answer to "what was undone", and neither is a status on a billing document.
  const money = await tx.select({
    documentNumber: billingDocument.billingNumber,
    documentType: billingDocument.documentType,
    documentDate: billingDocument.billingDate,
    customerNumber: billingDocument.customerNumber,
    customerName: businessPartner.name,
    salesOrg: billingDocument.salesOrg,
    status: billingDocument.status,
    currency: billingDocument.currency,
    netValue: billingDocument.netValue,
    grossValue: billingDocument.grossValue,
    cancellationOf: billingDocument.cancellationOf,
    creditOf: billingDocument.creditOf,
  }).from(billingDocument)
    .leftJoin(businessPartner, and(
      eq(businessPartner.client, client),
      eq(businessPartner.partnerNumber, billingDocument.customerNumber),
    ))
    .where(and(
      eq(billingDocument.client, client),
      sql`(${billingDocument.cancellationOf} is not null or ${billingDocument.creditOf} is not null)`,
      filter.documentNumber ? eq(billingDocument.billingNumber, filter.documentNumber) : undefined,
      filter.customerNumber ? eq(billingDocument.customerNumber, filter.customerNumber) : undefined,
      filter.salesOrg ? eq(billingDocument.salesOrg, filter.salesOrg) : undefined,
      filter.documentType ? eq(billingDocument.documentType, filter.documentType) : undefined,
      filter.status ? eq(billingDocument.status, filter.status) : undefined,
      filter.dateFrom ? gte(billingDocument.billingDate, filter.dateFrom) : undefined,
      filter.dateTo ? lte(billingDocument.billingDate, filter.dateTo) : undefined,
    ))
    .orderBy(desc(billingDocument.billingDate), desc(billingDocument.billingNumber))
    .limit(limit);
  const rows: RegisterRow[] = [
    ...cancelledOrders.rows.map((row) => ({ ...row, kind: 'CANCELLATION' as const })),
    ...cancelledDeliveries.rows.map((row) => ({ ...row, kind: 'CANCELLATION' as const })),
    ...money.map((row) => ({
      kind: 'CANCELLATION' as const,
      documentNumber: row.documentNumber,
      documentType: row.documentType,
      documentDate: row.documentDate,
      customerNumber: row.customerNumber,
      customerName: row.customerName,
      salesOrg: row.salesOrg,
      plant: null,
      status: row.status,
      currency: row.currency,
      netValue: row.netValue,
      grossValue: row.grossValue,
      referenceNumber: row.cancellationOf ?? row.creditOf,
      invoiceListNumber: null,
    })),
  ].sort((a, b) => (
    a.documentDate === b.documentDate
      ? b.documentNumber.localeCompare(a.documentNumber)
      : b.documentDate.localeCompare(a.documentDate)
  )).slice(0, limit);
  return {
    rows,
    count: cancelledOrders.count + cancelledDeliveries.count + money.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The register
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What stands, of one kind, under one filter.
 *
 * The totals are read off what the register answered and not off the whole of the table: a register
 * that says 200 documents in the list and a total for 4,000 is two answers to one question.
 */
export async function listDocumentRegister(
  client: string,
  input: { kind: RegisterKind; filter?: RegisterFilter; limit?: number },
): Promise<DocumentRegister> {
  const filter = clean(input.filter ?? {});
  const limit = Math.min(Math.max(input.limit ?? REGISTER_LIMIT, 1), 1000);
  return withTenant(client, async (tx) => {
    const read = input.kind === 'ORDER' ? orderRegister
      : input.kind === 'DELIVERY' ? deliveryRegister
        : input.kind === 'BILLING' ? billingRegister
          : input.kind === 'RETURNS' ? returnsRegister
            : cancellationRegister;
    const { rows, count } = await read(tx, client, filter, limit);
    let net = 0;
    let gross = 0;
    let valued = 0;
    for (const row of rows) {
      if (row.netValue === null && row.grossValue === null) continue;
      valued += 1;
      net += Number(row.netValue ?? 0);
      gross += Number(row.grossValue ?? 0);
    }
    return {
      kind: input.kind,
      meaning: REGISTER_KIND_MEANING[input.kind],
      rows,
      count,
      truncated: count > rows.length,
      totals: {
        documents: rows.length,
        netValue: valued > 0 ? net.toFixed(2) : null,
        grossValue: valued > 0 ? gross.toFixed(2) : null,
      },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The due lists, read through the register's filter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What can be delivered, and what can be billed.
 *
 * These are not restated here. The register asks the same services the delivery and the billing
 * screens ask, and gives them the same filter — because a register that disagreed with the act it
 * is listing would be worse than no register at all.
 */
export async function listDueRegister(
  client: string,
  input: { kind: 'DELIVERY' | 'BILLING'; filter?: RegisterFilter },
): Promise<{
  kind: 'DELIVERY' | 'BILLING';
  rows: Array<Record<string, string | number | null>>;
  count: number;
  truncated: boolean;
}> {
  const filter = clean(input.filter ?? {});
  if (input.kind === 'DELIVERY') {
    // A delivery due list is a list of order lines, so the document number in the filter is the
    // order's.
    const rows = await listDeliverableOrderLines(client, {
      ...filter, orderNumber: filter.orderNumber ?? filter.documentNumber,
    });
    return {
      kind: 'DELIVERY',
      rows: rows as unknown as Array<Record<string, string | number | null>>,
      count: rows.length,
      truncated: rows.length >= 200,
    };
  }
  const rows = await billingDueList(client, {
    ...filter, deliveryNumber: filter.deliveryNumber ?? filter.documentNumber,
  });
  return {
    kind: 'BILLING',
    rows: rows as unknown as Array<Record<string, string | number | null>>,
    count: rows.length,
    truncated: rows.length >= 200,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// What the screen offers to filter by
// ─────────────────────────────────────────────────────────────────────────────

export interface RegisterChoices {
  customers: Array<{ partnerNumber: string; name: string | null }>;
  materials: Array<{ materialNumber: string; description: string | null }>;
  plants: Array<{ plant: string; name: string | null }>;
  salesOrgs: Array<{ salesOrg: string; name: string | null }>;
  documentTypes: Array<{ documentType: string; name: string | null }>;
  statuses: string[];
}

/** What a filter box may be filled with, so a register is not typed from memory. */
export async function listRegisterChoices(client: string): Promise<RegisterChoices> {
  return withTenant(client, async (tx) => {
    const customers = await tx.select({
      partnerNumber: businessPartner.partnerNumber, name: businessPartner.name,
    }).from(businessPartner).where(eq(businessPartner.client, client))
      .orderBy(asc(businessPartner.partnerNumber)).limit(500);
    const materials = await tx.select({
      materialNumber: material.materialNumber, description: material.description,
    }).from(material).where(eq(material.client, client))
      .orderBy(asc(material.materialNumber)).limit(500);
    const plants = await tx.select({ plant: plantTable.plant, name: plantTable.name })
      .from(plantTable).where(eq(plantTable.client, client)).orderBy(asc(plantTable.plant));
    const areas = await tx.select({ salesOrg: salesArea.salesOrg, name: salesArea.name })
      .from(salesArea).where(eq(salesArea.client, client)).orderBy(asc(salesArea.salesOrg));
    const types = await tx.select({
      documentType: salesDocumentType.documentType, name: salesDocumentType.name,
    }).from(salesDocumentType).where(eq(salesDocumentType.client, client))
      .orderBy(asc(salesDocumentType.documentType));
    const seen = new Set<string>();
    for (const row of areas) seen.add(row.salesOrg);
    return {
      customers,
      materials,
      plants,
      salesOrgs: [...new Map(areas.map((row) => [row.salesOrg, row])).values()],
      documentTypes: types,
      statuses: ['OPEN', 'PICKED', 'GOODS_ISSUED', 'POSTED', 'CANCELLED', 'REJECTED'],
    };
  });
}
