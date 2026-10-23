/**
 * Material price change — MR21 as a search alias only.
 *
 * The current period posts the stock-value difference now and updates the
 * book price and the book value. A previous period posts only when that
 * material period is open for backposting and the financial period accepts
 * the date; the current book price is left as it stands. A future price is
 * stored and does not post until it is released. A batch is not part of this.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry } from '../../platform/posting';
import { accountDetermination, plant as plantTable } from '../foundation/schema';
import { journalEntry } from '../finance/schema';
import { getMaterialPeriodControlInTx } from './goods-issue';
import { materialPeriodAllows } from './material-period-control';
import { material, materialValuation } from './schema';

export const PRICE_CHANGE_CAPABILITY = 'INV.MATERIAL.PRICECHANGE';
export const PRICE_CHANGE_ROUTE = '/inventory/price-change';
const DOCUMENT_TYPE = 'SA';
const OBJECT_CLASS = 'material_valuation';

export class PriceChangeError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'PriceChangeError';
    this.remedy = remedy;
  }
}

export type PriceWhen = 'CURRENT' | 'PREVIOUS' | 'FUTURE';

export interface PriceChangeLine {
  materialNumber: string;
  plant: string;
  price: number;
  priceUnit: number;
}

export interface PriceChangeInput {
  client: string;
  changedBy: string;
  companyCode: string;
  postingDate: string;
  when: PriceWhen;
  reason: string;
  requestKey: string;
  lines: PriceChangeLine[];
}

export interface PriceChangeResult {
  posted: boolean;
  documentNumber: string | null;
  warnings: string[];
  message: string;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function money(value: number): string {
  return round2(value).toFixed(4);
}

async function resolveAccount(
  tx: Tx, client: string, chart: string, event: string, valuationClass: string,
): Promise<string> {
  const rows = await tx.select().from(accountDetermination).where(and(
    eq(accountDetermination.client, client),
    eq(accountDetermination.chartOfAccounts, chart),
    eq(accountDetermination.event, event),
  ));
  const row = rows.find((entry) => entry.valuationClass === valuationClass)
    ?? rows.find((entry) => entry.valuationClass === '');
  if (!row) {
    throw new PriceChangeError(
      `Account determination for ${event}${valuationClass ? ` and valuation class ${valuationClass}` : ''} does not stand in chart ${chart}.`,
      'Maintain the account determination, then post again.',
    );
  }
  return row.glAccount;
}

async function stockAt(
  tx: Tx, client: string, materialNumber: string, plant: string, onDate: string,
): Promise<number> {
  const rows = await tx.execute(sql`
    select coalesce(sum(case when l.line_direction = 'RECEIPT' then l.base_quantity else -l.base_quantity end), 0) as qty
      from material_document_line l
      join material_document d
        on d.client = l.client and d.material_document_number = l.material_document_number
     where l.client = ${client}
       and l.material_number = ${materialNumber}
       and l.plant = ${plant}
       and d.posting_date <= ${onDate}
  `);
  return Number((rows as unknown as Array<{ qty: string }>)[0]?.qty ?? 0);
}

export async function changeMaterialPrice(input: PriceChangeInput): Promise<PriceChangeResult> {
  if (!input.reason.trim()) {
    throw new PriceChangeError('A reason is required.', 'Say why the price is changing.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.postingDate)) {
    throw new PriceChangeError('A posting date is required.');
  }
  if (input.lines.length === 0) throw new PriceChangeError('Name at least one material.');
  return withTenant(input.client, (tx) => applyPriceChange(tx, input, false));
}

async function applyPriceChange(tx: Tx, input: PriceChangeInput, clearFuture: boolean): Promise<PriceChangeResult> {
    const replay = await tx.select({ documentNumber: journalEntry.documentNumber }).from(journalEntry).where(and(
      eq(journalEntry.client, input.client),
      eq(journalEntry.reference, input.requestKey),
    ));
    if (replay[0]) {
      return {
        posted: true,
        documentNumber: replay[0].documentNumber,
        warnings: [],
        message: `Price change ${replay[0].documentNumber} already stands.`,
      };
    }
    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company?.fiscalYearVariant || !company.chartOfAccounts || !company.currency) {
      throw new PriceChangeError(`Company code ${input.companyCode} is not configured.`);
    }
    const position = await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate);
    const period = await getMaterialPeriodControlInTx(tx, input.client, input.companyCode);
    if (input.when === 'FUTURE') {
      return storeFuture(tx, input, company.currency.trim());
    }
    if (!materialPeriodAllows(period, position.fiscalYear, position.period)) {
      throw new PriceChangeError(
        `The material period ${position.fiscalYear}/${position.period} is not open for company ${input.companyCode}.`,
        input.when === 'PREVIOUS'
          ? 'Allow backposting for the previous material period, or post in the current period.'
          : 'Post in the open material period.',
      );
    }
    if (input.when === 'CURRENT' && (period?.currentFiscalYear !== position.fiscalYear || period.currentPeriod !== position.period)) {
      throw new PriceChangeError(
        `Date ${input.postingDate} is not in the current material period ${period?.currentFiscalYear}/${period?.currentPeriod}.`,
        'Use the current period date, or choose the previous period.',
      );
    }
    if (input.when === 'PREVIOUS' && (period?.previousFiscalYear !== position.fiscalYear || period.previousPeriod !== position.period)) {
      throw new PriceChangeError(
        `Date ${input.postingDate} is not in the previous material period ${period?.previousFiscalYear}/${period?.previousPeriod}.`,
      );
    }
    const warnings: string[] = [];
    const journalLines: Array<{ glAccount: string; debitCredit: 'S' | 'H'; amount: string; material?: string; plant?: string }> = [];
    const updates: Array<{ materialNumber: string; plant: string; before: string; after: string; stockValue: string }> = [];
    for (const line of input.lines) {
      if (!Number.isFinite(line.price) || line.price < 0) {
        throw new PriceChangeError(`The price of ${line.materialNumber} cannot be negative.`);
      }
      if (!Number.isFinite(line.priceUnit) || line.priceUnit <= 0) {
        throw new PriceChangeError(`The price unit of ${line.materialNumber} must be greater than zero.`);
      }
      const [master] = await tx.select().from(material).where(and(
        eq(material.client, input.client),
        eq(material.materialNumber, line.materialNumber),
      ));
      if (!master) throw new PriceChangeError(`Material ${line.materialNumber} does not exist.`);
      const [plantRow] = await tx.select().from(plantTable).where(and(
        eq(plantTable.client, input.client),
        eq(plantTable.plant, line.plant),
      ));
      if (plantRow?.companyCode !== input.companyCode) {
        throw new PriceChangeError(`Plant ${line.plant} does not belong to company ${input.companyCode}.`);
      }
      const [valuation] = await tx.select().from(materialValuation).where(and(
        eq(materialValuation.client, input.client),
        eq(materialValuation.materialNumber, line.materialNumber),
        eq(materialValuation.valuationArea, line.plant),
      ));
      if (!valuation) {
        throw new PriceChangeError(
          `Material ${line.materialNumber} has no valuation at plant ${line.plant}.`,
          'Extend the material to the plant, then change the price.',
        );
      }
      if (valuation.currency.trim() !== company.currency.trim()) {
        throw new PriceChangeError(
          `Material ${line.materialNumber} is valued in ${valuation.currency.trim()}, not company currency ${company.currency.trim()}.`,
        );
      }
      if (!valuation.valuationClass) {
        throw new PriceChangeError(`Material ${line.materialNumber} has no valuation class at plant ${line.plant}.`);
      }
      const controlled = valuation.priceControl === 'STANDARD' ? valuation.standardPrice : valuation.movingAveragePrice;
      const oldPrice = input.when === 'PREVIOUS' && valuation.previousPrice != null
        ? Number(valuation.previousPrice)
        : Number(controlled);
      const oldUnit = input.when === 'PREVIOUS' && valuation.previousPriceUnit != null
        ? Number(valuation.previousPriceUnit)
        : Number(valuation.priceUnit);
      const quantity = input.when === 'PREVIOUS'
        ? await stockAt(tx, input.client, line.materialNumber, line.plant, input.postingDate)
        : Number(valuation.totalStockQuantity);
      if (quantity < -0.0005) {
        throw new PriceChangeError(`Material ${line.materialNumber} has a negative stock quantity at plant ${line.plant}.`);
      }
      const nextValue = round2(quantity * line.price / line.priceUnit);
      const previousValue = input.when === 'CURRENT'
        ? Number(valuation.stockValue)
        : round2(quantity * oldPrice / oldUnit);
      const difference = round2(nextValue - previousValue);
      if (input.when === 'CURRENT' && nextValue < 0) {
        throw new PriceChangeError(`The new stock value of ${line.materialNumber} would be negative.`);
      }
      if (Math.abs(difference) >= 0.005 && quantity > 0) {
        const inventory = await resolveAccount(tx, input.client, company.chartOfAccounts, 'INVENTORY', valuation.valuationClass);
        const offset = await resolveAccount(tx, input.client, company.chartOfAccounts, 'PRICE_DIFFERENCE', valuation.valuationClass);
        const amount = Math.abs(difference).toFixed(2);
        journalLines.push({
          glAccount: inventory,
          debitCredit: difference > 0 ? 'S' : 'H',
          amount,
          material: line.materialNumber,
          plant: line.plant,
        });
        journalLines.push({
          glAccount: offset,
          debitCredit: difference > 0 ? 'H' : 'S',
          amount,
          material: line.materialNumber,
          plant: line.plant,
        });
      } else if (quantity === 0) {
        warnings.push(`Material ${line.materialNumber} has no stock at plant ${line.plant}. The price is changed and nothing is posted.`);
      }
      if (input.when === 'CURRENT') {
        await tx.update(materialValuation).set({
          standardPrice: valuation.priceControl === 'STANDARD' ? money(line.price) : valuation.standardPrice,
          movingAveragePrice: valuation.priceControl === 'MOVING_AVERAGE' ? money(line.price) : valuation.movingAveragePrice,
          priceUnit: String(line.priceUnit),
          stockValue: money(nextValue),
          version: valuation.version + 1,
          changedBy: input.changedBy,
          changedAt: new Date(),
        }).where(and(
          eq(materialValuation.client, input.client),
          eq(materialValuation.materialNumber, line.materialNumber),
          eq(materialValuation.valuationArea, line.plant),
        ));
      } else {
        await tx.update(materialValuation).set({
          previousPrice: money(line.price),
          previousPriceUnit: String(line.priceUnit),
          version: valuation.version + 1,
          changedBy: input.changedBy,
          changedAt: new Date(),
        }).where(and(
          eq(materialValuation.client, input.client),
          eq(materialValuation.materialNumber, line.materialNumber),
          eq(materialValuation.valuationArea, line.plant),
        ));
        warnings.push(`The previous-period price of ${line.materialNumber} is stored. The current book price is unchanged.`);
      }
      if (clearFuture) {
        await tx.update(materialValuation).set({
          futurePrice: null,
          futurePriceUnit: null,
          futureValidFrom: null,
        }).where(and(
          eq(materialValuation.client, input.client),
          eq(materialValuation.materialNumber, line.materialNumber),
          eq(materialValuation.valuationArea, line.plant),
        ));
      }
      updates.push({
        materialNumber: line.materialNumber,
        plant: line.plant,
        before: `${oldPrice} / ${oldUnit}`,
        after: `${line.price} / ${line.priceUnit}`,
        stockValue: input.when === 'CURRENT' ? money(nextValue) : valuation.stockValue,
      });
    }
    let documentNumber: string | null = null;
    if (journalLines.length > 0) {
      const posted = await postJournalEntry(tx, {
        client: input.client,
        companyCode: input.companyCode,
        documentType: DOCUMENT_TYPE,
        documentDate: input.postingDate,
        postingDate: input.postingDate,
        fiscalYear: position.fiscalYear,
        postingPeriod: position.period,
        currency: company.currency.trim(),
        localCurrency: company.currency.trim(),
        exchangeRate: '1',
        reference: input.requestKey,
        headerText: input.reason.slice(0, 25),
        lines: journalLines,
        postedBy: input.changedBy,
        transactionCode: PRICE_CHANGE_CAPABILITY,
      });
      documentNumber = posted.documentNumber;
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: OBJECT_CLASS,
      objectKey: `${input.companyCode}/${input.postingDate}`,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: PRICE_CHANGE_CAPABILITY,
      reason: input.reason,
      after: { when: input.when, document: documentNumber, lines: updates },
    });
    return {
      posted: documentNumber != null,
      documentNumber,
      warnings,
      message: documentNumber
        ? `Price change posted as ${documentNumber}.`
        : 'The price is stored. No stock difference was posted.',
    };
}

async function storeFuture(tx: Tx, input: PriceChangeInput, currency: string): Promise<PriceChangeResult> {
  const today = new Date().toISOString().slice(0, 10);
  if (input.postingDate <= today) {
    throw new PriceChangeError(
      'A future price needs a date after today.',
      'Choose a later date, or post the current period.',
    );
  }
  for (const line of input.lines) {
    if (!Number.isFinite(line.price) || line.price < 0) {
      throw new PriceChangeError(`The price of ${line.materialNumber} cannot be negative.`);
    }
    if (!Number.isFinite(line.priceUnit) || line.priceUnit <= 0) {
      throw new PriceChangeError(`The price unit of ${line.materialNumber} must be greater than zero.`);
    }
    const [valuation] = await tx.select().from(materialValuation).where(and(
      eq(materialValuation.client, input.client),
      eq(materialValuation.materialNumber, line.materialNumber),
      eq(materialValuation.valuationArea, line.plant),
    ));
    if (!valuation) {
      throw new PriceChangeError(`Material ${line.materialNumber} has no valuation at plant ${line.plant}.`);
    }
    if (valuation.currency.trim() !== currency) {
      throw new PriceChangeError(`Material ${line.materialNumber} is not valued in ${currency}.`);
    }
    await tx.update(materialValuation).set({
      futurePrice: money(line.price),
      futurePriceUnit: String(line.priceUnit),
      futureValidFrom: input.postingDate,
      version: valuation.version + 1,
      changedBy: input.changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(materialValuation.client, input.client),
      eq(materialValuation.materialNumber, line.materialNumber),
      eq(materialValuation.valuationArea, line.plant),
    ));
  }
  await recordChange(tx, {
    client: input.client,
    objectClass: OBJECT_CLASS,
    objectKey: `${input.companyCode}/${input.postingDate}`,
    changeType: 'CHANGE',
    changedBy: input.changedBy,
    transactionCode: PRICE_CHANGE_CAPABILITY,
    reason: input.reason,
    after: { when: 'FUTURE', lines: input.lines },
  });
  return {
    posted: false,
    documentNumber: null,
    warnings: [],
    message: `The future price is stored from ${input.postingDate}. Nothing was posted.`,
  };
}

export async function releaseFuturePrices(input: {
  client: string;
  changedBy: string;
  companyCode: string;
  postingDate: string;
  reason: string;
  requestKey: string;
  materials: Array<{ materialNumber: string; plant: string }>;
}): Promise<PriceChangeResult> {
  if (!input.reason.trim()) throw new PriceChangeError('A reason is required.', 'Say why the future price is being released.');
  return withTenant(input.client, async (tx) => {
    const lines: PriceChangeLine[] = [];
    for (const row of input.materials) {
      const [valuation] = await tx.select().from(materialValuation).where(and(
        eq(materialValuation.client, input.client),
        eq(materialValuation.materialNumber, row.materialNumber),
        eq(materialValuation.valuationArea, row.plant),
      ));
      if (!valuation?.futurePrice || !valuation.futureValidFrom) {
        throw new PriceChangeError(`Material ${row.materialNumber} has no future price at plant ${row.plant}.`);
      }
      if (valuation.futureValidFrom > input.postingDate) {
        throw new PriceChangeError(
          `The future price of ${row.materialNumber} is valid from ${valuation.futureValidFrom}, which is after ${input.postingDate}.`,
        );
      }
      lines.push({
        materialNumber: row.materialNumber,
        plant: row.plant,
        price: Number(valuation.futurePrice),
        priceUnit: Number(valuation.futurePriceUnit),
      });
    }
    return applyPriceChange(tx, {
      client: input.client,
      changedBy: input.changedBy,
      companyCode: input.companyCode,
      postingDate: input.postingDate,
      when: 'CURRENT',
      reason: input.reason,
      requestKey: input.requestKey,
      lines,
    }, true);
  });
}

export async function listFuturePrices(client: string): Promise<Array<{
  materialNumber: string;
  plant: string;
  futurePrice: string;
  futurePriceUnit: string;
  futureValidFrom: string;
  currency: string;
}>> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(materialValuation).where(eq(materialValuation.client, client));
    return rows.filter((row) => row.futurePrice != null && row.futureValidFrom != null).map((row) => ({
      materialNumber: row.materialNumber,
      plant: row.valuationArea,
      futurePrice: row.futurePrice!,
      futurePriceUnit: row.futurePriceUnit ?? '1',
      futureValidFrom: row.futureValidFrom!,
      currency: row.currency.trim(),
    }));
  });
}
