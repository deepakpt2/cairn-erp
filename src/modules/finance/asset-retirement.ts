/**
 * Asset retirement by scrapping — SCR-093 / R-141
 * (ABAVN as a search alias only).
 *
 * A retirement without proceeds posted only through the canonical
 * posting engine: credit the asset class's reconciliation account
 * with the retired acquisition value, debit accumulated
 * depreciation for its proportional share and the retirement loss
 * account with the remaining net book value. The retirement stands
 * as a value record linked to the accounting document — never a
 * second ledger — and asset values always derive from ACTIVE
 * acquisition and retirement records. Simulation runs the
 * identical judges and persists nothing; posting is request-key
 * idempotent under the asset's locks; reversal is asset-aware and
 * restores eligibility.
 *
 * Stage 1 carries the vocabulary only; the service lands in
 * stage 3 of R-141.
 */
export const ASSET_RETIRE_CAPABILITY = 'FIN.ASSET.RETIRE';

export class AssetRetirementError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'AssetRetirementError';
    this.remedy = remedy;
  }
}

export type RetirementScope = 'COMPLETE' | 'PERCENT' | 'AMOUNT';

export interface RetirementInputView {
  companyCode: string;
  assetNumber: string;
  subNumber: string;
  documentDate: string;
  postingDate: string;
  assetValueDate: string;
  documentType: string;
  currency: string;
  transactionType: string;
  scope: RetirementScope;
  /** PERCENT scope: percentage of the remaining retireable acquisition value. */
  retirementPercent?: number;
  /** AMOUNT scope: acquisition value to retire (never net book value). */
  retirementAmount?: number;
  text?: string;
  reference?: string;
}

export interface RetirementPreview {
  assetDescription: string;
  assetClass: string;
  reconAccount: string;
  accumAccount: string;
  lossAccount: string;
  acquiredValue: number;
  alreadyRetiredValue: number;
  accumulatedDepreciation: number;
  scope: RetirementScope;
  retiredAcquisitionValue: number;
  depreciationReversed: number;
  lossAmount: number;
  remainingAcquisitionValue: number;
  remainingNetBookValue: number;
  currency: string;
  warnings: string[];
}

export interface RetirementResult {
  documentNumber: string;
  fiscalYear: number;
  assetNumber: string;
  subNumber: string;
  scope: RetirementScope;
  retiredAcquisitionValue: number;
  depreciationReversed: number;
  lossAmount: number;
  remainingAcquisitionValue: number;
  currency: string;
}

import { and, asc, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, PostingError, reverseJournalEntry } from '../../platform/posting';
import { documentType } from '../foundation/schema';
import {
  assetClass, assetRetirement, assetTransaction, assetTransactionType,
  fixedAsset, glAccount,
} from './schema';

export const ASSET_RETIREMENT_CLASS = 'asset_retirement';

export interface AssetRetirementInput extends RetirementInputView {
  client: string;
  changedBy: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

type AssetRow = typeof fixedAsset.$inferSelect;

interface Resolved {
  asset: AssetRow;
  reconAccount: string;
  accumAccount: string;
  lossAccount: string;
  localCurrency: string;
  fiscalYear: number;
  postingPeriod: number;
  acquiredValue: number;
  alreadyRetiredValue: number;
  accumulatedDepreciation: number;
  retiredAcquisitionValue: number;
  depreciationReversed: number;
  lossAmount: number;
  completesAsset: boolean;
  acquisitionCurrency: string;
}

async function valueSums(tx: Tx, client: string, companyCode: string, assetNumber: string, subNumber: string) {
  const acq = await tx.select({
    amount: assetTransaction.amount, currency: assetTransaction.currency,
  }).from(assetTransaction).where(and(
    eq(assetTransaction.client, client), eq(assetTransaction.companyCode, companyCode),
    eq(assetTransaction.assetNumber, assetNumber), eq(assetTransaction.subNumber, subNumber),
    eq(assetTransaction.status, 'ACTIVE'),
  ));
  const ret = await tx.select({
    value: assetRetirement.retiredAcquisitionValue,
  }).from(assetRetirement).where(and(
    eq(assetRetirement.client, client), eq(assetRetirement.companyCode, companyCode),
    eq(assetRetirement.assetNumber, assetNumber), eq(assetRetirement.subNumber, subNumber),
    eq(assetRetirement.status, 'ACTIVE'),
  ));
  return {
    acquiredValue: round2(acq.reduce((s, r) => s + Number(r.amount), 0)),
    alreadyRetiredValue: round2(ret.reduce((s, r) => s + Number(r.value), 0)),
    currencies: [...new Set(acq.map((r) => r.currency.toUpperCase()))],
  };
}

/**
 * Posted accumulated depreciation. Depreciation value records
 * arrive with the depreciation run (FIN.ASSET.DEPRECIATE); until
 * then no depreciation has posted and this stands at zero. The
 * retirement mathematics below is proportional over this figure,
 * so the run plugs in without rework.
 */
async function postedAccumulatedDepreciation(
  _tx: Tx, _client: string, _companyCode: string, _assetNumber: string, _subNumber: string,
): Promise<number> {
  return 0;
}

async function judge(
  tx: Tx, client: string, input: RetirementInputView, lock: boolean,
): Promise<Resolved> {
  if (input.text && input.text.length > 50) {
    throw new AssetRetirementError('The text may be at most 50 characters.');
  }
  for (const [label, value] of [
    ['Document date', input.documentDate], ['Posting date', input.postingDate], ['Asset value date', input.assetValueDate],
  ] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AssetRetirementError(`${label} ${value} is not a calendar date.`);
  }
  const company = await getCompanyCode(tx, client, input.companyCode);
  if (!company?.fiscalYearVariant) {
    throw new AssetRetirementError(`Company code ${input.companyCode} is not configured in this tenant.`);
  }
  const assetQuery = tx.select().from(fixedAsset).where(and(
    eq(fixedAsset.client, client), eq(fixedAsset.companyCode, input.companyCode),
    eq(fixedAsset.assetNumber, input.assetNumber), eq(fixedAsset.subNumber, input.subNumber || '0000'),
  ));
  const [asset] = lock ? await assetQuery.for('update') : await assetQuery;
  if (!asset) {
    throw new AssetRetirementError(
      `Asset ${input.assetNumber}/${input.subNumber || '0000'} does not stand in company ${input.companyCode}.`,
      'Create the asset master (AS01) before retiring it.',
    );
  }
  if (asset.status === 'RETIRED') {
    throw new AssetRetirementError(`Asset ${asset.assetNumber}/${asset.subNumber} already stands retired.`);
  }
  if (asset.status !== 'ACTIVE') {
    throw new AssetRetirementError(`Asset ${asset.assetNumber}/${asset.subNumber} stands deactivated and takes no retirement.`);
  }
  const [klass] = await tx.select().from(assetClass).where(and(
    eq(assetClass.client, client), eq(assetClass.assetClass, asset.assetClass),
  ));
  if (!klass || !klass.isActive) {
    throw new AssetRetirementError(`Asset class ${asset.assetClass} is not configured active in this tenant.`);
  }
  for (const [label, account] of [
    ['acquisition', klass.reconAccount], ['accumulated depreciation', klass.accumDeprAccount], ['retirement loss', klass.retirementLossAccount],
  ] as const) {
    if (!account) {
      throw new AssetRetirementError(
        `Asset class ${asset.assetClass} carries no ${label} account determination.`,
        'Configure the class account determination, then retire.',
      );
    }
    const [standing] = await tx.select({ accountNumber: glAccount.accountNumber }).from(glAccount).where(and(
      eq(glAccount.client, client), eq(glAccount.accountNumber, account),
    ));
    if (!standing) {
      throw new AssetRetirementError(`Determined ${label} account ${account} does not stand in this tenant.`);
    }
  }
  const [type] = await tx.select().from(assetTransactionType).where(and(
    eq(assetTransactionType.client, client), eq(assetTransactionType.typeCode, input.transactionType),
  ));
  if (!type || !type.isActive || type.kind !== 'RETIREMENT') {
    throw new AssetRetirementError(
      `Asset transaction type ${input.transactionType} is not configured as an active retirement type.`,
      'Configure a retirement-without-proceeds transaction type, then post.',
    );
  }
  const [docType] = await tx.select().from(documentType).where(and(
    eq(documentType.client, client), eq(documentType.documentType, input.documentType.toUpperCase()),
  ));
  if (!docType) {
    throw new AssetRetirementError(`Document type ${input.documentType.toUpperCase()} is not configured for this tenant.`);
  }

  const sums = await valueSums(tx, client, input.companyCode, asset.assetNumber, asset.subNumber);
  if (sums.acquiredValue <= 0) {
    throw new AssetRetirementError(
      `Asset ${asset.assetNumber}/${asset.subNumber} carries no acquisition value to retire.`,
      'Acquire the asset (ABZON) before retiring it.',
    );
  }
  const remaining = round2(sums.acquiredValue - sums.alreadyRetiredValue);
  if (remaining <= 0) {
    throw new AssetRetirementError(`Asset ${asset.assetNumber}/${asset.subNumber} stands fully retired by value.`);
  }
  const acquisitionCurrency = sums.currencies[0] ?? company.currency;
  if (sums.currencies.length > 1) {
    throw new AssetRetirementError('The standing acquisitions carry more than one currency; retire them per currency.');
  }
  if (input.currency.toUpperCase() !== acquisitionCurrency) {
    throw new AssetRetirementError(
      `Retirement currency ${input.currency.toUpperCase()} is not the asset's acquisition currency ${acquisitionCurrency}.`,
      'Retire in the currency the asset was acquired in.',
    );
  }

  let retiredAcquisitionValue: number;
  if (input.scope === 'COMPLETE') {
    retiredAcquisitionValue = remaining;
  } else if (input.scope === 'PERCENT') {
    const p = Number(input.retirementPercent);
    if (!Number.isFinite(p) || p <= 0 || p > 100) {
      throw new AssetRetirementError('The retirement percentage must stand above zero and no higher than 100.');
    }
    retiredAcquisitionValue = p >= 100 ? remaining : round2((remaining * p) / 100);
  } else if (input.scope === 'AMOUNT') {
    const a = Number(input.retirementAmount);
    if (!Number.isFinite(a) || a <= 0) {
      throw new AssetRetirementError('The retirement amount must stand above zero.');
    }
    if (round2(a) > remaining) {
      throw new AssetRetirementError(
        `Retirement amount ${round2(a).toFixed(2)} exceeds the remaining retireable acquisition value ${remaining.toFixed(2)}.`,
        'Retire no more than the remaining acquisition value, or retire completely.',
      );
    }
    retiredAcquisitionValue = round2(a);
  } else {
    throw new AssetRetirementError(`Retirement scope ${String(input.scope)} is not supported.`);
  }
  if (retiredAcquisitionValue <= 0) {
    throw new AssetRetirementError('The retirement resolves to no acquisition value; nothing can be retired.');
  }
  const accumulatedDepreciation = await postedAccumulatedDepreciation(
    tx, client, input.companyCode, asset.assetNumber, asset.subNumber,
  );
  const depreciationReversed = retiredAcquisitionValue >= sums.acquiredValue
    ? accumulatedDepreciation
    : round2((accumulatedDepreciation * retiredAcquisitionValue) / sums.acquiredValue);
  const lossAmount = round2(retiredAcquisitionValue - depreciationReversed);
  const position = await derivePosition(tx, client, company.fiscalYearVariant, input.postingDate);
  return {
    asset, reconAccount: klass.reconAccount!, accumAccount: klass.accumDeprAccount!,
    lossAccount: klass.retirementLossAccount!, localCurrency: company.currency,
    fiscalYear: position.fiscalYear, postingPeriod: position.period,
    acquiredValue: sums.acquiredValue, alreadyRetiredValue: sums.alreadyRetiredValue,
    accumulatedDepreciation, retiredAcquisitionValue, depreciationReversed, lossAmount,
    completesAsset: retiredAcquisitionValue >= remaining,
    acquisitionCurrency,
  };
}

export async function simulateAssetRetirement(
  input: AssetRetirementInput,
): Promise<RetirementPreview> {
  return withTenant(input.client, async (tx) => {
    const r = await judge(tx, input.client, input, false);
    const warnings: string[] = [];
    if (r.completesAsset) {
      warnings.push('This retirement completes the asset: it will stand RETIRED and take no further acquisition, retirement or depreciation.');
    }
    if (r.accumulatedDepreciation <= 0) {
      warnings.push('No depreciation has posted against this asset yet (the depreciation run is a separate round), so the whole retired value writes off as loss.');
    }
    warnings.push(`Depreciation cutoff: the retired portion leaves planned depreciation from the asset value date ${input.assetValueDate}; historical postings stand untouched.`);
    warnings.push('Simulation persists nothing: no document, no retirement record, no number drawn.');
    return {
      assetDescription: r.asset.description1, assetClass: r.asset.assetClass,
      reconAccount: r.reconAccount, accumAccount: r.accumAccount, lossAccount: r.lossAccount,
      acquiredValue: r.acquiredValue, alreadyRetiredValue: r.alreadyRetiredValue,
      accumulatedDepreciation: r.accumulatedDepreciation,
      scope: input.scope,
      retiredAcquisitionValue: r.retiredAcquisitionValue,
      depreciationReversed: r.depreciationReversed,
      lossAmount: r.lossAmount,
      remainingAcquisitionValue: round2(r.acquiredValue - r.alreadyRetiredValue - r.retiredAcquisitionValue),
      remainingNetBookValue: round2(r.acquiredValue - r.alreadyRetiredValue - r.retiredAcquisitionValue - (r.accumulatedDepreciation - r.depreciationReversed)),
      currency: r.acquisitionCurrency,
      warnings,
    };
  });
}

async function remainingAfter(tx: Tx, client: string, companyCode: string, assetNumber: string, subNumber: string): Promise<number> {
  const sums = await valueSums(tx, client, companyCode, assetNumber, subNumber);
  return round2(sums.acquiredValue - sums.alreadyRetiredValue);
}

export async function postAssetRetirement(
  input: AssetRetirementInput & { requestKey: string },
): Promise<RetirementResult> {
  return withTenant(input.client, async (tx) => {
    const [replay] = await tx.select().from(assetRetirement).where(and(
      eq(assetRetirement.client, input.client), eq(assetRetirement.requestKey, input.requestKey),
    ));
    if (replay) {
      return {
        documentNumber: replay.documentNumber, fiscalYear: replay.fiscalYear,
        assetNumber: replay.assetNumber, subNumber: replay.subNumber,
        scope: replay.scope as RetirementScope,
        retiredAcquisitionValue: Number(replay.retiredAcquisitionValue),
        depreciationReversed: Number(replay.accumDepreciationReversed),
        lossAmount: Number(replay.netBookValueLoss),
        remainingAcquisitionValue: await remainingAfter(tx, input.client, replay.companyCode, replay.assetNumber, replay.subNumber),
        currency: replay.currency,
      };
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/assetret/${input.companyCode}/${input.assetNumber}/${input.subNumber || '0000'}`}, 0))`);
    const r = await judge(tx, input.client, input, true);
    const asset = r.asset;
    const lines: Array<{ glAccount: string; debitCredit: 'S' | 'H'; amount: string; lineText?: string }> = [];
    if (r.depreciationReversed > 0) {
      lines.push({ glAccount: r.accumAccount, debitCredit: 'S', amount: r.depreciationReversed.toFixed(2), lineText: input.text });
    }
    if (r.lossAmount > 0) {
      lines.push({ glAccount: r.lossAccount, debitCredit: 'S', amount: r.lossAmount.toFixed(2), lineText: input.text });
    }
    lines.push({ glAccount: r.reconAccount, debitCredit: 'H', amount: r.retiredAcquisitionValue.toFixed(2), lineText: input.text });
    const journal = await postJournalEntry(tx, {
      client: input.client,
      companyCode: input.companyCode,
      documentType: input.documentType.toUpperCase(),
      documentDate: input.documentDate,
      postingDate: input.postingDate,
      fiscalYear: r.fiscalYear,
      postingPeriod: r.postingPeriod,
      currency: r.acquisitionCurrency,
      localCurrency: r.localCurrency,
      reference: input.reference,
      lines,
      origin: {
        documentClass: ASSET_RETIREMENT_CLASS,
        documentKey: `${input.companyCode}/${asset.assetNumber}/${asset.subNumber}`,
      },
      postedBy: input.changedBy,
      transactionCode: ASSET_RETIRE_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new AssetRetirementError(error.message, error.remedy);
      if (error instanceof Error && 'remedy' in error) {
        throw new AssetRetirementError(error.message, (error as { remedy?: string }).remedy);
      }
      throw error;
    });

    await tx.insert(assetRetirement).values({
      client: input.client, companyCode: input.companyCode,
      assetNumber: asset.assetNumber, subNumber: asset.subNumber,
      documentNumber: journal.documentNumber, fiscalYear: journal.fiscalYear,
      transactionType: input.transactionType, scope: input.scope,
      retirementPercent: input.scope === 'PERCENT' ? String(input.retirementPercent) : null,
      retirementAmount: input.scope === 'AMOUNT' ? String(round2(Number(input.retirementAmount))) : null,
      retiredAcquisitionValue: String(r.retiredAcquisitionValue),
      accumDepreciationReversed: String(r.depreciationReversed),
      netBookValueLoss: String(r.lossAmount),
      currency: r.acquisitionCurrency,
      documentDate: input.documentDate, postingDate: input.postingDate,
      assetValueDate: input.assetValueDate,
      reference: input.reference ?? null, lineText: input.text ?? null,
      status: 'ACTIVE', requestKey: input.requestKey, createdBy: input.changedBy,
    });
    if (r.completesAsset) {
      await tx.update(fixedAsset).set({
        status: 'RETIRED', deactivationDate: input.assetValueDate,
        version: asset.version + 1,
        changedBy: input.changedBy, changedAt: new Date(),
      }).where(and(
        eq(fixedAsset.client, input.client), eq(fixedAsset.companyCode, input.companyCode),
        eq(fixedAsset.assetNumber, asset.assetNumber), eq(fixedAsset.subNumber, asset.subNumber),
      ));
    }
    await recordChange(tx, {
      client: input.client, objectClass: ASSET_RETIREMENT_CLASS,
      objectKey: `${input.companyCode}/${asset.assetNumber}/${asset.subNumber}/${journal.documentNumber}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: ASSET_RETIRE_CAPABILITY,
      after: {
        documentNumber: journal.documentNumber, scope: input.scope,
        retiredAcquisitionValue: r.retiredAcquisitionValue,
        depreciationReversed: r.depreciationReversed, lossAmount: r.lossAmount,
        currency: r.acquisitionCurrency, assetValueDate: input.assetValueDate,
        completesAsset: r.completesAsset,
      },
    });
    return {
      documentNumber: journal.documentNumber, fiscalYear: journal.fiscalYear,
      assetNumber: asset.assetNumber, subNumber: asset.subNumber,
      scope: input.scope,
      retiredAcquisitionValue: r.retiredAcquisitionValue,
      depreciationReversed: r.depreciationReversed,
      lossAmount: r.lossAmount,
      remainingAcquisitionValue: await remainingAfter(tx, input.client, input.companyCode, asset.assetNumber, asset.subNumber),
      currency: r.acquisitionCurrency,
    };
  });
}

export async function reverseAssetRetirement(input: {
  client: string; changedBy: string; companyCode: string;
  assetNumber: string; subNumber: string;
  documentNumber: string; fiscalYear: number;
  reversalDate: string; reason?: string;
}): Promise<{ reversalDocumentNumber: string }> {
  const reason = (input.reason ?? '').trim();
  if (!reason) throw new AssetRetirementError('A reason is required to reverse a retirement.', 'State why the retirement is reversed.');
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/assetret/${input.companyCode}/${input.assetNumber}/${input.subNumber}`}, 0))`);
    const [record] = await tx.select().from(assetRetirement).where(and(
      eq(assetRetirement.client, input.client), eq(assetRetirement.companyCode, input.companyCode),
      eq(assetRetirement.assetNumber, input.assetNumber), eq(assetRetirement.subNumber, input.subNumber),
      eq(assetRetirement.documentNumber, input.documentNumber), eq(assetRetirement.fiscalYear, input.fiscalYear),
    )).for('update');
    if (!record) {
      throw new AssetRetirementError(
        `No retirement stands under document ${input.documentNumber} for asset ${input.assetNumber}/${input.subNumber}.`,
      );
    }
    if (record.status === 'REVERSED') {
      throw new AssetRetirementError(`Retirement ${input.documentNumber} already stands reversed by ${record.reversalDocumentNumber}.`);
    }
    const reversal = await reverseJournalEntry(tx, {
      client: input.client, documentNumber: input.documentNumber, fiscalYear: input.fiscalYear,
      reversalDate: input.reversalDate, reversalDocumentDate: input.reversalDate,
      reason, reversedBy: input.changedBy, transactionCode: ASSET_RETIRE_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new AssetRetirementError(error.message, error.remedy);
      if (error instanceof Error && 'remedy' in error) {
        throw new AssetRetirementError(error.message, (error as { remedy?: string }).remedy);
      }
      throw error;
    });
    await tx.update(assetRetirement).set({
      status: 'REVERSED', reversalDocumentNumber: reversal.documentNumber,
      changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(assetRetirement.client, input.client), eq(assetRetirement.companyCode, input.companyCode),
      eq(assetRetirement.assetNumber, input.assetNumber), eq(assetRetirement.subNumber, input.subNumber),
      eq(assetRetirement.documentNumber, input.documentNumber), eq(assetRetirement.fiscalYear, input.fiscalYear),
    ));
    const [asset] = await tx.select().from(fixedAsset).where(and(
      eq(fixedAsset.client, input.client), eq(fixedAsset.companyCode, input.companyCode),
      eq(fixedAsset.assetNumber, input.assetNumber), eq(fixedAsset.subNumber, input.subNumber),
    )).for('update');
    if (asset?.status === 'RETIRED') {
      await tx.update(fixedAsset).set({
        status: 'ACTIVE', deactivationDate: null, version: asset.version + 1,
        changedBy: input.changedBy, changedAt: new Date(),
      }).where(and(
        eq(fixedAsset.client, input.client), eq(fixedAsset.companyCode, input.companyCode),
        eq(fixedAsset.assetNumber, input.assetNumber), eq(fixedAsset.subNumber, input.subNumber),
      ));
    }
    await recordChange(tx, {
      client: input.client, objectClass: ASSET_RETIREMENT_CLASS,
      objectKey: `${input.companyCode}/${input.assetNumber}/${input.subNumber}/${input.documentNumber}`,
      changeType: 'REVERSE', changedBy: input.changedBy, transactionCode: ASSET_RETIRE_CAPABILITY,
      reason,
      after: { status: 'REVERSED', reversalDocumentNumber: reversal.documentNumber },
    });
    return { reversalDocumentNumber: reversal.documentNumber };
  });
}

export async function getAssetRetirements(
  client: string, companyCode: string, assetNumber: string, subNumber: string,
) {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(assetRetirement).where(and(
      eq(assetRetirement.client, client), eq(assetRetirement.companyCode, companyCode),
      eq(assetRetirement.assetNumber, assetNumber), eq(assetRetirement.subNumber, subNumber),
    )).orderBy(asc(assetRetirement.postingDate), asc(assetRetirement.documentNumber));
    return rows.map((r) => ({
      documentNumber: r.documentNumber, fiscalYear: r.fiscalYear,
      transactionType: r.transactionType, scope: r.scope as RetirementScope,
      assetValueDate: r.assetValueDate, postingDate: r.postingDate,
      retiredAcquisitionValue: Number(r.retiredAcquisitionValue),
      depreciationReversed: Number(r.accumDepreciationReversed),
      lossAmount: Number(r.netBookValueLoss),
      currency: r.currency,
      status: r.status as 'ACTIVE' | 'REVERSED',
      reversalDocumentNumber: r.reversalDocumentNumber,
    }));
  });
}

/** Assets with their derived values, for retirement selection. */
export async function listRetireableAssets(client: string) {
  return withTenant(client, async (tx) => {
    const assets = await tx.select().from(fixedAsset).where(eq(fixedAsset.client, client))
      .orderBy(asc(fixedAsset.companyCode), asc(fixedAsset.assetNumber), asc(fixedAsset.subNumber));
    const out = [];
    for (const asset of assets) {
      const sums = await valueSums(tx, client, asset.companyCode, asset.assetNumber, asset.subNumber);
      const remaining = round2(sums.acquiredValue - sums.alreadyRetiredValue);
      out.push({
        companyCode: asset.companyCode, assetNumber: asset.assetNumber, subNumber: asset.subNumber,
        assetClass: asset.assetClass, description1: asset.description1, status: asset.status,
        acquiredValue: sums.acquiredValue, retiredValue: sums.alreadyRetiredValue,
        remainingValue: remaining,
        netBookValue: remaining,
        currency: sums.currencies[0] ?? '',
      });
    }
    return out;
  });
}
