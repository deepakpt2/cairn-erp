/**
 * Material document output — SCR-135 / INV.MATERIALDOC.RECEIVEPRINT (MB90 as a
 * search alias only).
 *
 * Output determination and dispatch in the NAST shape (§26.882): an `output_type`
 * is the catalogue and the condition, an `output_message` is one queue row per
 * document, output type and medium. Determination happens where a document is born
 * — goods receipt, transfer posting and reversal each call in as they post — and a
 * run fills what stands missing, which is both the periodic dispatch path (VSZTP
 * 3: canon has no scheduler) and the way documents posted before this capability
 * existed acquire their slips.
 *
 * Printing is rendering. A dispatch renders the slip from the document as posted,
 * marks the message PROCESSED, counts the send and stamps the time. It hands
 * nothing to a printer or a mail server: spool and transport are deferred by name.
 *
 * Failure is real: an EMAIL message with no recipient fails at dispatch with a
 * recorded reason and status ERROR; set a recipient and dispatch again and it
 * succeeds. That is the package's "re-trigger failed transmissions".
 *
 * Refused by name: FAX and EDI media (no endpoint exists), re-dispatching a
 * PROCESSED message, and posting-period checks (a document that stands passed its
 * own at posting; this screen reads history). Deferred by name: the scheduler,
 * condition technology beyond direction, spool files and the transport.
 */
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import type { Tx } from '../../platform/db/client';
import { plant as plantTable } from '../foundation/schema';
import {
  material, materialDocument, materialDocumentLine, movementType,
  outputMessage, outputType,
} from './schema';

export const MATERIAL_DOC_OUTPUT_CAPABILITY = 'INV.MATERIALDOC.RECEIVEPRINT';
export const MATERIAL_DOC_OUTPUT_ALIAS = 'MB90';
export const MATERIAL_DOC_OUTPUT_ROUTE = '/inventory/material-document-output';

export class MaterialDocumentOutputError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'MaterialDocumentOutputError';
  }
}

/** Named media, with SAP's NACHA digits as documented aliases only. */
export const OUTPUT_MEDIA = ['PRINT', 'EMAIL'] as const;
export type OutputMedium = (typeof OUTPUT_MEDIA)[number];
/** Refused by name: canon has neither a fax nor an EDI endpoint. */
export const REFUSED_MEDIA: Record<string, string> = {
  FAX: '2',
  EDI: '6',
};

export const OUTPUT_STATUSES = ['PENDING', 'PROCESSED', 'ERROR'] as const;
export type OutputStatus = (typeof OUTPUT_STATUSES)[number];
/** SAP VSTAT's digits, shown beside the names. */
export const STATUS_ALIASES: Record<OutputStatus, string> = {
  PENDING: '0', PROCESSED: '1', ERROR: '2',
};

export const DISPATCH_TIMES = ['IMMEDIATE', 'PERIODIC'] as const;
export type DispatchTime = (typeof DISPATCH_TIMES)[number];

export interface DeliveredOutputType {
  outputType: string;
  description: string;
  direction: 'RECEIPT' | 'ISSUE';
  transmissionMedium: OutputMedium;
  dispatchTime: DispatchTime;
}

/** The two slips canon delivers. A transfer prints neither (§26.884). */
export const DELIVERED_OUTPUT_TYPES: readonly DeliveredOutputType[] = [
  {
    outputType: 'WE01', description: 'Goods receipt slip', direction: 'RECEIPT',
    transmissionMedium: 'PRINT', dispatchTime: 'IMMEDIATE',
  },
  {
    outputType: 'WA01', description: 'Goods issue slip', direction: 'ISSUE',
    transmissionMedium: 'PRINT', dispatchTime: 'PERIODIC',
  },
] as const;

export interface OutputSelection {
  outputType?: string;
  transmissionMedium?: string;
  dispatchTime?: string;
  status?: string;
  documentFrom?: string;
  documentTo?: string;
  documentYear?: string;
  plantFrom?: string;
  plantTo?: string;
  postingDateFrom?: string;
  postingDateTo?: string;
  recipient?: string;
  maxHits?: number;
}

export const DEFAULT_MAX_HITS = 200;
export const MAX_HITS_CAP = 1000;

export interface OutputMessageView {
  documentNumber: string;
  documentYear: number;
  postingDate: string;
  documentDate: string;
  outputType: string;
  outputTypeDescription: string;
  transmissionMedium: string;
  dispatchTime: string;
  status: string;
  /** SAP VSTAT's digit for the status, shown as an alias. */
  statusCode: string;
  sendCount: number;
  recipient: string | null;
  printerQueue: string | null;
  lastProcessedAt: string | null;
  errorText: string | null;
  plants: string[];
  companyCodes: string[];
}

export interface OutputListResult {
  capability: string;
  selection: OutputSelection;
  rows: OutputMessageView[];
  rowCount: number;
  pending: number;
  processed: number;
  failed: number;
  truncated: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function ensureOutputTypes(tx: Tx, client: string, changedBy: string) {
  for (const type of DELIVERED_OUTPUT_TYPES) {
    await tx.insert(outputType).values({
      client, ...type, isActive: true, createdBy: changedBy,
    }).onConflictDoNothing();
  }
}

/** The line directions a document carries, as a set: RECEIPT, ISSUE, or both. */
async function directionsOf(tx: Tx, client: string, documentNumber: string) {
  const rows = await tx.select({ direction: materialDocumentLine.lineDirection })
    .from(materialDocumentLine)
    .where(and(
      eq(materialDocumentLine.client, client),
      eq(materialDocumentLine.materialDocumentNumber, documentNumber),
    ));
  return new Set(rows.map((r) => r.direction));
}

/**
 * Determine the outputs a document earns and write the missing queue rows.
 *
 * A document whose lines are all receipts earns WE01; all issues earns WA01. A
 * document that both receipts and issues — a transfer posting — matches neither
 * delivered output, and nothing is written for it.
 *
 * Runs inside the caller's transaction so a posting records its outputs with the
 * document, never after it.
 */
export async function recordOutputsForDocument(
  tx: Tx, client: string, documentNumber: string, changedBy: string,
): Promise<number> {
  await ensureOutputTypes(tx, client, changedBy);

  const [header] = await tx.select().from(materialDocument).where(and(
    eq(materialDocument.client, client),
    eq(materialDocument.materialDocumentNumber, documentNumber),
  ));
  if (!header) {
    throw new MaterialDocumentOutputError(
      `Material document ${documentNumber} does not exist.`,
      'Only a posted document carries an output.',
    );
  }

  const directions = await directionsOf(tx, client, documentNumber);
  const types = await tx.select().from(outputType).where(and(
    eq(outputType.client, client), eq(outputType.isActive, true),
  ));

  let created = 0;
  for (const type of types) {
    if (!directions.has(type.direction)) continue;
    const opposite = type.direction === 'RECEIPT' ? 'ISSUE' : 'RECEIPT';
    // A document that moves both ways is a transfer: neither slip describes it.
    if (directions.has(opposite)) continue;
    const inserted = await tx.insert(outputMessage).values({
      client,
      materialDocumentNumber: header.materialDocumentNumber,
      documentYear: header.documentYear,
      outputType: type.outputType,
      transmissionMedium: type.transmissionMedium,
      dispatchTime: type.dispatchTime,
      status: 'PENDING',
      sendCount: 0,
      createdBy: changedBy,
    }).onConflictDoNothing().returning({ outputType: outputMessage.outputType });
    created += inserted.length;
  }
  return created;
}

/** Dispatch the immediate messages of a document written in this transaction. */
async function dispatchImmediateInTx(tx: Tx, client: string, documentNumber: string, changedBy: string) {
  const due = await tx.select().from(outputMessage).where(and(
    eq(outputMessage.client, client),
    eq(outputMessage.materialDocumentNumber, documentNumber),
    eq(outputMessage.status, 'PENDING'),
    eq(outputMessage.dispatchTime, 'IMMEDIATE'),
  ));
  for (const message of due) {
    const [type] = await tx.select().from(outputType).where(and(
      eq(outputType.client, client), eq(outputType.outputType, message.outputType),
    ));
    if (!type?.isActive) continue;
    if (message.transmissionMedium === 'EMAIL' && !message.recipient) continue;
    await tx.update(outputMessage).set({
      status: 'PROCESSED',
      sendCount: message.sendCount + 1,
      lastProcessedAt: new Date(),
      errorText: null,
      changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(outputMessage.client, client),
      eq(outputMessage.materialDocumentNumber, documentNumber),
      eq(outputMessage.outputType, message.outputType),
      eq(outputMessage.transmissionMedium, message.transmissionMedium),
    ));
  }
}

/**
 * The posting hook: determine a freshly posted document's outputs, then dispatch
 * the immediate ones inside the same transaction. Returns what was created.
 */
export async function recordOutputsForPostedDocument(
  tx: Tx, client: string, documentNumber: string, changedBy: string,
): Promise<number> {
  const created = await recordOutputsForDocument(tx, client, documentNumber, changedBy);
  await dispatchImmediateInTx(tx, client, documentNumber, changedBy);
  return created;
}

async function selectionClause(client: string, s: OutputSelection) {
  const clauses = [eq(outputMessage.client, client)];
  if (s.status) {
    if (!(OUTPUT_STATUSES as readonly string[]).includes(s.status)) {
      throw new MaterialDocumentOutputError(
        `${s.status} is not a processing status.`,
        'A status is PENDING (0), PROCESSED (1) or ERROR (2).',
      );
    }
    clauses.push(eq(outputMessage.status, s.status));
  }
  if (s.transmissionMedium) {
    if (!(OUTPUT_MEDIA as readonly string[]).includes(s.transmissionMedium)) {
      throw new MaterialDocumentOutputError(
        `${s.transmissionMedium} is not a transmission medium`,
        `Canon delivers PRINT (1) and EMAIL (5).${s.transmissionMedium === 'FAX' || s.transmissionMedium === 'EDI'
          ? ' FAX (2) and EDI (6) are refused by name: no endpoint exists.' : ''}`,
      );
    }
    clauses.push(eq(outputMessage.transmissionMedium, s.transmissionMedium));
  }
  if (s.dispatchTime) {
    if (!(DISPATCH_TIMES as readonly string[]).includes(s.dispatchTime)) {
      throw new MaterialDocumentOutputError(
        `${s.dispatchTime} is not a dispatch time.`,
        'A dispatch time is IMMEDIATE (1) or PERIODIC (3).',
      );
    }
    clauses.push(eq(outputMessage.dispatchTime, s.dispatchTime));
  }
  if (s.outputType) clauses.push(eq(outputMessage.outputType, s.outputType.trim().toUpperCase()));
  if (s.documentFrom) clauses.push(gte(outputMessage.materialDocumentNumber, s.documentFrom.trim()));
  if (s.documentTo) clauses.push(lte(outputMessage.materialDocumentNumber, s.documentTo.trim()));
  if (s.documentYear) {
    if (!/^\d{4}$/.test(s.documentYear)) {
      throw new MaterialDocumentOutputError(
        `Fiscal year ${s.documentYear} is not a four-digit year.`,
        'Enter the year as four digits, for example 2026.',
      );
    }
    clauses.push(eq(outputMessage.documentYear, Number(s.documentYear)));
  }
  if (s.postingDateFrom) {
    if (!ISO_DATE.test(s.postingDateFrom)) {
      throw new MaterialDocumentOutputError('The posting-date-from is not a date.', 'Enter it as YYYY-MM-DD.');
    }
    clauses.push(gte(materialDocument.postingDate, s.postingDateFrom));
  }
  if (s.postingDateTo) {
    if (!ISO_DATE.test(s.postingDateTo)) {
      throw new MaterialDocumentOutputError('The posting-date-to is not a date.', 'Enter it as YYYY-MM-DD.');
    }
    clauses.push(lte(materialDocument.postingDate, s.postingDateTo));
  }
  if (s.recipient) clauses.push(eq(outputMessage.recipient, s.recipient));
  if (s.plantFrom || s.plantTo) {
    const from = (s.plantFrom ?? '').trim();
    const to = (s.plantTo ?? '').trim() || from;
    clauses.push(sql`exists (
      select 1 from material_document_line l
      where l.client = ${client}
        and l.material_document_number = ${outputMessage.materialDocumentNumber}
        and l.plant between ${from} and ${to}
    )`);
  }
  return and(...clauses);
}

/** The MB90 grid: the queue as it stands, newest first, with its counts. */
export async function listOutputMessages(input: {
  client: string; selection?: OutputSelection;
}): Promise<OutputListResult> {
  const selection = input.selection ?? {};
  const maxHits = Math.min(
    Math.max(Number(selection.maxHits) || DEFAULT_MAX_HITS, 1), MAX_HITS_CAP,
  );

  return withTenant(input.client, async (tx) => {
    const where = await selectionClause(input.client, selection);
    const rows = await tx.select({
      message: outputMessage,
      description: outputType.description,
      header: materialDocument,
    }).from(outputMessage)
      .innerJoin(materialDocument, and(
        eq(materialDocument.client, outputMessage.client),
        eq(materialDocument.materialDocumentNumber, outputMessage.materialDocumentNumber),
      ))
      .innerJoin(outputType, and(
        eq(outputType.client, outputMessage.client),
        eq(outputType.outputType, outputMessage.outputType),
      ))
      .where(where)
      .orderBy(desc(outputMessage.createdAt), asc(outputMessage.materialDocumentNumber))
      .limit(maxHits + 1);

    const counts = await tx.select({
      status: outputMessage.status,
      count: sql<number>`count(*)::int`,
    }).from(outputMessage)
      .innerJoin(materialDocument, and(
        eq(materialDocument.client, outputMessage.client),
        eq(materialDocument.materialDocumentNumber, outputMessage.materialDocumentNumber),
      ))
      .where(await selectionClause(input.client, { ...selection, status: undefined }))
      .groupBy(outputMessage.status);

    const shown = rows.slice(0, maxHits);
    const numbers = [...new Set(shown.map((r) => r.message.materialDocumentNumber))];
    const places = new Map<string, { plants: Set<string>; companies: Set<string> }>();
    if (numbers.length > 0) {
      const lines = await tx.select({
        number: materialDocumentLine.materialDocumentNumber,
        plant: materialDocumentLine.plant,
      }).from(materialDocumentLine).where(and(
        eq(materialDocumentLine.client, input.client),
        inArray(materialDocumentLine.materialDocumentNumber, numbers),
      ));
      const companyByPlant = new Map<string, string>();
      if (lines.length > 0) {
        const found = await tx.select({
          plant: plantTable.plant, companyCode: plantTable.companyCode,
        }).from(plantTable).where(and(
          eq(plantTable.client, input.client),
          inArray(plantTable.plant, [...new Set(lines.map((l) => l.plant))]),
        ));
        for (const p of found) if (p.companyCode) companyByPlant.set(p.plant, p.companyCode);
      }
      for (const l of lines) {
        const entry = places.get(l.number) ?? { plants: new Set<string>(), companies: new Set<string>() };
        entry.plants.add(l.plant);
        const company = companyByPlant.get(l.plant);
        if (company) entry.companies.add(company);
        places.set(l.number, entry);
      }
    }

    const statusCount = (code: string) => counts.find((c) => c.status === code)?.count ?? 0;

    return {
      capability: MATERIAL_DOC_OUTPUT_CAPABILITY,
      selection,
      rows: shown.map((r) => {
        const place = places.get(r.message.materialDocumentNumber);
        return {
          documentNumber: r.message.materialDocumentNumber,
          documentYear: r.message.documentYear,
          postingDate: r.header.postingDate,
          documentDate: r.header.documentDate,
          outputType: r.message.outputType,
          outputTypeDescription: r.description,
          transmissionMedium: r.message.transmissionMedium,
          dispatchTime: r.message.dispatchTime,
          status: r.message.status,
          statusCode: STATUS_ALIASES[r.message.status as OutputStatus] ?? '?',
          sendCount: r.message.sendCount,
          recipient: r.message.recipient,
          printerQueue: r.message.printerQueue,
          lastProcessedAt: r.message.lastProcessedAt ? new Date(r.message.lastProcessedAt).toISOString() : null,
          errorText: r.message.errorText,
          plants: [...(place?.plants ?? [])].sort(),
          companyCodes: [...(place?.companies ?? [])].sort(),
        };
      }),
      rowCount: shown.length,
      pending: statusCount('PENDING'),
      processed: statusCount('PROCESSED'),
      failed: statusCount('ERROR'),
      truncated: rows.length > maxHits,
    };
  });
}

/**
 * Determine the outputs of every posted document in the selection that carries
 * none — the run's first half, and the way history acquires its slips.
 */
export async function determineOutputs(input: {
  client: string; changedBy: string; selection?: OutputSelection;
}): Promise<{ examined: number; created: number; transfers: number }> {
  const selection = input.selection ?? {};
  return withTenant(input.client, async (tx) => {
    const clauses = [eq(materialDocument.client, input.client)];
    if (selection.documentFrom) clauses.push(gte(materialDocument.materialDocumentNumber, selection.documentFrom.trim()));
    if (selection.documentTo) clauses.push(lte(materialDocument.materialDocumentNumber, selection.documentTo.trim()));
    if (selection.documentYear) clauses.push(eq(materialDocument.documentYear, Number(selection.documentYear)));
    if (selection.postingDateFrom) clauses.push(gte(materialDocument.postingDate, selection.postingDateFrom));
    if (selection.postingDateTo) clauses.push(lte(materialDocument.postingDate, selection.postingDateTo));

    const documents = await tx.select({ number: materialDocument.materialDocumentNumber })
      .from(materialDocument)
      .where(and(...clauses))
      .orderBy(desc(materialDocument.postingDate), desc(materialDocument.materialDocumentNumber))
      .limit(5000);

    let created = 0;
    let transfers = 0;
    for (const document of documents) {
      const before = await tx.select({ count: sql<number>`count(*)::int` }).from(outputMessage).where(and(
        eq(outputMessage.client, input.client),
        eq(outputMessage.materialDocumentNumber, document.number),
      ));
      const written = await recordOutputsForDocument(tx, input.client, document.number, input.changedBy);
      created += written;
      if (written === 0 && (before[0]?.count ?? 0) === 0) transfers += 1;
    }
    return { examined: documents.length, created, transfers };
  });
}

export interface DispatchResult {
  documentNumber: string;
  outputType: string;
  transmissionMedium: string;
  status: OutputStatus;
  sendCount: number;
  lastProcessedAt: string | null;
  errorText: string | null;
  /** The rendered slip, when the dispatch produced one. */
  slip: string | null;
}

/**
 * Render the slip from the document as posted. Pure reading: no writes, no period
 * check, no valuation judgement.
 */
export async function renderSlip(input: {
  client: string; documentNumber: string;
}): Promise<string> {
  return withTenant(input.client, async (tx) => {
    const [header] = await tx.select().from(materialDocument).where(and(
      eq(materialDocument.client, input.client),
      eq(materialDocument.materialDocumentNumber, input.documentNumber),
    ));
    if (!header) {
      throw new MaterialDocumentOutputError(`Material document ${input.documentNumber} does not exist.`);
    }
    const lines = await tx.select().from(materialDocumentLine).where(and(
      eq(materialDocumentLine.client, input.client),
      eq(materialDocumentLine.materialDocumentNumber, input.documentNumber),
    )).orderBy(materialDocumentLine.lineNumber);

    const numbers = [...new Set(lines.map((l) => l.materialNumber))];
    const descriptions = new Map<string, string>();
    if (numbers.length > 0) {
      const masters = await tx.select({
        materialNumber: material.materialNumber, description: material.description,
      }).from(material).where(and(
        eq(material.client, input.client), inArray(material.materialNumber, numbers),
      ));
      for (const m of masters) if (m.description) descriptions.set(m.materialNumber, m.description);
    }
    const codes = [...new Set(lines.map((l) => l.movementType))];
    const movements = new Map<string, string>();
    if (codes.length > 0) {
      const found = await tx.select({
        movementType: movementType.movementType, description: movementType.description,
      }).from(movementType).where(and(
        eq(movementType.client, input.client), inArray(movementType.movementType, codes),
      ));
      for (const m of found) movements.set(m.movementType, m.description);
    }

    const rule = '-'.repeat(66);
    const out: string[] = [];
    out.push(`MATERIAL DOCUMENT ${header.materialDocumentNumber} / ${header.documentYear}`);
    out.push(`Posted ${header.postingDate}   Document date ${header.documentDate}   By ${header.createdBy}`);
    if (header.headerText) out.push(`Text: ${header.headerText}`);
    out.push(rule);
    out.push('It  Movement        Material                  Plant  Loc   Quantity');
    out.push(rule);
    for (const line of lines) {
      const movement = `${line.movementType}`.padEnd(15, ' ');
      const materialText = `${line.materialNumber}${descriptions.get(line.materialNumber) ? ` ${descriptions.get(line.materialNumber)}` : ''}`;
      out.push([
        String(line.lineNumber).padStart(2, ' '),
        movement.slice(0, 15),
        materialText.padEnd(25, ' ').slice(0, 25),
        line.plant.padEnd(5, ' ').slice(0, 5),
        (line.storageLocation ?? '—').padEnd(5, ' ').slice(0, 5),
        `${line.baseQuantity} ${line.baseUnit}`,
      ].join(' '));
      out.push(`    ${movements.get(line.movementType) ?? 'movement type not described'} · ${line.lineDirection}`);
    }
    out.push(rule);
    out.push(`Items ${lines.length}`);
    return out.join('\n');
  });
}

/**
 * Dispatch one message: render the slip, mark it PROCESSED, count the send. An
 * EMAIL with no recipient fails and records why; a PROCESSED message refuses,
 * because a repeat is a new output.
 */
export async function dispatchMessage(input: {
  client: string; changedBy: string; documentNumber: string;
  outputType: string; transmissionMedium: string;
}): Promise<DispatchResult> {
  const slip = await renderSlip({ client: input.client, documentNumber: input.documentNumber });

  return withTenant(input.client, async (tx) => {
    const [message] = await tx.select().from(outputMessage).where(and(
      eq(outputMessage.client, input.client),
      eq(outputMessage.materialDocumentNumber, input.documentNumber),
      eq(outputMessage.outputType, input.outputType),
      eq(outputMessage.transmissionMedium, input.transmissionMedium),
    ));
    if (!message) {
      throw new MaterialDocumentOutputError(
        `No ${input.outputType} output stands for material document ${input.documentNumber}.`,
        'Determine the outputs first; the run does it for every document in the selection.',
      );
    }
    if (message.status === 'PROCESSED') {
      throw new MaterialDocumentOutputError(
        `The ${message.outputType} output for ${input.documentNumber} is already processed.`,
        'A repeat dispatch is a new output, which is deferred by name.',
      );
    }

    const now = new Date();
    if (message.transmissionMedium === 'EMAIL' && !message.recipient) {
      const [failed] = await tx.update(outputMessage).set({
        status: 'ERROR',
        errorText: 'An EMAIL output needs a recipient and none stands on the message.',
        lastProcessedAt: now,
        changedBy: input.changedBy, changedAt: now,
      }).where(and(
        eq(outputMessage.client, input.client),
        eq(outputMessage.materialDocumentNumber, input.documentNumber),
        eq(outputMessage.outputType, input.outputType),
        eq(outputMessage.transmissionMedium, input.transmissionMedium),
      )).returning();
      return {
        documentNumber: failed.materialDocumentNumber,
        outputType: failed.outputType,
        transmissionMedium: failed.transmissionMedium,
        status: 'ERROR' as OutputStatus,
        sendCount: failed.sendCount,
        lastProcessedAt: failed.lastProcessedAt ? new Date(failed.lastProcessedAt).toISOString() : null,
        errorText: failed.errorText,
        slip: null,
      };
    }

    const [done] = await tx.update(outputMessage).set({
      status: 'PROCESSED',
      sendCount: message.sendCount + 1,
      lastProcessedAt: now,
      errorText: null,
      changedBy: input.changedBy, changedAt: now,
    }).where(and(
      eq(outputMessage.client, input.client),
      eq(outputMessage.materialDocumentNumber, input.documentNumber),
      eq(outputMessage.outputType, input.outputType),
      eq(outputMessage.transmissionMedium, input.transmissionMedium),
    )).returning();

    return {
      documentNumber: done.materialDocumentNumber,
      outputType: done.outputType,
      transmissionMedium: done.transmissionMedium,
      status: 'PROCESSED' as OutputStatus,
      sendCount: done.sendCount,
      lastProcessedAt: done.lastProcessedAt ? new Date(done.lastProcessedAt).toISOString() : null,
      errorText: null,
      slip,
    };
  });
}

/** Dispatch every PENDING message the selection names — the periodic run. */
export async function dispatchPending(input: {
  client: string; changedBy: string; selection?: OutputSelection;
}): Promise<{ dispatched: number; failed: number; results: DispatchResult[] }> {
  const list = await listOutputMessages({
    client: input.client,
    selection: { ...(input.selection ?? {}), status: 'PENDING', maxHits: MAX_HITS_CAP },
  });
  const results: DispatchResult[] = [];
  for (const row of list.rows) {
    results.push(await dispatchMessage({
      client: input.client, changedBy: input.changedBy,
      documentNumber: row.documentNumber, outputType: row.outputType,
      transmissionMedium: row.transmissionMedium,
    }));
  }
  return {
    dispatched: results.filter((r) => r.status === 'PROCESSED').length,
    failed: results.filter((r) => r.status === 'ERROR').length,
    results,
  };
}

/** Set the recipient (and optionally the printer queue) on a message. */
export async function setRecipient(input: {
  client: string; changedBy: string; documentNumber: string; outputType: string;
  transmissionMedium: string; recipient?: string; printerQueue?: string;
}): Promise<OutputMessageView> {
  const recipient = (input.recipient ?? '').trim();
  const printerQueue = (input.printerQueue ?? '').trim();
  if (recipient.length > 50) {
    throw new MaterialDocumentOutputError('The recipient is longer than 50 characters.', 'Shorten the recipient.');
  }
  if (printerQueue.length > 30) {
    throw new MaterialDocumentOutputError('The printer queue is longer than 30 characters.', 'Shorten the queue name.');
  }

  return withTenant(input.client, async (tx) => {
    const [message] = await tx.select().from(outputMessage).where(and(
      eq(outputMessage.client, input.client),
      eq(outputMessage.materialDocumentNumber, input.documentNumber),
      eq(outputMessage.outputType, input.outputType),
      eq(outputMessage.transmissionMedium, input.transmissionMedium),
    ));
    if (!message) {
      throw new MaterialDocumentOutputError(
        `No ${input.outputType} output stands for material document ${input.documentNumber}.`,
        'Determine the outputs first.',
      );
    }
    const [updated] = await tx.update(outputMessage).set({
      recipient: recipient || null,
      printerQueue: printerQueue || null,
      changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(outputMessage.client, input.client),
      eq(outputMessage.materialDocumentNumber, input.documentNumber),
      eq(outputMessage.outputType, input.outputType),
      eq(outputMessage.transmissionMedium, input.transmissionMedium),
    )).returning();

    return {
      documentNumber: updated.materialDocumentNumber,
      documentYear: updated.documentYear,
      postingDate: '',
      documentDate: '',
      outputType: updated.outputType,
      outputTypeDescription: '',
      transmissionMedium: updated.transmissionMedium,
      dispatchTime: updated.dispatchTime,
      status: updated.status,
      statusCode: STATUS_ALIASES[updated.status as OutputStatus] ?? '?',
      sendCount: updated.sendCount,
      recipient: updated.recipient,
      printerQueue: updated.printerQueue,
      lastProcessedAt: updated.lastProcessedAt ? new Date(updated.lastProcessedAt).toISOString() : null,
      errorText: updated.errorText,
      plants: [],
      companyCodes: [],
    };
  });
}
