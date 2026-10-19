/**
 * Asset acquisition with automatic offsetting — SCR-092 / R-140
 * (ABZON as a search alias only).
 *
 * A vendor-less acquisition posted only through the canonical
 * posting engine: debit the asset class's configured
 * reconciliation account, credit the entered offsetting account,
 * and record the asset transaction as a value record linked to
 * the accounting document — never a second ledger. Simulation
 * runs the identical judges and persists nothing. Posting is
 * request-key idempotent under the asset's locks, and reversal
 * is asset-aware, flipping the value record with its journal.
 *
 * Stage 1 carries the vocabulary only; the service lands in
 * stage 3 of R-140.
 */
export const ASSET_ACQUIRE_CAPABILITY = 'FIN.ASSET.ACQUIRE';

export class AssetAcquisitionError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'AssetAcquisitionError';
    this.remedy = remedy;
  }
}

export interface AcquisitionInputView {
  companyCode: string;
  assetNumber: string;
  subNumber: string;
  documentDate: string;
  postingDate: string;
  assetValueDate: string;
  documentType: string;
  currency: string;
  amount: number;
  offsetAccount: string;
  transactionType: string;
  text?: string;
  reference?: string;
}

export interface AcquisitionPreview {
  assetDescription: string;
  assetClass: string;
  reconAccount: string;
  offsetAccount: string;
  debitAmount: number;
  creditAmount: number;
  currency: string;
  localCurrency: string;
  localAmount: number;
  capitalizationDate: string;
  warnings: string[];
}

export interface AcquisitionResult {
  documentNumber: string;
  fiscalYear: number;
  assetNumber: string;
  subNumber: string;
  amount: number;
  currency: string;
  totalAcquiredValue: number;
}

import { and, asc, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, PostingError, reverseJournalEntry } from '../../platform/posting';
import { documentType } from '../foundation/schema';
import {
  assetClass, assetDepreciation, assetTransaction, assetTransactionType,
  fixedAsset, glAccount,
} from './schema';

export const ASSET_ACQUISITION_CLASS = 'asset_acquisition';

export interface AssetAcquisitionInput extends AcquisitionInputView {
  client: string;
  changedBy: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

type AssetRow = typeof fixedAsset.$inferSelect;

interface Resolved {
  asset: AssetRow;
  reconAccount: string;
  localCurrency: string;
  fiscalYear: number;
  postingPeriod: number;
}

async function judge(
  tx: Tx, client: string, input: AcquisitionInputView, lock: boolean,
): Promise<Resolved> {
  if (!(input.amount > 0) || !Number.isFinite(input.amount)) {
    throw new AssetAcquisitionError('The acquisition amount must stand above zero.');
  }
  if (input.text && input.text.length > 50) {
    throw new AssetAcquisitionError('The text may be at most 50 characters.');
  }
  for (const [label, value] of [
    ['Document date', input.documentDate], ['Posting date', input.postingDate], ['Asset value date', input.assetValueDate],
  ] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AssetAcquisitionError(`${label} ${value} is not a calendar date.`);
  }
  const company = await getCompanyCode(tx, client, input.companyCode);
  if (!company?.fiscalYearVariant) {
    throw new AssetAcquisitionError(`Company code ${input.companyCode} is not configured in this tenant.`);
  }
  const assetQuery = tx.select().from(fixedAsset).where(and(
    eq(fixedAsset.client, client), eq(fixedAsset.companyCode, input.companyCode),
    eq(fixedAsset.assetNumber, input.assetNumber), eq(fixedAsset.subNumber, input.subNumber || '0000'),
  ));
  const [asset] = lock ? await assetQuery.for('update') : await assetQuery;
  if (!asset) {
    throw new AssetAcquisitionError(
      `Asset ${input.assetNumber}/${input.subNumber || '0000'} does not stand in company ${input.companyCode}.`,
      'Create the asset master (AS01) before acquiring it.',
    );
  }
  if (asset.status !== 'ACTIVE') {
    throw new AssetAcquisitionError(`Asset ${asset.assetNumber}/${asset.subNumber} stands deactivated and takes no acquisition.`);
  }
  const [klass] = await tx.select().from(assetClass).where(and(
    eq(assetClass.client, client), eq(assetClass.assetClass, asset.assetClass),
  ));
  if (!klass || !klass.isActive) {
    throw new AssetAcquisitionError(`Asset class ${asset.assetClass} is not configured active in this tenant.`);
  }
  if (!klass.reconAccount) {
    throw new AssetAcquisitionError(
      `Asset class ${asset.assetClass} carries no acquisition account determination.`,
      'Configure the class reconciliation account, then acquire.',
    );
  }
  const [type] = await tx.select().from(assetTransactionType).where(and(
    eq(assetTransactionType.client, client), eq(assetTransactionType.typeCode, input.transactionType),
  ));
  if (!type || !type.isActive || type.kind !== 'ACQUISITION') {
    throw new AssetAcquisitionError(
      `Asset transaction type ${input.transactionType} is not configured as an active acquisition type.`,
      'Configure the transaction type, then post.',
    );
  }
  const [docType] = await tx.select().from(documentType).where(and(
    eq(documentType.client, client), eq(documentType.documentType, input.documentType.toUpperCase()),
  ));
  if (!docType) {
    throw new AssetAcquisitionError(`Document type ${input.documentType.toUpperCase()} is not configured for this tenant.`);
  }
  const [offset] = await tx.select().from(glAccount).where(and(
    eq(glAccount.client, client), eq(glAccount.accountNumber, input.offsetAccount),
  ));
  if (!offset) {
    throw new AssetAcquisitionError(`Offsetting account ${input.offsetAccount} does not stand in this tenant.`);
  }
  if (offset.reconciliationType) {
    throw new AssetAcquisitionError(
      `Offsetting account ${input.offsetAccount} is a reconciliation account and cannot be posted directly.`,
      'Choose an ordinary G/L account as the offsetting entry.',
    );
  }
  if (input.offsetAccount === klass.reconAccount) {
    throw new AssetAcquisitionError('The offsetting account cannot be the asset reconciliation account itself.');
  }
  const position = await derivePosition(tx, client, company.fiscalYearVariant, input.postingDate);
  return {
    asset, reconAccount: klass.reconAccount, localCurrency: company.currency,
    fiscalYear: position.fiscalYear, postingPeriod: position.period,
  };
}

export async function simulateAssetAcquisition(
  input: AssetAcquisitionInput,
): Promise<AcquisitionPreview> {
  return withTenant(input.client, async (tx) => {
    const resolved = await judge(tx, input.client, input, false);
    const warnings: string[] = [];
    if (!resolved.asset.capitalizationDate) {
      warnings.push(`Posting will capitalize the asset at the value date ${input.assetValueDate}.`);
    }
    if (input.currency.toUpperCase() !== resolved.localCurrency) {
      warnings.push(`The document currency differs from the company currency ${resolved.localCurrency}; local amounts follow the posting engine's stored rate.`);
    }
    warnings.push('Simulation persists nothing: no document, no asset transaction, no number drawn.');
    return {
      assetDescription: resolved.asset.description1,
      assetClass: resolved.asset.assetClass,
      reconAccount: resolved.reconAccount,
      offsetAccount: input.offsetAccount,
      debitAmount: round2(input.amount), creditAmount: round2(input.amount),
      currency: input.currency.toUpperCase(), localCurrency: resolved.localCurrency,
      localAmount: round2(input.amount),
      capitalizationDate: resolved.asset.capitalizationDate ?? input.assetValueDate,
      warnings,
    };
  });
}

async function acquiredTotal(tx: Tx, client: string, companyCode: string, assetNumber: string, subNumber: string): Promise<number> {
  const rows = await tx.select({ amount: assetTransaction.amount }).from(assetTransaction).where(and(
    eq(assetTransaction.client, client), eq(assetTransaction.companyCode, companyCode),
    eq(assetTransaction.assetNumber, assetNumber), eq(assetTransaction.subNumber, subNumber),
    eq(assetTransaction.status, 'ACTIVE'),
  ));
  return round2(rows.reduce((s, r) => s + Number(r.amount), 0));
}

export async function postAssetAcquisition(
  input: AssetAcquisitionInput & { requestKey: string },
): Promise<AcquisitionResult> {
  return withTenant(input.client, async (tx) => {
    const [replay] = await tx.select().from(assetTransaction).where(and(
      eq(assetTransaction.client, input.client), eq(assetTransaction.requestKey, input.requestKey),
    ));
    if (replay) {
      return {
        documentNumber: replay.documentNumber, fiscalYear: replay.fiscalYear,
        assetNumber: replay.assetNumber, subNumber: replay.subNumber,
        amount: Number(replay.amount), currency: replay.currency,
        totalAcquiredValue: await acquiredTotal(tx, input.client, replay.companyCode, replay.assetNumber, replay.subNumber),
      };
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/assetacq/${input.companyCode}/${input.assetNumber}/${input.subNumber || '0000'}`}, 0))`);
    const resolved = await judge(tx, input.client, input, true);
    const asset = resolved.asset;
    const journal = await postJournalEntry(tx, {
      client: input.client,
      companyCode: input.companyCode,
      documentType: input.documentType.toUpperCase(),
      documentDate: input.documentDate,
      postingDate: input.postingDate,
      fiscalYear: resolved.fiscalYear,
      postingPeriod: resolved.postingPeriod,
      currency: input.currency.toUpperCase(),
      localCurrency: resolved.localCurrency,
      reference: input.reference,
      lines: [
        { glAccount: resolved.reconAccount, debitCredit: 'S', amount: input.amount.toFixed(2), lineText: input.text },
        { glAccount: input.offsetAccount, debitCredit: 'H', amount: input.amount.toFixed(2), lineText: input.text },
      ],
      origin: {
        documentClass: ASSET_ACQUISITION_CLASS,
        documentKey: `${input.companyCode}/${asset.assetNumber}/${asset.subNumber}`,
      },
      postedBy: input.changedBy,
      transactionCode: ASSET_ACQUIRE_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new AssetAcquisitionError(error.message, error.remedy);
      if (error instanceof Error && 'remedy' in error) {
        throw new AssetAcquisitionError(error.message, (error as { remedy?: string }).remedy);
      }
      throw error;
    });

    await tx.insert(assetTransaction).values({
      client: input.client, companyCode: input.companyCode,
      assetNumber: asset.assetNumber, subNumber: asset.subNumber,
      documentNumber: journal.documentNumber, fiscalYear: journal.fiscalYear,
      transactionType: input.transactionType,
      documentDate: input.documentDate, postingDate: input.postingDate,
      assetValueDate: input.assetValueDate,
      amount: String(round2(input.amount)), currency: input.currency.toUpperCase(),
      offsetAccount: input.offsetAccount,
      reference: input.reference ?? null, lineText: input.text ?? null,
      status: 'ACTIVE', requestKey: input.requestKey, createdBy: input.changedBy,
    });
    if (!asset.capitalizationDate) {
      await tx.update(fixedAsset).set({
        capitalizationDate: input.assetValueDate,
        changedBy: input.changedBy, changedAt: new Date(),
      }).where(and(
        eq(fixedAsset.client, input.client), eq(fixedAsset.companyCode, input.companyCode),
        eq(fixedAsset.assetNumber, asset.assetNumber), eq(fixedAsset.subNumber, asset.subNumber),
      ));
    }
    await tx.update(assetDepreciation).set({
      depreciationStartDate: input.assetValueDate,
      changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(assetDepreciation.client, input.client), eq(assetDepreciation.companyCode, input.companyCode),
      eq(assetDepreciation.assetNumber, asset.assetNumber), eq(assetDepreciation.subNumber, asset.subNumber),
      sql`${assetDepreciation.depreciationStartDate} is null`,
    ));
    await recordChange(tx, {
      client: input.client, objectClass: ASSET_ACQUISITION_CLASS,
      objectKey: `${input.companyCode}/${asset.assetNumber}/${asset.subNumber}/${journal.documentNumber}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: ASSET_ACQUIRE_CAPABILITY,
      after: {
        documentNumber: journal.documentNumber, amount: round2(input.amount),
        currency: input.currency.toUpperCase(), transactionType: input.transactionType,
        assetValueDate: input.assetValueDate,
      },
    });
    return {
      documentNumber: journal.documentNumber, fiscalYear: journal.fiscalYear,
      assetNumber: asset.assetNumber, subNumber: asset.subNumber,
      amount: round2(input.amount), currency: input.currency.toUpperCase(),
      totalAcquiredValue: await acquiredTotal(tx, input.client, input.companyCode, asset.assetNumber, asset.subNumber),
    };
  });
}

export async function reverseAssetAcquisition(input: {
  client: string; changedBy: string; companyCode: string;
  assetNumber: string; subNumber: string;
  documentNumber: string; fiscalYear: number;
  reversalDate: string; reason?: string;
}): Promise<{ reversalDocumentNumber: string }> {
  const reason = (input.reason ?? '').trim();
  if (!reason) throw new AssetAcquisitionError('A reason is required to reverse an acquisition.', 'State why the acquisition is reversed.');
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/assetacq/${input.companyCode}/${input.assetNumber}/${input.subNumber}`}, 0))`);
    const [record] = await tx.select().from(assetTransaction).where(and(
      eq(assetTransaction.client, input.client), eq(assetTransaction.companyCode, input.companyCode),
      eq(assetTransaction.assetNumber, input.assetNumber), eq(assetTransaction.subNumber, input.subNumber),
      eq(assetTransaction.documentNumber, input.documentNumber), eq(assetTransaction.fiscalYear, input.fiscalYear),
    )).for('update');
    if (!record) {
      throw new AssetAcquisitionError(
        `No acquisition stands under document ${input.documentNumber} for asset ${input.assetNumber}/${input.subNumber}.`,
      );
    }
    if (record.status === 'REVERSED') {
      throw new AssetAcquisitionError(`Acquisition ${input.documentNumber} already stands reversed by ${record.reversalDocumentNumber}.`);
    }
    const reversal = await reverseJournalEntry(tx, {
      client: input.client, documentNumber: input.documentNumber, fiscalYear: input.fiscalYear,
      reversalDate: input.reversalDate, reversalDocumentDate: input.reversalDate,
      reason, reversedBy: input.changedBy, transactionCode: ASSET_ACQUIRE_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new AssetAcquisitionError(error.message, error.remedy);
      if (error instanceof Error && 'remedy' in error) {
        throw new AssetAcquisitionError(error.message, (error as { remedy?: string }).remedy);
      }
      throw error;
    });
    await tx.update(assetTransaction).set({
      status: 'REVERSED', reversalDocumentNumber: reversal.documentNumber,
      changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(assetTransaction.client, input.client), eq(assetTransaction.companyCode, input.companyCode),
      eq(assetTransaction.assetNumber, input.assetNumber), eq(assetTransaction.subNumber, input.subNumber),
      eq(assetTransaction.documentNumber, input.documentNumber), eq(assetTransaction.fiscalYear, input.fiscalYear),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: ASSET_ACQUISITION_CLASS,
      objectKey: `${input.companyCode}/${input.assetNumber}/${input.subNumber}/${input.documentNumber}`,
      changeType: 'REVERSE', changedBy: input.changedBy, transactionCode: ASSET_ACQUIRE_CAPABILITY,
      reason,
      after: { status: 'REVERSED', reversalDocumentNumber: reversal.documentNumber },
    });
    return { reversalDocumentNumber: reversal.documentNumber };
  });
}

export async function getAssetTransactions(
  client: string, companyCode: string, assetNumber: string, subNumber: string,
) {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(assetTransaction).where(and(
      eq(assetTransaction.client, client), eq(assetTransaction.companyCode, companyCode),
      eq(assetTransaction.assetNumber, assetNumber), eq(assetTransaction.subNumber, subNumber),
    )).orderBy(asc(assetTransaction.postingDate), asc(assetTransaction.documentNumber));
    return rows.map((r) => ({
      documentNumber: r.documentNumber, fiscalYear: r.fiscalYear,
      transactionType: r.transactionType, assetValueDate: r.assetValueDate,
      postingDate: r.postingDate, amount: Number(r.amount), currency: r.currency,
      offsetAccount: r.offsetAccount, status: r.status as 'ACTIVE' | 'REVERSED',
      reversalDocumentNumber: r.reversalDocumentNumber,
    }));
  });
}
