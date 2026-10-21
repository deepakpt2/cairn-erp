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
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, reverseJournalEntry, PostingError } from '../../platform/posting';
import { accountDetermination, plant as plantTable, storageLocation } from '../foundation/schema';
import { materialPeriodAllows } from './material-period-control';
import { recordOutputsForPostedDocument } from './material-document-output';
import {
  material, materialDocument, materialDocumentLine, materialPlant, materialValuation,
  movementType, stockQuantity,
} from './schema';
import { COUNTER_CODES, DELIVERED_TRANSFER_MOVEMENTS, TRANSFER_SCENARIOS, type TransferScenario } from './transfer-scenarios';
import { assertInventoryCountOpen, PhysicalInventoryError } from './physical-inventory';

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

async function resolveScenario(code: string): Promise<TransferScenario> {
  const found = TRANSFER_SCENARIOS.find((s) => s.code === code);
  if (found) return found;
  const counter = COUNTER_CODES[code];
  if (counter) {
    throw new TransferPostingError(
      `Movement type ${code} is the counter of ${counter[0]} and is posted only by reversing a transfer.`,
      `Reverse the transfer document that posted ${counter[0]}; the counter movement is not entered by hand.`,
    );
  }
  throw new TransferPostingError(
    `Movement type ${code || '(empty)'} is not a transfer.`,
    `Transfer postings stand on 311 (storage location to storage location), 301 (plant to plant) or 321 (quality inspection to unrestricted).`,
  );
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
    status: header.status,
    journalDocumentNumber: header.journalDocumentNumber,
    reversalOf: header.reversalOf,
    reversedBy: header.reversedBy,
    lines: lines.map((l) => ({
      lineNumber: l.lineNumber, lineDirection: l.lineDirection, movementType: l.movementType,
      materialNumber: l.materialNumber, plant: l.plant, storageLocation: l.storageLocation,
      stockType: l.stockType, quantity: l.baseQuantity, unit: l.baseUnit, value: l.value,
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
      storageLocation: r.storageLocation, stockType: r.stockType, quantity: r.quantity,
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
  return { plant, companyCode: row.companyCode, valuation };
}

async function loadStorageLocation(
  tx: Tx, client: string, plant: string, storageLocationCode: string, role: string,
): Promise<typeof storageLocation.$inferSelect> {
  const [row] = await tx.select().from(storageLocation).where(and(
    eq(storageLocation.client, client),
    eq(storageLocation.plant, plant),
    eq(storageLocation.storageLocation, storageLocationCode),
  ));
  if (!row) {
    throw new TransferPostingError(
      `Storage location ${storageLocationCode} does not stand in plant ${plant}.`,
      `Enter a ${role} storage location that belongs to plant ${plant}.`,
    );
  }
  if (!row.isActive) {
    throw new TransferPostingError(
      `Storage location ${storageLocationCode} in plant ${plant} is blocked for postings.`,
      'Choose an active storage location.',
    );
  }
  return row;
}

async function stockAt(
  tx: Tx, client: string, materialNumber: string, plant: string, location: string, stockType: string,
): Promise<number | null> {
  const [row] = await tx.select().from(stockQuantity).where(and(
    eq(stockQuantity.client, client),
    eq(stockQuantity.materialNumber, materialNumber),
    eq(stockQuantity.plant, plant),
    eq(stockQuantity.storageLocation, location),
    eq(stockQuantity.stockType, stockType),
  ));
  return row ? Number(row.quantity) : null;
}

/** The sufficiency rule: the issuing side must cover it, unless the location permits a negative. */
async function requireStock(
  tx: Tx, client: string, materialNumber: string, plant: string, location: string,
  stockType: string, quantity: number, allowNegative: boolean, role: string,
): Promise<void> {
  const held = await stockAt(tx, client, materialNumber, plant, location, stockType);
  if ((held ?? 0) + 1e-9 < quantity && !allowNegative) {
    throw new TransferPostingError(
      `Stock of ${materialNumber} (${stockType}) in storage location ${location} of plant ${plant} is ${(held ?? 0).toFixed(3)}, short of the ${quantity.toFixed(3)} to move.`,
      `Reduce the quantity to what stands, or release negative stock on the ${role} storage location.`,
    );
  }
}

async function moveStock(
  tx: Tx, client: string, changedBy: string, row: {
    materialNumber: string; plant: string; storageLocation: string; stockType: string;
  }, delta: number,
): Promise<void> {
  const [existing] = await tx.select().from(stockQuantity).where(and(
    eq(stockQuantity.client, client),
    eq(stockQuantity.materialNumber, row.materialNumber),
    eq(stockQuantity.plant, row.plant),
    eq(stockQuantity.storageLocation, row.storageLocation),
    eq(stockQuantity.stockType, row.stockType),
  ));
  if (!existing) {
    await tx.insert(stockQuantity).values({
      client, materialNumber: row.materialNumber, plant: row.plant,
      storageLocation: row.storageLocation, stockType: row.stockType,
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
  ));
}

async function moveValuation(
  tx: Tx, client: string, changedBy: string, prepared: PreparedPlant,
  quantityDelta: number, valueDelta: number,
): Promise<void> {
  const v = prepared.valuation;
  const newQty = Number(v.totalStockQuantity) + quantityDelta;
  const newValue = Number(v.stockValue) + valueDelta;
  await tx.update(materialValuation).set({
    totalStockQuantity: String(newQty),
    stockValue: String(newValue),
    movingAveragePrice: v.priceControl === 'MOVING_AVERAGE' && newQty > 0
      ? String(round2((newValue / newQty) * Number(v.priceUnit)) || 0)
      : v.movingAveragePrice,
    changedBy, changedAt: new Date(),
  }).where(and(
    eq(materialValuation.client, client),
    eq(materialValuation.materialNumber, v.materialNumber),
    eq(materialValuation.valuationArea, v.valuationArea),
  ));
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

export async function postTransfer(input: PostTransferInput): Promise<TransferDocumentView> {
  requireDate(input.postingDate, 'The posting date');
  requireDate(input.documentDate, 'The document date');
  if ((input.headerText ?? '').length > 25) {
    throw new TransferPostingError('The header text is longer than 25 characters.', 'Shorten the header text.');
  }
  if (!(input.quantity > 0)) {
    throw new TransferPostingError('The transfer quantity must be positive.', 'Enter a quantity greater than zero.');
  }
  const scenario = await resolveScenario(input.movementTypeCode);
  const materialNumber = input.materialNumber.trim();
  if (!materialNumber) throw new TransferPostingError('A material is required.', 'Enter the material being transferred.');

  return withTenant(input.client, async (tx) => {
    const replay = await existingByRequestKey(tx, input.client, input.requestKey);
    if (replay) return replay;

    await ensureMovements(tx, input.client, input.changedBy);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/transfer/${materialNumber}`}, 0))`);

    const [mat] = await tx.select().from(material).where(and(
      eq(material.client, input.client), eq(material.materialNumber, materialNumber),
    ));
    if (!mat) throw new TransferPostingError(`Material ${materialNumber} does not exist.`);
    if (mat.markedForDeletion) {
      throw new TransferPostingError(`Material ${materialNumber} is flagged for deletion.`, 'Cancel the deletion flag, then post again.');
    }

    // Scenario structure, judged before anything is read for stock.
    const samePlant = input.issuingPlant === input.receivingPlant;
    if (scenario.kind === 'PLANT' && samePlant) {
      throw new TransferPostingError(
        `Movement type ${scenario.code} moves between plants, but both sides name plant ${input.issuingPlant}.`,
        'Name a different receiving plant, or post 311 to move inside one plant.',
      );
    }
    if (scenario.kind !== 'PLANT' && !samePlant) {
      throw new TransferPostingError(
        `Movement type ${scenario.code} moves inside one plant, but the receiving plant ${input.receivingPlant} differs from ${input.issuingPlant}.`,
        'Name the same plant on both sides, or post 301 to move between plants.',
      );
    }
    if (scenario.kind === 'STORAGE_LOCATION' && input.issuingStorageLocation === input.receivingStorageLocation) {
      throw new TransferPostingError(
        `Movement type ${scenario.code} moves between storage locations, but both sides name ${input.issuingStorageLocation}.`,
        'Name a different receiving storage location.',
      );
    }
    if (scenario.kind === 'STOCK_TYPE' && input.issuingStorageLocation !== input.receivingStorageLocation) {
      throw new TransferPostingError(
        `Movement type ${scenario.code} moves stock between stock types inside one storage location, but ${input.issuingStorageLocation} and ${input.receivingStorageLocation} differ.`,
        'Name the same storage location on both sides.',
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
      });
      await assertInventoryCountOpen(tx, input.client, {
        materialNumber, plant: input.receivingPlant, storageLocation: receivingLocation.storageLocation,
      });
    } catch (caught) {
      if (caught instanceof PhysicalInventoryError) {
        throw new TransferPostingError(caught.message, caught.remedy);
      }
      throw caught;
    }

    await requireStock(
      tx, input.client, materialNumber, input.issuingPlant, issuingLocation.storageLocation,
      scenario.fromStockType, input.quantity, issuingLocation.allowNegativeStock, 'issuing',
    );

    // Value: a move inside one plant changes none; a move between plants carries it.
    const q = input.quantity;
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

    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: 'MATDOC', allocatedBy: input.changedBy,
    });
    const number = allocated.display;

    // A price difference stands only when a standard-priced receiving plant values the
    // stock differently from what was transferred — SAP posts no journal otherwise.
    let journalNumber: string | null = null;
    if (scenario.kind === 'PLANT' && round2(receivingValue - movedValue) !== 0) {
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
      journalDocumentNumber: journalNumber, requestKey: input.requestKey,
      createdBy: input.changedBy,
    });

    const issuingValue = scenario.kind === 'PLANT' ? movedValue : 0;
    const receivingLineValue = scenario.kind === 'PLANT' ? receivingValue : 0;
    if (!mat.baseUnit) {
      throw new TransferPostingError(
        `Material ${materialNumber} carries no base unit.`,
        'Complete the material master, then post the transfer.',
      );
    }
    const unit = mat.baseUnit;

    const issueLine: typeof materialDocumentLine.$inferInsert = {
      client: input.client, materialDocumentNumber: number, lineNumber: 1,
      movementType: scenario.movementType, lineDirection: 'ISSUE',
      materialNumber, plant: input.issuingPlant,
      storageLocation: issuingLocation.storageLocation, stockType: scenario.fromStockType,
      entryQuantity: String(q), entryUnit: unit, baseQuantity: String(q), baseUnit: unit,
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
      entryQuantity: String(q), entryUnit: unit, baseQuantity: String(q), baseUnit: unit,
      unitPrice: scenario.kind === 'PLANT' ? String(round2(receivingLineValue / q)) : '0',
      priceUnit: '1', currency: company.currency as string, value: String(receivingLineValue),
      itemText: `Transfer ${scenario.code}`,
      createdBy: input.changedBy,
    };
    await tx.insert(materialDocumentLine).values(receiptLine);

    await moveStock(tx, input.client, input.changedBy, {
      materialNumber, plant: input.issuingPlant,
      storageLocation: issuingLocation.storageLocation, stockType: scenario.fromStockType,
    }, -q);
    await moveStock(tx, input.client, input.changedBy, {
      materialNumber, plant: input.receivingPlant,
      storageLocation: receivingLocation.storageLocation, stockType: scenario.toStockType,
    }, q);

    if (scenario.kind === 'PLANT') {
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

  return withTenant(input.client, async (tx) => {
    const replay = await existingByRequestKey(tx, input.client, input.requestKey);
    if (replay) return replay;

    await ensureMovements(tx, input.client, input.changedBy);

    const [original] = await tx.select().from(materialDocument).where(and(
      eq(materialDocument.client, input.client),
      eq(materialDocument.materialDocumentNumber, input.materialDocumentNumber),
    ));
    if (!original) throw new TransferPostingError(`Material document ${input.materialDocumentNumber} does not exist.`);
    if (original.reversalOf) {
      throw new TransferPostingError('A reversal document cannot itself be reversed.', 'Reverse the original document instead.');
    }
    if (original.status === 'REVERSED') {
      throw new TransferPostingError(
        `Material document ${input.materialDocumentNumber} has already been reversed by ${original.reversedBy}.`,
      );
    }
    const lines = await tx.select().from(materialDocumentLine).where(and(
      eq(materialDocumentLine.client, input.client),
      eq(materialDocumentLine.materialDocumentNumber, input.materialDocumentNumber),
    )).orderBy(materialDocumentLine.lineNumber);
    const issue = lines.find((l) => l.lineDirection === 'ISSUE');
    const receipt = lines.find((l) => l.lineDirection === 'RECEIPT');
    if (!issue || !receipt) {
      throw new TransferPostingError(
        `Material document ${input.materialDocumentNumber} is not a transfer.`,
        'Only a transfer document carries an issuing and a receiving line; reverse a goods receipt from its own screen.',
      );
    }
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
      requestKey: input.requestKey, createdBy: input.changedBy,
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
      }, line.direction === 'ISSUE' ? -Number(line.from.baseQuantity) : Number(line.from.baseQuantity));
    }

    if (issue.plant !== receipt.plant) {
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
