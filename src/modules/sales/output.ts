/**
 * Sales output — the document the customer receives (§4.4, audit gap C7).
 *
 * Everything else in Sales is a document the company keeps. This is the one it hands over: an order
 * confirmation that says what was promised, a delivery note that travels with the goods, an invoice
 * that asks for the money. Until this increment the package could show any of them on a screen and
 * send none of them anywhere, which is the gap the audit names.
 *
 * Output determination is the condition technique applied to documents, and that is the half the
 * package never had. Inventory's engine (SCR-135) decided by one test — the direction a material
 * document's lines move in — and deferred "condition technology beyond direction" by name. A sales
 * invoice cannot be decided that way: who receives it, by which channel and when is a decision a
 * company makes per customer, not a property of the document. So there is an **access sequence**, and
 * it is read most specific first:
 *
 *   1. sales area + document type + customer
 *   2. sales area + document type
 *   3. sales area
 *   4. sales organisation
 *   5. general (no sales area at all)
 *
 * Blank means *any* and is a value that is matched, never an absence — which is why nothing here is
 * nullable. The first record that stands on the document's own date answers, and it carries what SAP's
 * NAST carries beside the output type: the **medium** (print or e-mail), the **dispatch time** and the
 * **partner function that receives it** — an invoice addressed to the bill-to and one addressed to the
 * payer are two different decisions.
 *
 * And the rule that makes it a decision rather than a decoration: **no condition record, no output.**
 * A document the company has not configured an output for earns none, rather than a plausible one
 * nobody asked for. The three output types are delivered — BA00, LD00 and RD00; SAP's own names — and
 * no records are, because who gets what is a tenant's act.
 *
 * Determination runs **inside the transaction that wrote the document**, as the material document does,
 * so a document never stands with its output missing because the process died in between. Dispatch
 * renders the document and **stores the rendering on the message**: a copy asked for a year later is
 * the document as it went out, not a fresh reading of masters that have since moved.
 *
 * An output is issued **once**. A second dispatch is refused, and issuing again writes a new message
 * with the next issue number and a reason — because "we sent it twice" and "here is both" are only
 * answerable if the first still stands as it was sent.
 *
 * Refused by name: FAX and EDI (no endpoint exists). Deferred by name: spool files, transport and the
 * mail server — a message that reaches PROCESSED says the document was rendered and handed to a
 * channel, not that a printer printed it.
 */
import { z } from 'zod';
import { type SQL, and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { businessPartner } from '../foundation/business-partner-schema';
import {
  outputConditionRecord, outputMessage, outputType,
} from '../foundation/output-schema';
import { material } from '../inventory/schema';
import { type DocumentPartners, documentPartners } from './partners';
import {
  billingDocument, billingDocumentLine, delivery, deliveryLine, salesOrder, salesOrderLine,
} from './schema';

export const SALES_OUTPUT_ROUTE = '/sales/output';
/** Sending a document to somebody outside the company. */
export const SALES_OUTPUT_CAPABILITY = 'SALES.OUTPUT.PROCESS';
/** Deciding what a customer receives at all. */
export const SALES_OUTPUT_ADMIN_CAPABILITY = 'SALES.OUTPUT.ADMIN';

export const SALES_OUTPUT_OBJECT_CLASS = 'output_message';
export const OUTPUT_CONDITION_OBJECT_CLASS = 'output_condition_record';

/** The documents sales sends something for. */
export const SALES_OUTPUT_CATEGORIES = ['SALES_ORDER', 'DELIVERY', 'BILLING'] as const;
export type SalesOutputCategory = (typeof SALES_OUTPUT_CATEGORIES)[number];

/**
 * The output types delivered with the package: SAP's own names. They are delivered to every client
 * because a condition record points at one, and a record naming a type that does not exist would be a
 * decision referencing nothing. What is *not* delivered is any record: who receives what is a tenant's
 * act, and no record means no output.
 */
export const DELIVERED_SALES_OUTPUT_TYPES = [
  { outputType: 'BA00', description: 'Order confirmation' },
  { outputType: 'LD00', description: 'Delivery note' },
  { outputType: 'RD00', description: 'Invoice' },
] as const;

/** Which of the delivered types a document earns by default, absent a record saying otherwise. */
export const CATEGORY_OUTPUT_TYPE: Record<SalesOutputCategory, string> = {
  SALES_ORDER: 'BA00', DELIVERY: 'LD00', BILLING: 'RD00',
};

export class SalesOutputError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'SalesOutputError';
    this.remedy = remedy;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLIENT_KEY = /^[A-Za-z0-9]{2,4}$/;

const DEFAULT_MAX_HITS = 200;
const MAX_HITS_CAP = 1000;

function money(value: number | string): string {
  const asNumber = typeof value === 'number' ? value : Number(value);
  return (Math.round((asNumber + Number.EPSILON) * 100) / 100).toFixed(2);
}

function trimQuantity(value: string): string {
  const asNumber = Number(value);
  if (!Number.isFinite(asNumber)) return value;
  return String(Math.round(asNumber * 1000) / 1000);
}

/* ─── Inputs ─────────────────────────────────────────────────────────────────────────────────── */

const conditionInput = z.object({
  client: z.string().regex(CLIENT_KEY, 'The client key is two to four characters.'),
  outputType: z.string().trim().min(2).max(4).toUpperCase(),
  /** Blank means the record answers for any document category. */
  documentCategory: z.enum(SALES_OUTPUT_CATEGORIES).or(z.literal('')).default(''),
  /** Blank means any sales document type. */
  documentType: z.string().trim().max(2).toUpperCase().default(''),
  salesOrg: z.string().trim().max(4).toUpperCase().default(''),
  distributionChannel: z.string().trim().max(2).toUpperCase().default(''),
  division: z.string().trim().max(2).toUpperCase().default(''),
  customerNumber: z.string().trim().max(40).toUpperCase().default(''),
  transmissionMedium: z.enum(['PRINT', 'EMAIL']).default('PRINT'),
  dispatchTime: z.enum(['IMMEDIATE', 'PERIODIC']).default('IMMEDIATE'),
  partnerFunction: z.enum(['SP', 'SH', 'BP', 'PY']).default('BP'),
  printerQueue: z.string().trim().max(30).optional(),
  validityFrom: z.string().regex(ISO_DATE, 'Use a date, as YYYY-MM-DD.'),
  validityTo: z.string().regex(ISO_DATE, 'Use a date, as YYYY-MM-DD.'),
  isActive: z.boolean().default(true),
  changedBy: z.string().trim().min(1).max(60),
});
export type SaveOutputConditionInput = z.input<typeof conditionInput>;

const dispatchInput = z.object({
  client: z.string().regex(CLIENT_KEY),
  changedBy: z.string().trim().min(1).max(60),
  documentCategory: z.enum(SALES_OUTPUT_CATEGORIES),
  documentNumber: z.string().trim().min(1).max(20),
  outputType: z.string().trim().min(2).max(4).toUpperCase(),
  transmissionMedium: z.enum(['PRINT', 'EMAIL']),
  /** Which issue. Absent means the standing one, which is the only issue a document normally has. */
  issueNumber: z.coerce.number().int().positive().optional(),
});
export type DispatchSalesOutputInput = z.input<typeof dispatchInput>;

const reissueInput = dispatchInput.omit({ issueNumber: true }).extend({
  /** Why a second copy is being sent. A copy without a reason answers nothing when asked. */
  reason: z.string().trim().min(1).max(200),
});
export type ReissueSalesOutputInput = z.input<typeof reissueInput>;

/* ─── The access sequence ────────────────────────────────────────────────────────────────────── */

/**
 * The fields of a document a record may be narrowed by, in the order the accesses give them up. Each
 * access holds the ones it insists on and requires every other to be blank, so a record can never be
 * half-specific: a sales area with no division and a customer with no sales area are not record the
 * access sequence can reach, and a unique key over the whole combination keeps two of them from
 * standing side by side.
 */
const ACCESS_FIELDS = [
  'salesOrg', 'distributionChannel', 'division', 'documentType', 'customerNumber',
] as const;
type AccessField = (typeof ACCESS_FIELDS)[number];

const ACCESS_SEQUENCE: ReadonlyArray<{ access: number; name: string; holds: readonly AccessField[] }> = [
  { access: 1, name: 'Sales area, document type and customer', holds: ACCESS_FIELDS },
  { access: 2, name: 'Sales area and document type', holds: ['salesOrg', 'distributionChannel', 'division', 'documentType'] },
  { access: 3, name: 'Sales area', holds: ['salesOrg', 'distributionChannel', 'division'] },
  { access: 4, name: 'Sales organisation', holds: ['salesOrg'] },
  { access: 5, name: 'General', holds: [] },
];

export const ACCESS_SEQUENCE_VIEW = ACCESS_SEQUENCE.map((entry) => ({
  access: entry.access,
  name: entry.name,
  holds: [...entry.holds],
}));

/** What a document brings to the access sequence. */
interface OutputKey {
  salesOrg: string;
  distributionChannel: string;
  division: string;
  documentType: string;
  customerNumber: string;
}

type ConditionRow = typeof outputConditionRecord.$inferSelect;

/** Whether a record stands at this access for this document. */
function standsAt(row: ConditionRow, access: readonly AccessField[], key: OutputKey): boolean {
  for (const field of ACCESS_FIELDS) {
    const value = row[field] ?? '';
    if (access.includes(field)) {
      if (value !== key[field]) return false;
    } else if (value !== '') {
      return false;
    }
  }
  return true;
}

export interface OutputDetermination {
  access: number;
  accessName: string;
  conditionNumber: string;
  outputType: string;
  transmissionMedium: string;
  dispatchTime: string;
  partnerFunction: string;
  printerQueue: string | null;
}

/** The first record that answers, most specific first. Null where no record stands. */
function determineWith(rows: ConditionRow[], key: OutputKey): OutputDetermination | null {
  for (const entry of ACCESS_SEQUENCE) {
    const hit = rows.find((row) => standsAt(row, entry.holds, key));
    if (!hit) continue;
    return {
      access: entry.access,
      accessName: entry.name,
      conditionNumber: hit.conditionNumber,
      outputType: hit.outputType,
      transmissionMedium: hit.transmissionMedium,
      dispatchTime: hit.dispatchTime,
      partnerFunction: hit.partnerFunction,
      printerQueue: hit.printerQueue,
    };
  }
  return null;
}

/* ─── What a document is ─────────────────────────────────────────────────────────────────────── */

export interface OutputDocumentFacts extends OutputKey {
  documentNumber: string;
  documentDate: string;
  documentYear: number;
  currency: string;
  netValue: string;
  taxValue: string;
  grossValue: string;
}

/**
 * Read a document as output determination needs it: the sales area it belongs to, the type it is, the
 * customer it was made with, and the day it bears — because a record answers for the day and not for
 * today.
 */
async function documentFacts(
  tx: Tx, client: string, category: SalesOutputCategory, documentNumber: string,
): Promise<OutputDocumentFacts | null> {
  const common = (row: {
    salesOrg: string; distributionChannel: string; division: string; documentType: string;
    customerNumber: string;
  }) => ({
    documentNumber,
    salesOrg: row.salesOrg,
    distributionChannel: row.distributionChannel,
    division: row.division,
    documentType: row.documentType,
    customerNumber: row.customerNumber,
  });

  if (category === 'SALES_ORDER') {
    const [row] = await tx.select().from(salesOrder).where(and(
      eq(salesOrder.client, client), eq(salesOrder.orderNumber, documentNumber),
    )).limit(1);
    if (!row) return null;
    return {
      ...common(row), documentDate: row.orderDate,
      documentYear: Number(row.orderDate.slice(0, 4)),
      currency: row.currency, netValue: row.netValue, taxValue: row.taxValue, grossValue: row.grossValue,
    };
  }
  if (category === 'DELIVERY') {
    const [row] = await tx.select().from(delivery).where(and(
      eq(delivery.client, client), eq(delivery.deliveryNumber, documentNumber),
    )).limit(1);
    if (!row) return null;
    // A delivery carries no value of its own: the goods it moved are priced by the order, and the
    // note that travels with them says what went out, not what it is worth.
    const [order] = await tx.select({ currency: salesOrder.currency }).from(salesOrder).where(and(
      eq(salesOrder.client, client), eq(salesOrder.orderNumber, row.orderNumber),
    )).limit(1);
    return {
      ...common(row), documentDate: row.deliveryDate,
      documentYear: Number(row.deliveryDate.slice(0, 4)),
      currency: order?.currency ?? '', netValue: '0', taxValue: '0', grossValue: '0',
    };
  }
  const [row] = await tx.select().from(billingDocument).where(and(
    eq(billingDocument.client, client), eq(billingDocument.billingNumber, documentNumber),
  )).limit(1);
  if (!row) return null;
  return {
    ...common(row), documentDate: row.billingDate,
    documentYear: Number(row.billingDate.slice(0, 4)),
    currency: row.currency, netValue: row.netValue, taxValue: row.taxValue, grossValue: row.grossValue,
  };
}

/** The partner a record's partner function names, falling back as the document's own partners do. */
function partnerFor(partners: DocumentPartners | null, functionCode: string, fallback: string): string {
  if (!partners) return fallback;
  if (functionCode === 'SP') return partners.soldTo;
  if (functionCode === 'SH') return partners.shipTo;
  if (functionCode === 'PY') return partners.payer;
  return partners.billTo;
}

/** The e-mail address of a partner, as the master stands it. Null where the master carries none. */
async function emailOf(tx: Tx, client: string, partnerNumber: string): Promise<string | null> {
  const [row] = await tx.select({ email: businessPartner.email }).from(businessPartner).where(and(
    eq(businessPartner.client, client), eq(businessPartner.partnerNumber, partnerNumber),
  )).limit(1);
  const email = (row?.email ?? '').trim();
  return email.length > 0 ? email.slice(0, 50) : null;
}

/* ─── Determination ──────────────────────────────────────────────────────────────────────────── */

/** Make sure the delivered sales output types stand, so a record has something to point at. */
async function ensureSalesOutputTypes(tx: Tx, client: string, changedBy: string): Promise<void> {
  for (const delivered of DELIVERED_SALES_OUTPUT_TYPES) {
    await tx.insert(outputType).values({
      client,
      outputType: delivered.outputType,
      description: delivered.description,
      application: 'SD',
      direction: 'ANY',
      transmissionMedium: 'PRINT',
      dispatchTime: 'IMMEDIATE',
      isActive: true,
      createdBy: changedBy,
    }).onConflictDoNothing();
  }
}

/**
 * The records that may answer for a document: this client's, this application's, active, and standing
 * on the day the document bears.
 */
async function recordsFor(
  tx: Tx, client: string, category: SalesOutputCategory, documentDate: string,
): Promise<ConditionRow[]> {
  return tx.select().from(outputConditionRecord).where(and(
    eq(outputConditionRecord.client, client),
    eq(outputConditionRecord.application, 'SD'),
    eq(outputConditionRecord.isActive, true),
    lte(outputConditionRecord.validityFrom, documentDate),
    gte(outputConditionRecord.validityTo, documentDate),
    // A record narrowed to another document's category does not answer here; a blank one answers for
    // all three.
    sql`(${outputConditionRecord.documentCategory} = '' or ${outputConditionRecord.documentCategory} = ${category})`,
  ));
}

/**
 * Determine what a document earns and write the messages that stand missing.
 *
 * Called inside the transaction that wrote the document, so a document and its outputs are written
 * together or not at all — a document never stands with its confirmation missing because the process
 * died between the two writes.
 *
 * **No record, no output.** A document nobody configured an output for earns none.
 */
export async function determineSalesOutputs(tx: Tx, input: {
  client: string; changedBy: string;
  documentCategory: SalesOutputCategory; documentNumber: string;
}): Promise<{ created: number; determined: OutputDetermination[] }> {
  const facts = await documentFacts(tx, input.client, input.documentCategory, input.documentNumber);
  if (!facts) {
    throw new SalesOutputError(
      `${input.documentCategory} ${input.documentNumber} does not stand.`,
      'Only a document that exists earns an output.',
    );
  }

  await ensureSalesOutputTypes(tx, input.client, input.changedBy);
  const records = await recordsFor(tx, input.client, input.documentCategory, facts.documentDate);
  if (records.length === 0) return { created: 0, determined: [] };

  const partners = await documentPartners(
    tx, input.client,
    input.documentCategory === 'SALES_ORDER' ? 'ORDER'
      : input.documentCategory === 'DELIVERY' ? 'DELIVERY' : 'BILLING',
    input.documentNumber,
  );

  const types = await tx.select().from(outputType).where(and(
    eq(outputType.client, input.client),
    eq(outputType.application, 'SD'),
    eq(outputType.isActive, true),
  ));

  const determined: OutputDetermination[] = [];
  let created = 0;
  for (const type of types) {
    const decision = determineWith(
      records.filter((row) => row.outputType === type.outputType),
      {
        salesOrg: facts.salesOrg, distributionChannel: facts.distributionChannel,
        division: facts.division, documentType: facts.documentType,
        customerNumber: facts.customerNumber,
      },
    );
    if (!decision) continue;
    determined.push(decision);

    const recipient = decision.transmissionMedium === 'EMAIL'
      ? await emailOf(
        tx, input.client,
        partnerFor(partners, decision.partnerFunction, facts.customerNumber),
      )
      : null;

    const inserted = await tx.insert(outputMessage).values({
      client: input.client,
      documentCategory: input.documentCategory,
      documentNumber: input.documentNumber,
      documentYear: facts.documentYear,
      outputType: type.outputType,
      transmissionMedium: decision.transmissionMedium,
      dispatchTime: decision.dispatchTime,
      issueNumber: 1,
      status: 'PENDING',
      sendCount: 0,
      recipient,
      printerQueue: decision.printerQueue,
      createdBy: input.changedBy,
    }).onConflictDoNothing().returning({ outputType: outputMessage.outputType });
    created += inserted.length;
  }
  return { created, determined };
}

/**
 * The posting hook: determine a document's outputs and dispatch the immediate ones, inside the
 * caller's transaction. Returns the number of messages written.
 */
export async function recordSalesOutputs(tx: Tx, input: {
  client: string; changedBy: string;
  documentCategory: SalesOutputCategory; documentNumber: string;
}): Promise<number> {
  const { created } = await determineSalesOutputs(tx, input);
  await dispatchImmediateInTx(tx, input.client, input.changedBy, input.documentCategory, input.documentNumber);
  return created;
}

/** The primary key of one message, as a clause: category, document, type, medium and issue. */
function messageKey(client: string, message: typeof outputMessage.$inferSelect) {
  return and(
    eq(outputMessage.client, client),
    eq(outputMessage.documentCategory, message.documentCategory),
    eq(outputMessage.documentNumber, message.documentNumber),
    eq(outputMessage.outputType, message.outputType),
    eq(outputMessage.transmissionMedium, message.transmissionMedium),
    eq(outputMessage.issueNumber, message.issueNumber),
  );
}

/** Why an e-mail nobody is addressed to cannot be sent. The message records it in these words. */
const NO_RECIPIENT = 'An EMAIL output needs a recipient, and the partner it is addressed to carries no e-mail address.';

interface DispatchOutcome {
  status: 'PROCESSED' | 'ERROR';
  sendCount: number;
  errorText: string | null;
  rendered: string | null;
}

/**
 * The one author of what dispatch does.
 *
 * Both paths come through here — the immediate dispatch that runs inside the transaction writing the
 * document, and the deliberate dispatch of one message from the screen — because two authors of the
 * same rule is how a rule becomes two rules. An EMAIL with nobody to send it to fails for real and
 * records why, rather than standing as though it were merely waiting: a missing address is not a
 * transient fault, and leaving it PENDING would say that it is.
 */
async function dispatchInTx(
  tx: Tx, client: string, changedBy: string, message: typeof outputMessage.$inferSelect,
): Promise<DispatchOutcome> {
  const now = new Date();
  if (message.transmissionMedium === 'EMAIL' && !message.recipient) {
    await tx.update(outputMessage).set({
      status: 'ERROR',
      errorText: NO_RECIPIENT,
      lastProcessedAt: now,
      changedBy, changedAt: now,
    }).where(messageKey(client, message));
    return { status: 'ERROR', sendCount: message.sendCount, errorText: NO_RECIPIENT, rendered: null };
  }

  // Rendered here and not on another connection: the posting path dispatches before it commits, and a
  // separate connection would not see a document that does not exist yet. What is stored is what was
  // handed to the channel.
  const rendered = await renderSalesDocument(
    tx, client, message.documentCategory as SalesOutputCategory, message.documentNumber,
  );
  const sendCount = message.sendCount + 1;
  await tx.update(outputMessage).set({
    status: 'PROCESSED',
    sendCount,
    lastProcessedAt: now,
    errorText: null,
    renderedDocument: rendered,
    changedBy, changedAt: now,
  }).where(messageKey(client, message));
  return { status: 'PROCESSED', sendCount, errorText: null, rendered };
}

/** Dispatch this document's PENDING immediate messages, in the transaction that wrote it. */
async function dispatchImmediateInTx(
  tx: Tx, client: string, changedBy: string,
  documentCategory: SalesOutputCategory, documentNumber: string,
): Promise<void> {
  const due = await tx.select().from(outputMessage).where(and(
    eq(outputMessage.client, client),
    eq(outputMessage.documentCategory, documentCategory),
    eq(outputMessage.documentNumber, documentNumber),
    eq(outputMessage.status, 'PENDING'),
    eq(outputMessage.dispatchTime, 'IMMEDIATE'),
  ));
  for (const message of due) {
    await dispatchInTx(tx, client, changedBy, message);
  }
}

/* ─── Rendering ──────────────────────────────────────────────────────────────────────────────── */

const RULE = '='.repeat(78);
const THIN = '-'.repeat(78);

function pad(value: string, width: number): string {
  return value.length > width ? value.slice(0, width) : value.padEnd(width, ' ');
}

function padStart(value: string, width: number): string {
  return value.length > width ? value.slice(0, width) : value.padStart(width, ' ');
}

async function descriptionsOf(tx: Tx, client: string, numbers: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (numbers.length === 0) return map;
  const rows = await tx.select({
    materialNumber: material.materialNumber, description: material.description,
  }).from(material).where(and(
    eq(material.client, client), inArray(material.materialNumber, numbers),
  ));
  for (const row of rows) if (row.description) map.set(row.materialNumber, row.description);
  return map;
}

async function addressBlock(
  tx: Tx, client: string, partnerNumber: string, label: string,
): Promise<string[]> {
  const [row] = await tx.select({
    name: businessPartner.name, street: businessPartner.street, city: businessPartner.city,
    region: businessPartner.region, postalCode: businessPartner.postalCode,
    country: businessPartner.country,
  }).from(businessPartner).where(and(
    eq(businessPartner.client, client), eq(businessPartner.partnerNumber, partnerNumber),
  )).limit(1);
  const lines = [`${pad(label, 10)}${pad(partnerNumber, 12)}${row?.name ?? ''}`];
  const place = [row?.street, row?.city, row?.region, row?.postalCode, row?.country]
    .filter((part) => part && String(part).trim().length > 0).join(', ');
  if (place) lines.push(`${pad('', 10)}${place}`);
  return lines;
}

function totalsBlock(currency: string, net: string, tax: string, gross: string): string[] {
  return [
    THIN,
    `${padStart('Net value', 58)}${padStart(money(net), 10)} ${currency}`,
    `${padStart('Tax', 58)}${padStart(money(tax), 10)} ${currency}`,
    `${padStart('Gross value', 58)}${padStart(money(gross), 10)} ${currency}`,
  ];
}

/** Render an order confirmation: what was promised, to whom, and for how much. */
async function renderOrder(
  tx: Tx, client: string, documentNumber: string,
): Promise<string> {
  const [header] = await tx.select().from(salesOrder).where(and(
    eq(salesOrder.client, client), eq(salesOrder.orderNumber, documentNumber),
  )).limit(1);
  if (!header) throw new SalesOutputError(`Sales order ${documentNumber} does not stand.`);
  const lines = await tx.select().from(salesOrderLine).where(and(
    eq(salesOrderLine.client, client), eq(salesOrderLine.orderNumber, documentNumber),
  )).orderBy(asc(salesOrderLine.lineNumber));
  const descriptions = await descriptionsOf(tx, client, [...new Set(lines.map((l) => l.materialNumber))]);
  const partners = await documentPartners(tx, client, 'ORDER', documentNumber);

  const out: string[] = [RULE, padStart('ORDER CONFIRMATION', 50), RULE];
  out.push(`${pad('Order', 20)}${pad(documentNumber, 22)}${pad('Date', 12)}${header.orderDate}`);
  out.push(`${pad('Document type', 20)}${pad(header.documentType, 22)}${pad('Currency', 12)}${header.currency}`);
  out.push(`${pad('Sales area', 20)}${pad(`${header.salesOrg}/${header.distributionChannel}/${header.division}`, 22)}${pad('Requested', 12)}${header.requestedDate ?? '—'}`);
  if (header.purchaseOrderReference) {
    out.push(`${pad('Your reference', 20)}${header.purchaseOrderReference}`);
  }
  if (header.headerText) out.push(`${pad('Text', 20)}${header.headerText}`);
  out.push(THIN);
  out.push(...await addressBlock(tx, client, partners?.soldTo ?? header.customerNumber, 'Sold-to'));
  out.push(...await addressBlock(tx, client, partners?.billTo ?? header.customerNumber, 'Bill-to'));
  out.push(...await addressBlock(tx, client, partners?.shipTo ?? header.customerNumber, 'Ship-to'));
  out.push(THIN);
  out.push(`${padStart('It', 2)} ${pad('Material', 26)}${padStart('Quantity', 10)} ${pad('', 6)}${padStart('Price', 12)}${padStart('Amount', 12)}`);
  for (const line of lines) {
    out.push([
      padStart(String(line.lineNumber), 2),
      pad(`${line.materialNumber} ${descriptions.get(line.materialNumber) ?? ''}`.trim(), 26),
      padStart(trimQuantity(line.orderQuantity), 10),
      pad(line.quantityUnit, 6),
      padStart(money(line.netPrice), 12),
      padStart(money(line.netAmount), 12),
    ].join(' '));
  }
  out.push(...totalsBlock(header.currency, header.netValue, header.taxValue, header.grossValue));
  out.push(RULE);
  return out.join('\n');
}

/** Render a delivery note: what went out, and where it went. */
async function renderDelivery(
  tx: Tx, client: string, documentNumber: string,
): Promise<string> {
  const [header] = await tx.select().from(delivery).where(and(
    eq(delivery.client, client), eq(delivery.deliveryNumber, documentNumber),
  )).limit(1);
  if (!header) throw new SalesOutputError(`Delivery ${documentNumber} does not stand.`);
  const lines = await tx.select().from(deliveryLine).where(and(
    eq(deliveryLine.client, client), eq(deliveryLine.deliveryNumber, documentNumber),
  )).orderBy(asc(deliveryLine.lineNumber));
  const descriptions = await descriptionsOf(tx, client, [...new Set(lines.map((l) => l.materialNumber))]);
  const partners = await documentPartners(tx, client, 'DELIVERY', documentNumber);

  const out: string[] = [RULE, padStart('DELIVERY NOTE', 50), RULE];
  out.push(`${pad('Delivery', 20)}${pad(documentNumber, 22)}${pad('Date', 12)}${header.deliveryDate}`);
  out.push(`${pad('Order', 20)}${pad(header.orderNumber, 22)}${pad('Plant', 12)}${header.plant}`);
  out.push(`${pad('Shipping point', 20)}${pad(header.shippingPoint ?? '—', 22)}${pad('Goods issue', 12)}${header.goodsMovementDate ?? '—'}`);
  out.push(THIN);
  out.push(...await addressBlock(tx, client, partners?.shipTo ?? header.customerNumber, 'Ship-to'));
  out.push(THIN);
  out.push(`${padStart('It', 2)} ${pad('Material', 30)}${padStart('Quantity', 12)} ${pad('', 6)}`);
  for (const line of lines) {
    out.push([
      padStart(String(line.lineNumber), 2),
      pad(`${line.materialNumber} ${descriptions.get(line.materialNumber) ?? ''}`.trim(), 30),
      padStart(trimQuantity(line.goodsIssueQuantity || line.deliveryQuantity), 12),
      pad(line.quantityUnit, 6),
    ].join(' '));
  }
  out.push(THIN);
  out.push(`Items ${lines.length}`);
  if (header.materialDocumentNumber) {
    out.push(`Material document ${header.materialDocumentNumber} / ${header.materialDocumentYear}`);
  }
  out.push(RULE);
  return out.join('\n');
}

/** Render an invoice: what is owed, by whom, and the accounting document behind it. */
async function renderInvoice(
  tx: Tx, client: string, documentNumber: string,
): Promise<string> {
  const [header] = await tx.select().from(billingDocument).where(and(
    eq(billingDocument.client, client), eq(billingDocument.billingNumber, documentNumber),
  )).limit(1);
  if (!header) throw new SalesOutputError(`Billing document ${documentNumber} does not stand.`);
  const lines = await tx.select().from(billingDocumentLine).where(and(
    eq(billingDocumentLine.client, client), eq(billingDocumentLine.billingNumber, documentNumber),
  )).orderBy(asc(billingDocumentLine.lineNumber));
  const descriptions = await descriptionsOf(tx, client, [...new Set(lines.map((l) => l.materialNumber))]);
  const partners = await documentPartners(tx, client, 'BILLING', documentNumber);

  const out: string[] = [RULE, padStart('INVOICE', 50), RULE];
  out.push(`${pad('Invoice', 20)}${pad(documentNumber, 22)}${pad('Date', 12)}${header.billingDate}`);
  out.push(`${pad('Document type', 20)}${pad(header.documentType, 22)}${pad('Currency', 12)}${header.currency}`);
  if (header.customerInvoiceNumber) {
    out.push(`${pad('Accounting invoice', 20)}${header.customerInvoiceNumber}`);
  }
  if (header.deliveryNumber) out.push(`${pad('Delivery', 20)}${header.deliveryNumber}`);
  out.push(`${pad('Order', 20)}${header.orderNumber}`);
  out.push(THIN);
  out.push(...await addressBlock(tx, client, partners?.billTo ?? header.customerNumber, 'Bill-to'));
  out.push(...await addressBlock(tx, client, partners?.payer ?? header.customerNumber, 'Payer'));
  out.push(THIN);
  out.push(`${padStart('It', 2)} ${pad('Material', 30)}${padStart('Quantity', 12)}${padStart('Price', 12)}${padStart('Amount', 12)}`);
  for (const line of lines) {
    out.push([
      padStart(String(line.lineNumber), 2),
      pad(`${line.materialNumber} ${descriptions.get(line.materialNumber) ?? ''}`.trim(), 30),
      padStart(trimQuantity(line.billingQuantity), 12),
      padStart(money(line.netPrice), 12),
      padStart(money(line.netAmount), 12),
    ].join(' '));
  }
  out.push(...totalsBlock(header.currency, header.netValue, header.taxValue, header.grossValue));
  out.push(RULE);
  return out.join('\n');
}

/**
 * Render the document an output stands for, from what stands — never from input, and never re-derived
 * from a master at print time, because a copy has to be the document the customer received.
 */
export async function renderSalesDocument(
  tx: Tx, client: string, category: SalesOutputCategory, documentNumber: string,
): Promise<string> {
  if (category === 'SALES_ORDER') return renderOrder(tx, client, documentNumber);
  if (category === 'DELIVERY') return renderDelivery(tx, client, documentNumber);
  return renderInvoice(tx, client, documentNumber);
}

/* ─── Dispatch ───────────────────────────────────────────────────────────────────────────────── */

export interface SalesOutputDispatchResult {
  documentCategory: string;
  documentNumber: string;
  outputType: string;
  transmissionMedium: string;
  issueNumber: number;
  status: string;
  sendCount: number;
  recipient: string | null;
  lastProcessedAt: string | null;
  errorText: string | null;
}

/**
 * Dispatch one message: render the document, mark it PROCESSED, count the send and keep what was
 * rendered. Nothing here reaches a printer or a mail server; PROCESSED says the document was rendered
 * and handed to a channel.
 *
 * An EMAIL with nobody to send it to fails for real and records why, rather than succeeding quietly.
 * A message that already stands PROCESSED refuses: a repeat is a new output, which is `reissue`.
 */
export async function dispatchSalesOutput(
  input: DispatchSalesOutputInput,
): Promise<SalesOutputDispatchResult> {
  const parsed = dispatchInput.parse(input);
  return withTenant(parsed.client, async (tx) => {
    const [message] = await tx.select().from(outputMessage).where(and(
      eq(outputMessage.client, parsed.client),
      eq(outputMessage.documentCategory, parsed.documentCategory),
      eq(outputMessage.documentNumber, parsed.documentNumber),
      eq(outputMessage.outputType, parsed.outputType),
      eq(outputMessage.transmissionMedium, parsed.transmissionMedium),
      eq(outputMessage.issueNumber, parsed.issueNumber ?? 1),
    )).limit(1);
    if (!message) {
      throw new SalesOutputError(
        `No ${parsed.outputType} output stands for ${parsed.documentCategory} ${parsed.documentNumber}.`,
        'Determine the outputs first; the run does it for every document in the selection.',
      );
    }
    if (message.status === 'PROCESSED') {
      throw new SalesOutputError(
        `The ${message.outputType} output for ${parsed.documentNumber} (issue ${message.issueNumber}) is already processed.`,
        'Sending it again is a new output: issue a re-issue, which stands beside the first.',
      );
    }

    const outcome = await dispatchInTx(tx, parsed.client, parsed.changedBy, message);

    await recordChange(tx, {
      client: parsed.client, objectClass: SALES_OUTPUT_OBJECT_CLASS,
      objectKey: `${message.documentCategory}/${message.documentNumber}/${message.outputType}/${message.issueNumber}`,
      changeType: 'CHANGE', changedBy: parsed.changedBy,
      before: { status: message.status, sendCount: message.sendCount },
      after: {
        status: outcome.status,
        sendCount: outcome.sendCount,
        recipient: message.recipient ?? '',
        ...(outcome.errorText ? { error: outcome.errorText } : {}),
      },
      fieldLabels: { sendCount: 'Times sent', recipient: 'Recipient' },
    });

    return {
      documentCategory: message.documentCategory,
      documentNumber: message.documentNumber,
      outputType: message.outputType,
      transmissionMedium: message.transmissionMedium,
      issueNumber: message.issueNumber,
      status: outcome.status,
      sendCount: outcome.sendCount,
      recipient: message.recipient,
      lastProcessedAt: new Date().toISOString(),
      errorText: outcome.errorText,
    };
  });
}

/**
 * Issue the same output again.
 *
 * An output is issued once, and a second copy is a second act: it writes a **new message** with the
 * next issue number and the reason it was raised, and the first stays exactly as it was sent — which
 * is what makes "we sent it twice, here is both" answerable. The recipient is resolved again from the
 * partner the record names, because a re-issue sent today goes to the address that stands today.
 */
export async function reissueSalesOutput(
  input: ReissueSalesOutputInput,
): Promise<{ issueNumber: number; message: SalesOutputDispatchResult; determination: OutputDetermination | null }> {
  const parsed = reissueInput.parse(input);
  return withTenant(parsed.client, async (tx) => {
    const facts = await documentFacts(tx, parsed.client, parsed.documentCategory, parsed.documentNumber);
    if (!facts) {
      throw new SalesOutputError(
        `${parsed.documentCategory} ${parsed.documentNumber} does not stand.`,
        'Only a document that exists can be sent again.',
      );
    }
    const standing = await tx.select({ issueNumber: outputMessage.issueNumber }).from(outputMessage).where(and(
      eq(outputMessage.client, parsed.client),
      eq(outputMessage.documentCategory, parsed.documentCategory),
      eq(outputMessage.documentNumber, parsed.documentNumber),
      eq(outputMessage.outputType, parsed.outputType),
      eq(outputMessage.transmissionMedium, parsed.transmissionMedium),
    ));
    if (standing.length === 0) {
      throw new SalesOutputError(
        `No ${parsed.outputType} output has been issued for ${parsed.documentNumber}, so there is nothing to issue again.`,
        'Determine the outputs and dispatch the first issue before asking for a second.',
      );
    }
    const nextIssue = Math.max(...standing.map((row) => row.issueNumber)) + 1;

    const records = await recordsFor(tx, parsed.client, parsed.documentCategory, facts.documentDate);
    const decision = determineWith(
      records.filter((row) => row.outputType === parsed.outputType),
      {
        salesOrg: facts.salesOrg, distributionChannel: facts.distributionChannel,
        division: facts.division, documentType: facts.documentType,
        customerNumber: facts.customerNumber,
      },
    );
    const partners = await documentPartners(
      tx, parsed.client,
      parsed.documentCategory === 'SALES_ORDER' ? 'ORDER'
        : parsed.documentCategory === 'DELIVERY' ? 'DELIVERY' : 'BILLING',
      parsed.documentNumber,
    );
    const recipient = parsed.transmissionMedium === 'EMAIL'
      ? await emailOf(
        tx, parsed.client,
        partnerFor(partners, decision?.partnerFunction ?? 'BP', facts.customerNumber),
      )
      : null;

    await tx.insert(outputMessage).values({
      client: parsed.client,
      documentCategory: parsed.documentCategory,
      documentNumber: parsed.documentNumber,
      documentYear: facts.documentYear,
      outputType: parsed.outputType,
      transmissionMedium: parsed.transmissionMedium,
      dispatchTime: decision?.dispatchTime ?? 'IMMEDIATE',
      issueNumber: nextIssue,
      status: 'PENDING',
      sendCount: 0,
      recipient,
      printerQueue: decision?.printerQueue ?? null,
      reissueReason: parsed.reason,
      createdBy: parsed.changedBy,
    });

    await recordChange(tx, {
      client: parsed.client, objectClass: SALES_OUTPUT_OBJECT_CLASS,
      objectKey: `${parsed.documentCategory}/${parsed.documentNumber}/${parsed.outputType}/${nextIssue}`,
      changeType: 'CREATE', changedBy: parsed.changedBy,
      after: { issueNumber: nextIssue, reason: parsed.reason, outputType: parsed.outputType },
      fieldLabels: { issueNumber: 'Issue', reason: 'Reason', outputType: 'Output type' },
    });

    // Dispatched here, in the transaction that wrote the new issue, and not by calling the screen's
    // dispatch: that one opens a transaction of its own, and a second connection cannot see a document
    // that is not committed yet. One author of what dispatch does, reached from both paths.
    const [issued] = await tx.select().from(outputMessage).where(and(
      eq(outputMessage.client, parsed.client),
      eq(outputMessage.documentCategory, parsed.documentCategory),
      eq(outputMessage.documentNumber, parsed.documentNumber),
      eq(outputMessage.outputType, parsed.outputType),
      eq(outputMessage.transmissionMedium, parsed.transmissionMedium),
      eq(outputMessage.issueNumber, nextIssue),
    )).limit(1);
    const outcome = await dispatchInTx(tx, parsed.client, parsed.changedBy, issued);
    return {
      issueNumber: nextIssue,
      determination: decision,
      message: {
        documentCategory: issued.documentCategory,
        documentNumber: issued.documentNumber,
        outputType: issued.outputType,
        transmissionMedium: issued.transmissionMedium,
        issueNumber: issued.issueNumber,
        status: outcome.status,
        sendCount: outcome.sendCount,
        recipient: issued.recipient,
        lastProcessedAt: new Date().toISOString(),
        errorText: outcome.errorText,
      },
    };
  });
}

/** Set the recipient and printer queue on a message — how a failed e-mail is made to succeed. */
export async function setSalesOutputRecipient(input: {
  client: string; changedBy: string;
  documentCategory: SalesOutputCategory; documentNumber: string;
  outputType: string; transmissionMedium: string; issueNumber?: number;
  recipient?: string; printerQueue?: string;
}): Promise<SalesOutputRow> {
  const client = input.client;
  const recipient = (input.recipient ?? '').trim();
  const printerQueue = (input.printerQueue ?? '').trim();
  if (recipient.length > 50) {
    throw new SalesOutputError('The recipient is longer than 50 characters.', 'Shorten the recipient.');
  }
  if (printerQueue.length > 30) {
    throw new SalesOutputError('The printer queue is longer than 30 characters.', 'Shorten the queue name.');
  }
  return withTenant(client, async (tx) => {
    const [updated] = await tx.update(outputMessage).set({
      recipient: recipient || null,
      printerQueue: printerQueue || null,
      changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(outputMessage.client, client),
      eq(outputMessage.documentCategory, input.documentCategory),
      eq(outputMessage.documentNumber, input.documentNumber),
      eq(outputMessage.outputType, input.outputType),
      eq(outputMessage.transmissionMedium, input.transmissionMedium),
      eq(outputMessage.issueNumber, input.issueNumber ?? 1),
    )).returning();
    if (!updated) {
      throw new SalesOutputError(
        `No ${input.outputType} output stands for ${input.documentCategory} ${input.documentNumber}.`,
        'Determine the outputs first.',
      );
    }
    return mapRow(updated, null, null, null);
  });
}

/* ─── The register ───────────────────────────────────────────────────────────────────────────── */

export interface SalesOutputRow {
  documentCategory: string;
  documentNumber: string;
  documentDate: string | null;
  customerNumber: string | null;
  outputType: string;
  outputTypeDescription: string;
  transmissionMedium: string;
  dispatchTime: string;
  issueNumber: number;
  status: string;
  sendCount: number;
  recipient: string | null;
  printerQueue: string | null;
  reissueReason: string | null;
  lastProcessedAt: string | null;
  errorText: string | null;
  renderedDocument: string | null;
}

function mapRow(
  row: typeof outputMessage.$inferSelect,
  description: string | null,
  documentDate: string | null,
  customerNumber: string | null,
): SalesOutputRow {
  return {
    documentCategory: row.documentCategory,
    documentNumber: row.documentNumber,
    documentDate,
    customerNumber,
    outputType: row.outputType,
    outputTypeDescription: description ?? '',
    transmissionMedium: row.transmissionMedium,
    dispatchTime: row.dispatchTime,
    issueNumber: row.issueNumber,
    status: row.status,
    sendCount: row.sendCount,
    recipient: row.recipient,
    printerQueue: row.printerQueue,
    reissueReason: row.reissueReason,
    lastProcessedAt: row.lastProcessedAt ? new Date(row.lastProcessedAt).toISOString() : null,
    errorText: row.errorText,
    renderedDocument: row.renderedDocument,
  };
}

export interface SalesOutputSelection {
  documentCategory?: SalesOutputCategory;
  documentNumber?: string;
  outputType?: string;
  transmissionMedium?: string;
  status?: string;
  dispatchTime?: string;
  maxHits?: number;
}

export interface SalesOutputListResult {
  rows: SalesOutputRow[];
  rowCount: number;
  pending: number;
  processed: number;
  failed: number;
  truncated: boolean;
}

/** The queue as it stands, newest first, with the counts across the whole of it. */
export async function listSalesOutput(input: {
  client: string; selection?: SalesOutputSelection;
}): Promise<SalesOutputListResult> {
  const selection = input.selection ?? {};
  const maxHits = Math.min(Math.max(Number(selection.maxHits) || DEFAULT_MAX_HITS, 1), MAX_HITS_CAP);

  return withTenant(input.client, async (tx) => {
    const clauses = [
      eq(outputMessage.client, input.client),
      // Only this application's documents: the queue is shared with inventory, and a goods receipt
      // slip is no part of what a customer receives.
      inArray(outputMessage.documentCategory, [...SALES_OUTPUT_CATEGORIES]),
    ];
    if (selection.documentCategory) clauses.push(eq(outputMessage.documentCategory, selection.documentCategory));
    if (selection.documentNumber) clauses.push(eq(outputMessage.documentNumber, selection.documentNumber.trim()));
    if (selection.outputType) clauses.push(eq(outputMessage.outputType, selection.outputType.trim().toUpperCase()));
    if (selection.transmissionMedium) clauses.push(eq(outputMessage.transmissionMedium, selection.transmissionMedium));
    if (selection.dispatchTime) clauses.push(eq(outputMessage.dispatchTime, selection.dispatchTime));
    // The counts below answer for the whole selection and not for the status it narrows to, so the
    // status is held apart from the clauses the counts are read with.
    const statusClause = selection.status ? [eq(outputMessage.status, selection.status)] : [];

    const rows = await tx.select({
      message: outputMessage, description: outputType.description,
    }).from(outputMessage)
      .innerJoin(outputType, and(
        eq(outputType.client, outputMessage.client),
        eq(outputType.outputType, outputMessage.outputType),
      ))
      .where(and(...clauses, ...statusClause))
      .orderBy(desc(outputMessage.createdAt), asc(outputMessage.documentNumber), asc(outputMessage.issueNumber))
      .limit(maxHits + 1);

    const counts = await tx.select({
      status: outputMessage.status, count: sql<number>`count(*)::int`,
    }).from(outputMessage)
      .where(and(...clauses))
      .groupBy(outputMessage.status);

    const shown = rows.slice(0, maxHits);
    const facts = await factsFor(
      tx, input.client,
      shown.map((row) => ({ category: row.message.documentCategory, number: row.message.documentNumber })),
    );

    const statusCount = (code: string) => counts.find((c) => c.status === code)?.count ?? 0;
    return {
      rows: shown.map((row) => {
        const fact = facts.get(`${row.message.documentCategory}/${row.message.documentNumber}`);
        return mapRow(row.message, row.description, fact?.documentDate ?? null, fact?.customerNumber ?? null);
      }),
      rowCount: shown.length,
      pending: statusCount('PENDING'),
      processed: statusCount('PROCESSED'),
      failed: statusCount('ERROR'),
      truncated: rows.length > maxHits,
    };
  });
}

/** The dates and customers of a page of documents, read in one query per category. */
async function factsFor(
  tx: Tx, client: string, wanted: Array<{ category: string; number: string }>,
): Promise<Map<string, OutputDocumentFacts>> {
  const map = new Map<string, OutputDocumentFacts>();
  const byCategory = (category: SalesOutputCategory) => [
    ...new Set(wanted.filter((w) => w.category === category).map((w) => w.number)),
  ];

  const orders = byCategory('SALES_ORDER');
  if (orders.length > 0) {
    const rows = await tx.select({
      documentNumber: salesOrder.orderNumber, documentDate: salesOrder.orderDate,
      customerNumber: salesOrder.customerNumber,
    }).from(salesOrder).where(and(
      eq(salesOrder.client, client), inArray(salesOrder.orderNumber, orders),
    ));
    for (const row of rows) {
      map.set(`SALES_ORDER/${row.documentNumber}`, {
        documentNumber: row.documentNumber, documentDate: row.documentDate,
        documentYear: Number(row.documentDate.slice(0, 4)), currency: '',
        netValue: '0', taxValue: '0', grossValue: '0',
        salesOrg: '', distributionChannel: '', division: '', documentType: '',
        customerNumber: row.customerNumber,
      });
    }
  }
  const deliveries = byCategory('DELIVERY');
  if (deliveries.length > 0) {
    const rows = await tx.select({
      documentNumber: delivery.deliveryNumber, documentDate: delivery.deliveryDate,
      customerNumber: delivery.customerNumber,
    }).from(delivery).where(and(
      eq(delivery.client, client), inArray(delivery.deliveryNumber, deliveries),
    ));
    for (const row of rows) {
      map.set(`DELIVERY/${row.documentNumber}`, {
        documentNumber: row.documentNumber, documentDate: row.documentDate,
        documentYear: Number(row.documentDate.slice(0, 4)), currency: '',
        netValue: '0', taxValue: '0', grossValue: '0',
        salesOrg: '', distributionChannel: '', division: '', documentType: '',
        customerNumber: row.customerNumber,
      });
    }
  }
  const billings = byCategory('BILLING');
  if (billings.length > 0) {
    const rows = await tx.select({
      documentNumber: billingDocument.billingNumber, documentDate: billingDocument.billingDate,
      customerNumber: billingDocument.customerNumber,
    }).from(billingDocument).where(and(
      eq(billingDocument.client, client), inArray(billingDocument.billingNumber, billings),
    ));
    for (const row of rows) {
      map.set(`BILLING/${row.documentNumber}`, {
        documentNumber: row.documentNumber, documentDate: row.documentDate,
        documentYear: Number(row.documentDate.slice(0, 4)), currency: '',
        netValue: '0', taxValue: '0', grossValue: '0',
        salesOrg: '', distributionChannel: '', division: '', documentType: '',
        customerNumber: row.customerNumber,
      });
    }
  }
  return map;
}

/* ─── The run ────────────────────────────────────────────────────────────────────────────────── */

/**
 * Determine the outputs of every document in the selection that carries none — the periodic path, and
 * the way documents that stood before this increment acquire their outputs at all. Documents that
 * already carry one are left alone: determination is not a second issue.
 */
export async function determineSalesOutputsForSelection(input: {
  client: string; changedBy: string; selection?: {
    documentCategory?: SalesOutputCategory;
    documentFrom?: string; documentTo?: string;
  };
}): Promise<{ examined: number; created: number }> {
  const selection = input.selection ?? {};
  return withTenant(input.client, async (tx) => {
    const categories: SalesOutputCategory[] = selection.documentCategory
      ? [selection.documentCategory] : [...SALES_OUTPUT_CATEGORIES];
    let examined = 0;
    let created = 0;
    for (const category of categories) {
      const numbers = await documentNumbersIn(
        tx, input.client, category, selection.documentFrom, selection.documentTo,
      );
      for (const documentNumber of numbers) {
        const written = await determineSalesOutputs(tx, {
          client: input.client, changedBy: input.changedBy,
          documentCategory: category, documentNumber,
        });
        examined += 1;
        created += written.created;
      }
    }
    return { examined, created };
  });
}

async function documentNumbersIn(
  tx: Tx, client: string, category: SalesOutputCategory, from?: string, to?: string,
): Promise<string[]> {
  const between = <T extends PgColumn>(column: T) => {
    const clauses: SQL[] = [];
    if (from) clauses.push(gte(column, from.trim()));
    if (to) clauses.push(lte(column, to.trim()));
    return clauses;
  };
  if (category === 'SALES_ORDER') {
    const rows = await tx.select({ number: salesOrder.orderNumber }).from(salesOrder)
      .where(and(eq(salesOrder.client, client), ...between(salesOrder.orderNumber)))
      .orderBy(desc(salesOrder.orderNumber)).limit(5000);
    return rows.map((r) => r.number);
  }
  if (category === 'DELIVERY') {
    const rows = await tx.select({ number: delivery.deliveryNumber }).from(delivery)
      .where(and(eq(delivery.client, client), ...between(delivery.deliveryNumber)))
      .orderBy(desc(delivery.deliveryNumber)).limit(5000);
    return rows.map((r) => r.number);
  }
  const rows = await tx.select({ number: billingDocument.billingNumber }).from(billingDocument)
    .where(and(eq(billingDocument.client, client), ...between(billingDocument.billingNumber)))
    .orderBy(desc(billingDocument.billingNumber)).limit(5000);
  return rows.map((r) => r.number);
}

/** Dispatch every PENDING message the selection names — the periodic dispatch run. */
export async function dispatchPendingSalesOutput(input: {
  client: string; changedBy: string; selection?: SalesOutputSelection;
}): Promise<{ dispatched: number; failed: number; results: SalesOutputDispatchResult[] }> {
  const list = await listSalesOutput({
    client: input.client,
    selection: { ...(input.selection ?? {}), status: 'PENDING', maxHits: MAX_HITS_CAP },
  });
  const results: SalesOutputDispatchResult[] = [];
  for (const row of list.rows) {
    results.push(await dispatchSalesOutput({
      client: input.client, changedBy: input.changedBy,
      documentCategory: row.documentCategory as SalesOutputCategory,
      documentNumber: row.documentNumber,
      outputType: row.outputType,
      transmissionMedium: row.transmissionMedium as 'PRINT' | 'EMAIL',
      issueNumber: row.issueNumber,
    }));
  }
  return {
    dispatched: results.filter((r) => r.status === 'PROCESSED').length,
    failed: results.filter((r) => r.status === 'ERROR').length,
    results,
  };
}

/* ─── Maintaining the records ────────────────────────────────────────────────────────────────── */

/**
 * The record key, derived from the business key rather than drawn from a number range: the same
 * combination prices once, so a derived key cannot collide and no range has to be maintained for a
 * decision about who receives what. The output type stands in the number, so a record says what it is.
 */
function deriveConditionNumber(input: {
  outputType: string; salesOrg: string; distributionChannel: string; division: string;
  documentType: string; customerNumber: string; validityFrom: string;
}): string {
  const basis = [input.outputType, input.salesOrg, input.distributionChannel, input.division,
    input.documentType, input.customerNumber].join('|');
  let hash = 5381;
  for (let i = 0; i < basis.length; i += 1) hash = ((hash * 33) ^ basis.charCodeAt(i)) >>> 0;
  const tail = hash.toString(36).toUpperCase().padStart(6, '0').slice(-6);
  const day = input.validityFrom.replaceAll('-', '');
  return `${input.outputType}${day}${tail}`.slice(0, 18);
}

export async function saveOutputConditionRecord(
  input: SaveOutputConditionInput,
): Promise<{ conditionNumber: string; outputType: string; access: number; accessName: string }> {
  const parsed = conditionInput.parse(input);
  if (parsed.validityTo < parsed.validityFrom) {
    throw new SalesOutputError(
      `The record ends on ${parsed.validityTo}, before it starts on ${parsed.validityFrom}.`,
      'Give the record an end date on or after its start date.',
    );
  }
  return withTenant(parsed.client, async (tx) => {
    await ensureSalesOutputTypes(tx, parsed.client, parsed.changedBy);
    const [type] = await tx.select().from(outputType).where(and(
      eq(outputType.client, parsed.client), eq(outputType.outputType, parsed.outputType),
    )).limit(1);
    if (!type) {
      throw new SalesOutputError(
        `${parsed.outputType} is not an output type that stands.`,
        `The package delivers ${DELIVERED_SALES_OUTPUT_TYPES.map((t) => t.outputType).join(', ')}; define another before recording it.`,
      );
    }
    if (type.application !== 'SD') {
      throw new SalesOutputError(
        `${parsed.outputType} belongs to ${type.application} and cannot be determined for a sales document.`,
        'Output types are per application, which is what keeps a goods receipt slip off an order.',
      );
    }
    // A narrowed record has to narrow to something: a customer with no sales area, or a division with
    // no sales organisation, is a combination the access sequence cannot reach — and a record that
    // cannot be reached is a decision that silently never happens.
    if (parsed.customerNumber && !parsed.salesOrg) {
      throw new SalesOutputError(
        'A record naming a customer has to name the sales organisation too.',
        'Either name the sales area the customer is sold to, or leave the customer blank.',
      );
    }
    if (parsed.distributionChannel && !parsed.salesOrg) {
      throw new SalesOutputError(
        'A record naming a distribution channel has to name the sales organisation too.',
        'Either name the sales organisation, or leave the channel blank.',
      );
    }

    // A record the access sequence cannot reach is a decision that silently never happens, and it is
    // refused here rather than left to be wondered about: a customer with no sales area, or a document
    // type with no sales organisation, names a combination no document can arrive at.
    const reached = ACCESS_SEQUENCE.find((entry) => {
      const holds = new Set<string>(entry.holds);
      const values: Record<string, string> = {
        salesOrg: parsed.salesOrg, distributionChannel: parsed.distributionChannel,
        division: parsed.division, documentType: parsed.documentType,
        customerNumber: parsed.customerNumber,
      };
      return ACCESS_FIELDS.every((field) => (holds.has(field) ? values[field] !== '' : values[field] === ''));
    });
    if (!reached) {
      throw new SalesOutputError(
        'No access in the sequence can reach this combination: a record narrows from the sales organisation outwards, and never skips a level.',
        'Name the sales organisation, and then the channel, the division, the document type and the customer in that order — leaving each blank from some point on.',
      );
    }

    const conditionNumber = deriveConditionNumber({
      outputType: parsed.outputType, salesOrg: parsed.salesOrg,
      distributionChannel: parsed.distributionChannel, division: parsed.division,
      documentType: parsed.documentType, customerNumber: parsed.customerNumber,
      validityFrom: parsed.validityFrom,
    });
    const [inserted] = await tx.insert(outputConditionRecord).values({
      client: parsed.client,
      conditionNumber,
      application: 'SD',
      outputType: parsed.outputType,
      documentCategory: parsed.documentCategory,
      documentType: parsed.documentType,
      salesOrg: parsed.salesOrg,
      distributionChannel: parsed.distributionChannel,
      division: parsed.division,
      customerNumber: parsed.customerNumber,
      transmissionMedium: parsed.transmissionMedium,
      dispatchTime: parsed.dispatchTime,
      partnerFunction: parsed.partnerFunction,
      printerQueue: parsed.printerQueue?.trim() || null,
      validityFrom: parsed.validityFrom,
      validityTo: parsed.validityTo,
      isActive: parsed.isActive,
      createdBy: parsed.changedBy,
    }).onConflictDoNothing().returning();
    if (!inserted) {
      throw new SalesOutputError(
        `A ${parsed.outputType} record already stands for this combination from ${parsed.validityFrom}.`,
        'Start the new record on a day the standing one does not use, or correct the record that does.',
      );
    }

    await recordChange(tx, {
      client: parsed.client, objectClass: OUTPUT_CONDITION_OBJECT_CLASS, objectKey: conditionNumber,
      changeType: 'CREATE', changedBy: parsed.changedBy,
      after: {
        outputType: parsed.outputType, salesArea: `${parsed.salesOrg}/${parsed.distributionChannel}/${parsed.division}`,
        documentType: parsed.documentType, customer: parsed.customerNumber,
        medium: parsed.transmissionMedium, dispatchTime: parsed.dispatchTime,
        partnerFunction: parsed.partnerFunction,
        validity: `${parsed.validityFrom} to ${parsed.validityTo}`,
      },
      fieldLabels: {
        outputType: 'Output type', salesArea: 'Sales area', documentType: 'Document type',
        customer: 'Customer', medium: 'Medium', dispatchTime: 'Dispatch time',
        partnerFunction: 'Partner function', validity: 'Validity',
      },
    });

    return {
      conditionNumber, outputType: parsed.outputType,
      access: reached.access, accessName: reached.name,
    };
  });
}

export async function listOutputConditionRecords(
  client: string,
  filter: { outputType?: string; validOn?: string } = {},
): Promise<Array<{
  conditionNumber: string; outputType: string; outputTypeDescription: string;
  documentCategory: string; documentType: string;
  salesOrg: string; distributionChannel: string; division: string; customerNumber: string;
  transmissionMedium: string; dispatchTime: string; partnerFunction: string; printerQueue: string | null;
  validityFrom: string; validityTo: string; isActive: boolean; access: number; accessName: string;
}>> {
  return withTenant(client, async (tx) => {
    const clauses = [eq(outputConditionRecord.client, client)];
    if (filter.outputType) clauses.push(eq(outputConditionRecord.outputType, filter.outputType));
    if (filter.validOn) {
      clauses.push(lte(outputConditionRecord.validityFrom, filter.validOn));
      clauses.push(gte(outputConditionRecord.validityTo, filter.validOn));
    }
    const rows = await tx.select({
      record: outputConditionRecord, description: outputType.description,
    }).from(outputConditionRecord)
      .innerJoin(outputType, and(
        eq(outputType.client, outputConditionRecord.client),
        eq(outputType.outputType, outputConditionRecord.outputType),
      ))
      .where(and(...clauses))
      .orderBy(asc(outputConditionRecord.outputType), asc(outputConditionRecord.conditionNumber));

    return rows.map((row) => {
      const values: Record<string, string> = {
        salesOrg: row.record.salesOrg, distributionChannel: row.record.distributionChannel,
        division: row.record.division, documentType: row.record.documentType,
        customerNumber: row.record.customerNumber,
      };
      const access = ACCESS_SEQUENCE.find((entry) => {
        const holds = new Set(entry.holds);
        return ACCESS_FIELDS.every((field) => (holds.has(field) ? values[field] !== '' : values[field] === ''));
      });
      return {
        conditionNumber: row.record.conditionNumber,
        outputType: row.record.outputType,
        outputTypeDescription: row.description,
        documentCategory: row.record.documentCategory,
        documentType: row.record.documentType,
        salesOrg: row.record.salesOrg,
        distributionChannel: row.record.distributionChannel,
        division: row.record.division,
        customerNumber: row.record.customerNumber,
        transmissionMedium: row.record.transmissionMedium,
        dispatchTime: row.record.dispatchTime,
        partnerFunction: row.record.partnerFunction,
        printerQueue: row.record.printerQueue,
        validityFrom: row.record.validityFrom,
        validityTo: row.record.validityTo,
        isActive: row.record.isActive,
        access: access?.access ?? 0,
        accessName: access?.name ?? 'unreachable',
      };
    });
  });
}

/** Activate or withdraw a record. Withdrawing one stops the output without losing the decision. */
export async function setOutputConditionRecordStatus(input: {
  client: string; conditionNumber: string; isActive: boolean; changedBy: string;
}): Promise<{ conditionNumber: string; isActive: boolean }> {
  return withTenant(input.client, async (tx) => {
    const [before] = await tx.select().from(outputConditionRecord).where(and(
      eq(outputConditionRecord.client, input.client),
      eq(outputConditionRecord.conditionNumber, input.conditionNumber),
    )).limit(1);
    if (!before) {
      throw new SalesOutputError(
        `Output condition record ${input.conditionNumber} does not stand.`,
        'Read the records that stand and choose one of them.',
      );
    }
    await tx.update(outputConditionRecord).set({
      isActive: input.isActive, changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(outputConditionRecord.client, input.client),
      eq(outputConditionRecord.conditionNumber, input.conditionNumber),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: OUTPUT_CONDITION_OBJECT_CLASS, objectKey: input.conditionNumber,
      changeType: 'CHANGE', changedBy: input.changedBy,
      before: { isActive: before.isActive }, after: { isActive: input.isActive },
      securityRelevantFields: ['isActive'],
    });
    return { conditionNumber: input.conditionNumber, isActive: input.isActive };
  });
}

/** The output types a client may record a condition against, with what each one is. */
export async function salesOutputTypeChoices(client: string): Promise<Array<{
  outputType: string; description: string; transmissionMedium: string; dispatchTime: string; isActive: boolean;
}>> {
  return withTenant(client, async (tx) => {
    await ensureSalesOutputTypes(tx, client, 'SYSTEM');
    const rows = await tx.select().from(outputType).where(and(
      eq(outputType.client, client), eq(outputType.application, 'SD'),
    )).orderBy(asc(outputType.outputType));
    return rows.map((row) => ({
      outputType: row.outputType,
      description: row.description,
      transmissionMedium: row.transmissionMedium,
      dispatchTime: row.dispatchTime,
      isActive: row.isActive,
    }));
  });
}
