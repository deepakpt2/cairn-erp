/**
 * Transfer posting — SCR-131 / MB1B.
 *
 * A transfer is one material document of two lines: an issuing line and a
 * receiving line of the same material and quantity, net zero. The movement
 * type is tenant data (the T156 shape) and carries the scenario: a storage
 * location move (311), a plant move (301) or a quality-to-unrestricted move
 * (321), each with the counter movement type its reversal posts.
 *
 * Stock moves under the same sufficiency rule for every scenario: the issuing
 * storage location must carry the quantity unless its configuration permits a
 * negative balance (`storage_location.allow_negative_stock`, operational here
 * for the first time). A plant move carries value between two valuation areas
 * and posts a journal only when the receiving plant is standard-priced and its
 * price differs from the value transferred; a move inside one plant carries no
 * value and posts nothing. Posted documents are immutable; correction is a
 * counter movement type.
 */
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, reverseJournalEntry, PostingError } from '../../platform/posting';
import { toBaseQuantity, UnitConversionError } from './unit-conversion';
import { accountDetermination, plant as plantTable, storageLocation } from '../foundation/schema';
import { materialPeriodAllows } from './material-period-control';
import { resolveStorageLocation, StorageLocationError } from './storage-location';
import { postingValuationRefusal } from './valuation-class-definition';
import { BatchPostingError, resolvePostingBatch } from './batch-posting';
import { recordOutputsForPostedDocument } from './material-document-output';
import {
  material, materialDocument, materialDocumentLine, materialPlant, materialValuation,
  movementType, stockQuantity,
} from './schema';
import { DELIVERED_TRANSFER_MOVEMENTS, type ScenarioKind, type TransferScenario } from './transfer-scenarios';
import { assertInventoryCountOpen, lockStockScope, PhysicalInventoryError } from './physical-inventory';
import {
  applyValuationDelta, lockRequestKey, mismatchedRequest, postingFingerprint, REQUEST_MISMATCH_REMEDY,
} from './balance-update';

export { DELIVERED_TRANSFER_MOVEMENTS, TRANSFER_SCENARIOS } from './transfer-scenarios';

export const TRANSFER_POST_CAPABILITY = 'INV.TRANSFER.POST';
/** The FI document type a transfer's price difference posts under (a goods issue leaving the issuing plant). */
const JOURNAL_DOCUMENT_TYPE = 'WA';
const MATERIAL_DOCUMENT_CLASS = 'material_document';

export class TransferPostingError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'TransferPostingError';
    this.remedy = remedy;
  }
}

export type { TransferScenario } from './transfer-scenarios';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n: number) => Math.round(n * 100) / 100;

async function ensureMovements(tx: Tx, client: string, changedBy: string) {
  for (const m of DELIVERED_TRANSFER_MOVEMENTS) {
    await tx.insert(movementType).values({ client, ...m, createdBy: changedBy }).onConflictDoNothing();
  }
}

/**
 * The three-digit numbers are input aliases — what a person types — and stay in one map here. What
 * the alias *means* is not decided here: the `movement_type` row decides, from SCR-146 onward.
 * Before this, permitted dimensions, stock types and organizational rules were read out of a
 * TypeScript array, so a tenant could not change what a transfer was without a deploy.
 */
const MOVEMENT_ALIASES: Record<string, string> = {
  '311': 'TRANSFER_SLOC',
  '301': 'TRANSFER_PLANT',
  '321': 'TRANSFER_STYPE',
};

/** The counters, so a hand-entered counter is refused with its own movement named. */
const COUNTER_ALIASES: Record<string, [string, string]> = {
  '312': ['311', 'TRANSFER_SLOC_REV'],
  '302': ['301', 'TRANSFER_PLANT_REV'],
  '322': ['321', 'TRANSFER_STYPE_REV'],
};

/** Two-step movements canon does not carry — §14 requires them refused by name, never run one-step. */
const TWO_STEP_ALIASES: Record<string, string> = {
  '303': 'transfer to in-transit stock',
  '313': 'stock transfer to in-transit storage location',
  '315': 'in-transit to destination',
};

function scenarioFromRow(row: typeof movementType.$inferSelect, code: string): TransferScenario {
  const kind = row.movementKind as ScenarioKind;
  if (!['STORAGE_LOCATION', 'PLANT', 'STOCK_TYPE'].includes(kind)) {
    throw new TransferPostingError(
      `Movement ${row.movementType} is configured as ${row.movementKind}, which is not a one-step transfer.`,
      'Configure a transfer movement kind, or post the movement it names.',
    );
  }
  return {
    code,
    movementType: row.movementType,
    reversalMovementType: row.reversalMovementType ?? '',
    kind,
    description: row.description,
    fromStockType: row.sourceStockType ?? 'UNRESTRICTED',
    toStockType: row.destinationStockType ?? 'UNRESTRICTED',
    plantRule: row.plantRule as 'SAME' | 'DIFFERENT' | 'ANY',
    locationRule: row.locationRule as 'SAME' | 'DIFFERENT' | 'ANY',
    isTwoStep: row.isTwoStep,
    valuationRelevant: row.valuationRelevant,
    negativeStockPolicy: row.negativeStockPolicy as 'LOCATION' | 'FORBID',
  };
}

/**
 * Resolve the movement from configuration (§9, §10 step 3).
 *
 * Every refusal here names what the configuration says, because a rule a person cannot see is a
 * rule they cannot satisfy: a two-step movement says so, and a movement whose kind is not a
 * transfer says which kinds are. A batch requirement is not a missing master. The posting uses
 * the batch already entered.
 */
async function resolveScenario(
  tx: Tx, client: string, code: string,
): Promise<{ scenario: TransferScenario; requiresBatch: boolean }> {
  const trimmed = (code ?? '').trim();
  if (TWO_STEP_ALIASES[trimmed]) {
    throw new TransferPostingError(
      `Movement type ${trimmed} is a two-step transfer (${TWO_STEP_ALIASES[trimmed]}), which this canon does not carry.`,
      'A two-step transfer puts stock in transit, and canon has no in-transit stock dimension. Post a one-step transfer, or leave the goods where they are.',
    );
  }
  const counter = COUNTER_ALIASES[trimmed];
  if (counter) {
    throw new TransferPostingError(
      `Movement type ${trimmed} is the counter of ${counter[0]} and is posted only by reversing a transfer.`,
      `Reverse the transfer document that posted ${counter[0]}; the counter movement is not entered by hand.`,
    );
  }
  const movementName = MOVEMENT_ALIASES[trimmed];
  if (!movementName) {
    throw new TransferPostingError(
      `Movement type ${trimmed || '(empty)'} is not a transfer.`,
      'Transfer postings stand on 311 (storage location to storage location), 301 (plant to plant) or 321 (quality inspection to unrestricted).',
    );
  }

  const [row] = await tx.select().from(movementType).where(and(
    eq(movementType.client, client), eq(movementType.movementType, movementName),
  ));
  if (!row) {
    throw new TransferPostingError(
      `Movement ${movementName} (${trimmed}) does not stand in this tenant's movement catalogue.`,
      'Seed or configure the movement, then post the transfer.',
    );
  }
  if (row.isTwoStep) {
    throw new TransferPostingError(
      `Movement ${row.movementType} is configured as a two-step transfer, which this canon does not carry.`,
      'Canon has no in-transit stock dimension; post a one-step transfer instead.',
    );
  }
  // Serial, special stock and valuation type still have no master. A batch requirement is
  // judged after the entered batch is resolved, not refused here as a missing master.
  const unmet: string[] = [];
  if (row.requiresSerial) unmet.push('serial numbers (canon carries no serial-number master)');
  if (row.requiresSpecialStock) unmet.push('a special-stock category (canon carries stock as a named stock type)');
  if (row.requiresValuationType) unmet.push('a valuation type (canon carries no split valuation)');
  if (unmet.length > 0) {
    throw new TransferPostingError(
      `Movement ${row.movementType} requires ${unmet.join(', ')}, which this canon does not carry.`,
      'Clear the requirement in the movement catalogue, or use a movement that does not need it.',
    );
  }
  return { scenario: scenarioFromRow(row, trimmed), requiresBatch: row.requiresBatch };
}

/**
 * What the caller asked for, reduced to one string (§16).
 *
 * A replay is the *same* request arriving twice — a retried HTTP call, a double-clicked button.
 * A reused key with a different quantity is not a replay; it is a second posting wearing the first
 * one's name, and honouring it would silently drop it. So the key is stored with a fingerprint of
 * the payload that made it, and a mismatch is refused.
 */
function fingerprintOf(input: {
  movementTypeCode: string; materialNumber: string; quantity: number;
  issuingPlant: string; issuingStorageLocation: string;
  receivingPlant: string; receivingStorageLocation: string;
  postingDate: string; documentDate: string; entryUnit?: string; externalReference?: string;
  batch?: string;
}): string {
  const batch = (input.batch ?? '').trim().toUpperCase();
  const canonical = [
    input.movementTypeCode.trim(), input.materialNumber.trim().toUpperCase(),
    input.quantity.toFixed(6), input.entryUnit ?? '',
    input.issuingPlant.trim(), input.issuingStorageLocation.trim(),
    input.receivingPlant.trim(), input.receivingStorageLocation.trim(),
    input.postingDate, input.documentDate, input.externalReference?.trim() ?? '',
    ...(batch ? [batch] : []),
  ].join('|');
  // A digest, not the payload: the column is 64 characters and the comparison only needs equality.
  return createHash('sha256').update(canonical).digest('hex');
}

/** A replay returns the document; a reused key wearing a different payload is refused by name. */
async function replayOrRefuse(
  tx: Tx, client: string, requestKey: string, fingerprint: string,
): Promise<TransferDocumentView | null> {
  const existing = await existingByRequestKey(tx, client, requestKey);
  if (!existing) return null;
  const [header] = await tx.select().from(materialDocument).where(and(
    eq(materialDocument.client, client), eq(materialDocument.materialDocumentNumber, existing.materialDocumentNumber),
  ));
  if (header?.requestFingerprint && header.requestFingerprint !== fingerprint) {
    throw new TransferPostingError(
      `Request key ${requestKey} already posted ${existing.materialDocumentNumber}, and this is a different posting: the stored request does not match this one.`,
      'Post with a fresh request key, or repeat the original request exactly.',
    );
  }
  return existing;
}

async function existingByRequestKey(tx: Tx, client: string, requestKey: string) {
  const [header] = await tx.select().from(materialDocument).where(and(
    eq(materialDocument.client, client), eq(materialDocument.requestKey, requestKey),
  ));
  if (!header) return null;
  const lines = await tx.select().from(materialDocumentLine).where(and(
    eq(materialDocumentLine.client, client),
    eq(materialDocumentLine.materialDocumentNumber, header.materialDocumentNumber),
  )).orderBy(materialDocumentLine.lineNumber);
  return transferView(header, lines);
}

export interface TransferLineView {
  lineNumber: number;
  lineDirection: string;
  movementType: string;
  materialNumber: string;
  plant: string;
  storageLocation: string | null;
  stockType: string;
  batch: string;
  quantity: string;
  unit: string;
  value: string;
}

export interface TransferDocumentView {
  materialDocumentNumber: string;
  documentYear: number;
  documentDate: string;
  postingDate: string;
  headerText: string | null;
  externalReference: string | null;
  status: string;
  journalDocumentNumber: string | null;
  reversalOf: string | null;
  reversedBy: string | null;
  lines: TransferLineView[];
}

function transferView(
  header: typeof materialDocument.$inferSelect,
  lines: Array<typeof materialDocumentLine.$inferSelect>,
): TransferDocumentView {
  return {
    materialDocumentNumber: header.materialDocumentNumber,
    documentYear: header.documentYear,
    documentDate: header.documentDate,
    postingDate: header.postingDate,
    headerText: header.headerText,
    externalReference: header.externalReference,
    status: header.status,
    journalDocumentNumber: header.journalDocumentNumber,
    reversalOf: header.reversalOf,
    reversedBy: header.reversedBy,
    lines: lines.map((l) => ({
      lineNumber: l.lineNumber, lineDirection: l.lineDirection, movementType: l.movementType,
      materialNumber: l.materialNumber, plant: l.plant, storageLocation: l.storageLocation,
      stockType: l.stockType, batch: l.batchNumber, quantity: l.baseQuantity, unit: l.baseUnit, value: l.value,
    })),
  };
}

export async function getTransferDocument(client: string, number: string): Promise<TransferDocumentView | null> {
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(materialDocument).where(and(
      eq(materialDocument.client, client), eq(materialDocument.materialDocumentNumber, number),
    ));
    if (!header) return null;
    const lines = await tx.select().from(materialDocumentLine).where(and(
      eq(materialDocumentLine.client, client),
      eq(materialDocumentLine.materialDocumentNumber, number),
    )).orderBy(materialDocumentLine.lineNumber);
    return transferView(header, lines);
  });
}

export interface TransferStockRow {
  storageLocation: string;
  stockType: string;
  batchNumber: string;
  quantity: string;
}

/** What the issuing side holds today, for the screen to show before anything is posted. */
export async function transferStockAt(
  client: string, materialNumber: string, plant: string,
): Promise<TransferStockRow[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(stockQuantity).where(and(
      eq(stockQuantity.client, client),
      eq(stockQuantity.materialNumber, materialNumber),
      eq(stockQuantity.plant, plant),
    )).orderBy(stockQuantity.storageLocation, stockQuantity.stockType);
    return rows.map((r) => ({
      storageLocation: r.storageLocation, stockType: r.stockType,
      batchNumber: r.batchNumber, quantity: r.quantity,
    }));
  });
}

export interface PostTransferInput {
  client: string;
  changedBy: string;
  movementTypeCode: string;
  materialNumber: string;
  quantity: number;
  issuingPlant: string;
  issuingStorageLocation: string;
  receivingPlant: string;
  receivingStorageLocation: string;
  stockType?: string;
  postingDate: string;
  documentDate: string;
  headerText?: string;
  externalReference?: string;
  /** Required when the material is batch-managed. The batch must already stand. */
  batch?: string;
  requestKey: string;
}

interface PreparedPlant {
  plant: string;
  companyCode: string;
  valuation: typeof materialValuation.$inferSelect;
}

function requireDate(value: string, label: string): void {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TransferPostingError(`${label} ${value || '(empty)'} is not a date.`, 'Enter the date as YYYY-MM-DD.');
  }
}

async function loadPlant(
  tx: Tx, client: string, plant: string, materialNumber: string, role: string, companyCode: string | null,
): Promise<PreparedPlant> {
  const [row] = await tx.select().from(plantTable).where(and(
    eq(plantTable.client, client), eq(plantTable.plant, plant),
  ));
  if (!row) throw new TransferPostingError(`Plant ${plant} does not exist.`, `Enter a ${role} plant that stands in the enterprise structure.`);
  if (!row.companyCode) {
    throw new TransferPostingError(
      `Plant ${plant} carries no company code.`,
      'Assign the plant to a company code, then post the transfer.',
    );
  }
  if (companyCode && row.companyCode !== companyCode) {
    throw new TransferPostingError(
      `Plant ${plant} stands in company code ${row.companyCode}, not in ${companyCode} as the issuing plant does.`,
      'A cross-company stock transfer needs intercompany clearing, which this round does not carry; transfer inside one company code.',
    );
  }
  if (!row.isStorageSite) {
    throw new TransferPostingError(
      `Plant ${plant} is not a storage site.`,
      'Choose a plant that carries storage locations.',
    );
  }
  const [ext] = await tx.select().from(materialPlant).where(and(
    eq(materialPlant.client, client),
    eq(materialPlant.materialNumber, materialNumber),
    eq(materialPlant.plant, plant),
  ));
  if (!ext) {
    throw new TransferPostingError(
      `Material ${materialNumber} is not extended to ${role} plant ${plant}.`,
      `Extend the material to plant ${plant}, then post the transfer.`,
    );
  }
  if (ext.markedForDeletion) {
    throw new TransferPostingError(
      `Material ${materialNumber} is flagged for deletion in ${role} plant ${plant}.`,
      'Cancel the plant deletion flag, then post the transfer.',
    );
  }
  const [valuation] = await tx.select().from(materialValuation).where(and(
    eq(materialValuation.client, client),
    eq(materialValuation.materialNumber, materialNumber),
    eq(materialValuation.valuationArea, plant),
  ));
  if (!valuation || !valuation.valuationClass) {
    throw new TransferPostingError(
      `Material ${materialNumber} carries no valuation in ${role} plant ${plant}.`,
      'Complete the material valuation data, then post the transfer.',
    );
  }
  const classRefusal = await postingValuationRefusal(tx, client, materialNumber, valuation.valuationClass);
  if (classRefusal) {
    throw new TransferPostingError(classRefusal, 'Maintain a valuation class this material type permits, then post the transfer.');
  }
  return { plant, companyCode: row.companyCode, valuation };
}

async function loadStorageLocation(
  tx: Tx, client: string, plant: string, storageLocationCode: string, role: string,
): Promise<typeof storageLocation.$inferSelect> {
  try {
    const resolved = await resolveStorageLocation(tx, {
      client, plant, typed: storageLocationCode, required: true, applyPlantDefault: false,
      verb: role === 'issuing' ? 'Issue from' : 'Receive into',
    });
    return resolved.row!;
  } catch (caught) {
    if (caught instanceof StorageLocationError) throw new TransferPostingError(caught.message, caught.remedy);
    throw caught;
  }
}

async function stockAt(
  tx: Tx, client: string, materialNumber: string, plant: string, location: string, stockType: string,
  batch = '',
): Promise<number | null> {
  const [row] = await tx.select().from(stockQuantity).where(and(
    eq(stockQuantity.client, client),
    eq(stockQuantity.materialNumber, materialNumber),
    eq(stockQuantity.plant, plant),
    eq(stockQuantity.storageLocation, location),
    eq(stockQuantity.stockType, stockType),
    eq(stockQuantity.batchNumber, batch),
  ));
  return row ? Number(row.quantity) : null;
}

/** The sufficiency rule: the issuing side must cover it, unless the location permits a negative. */
async function requireStock(
  tx: Tx, client: string, materialNumber: string, plant: string, location: string,
  stockType: string, quantity: number, allowNegative: boolean, role: string, batch = '',
): Promise<void> {
  const held = await stockAt(tx, client, materialNumber, plant, location, stockType, batch);
  if ((held ?? 0) + 1e-9 < quantity && !allowNegative) {
    throw new TransferPostingError(
      `Stock of ${materialNumber} (${stockType}) in storage location ${location} of plant ${plant} is ${(held ?? 0).toFixed(3)}, short of the ${quantity.toFixed(3)} to move.`,
      `Reduce the quantity to what stands, or release negative stock on the ${role} storage location.`,
    );
  }
}

async function moveStock(
  tx: Tx, client: string, changedBy: string, row: {
    materialNumber: string; plant: string; storageLocation: string; stockType: string; batchNumber?: string;
  }, delta: number,
): Promise<void> {
  const batchNumber = row.batchNumber ?? '';
  const [existing] = await tx.select().from(stockQuantity).where(and(
    eq(stockQuantity.client, client),
    eq(stockQuantity.materialNumber, row.materialNumber),
    eq(stockQuantity.plant, row.plant),
    eq(stockQuantity.storageLocation, row.storageLocation),
    eq(stockQuantity.stockType, row.stockType),
    eq(stockQuantity.batchNumber, batchNumber),
  ));
  if (!existing) {
    await tx.insert(stockQuantity).values({
      client, materialNumber: row.materialNumber, plant: row.plant,
      storageLocation: row.storageLocation, stockType: row.stockType, batchNumber,
      quantity: String(delta), createdBy: changedBy,
    });
    return;
  }
  await tx.update(stockQuantity).set({
    quantity: sql`${stockQuantity.quantity} + ${delta}`,
    changedBy, changedAt: new Date(),
  }).where(and(
    eq(stockQuantity.client, client),
    eq(stockQuantity.materialNumber, row.materialNumber),
    eq(stockQuantity.plant, row.plant),
    eq(stockQuantity.storageLocation, row.storageLocation),
    eq(stockQuantity.stockType, row.stockType),
    eq(stockQuantity.batchNumber, batchNumber),
  ));
}

async function moveValuation(
  tx: Tx, client: string, changedBy: string, prepared: PreparedPlant,
  quantityDelta: number, valueDelta: number,
): Promise<void> {
  const v = prepared.valuation;
  await applyValuationDelta(
    tx, client, changedBy, v.materialNumber, v.valuationArea, quantityDelta, valueDelta,
  );
}

async function resolveAccount(
  tx: Tx, client: string, chart: string, event: string, valuationClass: string,
): Promise<string> {
  const rows = await tx.select().from(accountDetermination).where(and(
    eq(accountDetermination.client, client),
    eq(accountDetermination.chartOfAccounts, chart),
    eq(accountDetermination.event, event),
  ));
  const row = rows.find((r) => r.valuationClass === valuationClass) ?? rows.find((r) => r.valuationClass === '');
  if (!row) {
    throw new TransferPostingError(
      `Account determination for ${event}${valuationClass ? ` and valuation class ${valuationClass}` : ''} does not stand in chart ${chart}.`,
      'Maintain the account determination for this event, then post again.',
    );
  }
  return row.glAccount;
}

/** The material period judges the posting date before anything moves (OMSY). */
async function judgePeriod(tx: Tx, client: string, plant: string, postingDate: string) {
  const [plantRow] = await tx.select().from(plantTable).where(and(
    eq(plantTable.client, client), eq(plantTable.plant, plant),
  ));
  const company = await getCompanyCode(tx, client, plantRow!.companyCode!);
  if (!company?.fiscalYearVariant) {
    throw new TransferPostingError(`Company code ${plantRow!.companyCode} is not configured.`);
  }
  const position = await derivePosition(tx, client, company.fiscalYearVariant, postingDate);
  const rows = await tx.execute(sql`
    select current_fiscal_year, current_period, previous_fiscal_year, previous_period,
           allow_backposting, disallow_backposting_after_change
    from material_period_control where client = ${client} and company_code = ${plantRow!.companyCode}
  `) as unknown as Array<{
    current_fiscal_year: number; current_period: number;
    previous_fiscal_year: number; previous_period: number;
    allow_backposting: boolean; disallow_backposting_after_change: boolean;
  }>;
  const record = rows[0]
    ? {
        companyCode: plantRow!.companyCode!,
        currentFiscalYear: Number(rows[0].current_fiscal_year),
        currentPeriod: Number(rows[0].current_period),
        previousFiscalYear: Number(rows[0].previous_fiscal_year),
        previousPeriod: Number(rows[0].previous_period),
        allowBackposting: Boolean(rows[0].allow_backposting),
        disallowBackpostingAfterChange: Boolean(rows[0].disallow_backposting_after_change),
      }
    : null;
  if (!materialPeriodAllows(record, position.fiscalYear, position.period)) {
    throw new TransferPostingError(
      `The material posting period ${position.fiscalYear}/${position.period} is closed for company ${plantRow!.companyCode}.`,
      'Post into the open material period, or shift the material period first.',
    );
  }
  return { company, position };
}

function splitJournalKey(key: string): [number, string] {
  const parts = key.split('/');
  return [Number(parts[1]), parts.slice(2).join('/')];
}

/** What a posting needs to know before it writes one row — and what a dry run answers with. */
export interface TransferPreflight {
  scenario: TransferScenario;
  mat: typeof material.$inferSelect;
  entryUnit: string;
  entryQuantity: number;
  quantity: number;
  issuing: Awaited<ReturnType<typeof loadPlant>>;
  receiving: Awaited<ReturnType<typeof loadPlant>>;
  issuingLocation: Awaited<ReturnType<typeof loadStorageLocation>>;
  receivingLocation: Awaited<ReturnType<typeof loadStorageLocation>>;
  company: { companyCode: string; chartOfAccounts: string; currency: string };
  position: { fiscalYear: number; period: number };
  q: number;
  valueMoves: boolean;
  movedValue: number;
  receivingValue: number;
  stockOnHand: number;
  batch: string;
}

/**
 * Every judgement the posting makes before it writes, in one place (§12, §16).
 *
 * The API validates the request shape; this repeats the judgements that depend on live data —
 * configuration, master data, period, count block, stock — inside the transaction that would post,
 * so a document can never pass validation in one instant and fail halfway in another. The same
 * function answers a dry run, which is why it writes nothing: `validateTransfer` has no way to
 * reach a writer because the writer starts after this returns.
 */
async function preflight(
  tx: Tx, client: string, changedBy: string, input: PostTransferInput, materialNumber: string,
): Promise<TransferPreflight> {
  await ensureMovements(tx, client, changedBy);
  // The advisory lock is taken before the material is read — deliberately earlier than §10's step
  // order, because a lock taken after the read leaves a window in which two postings both see the
  // same stock. The lock is on the material, so a transfer and a reversal of it serialise.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/transfer/${materialNumber}`}, 0))`);
  await lockStockScope(tx, client, [materialNumber], 'EXCLUSIVE');
  const { scenario, requiresBatch } = await resolveScenario(tx, client, input.movementTypeCode);

  const [mat] = await tx.select().from(material).where(and(
  eq(material.client, input.client), eq(material.materialNumber, materialNumber),
  ));
  if (!mat) throw new TransferPostingError(`Material ${materialNumber} does not exist.`);
  if (mat.markedForDeletion) {
    throw new TransferPostingError(`Material ${materialNumber} is flagged for deletion.`, 'Cancel the deletion flag, then post again.');
  }
  if (!mat.baseUnit) {
    throw new TransferPostingError(
    `Material ${materialNumber} carries no base unit.`,
    'Complete the material master, then post the transfer.',
    );
  }

  // SCR-144: a quantity entered in an alternative unit becomes the base quantity the ledger
  // records, at the material's own ratio. A unit with no conversion is refused by name.
  const entryUnit = input.entryUnit ?? mat.baseUnit;
  let quantity = input.quantity;
  if (entryUnit !== mat.baseUnit) {
    try {
      const conversion = await toBaseQuantity(tx, input.client, {
        materialNumber, quantity: input.quantity, entryUnit,
      });
      quantity = conversion.baseQuantity;
    } catch (caught) {
      if (caught instanceof UnitConversionError) {
        throw new TransferPostingError(caught.message, caught.remedy);
      }
      throw caught;
    }
  }

  // Scenario structure, judged before anything is read for stock — and judged from
  // configuration (SCR-146): the movement's own plant_rule and location_rule say what may change,
  // so the rules can differ per tenant without a line of TypeScript changing.
  const samePlant = input.issuingPlant === input.receivingPlant;
  if (scenario.plantRule === 'SAME' && !samePlant) {
    throw new TransferPostingError(
    `Movement ${scenario.movementType} (${scenario.code}) moves inside one plant, and the configuration says so; but the receiving plant ${input.receivingPlant} differs from ${input.issuingPlant}.`,
    `Name the same plant on both sides, or post a movement whose plant rule is DIFFERENT.`,
    );
  }
  if (scenario.plantRule === 'DIFFERENT' && samePlant) {
    throw new TransferPostingError(
    `Movement ${scenario.movementType} (${scenario.code}) moves between plants, and the configuration says so; but both sides name plant ${input.issuingPlant}.`,
    'Name a different receiving plant, or post a movement whose plant rule is SAME.',
    );
  }
  const sameLocation = input.issuingStorageLocation === input.receivingStorageLocation;
  if (scenario.locationRule === 'SAME' && !sameLocation) {
    throw new TransferPostingError(
    `Movement ${scenario.movementType} (${scenario.code}) moves inside one storage location, and the configuration says so; but ${input.issuingStorageLocation} and ${input.receivingStorageLocation} differ.`,
    'Name the same storage location on both sides.',
    );
  }
  if (scenario.locationRule === 'DIFFERENT' && sameLocation) {
    throw new TransferPostingError(
    `Movement ${scenario.movementType} (${scenario.code}) moves between storage locations, and the configuration says so; but both sides name ${input.issuingStorageLocation}.`,
    'Name a different receiving storage location.',
    );
  }
  const namedStockType = (input.stockType ?? '').trim().toUpperCase();
  if (namedStockType && namedStockType !== scenario.fromStockType) {
    throw new TransferPostingError(
    `Movement type ${scenario.code} takes stock from ${scenario.fromStockType}, not ${namedStockType}.`,
    `Leave the stock type empty, or name ${scenario.fromStockType}.`,
    );
  }

  const issuing = await loadPlant(tx, input.client, input.issuingPlant, materialNumber, 'issuing', null);
  const receiving = await loadPlant(tx, input.client, input.receivingPlant, materialNumber, 'receiving', issuing.companyCode);
  if (issuing.valuation.currency !== receiving.valuation.currency) {
    throw new TransferPostingError(
    'The two valuation areas do not share a currency.',
    'Post the transfer inside one valuation currency.',
    );
  }

  const issuingLocation = await loadStorageLocation(tx, input.client, input.issuingPlant, input.issuingStorageLocation, 'issuing');
  const receivingLocation = await loadStorageLocation(tx, input.client, input.receivingPlant, input.receivingStorageLocation, 'receiving');

  const { company, position } = await judgePeriod(tx, input.client, input.issuingPlant, input.postingDate);

  // SCR-142: an open count with a posting block refuses the movement for this material here.
  try {
    await assertInventoryCountOpen(tx, input.client, {
      materialNumber, plant: input.issuingPlant, storageLocation: issuingLocation.storageLocation,
      batch: input.batch,
    });
    await assertInventoryCountOpen(tx, input.client, {
      materialNumber, plant: input.receivingPlant, storageLocation: receivingLocation.storageLocation,
      batch: input.batch,
    });
  } catch (caught) {
    if (caught instanceof PhysicalInventoryError) {
      throw new TransferPostingError(caught.message, caught.remedy);
    }
    throw caught;
  }

  let batch = '';
  try {
    batch = await resolvePostingBatch(tx, {
      client: input.client, materialNumber, plant: input.issuingPlant, batch: input.batch, postingDate: input.postingDate,
    });
    if (input.receivingPlant !== input.issuingPlant) {
      await resolvePostingBatch(tx, {
        client: input.client, materialNumber, plant: input.receivingPlant, batch: input.batch, postingDate: input.postingDate,
      });
    }
  } catch (caught) {
    if (caught instanceof BatchPostingError) throw new TransferPostingError(caught.message, caught.remedy);
    throw caught;
  }
  if (requiresBatch && !batch) {
    throw new TransferPostingError(
      `Movement ${scenario.movementType} requires a batch. No stock was posted.`,
      'Enter a batch that already stands. This posting does not create a batch.',
    );
  }

  await requireStock(
  tx, input.client, materialNumber, input.issuingPlant, issuingLocation.storageLocation,
  scenario.fromStockType, quantity,
  scenario.negativeStockPolicy === 'FORBID' ? false : issuingLocation.allowNegativeStock,
  'issuing', batch,
  );

  // Value: a move inside one plant changes none; a move between plants carries it — but only
  // when the movement's configuration says it is valuation-relevant (SCR-146, §11).
  const valueMoves = scenario.kind === 'PLANT' && scenario.valuationRelevant;
  const q = quantity;
  let movedValue = 0;
  let receivingValue = 0;
  if (scenario.kind === 'PLANT') {
    const issuingUnit = issuing.valuation.priceControl === 'STANDARD'
    ? Number(issuing.valuation.standardPrice) / Number(issuing.valuation.priceUnit)
    : Number(issuing.valuation.movingAveragePrice) / Number(issuing.valuation.priceUnit);
    movedValue = round2(q * issuingUnit);
    receivingValue = receiving.valuation.priceControl === 'STANDARD'
    ? round2((q * Number(receiving.valuation.standardPrice)) / Number(receiving.valuation.priceUnit))
    : movedValue;
  }

  const stockOnHand = (await stockAt(
  tx, client, materialNumber, input.issuingPlant,
  issuingLocation.storageLocation, scenario.fromStockType, batch,
  )) ?? 0;

  return {
    scenario, mat, entryUnit, entryQuantity: input.quantity, quantity, q,
    issuing, receiving, issuingLocation, receivingLocation, company, position,
    valueMoves, movedValue, receivingValue, stockOnHand, batch,
  };
}

export interface TransferValidation {
  accepted: true;
  movement: {
    code: string; movementType: string; description: string;
    twoStep: boolean; valuationRelevant: boolean; negativeStockPolicy: string;
  };
  entry: { quantity: number; unit: string };
  base: { quantity: number; unit: string };
  from: { plant: string; storageLocation: string; stockType: string };
  to: { plant: string; storageLocation: string; stockType: string };
  stock: { onHand: number; after: number };
  value: { moves: boolean; issuing: number; receiving: number; journalExpected: boolean };
  period: { fiscalYear: number; period: number; postingDate: string };
  notes: string[];
}

/**
 * Answer what a transfer would do, without doing it (§16: "`validate` posts nothing").
 *
 * It runs the same `preflight` the posting runs, then stops — the writer lives past that boundary,
 * so there is no branch here that could post. A refusal arrives as the same `TransferPostingError`
 * a posting would raise, with the same words, because a preview that says "fine" and then fails is
 * worse than no preview.
 */
export async function validateTransfer(
  input: Omit<PostTransferInput, 'requestKey'>,
): Promise<TransferValidation> {
  requireDate(input.postingDate, 'The posting date');
  requireDate(input.documentDate, 'The document date');
  if ((input.headerText ?? '').length > 25) {
    throw new TransferPostingError('The header text is longer than 25 characters.', 'Shorten the header text.');
  }
  if (!(input.quantity > 0)) {
    throw new TransferPostingError('The transfer quantity must be positive.', 'Enter a quantity greater than zero.');
  }
  const materialNumber = input.materialNumber.trim();
  if (!materialNumber) throw new TransferPostingError('A material is required.', 'Enter the material being transferred.');

  return withTenant(input.client, async (tx) => {
    const pre = await preflight(tx, input.client, input.changedBy, { ...input, requestKey: 'validate' }, materialNumber);
    const journalExpected = pre.valueMoves
      && round2(pre.receivingValue - pre.movedValue) !== 0;

    const notes: string[] = [];
    if (pre.valueMoves) {
      notes.push(
        journalExpected
          ? `Value moves and the receiving plant values it differently: a journal posts for ${round2(pre.receivingValue - pre.movedValue).toFixed(2)}.`
          : 'Value moves with the goods at the same rate; no journal posts.',
      );
    } else {
      notes.push('No valuation change: this move stays inside one valuation area.');
    }
    if (pre.scenario.negativeStockPolicy === 'FORBID') {
      notes.push('The movement forbids a negative balance at the issuing location.');
    } else if (pre.issuingLocation.allowNegativeStock) {
      notes.push('The issuing location permits a negative balance.');
    }
    if (pre.scenario.reversalMovementType) {
      notes.push(`A reversal would post ${pre.scenario.reversalMovementType}.`);
    }

    return {
      accepted: true as const,
      movement: {
        code: pre.scenario.code, movementType: pre.scenario.movementType,
        description: pre.scenario.description, twoStep: pre.scenario.isTwoStep,
        valuationRelevant: pre.scenario.valuationRelevant,
        negativeStockPolicy: pre.scenario.negativeStockPolicy,
      },
      entry: { quantity: pre.entryQuantity, unit: pre.entryUnit },
      base: { quantity: pre.quantity, unit: pre.mat.baseUnit },
      from: {
        plant: input.issuingPlant, storageLocation: pre.issuingLocation.storageLocation,
        stockType: pre.scenario.fromStockType,
      },
      to: {
        plant: input.receivingPlant, storageLocation: pre.receivingLocation.storageLocation,
        stockType: pre.scenario.toStockType,
      },
      stock: {
        onHand: pre.stockOnHand,
        after: round2(pre.stockOnHand - pre.quantity),
      },
      value: {
        moves: pre.valueMoves, issuing: pre.movedValue,
        receiving: pre.receivingValue, journalExpected,
      },
      period: {
        fiscalYear: pre.position.fiscalYear, period: pre.position.period,
        postingDate: input.postingDate,
      },
      notes,
    };
  });
}

export async function postTransfer(input: PostTransferInput): Promise<TransferDocumentView> {
  requireDate(input.postingDate, 'The posting date');
  requireDate(input.documentDate, 'The document date');
  if ((input.headerText ?? '').length > 25) {
    throw new TransferPostingError('The header text is longer than 25 characters.', 'Shorten the header text.');
  }
  if (!(input.quantity > 0)) {
    throw new TransferPostingError('The transfer quantity must be positive.', 'Enter a quantity greater than zero.');
  }
  const materialNumber = input.materialNumber.trim();
  if (!materialNumber) throw new TransferPostingError('A material is required.', 'Enter the material being transferred.');

  return withTenant(input.client, async (tx) => {
    await lockRequestKey(tx, input.client, input.requestKey);
    const replay = await replayOrRefuse(tx, input.client, input.requestKey, fingerprintOf(input));
    if (replay) return replay;

    const pre = await preflight(tx, input.client, input.changedBy, input, materialNumber);
    const {
      scenario, mat, entryUnit, quantity, issuing, receiving,
      issuingLocation, receivingLocation, company, position,
      valueMoves, movedValue, receivingValue, q, batch,
    } = pre;

    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: 'MATDOC', allocatedBy: input.changedBy,
    });
    const number = allocated.display;

    // A price difference stands only when the movement's configuration says value moves and a
    // standard-priced receiving plant values the stock differently from what was transferred —
    // SAP posts no journal otherwise. §11: never assume cross-plant means a valuation change.
    let journalNumber: string | null = null;
    if (valueMoves && round2(receivingValue - movedValue) !== 0) {
      const chart = company.chartOfAccounts as string;
      const receivingAccount = await resolveAccount(tx, input.client, chart, 'INVENTORY', receiving.valuation.valuationClass!);
      const issuingAccount = await resolveAccount(tx, input.client, chart, 'INVENTORY', issuing.valuation.valuationClass!);
      const difference = round2(receivingValue - movedValue);
      const lines = [
        { glAccount: receivingAccount, debitCredit: 'S' as const, amount: receivingValue.toFixed(2), material: materialNumber, plant: input.receivingPlant },
        { glAccount: issuingAccount, debitCredit: 'H' as const, amount: movedValue.toFixed(2), material: materialNumber, plant: input.issuingPlant },
      ];
      if (difference !== 0) {
        const pdAccount = await resolveAccount(tx, input.client, chart, 'PRICE_DIFFERENCE', receiving.valuation.valuationClass!);
        lines.push({
          glAccount: pdAccount, debitCredit: difference > 0 ? 'H' : 'S',
          amount: Math.abs(difference).toFixed(2), material: materialNumber, plant: input.receivingPlant,
        });
      }
      const journal = await postJournalEntry(tx, {
        client: input.client,
        companyCode: issuing.companyCode,
        documentType: JOURNAL_DOCUMENT_TYPE,
        documentDate: input.documentDate,
        postingDate: input.postingDate,
        fiscalYear: position.fiscalYear,
        postingPeriod: position.period,
        currency: company.currency as string,
        localCurrency: company.currency as string,
        reference: `TRANSFER ${scenario.code}`,
        headerText: input.headerText,
        lines,
        origin: { documentClass: MATERIAL_DOCUMENT_CLASS, documentKey: number },
        postedBy: input.changedBy,
        transactionCode: TRANSFER_POST_CAPABILITY,
      }).catch((error: unknown) => {
        if (error instanceof PostingError) throw new TransferPostingError(error.message, error.remedy);
        throw error;
      });
      journalNumber = journal.documentNumber;
    }

    await tx.insert(materialDocument).values({
      client: input.client, materialDocumentNumber: number, documentYear: position.fiscalYear,
      documentDate: input.documentDate, postingDate: input.postingDate,
      headerText: input.headerText ?? null, status: 'POSTED',
      externalReference: input.externalReference?.trim() || null,
      journalDocumentNumber: journalNumber, requestKey: input.requestKey,
      requestFingerprint: fingerprintOf(input),
      createdBy: input.changedBy,
    });

    const issuingValue = movedValue;
    const receivingLineValue = receivingValue;
    const unit = mat.baseUnit;

    const issueLine: typeof materialDocumentLine.$inferInsert = {
      client: input.client, materialDocumentNumber: number, lineNumber: 1,
      movementType: scenario.movementType, lineDirection: 'ISSUE',
      materialNumber, plant: input.issuingPlant,
      storageLocation: issuingLocation.storageLocation, stockType: scenario.fromStockType,
      batchNumber: batch,
      entryQuantity: String(input.entryQuantity ?? input.quantity), entryUnit,
      baseQuantity: String(q), baseUnit: unit,
      unitPrice: scenario.kind === 'PLANT' ? String(round2(issuingValue / q)) : '0',
      priceUnit: '1', currency: company.currency as string, value: String(issuingValue),
      itemText: `Transfer ${scenario.code}`,
      createdBy: input.changedBy,
    };
    await tx.insert(materialDocumentLine).values(issueLine);
    const receiptLine: typeof materialDocumentLine.$inferInsert = {
      client: input.client, materialDocumentNumber: number, lineNumber: 2,
      movementType: scenario.movementType, lineDirection: 'RECEIPT',
      materialNumber, plant: input.receivingPlant,
      storageLocation: receivingLocation.storageLocation, stockType: scenario.toStockType,
      batchNumber: batch,
      entryQuantity: String(input.entryQuantity ?? input.quantity), entryUnit,
      baseQuantity: String(q), baseUnit: unit,
      unitPrice: scenario.kind === 'PLANT' ? String(round2(receivingLineValue / q)) : '0',
      priceUnit: '1', currency: company.currency as string, value: String(receivingLineValue),
      itemText: `Transfer ${scenario.code}`,
      createdBy: input.changedBy,
    };
    await tx.insert(materialDocumentLine).values(receiptLine);

    await moveStock(tx, input.client, input.changedBy, {
      materialNumber, plant: input.issuingPlant,
      storageLocation: issuingLocation.storageLocation, stockType: scenario.fromStockType, batchNumber: batch,
    }, -q);
    await moveStock(tx, input.client, input.changedBy, {
      materialNumber, plant: input.receivingPlant,
      storageLocation: receivingLocation.storageLocation, stockType: scenario.toStockType, batchNumber: batch,
    }, q);

    if (valueMoves) {
      await moveValuation(tx, input.client, input.changedBy, issuing, -q, -movedValue);
      await moveValuation(tx, input.client, input.changedBy, receiving, q, receivingValue);
    }

    await recordChange(tx, {
      client: input.client,
      objectClass: MATERIAL_DOCUMENT_CLASS,
      objectKey: number,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: TRANSFER_POST_CAPABILITY,
      after: {
        movement: scenario.movementType, transfer: scenario.code, quantity: q,
        from: `${input.issuingPlant}/${issuingLocation.storageLocation}/${scenario.fromStockType}`,
        to: `${input.receivingPlant}/${receivingLocation.storageLocation}/${scenario.toStockType}`,
        journal: journalNumber, status: 'POSTED',
      },
    });

    // SCR-135: the document carries its output with it, determined as it posts.
    await recordOutputsForPostedDocument(tx, input.client, number, input.changedBy);

    return (await existingByRequestKey(tx, input.client, input.requestKey))!;
  });
}

export interface ReverseTransferInput {
  client: string;
  changedBy: string;
  materialDocumentNumber: string;
  postingDate: string;
  documentDate: string;
  requestKey: string;
}

export async function reverseTransfer(input: ReverseTransferInput): Promise<TransferDocumentView> {
  requireDate(input.postingDate, 'The posting date');
  requireDate(input.documentDate, 'The document date');
  const fingerprint = postingFingerprint([
    'TR-REV', input.materialDocumentNumber.trim(), input.postingDate, input.documentDate,
  ]);

  return withTenant(input.client, async (tx) => {
    await lockRequestKey(tx, input.client, input.requestKey);
    const replay = await existingByRequestKey(tx, input.client, input.requestKey);
    if (replay) {
      const mismatch = await mismatchedRequest(tx, input.client, input.requestKey, fingerprint);
      if (mismatch) throw new TransferPostingError(mismatch, REQUEST_MISMATCH_REMEDY);
      return replay;
    }

    await ensureMovements(tx, input.client, input.changedBy);

    const [original] = await tx.select().from(materialDocument).where(and(
      eq(materialDocument.client, input.client),
      eq(materialDocument.materialDocumentNumber, input.materialDocumentNumber),
    ));
    if (!original) throw new TransferPostingError(`Material document ${input.materialDocumentNumber} does not exist.`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/reverse/${input.materialDocumentNumber}`}, 0))`);
    const [locked] = await tx.select().from(materialDocument).where(and(
      eq(materialDocument.client, input.client),
      eq(materialDocument.materialDocumentNumber, input.materialDocumentNumber),
    ));
    if (!locked) throw new TransferPostingError(`Material document ${input.materialDocumentNumber} does not exist.`);
    if (locked.reversalOf) {
      throw new TransferPostingError('A reversal document cannot itself be reversed.', 'Reverse the original document instead.');
    }
    if (locked.status === 'REVERSED') {
      throw new TransferPostingError(
        `Material document ${input.materialDocumentNumber} has already been reversed by ${locked.reversedBy}.`,
      );
    }
    const lines = await tx.select().from(materialDocumentLine).where(and(
      eq(materialDocumentLine.client, input.client),
      eq(materialDocumentLine.materialDocumentNumber, input.materialDocumentNumber),
    )).orderBy(materialDocumentLine.lineNumber);
    const issue = lines.find((l) => l.lineDirection === 'ISSUE');
    const receipt = lines.find((l) => l.lineDirection === 'RECEIPT');
    if (!issue?.materialNumber || !receipt) {
      throw new TransferPostingError(
        `Material document ${input.materialDocumentNumber} is not a transfer.`,
        'Only a transfer document carries an issuing and a receiving line; reverse a goods receipt from its own screen.',
      );
    }
    await lockStockScope(tx, input.client, [issue.materialNumber], 'EXCLUSIVE');
    const [movement] = await tx.select().from(movementType).where(and(
      eq(movementType.client, input.client), eq(movementType.movementType, issue.movementType),
    ));
    if (!movement?.reversalMovementType) {
      throw new TransferPostingError(
        `Movement type ${issue.movementType} carries no counter movement type.`,
        'The movement catalogue is incomplete for this transfer.',
      );
    }
    const [counter] = await tx.select().from(movementType).where(and(
      eq(movementType.client, input.client), eq(movementType.movementType, movement.reversalMovementType),
    ));
    if (!counter) {
      throw new TransferPostingError(
        `Counter movement type ${movement.reversalMovementType} does not stand in the catalogue.`,
        'Complete the movement catalogue, then reverse.',
      );
    }

    const quantity = Number(issue.baseQuantity);
    const [returningLocation] = await tx.select().from(storageLocation).where(and(
      eq(storageLocation.client, input.client),
      eq(storageLocation.plant, receipt.plant),
      eq(storageLocation.storageLocation, receipt.storageLocation ?? ''),
    ));
    await requireStock(
      tx, input.client, issue.materialNumber, receipt.plant, receipt.storageLocation ?? '',
      receipt.stockType, quantity, Boolean(returningLocation?.allowNegativeStock), 'receiving',
      receipt.batchNumber ?? '',
    );

    const { position } = await judgePeriod(tx, input.client, issue.plant, input.postingDate);

    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: 'MATDOC', allocatedBy: input.changedBy,
    });
    const number = allocated.display;

    let journalNumber: string | null = null;
    if (original.journalDocumentNumber) {
      const [journalYear] = splitJournalKey(original.journalDocumentNumber);
      const reversed = await reverseJournalEntry(tx, {
        client: input.client,
        documentNumber: original.journalDocumentNumber,
        fiscalYear: journalYear,
        reversalDate: input.postingDate,
        reason: `Transfer reversal ${number}`,
        reversedBy: input.changedBy,
        transactionCode: TRANSFER_POST_CAPABILITY,
      }).catch((error: unknown) => {
        if (error instanceof PostingError) throw new TransferPostingError(error.message, error.remedy);
        throw error;
      });
      journalNumber = reversed.documentNumber;
    }

    await tx.insert(materialDocument).values({
      client: input.client, materialDocumentNumber: number, documentYear: position.fiscalYear,
      documentDate: input.documentDate, postingDate: input.postingDate,
      headerText: `Reversal of ${input.materialDocumentNumber}`, status: 'POSTED',
      journalDocumentNumber: journalNumber, reversalOf: input.materialDocumentNumber,
      requestKey: input.requestKey, requestFingerprint: fingerprint, createdBy: input.changedBy,
    });

    // The sides swap: the reversal issues from where the transfer arrived.
    const reverseLines = [
      { lineNumber: 1, direction: 'ISSUE', from: receipt, value: Number(receipt.value) },
      { lineNumber: 2, direction: 'RECEIPT', from: issue, value: Number(issue.value) },
    ];
    for (const line of reverseLines) {
      await tx.insert(materialDocumentLine).values({
        client: input.client, materialDocumentNumber: number, lineNumber: line.lineNumber,
        movementType: counter.movementType, lineDirection: line.direction,
        materialNumber: line.from.materialNumber, plant: line.from.plant,
        storageLocation: line.from.storageLocation, stockType: line.from.stockType,
        batchNumber: line.from.batchNumber,
        entryQuantity: line.from.entryQuantity, entryUnit: line.from.entryUnit,
        baseQuantity: line.from.baseQuantity, baseUnit: line.from.baseUnit,
        unitPrice: line.from.unitPrice, priceUnit: line.from.priceUnit, currency: line.from.currency,
        value: String(line.value),
        reversalOfDocument: input.materialDocumentNumber, reversalOfLine: line.from.lineNumber,
        itemText: `Reversal of ${input.materialDocumentNumber}`,
        createdBy: input.changedBy,
      });
      await moveStock(tx, input.client, input.changedBy, {
        materialNumber: line.from.materialNumber, plant: line.from.plant,
        storageLocation: line.from.storageLocation ?? '', stockType: line.from.stockType,
        batchNumber: line.from.batchNumber ?? '',
      }, line.direction === 'ISSUE' ? -Number(line.from.baseQuantity) : Number(line.from.baseQuantity));
    }

    // Whether a reversal carries value is the counter movement's own configuration, never the
    // accident that the two plants differ (§13, §11). The forward posting asked the same question
    // of the movement that posted it; a reversal that decided differently would either move value
    // the transfer never moved, or leave value behind that it did.
    const reversalMovesValue = Boolean(movement.valuationRelevant) && Boolean(counter.valuationRelevant);
    if (reversalMovesValue) {
      for (const [plant, quantityDelta, valueDelta] of [
        [receipt.plant, -quantity, -Number(receipt.value)],
        [issue.plant, quantity, Number(issue.value)],
      ] as Array<[string, number, number]>) {
        const [valuation] = await tx.select().from(materialValuation).where(and(
          eq(materialValuation.client, input.client),
          eq(materialValuation.materialNumber, issue.materialNumber),
          eq(materialValuation.valuationArea, plant),
        ));
        if (valuation) {
          await moveValuation(tx, input.client, input.changedBy, {
            plant, companyCode: '', valuation,
          }, quantityDelta, valueDelta);
        }
      }
    }

    await tx.update(materialDocument).set({
      status: 'REVERSED', reversedBy: number, changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(materialDocument.client, input.client),
      eq(materialDocument.materialDocumentNumber, input.materialDocumentNumber),
    ));

    await recordChange(tx, {
      client: input.client,
      objectClass: MATERIAL_DOCUMENT_CLASS,
      objectKey: number,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: TRANSFER_POST_CAPABILITY,
      after: {
        movement: counter.movementType, reversalOf: input.materialDocumentNumber,
        journal: journalNumber, status: 'POSTED',
      },
    });

    // SCR-135: the document carries its output with it, determined as it posts.
    await recordOutputsForPostedDocument(tx, input.client, number, input.changedBy);

    return (await existingByRequestKey(tx, input.client, input.requestKey))!;
  });
}
