/**
 * Depreciation run — SCR-094 / R-142 (AFAB as a search alias only).
 *
 * The run calculates depreciation per asset and depreciation area
 * from standing configuration — depreciable base (ACTIVE
 * acquisitions less ACTIVE retirements), depreciation key method,
 * useful life, start date — and posts it through the canonical
 * engine: debit the class depreciation-expense account, credit the
 * class accumulated-depreciation account. Posted amounts stand in
 * `asset_depreciation_posting`, the value record the retirement
 * reversal (SCR-093) reads; the journal stays the financial
 * authority. A test run persists only its execution log.
 *
 * Stage 1 carries the vocabulary only; the service lands in
 * stage 3 of R-142.
 */
export const ASSET_DEPRECIATE_CAPABILITY = 'FIN.ASSET.DEPRECIATE';

export class AssetDepreciationError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'AssetDepreciationError';
    this.remedy = remedy;
  }
}

/** 1 Planned · 2 Repeat · 3 Restart · 4 Unplanned (refused this round). */
export type DepreciationRunType = '1' | '2' | '3' | '4';

export type DepreciationRunStatus =
  | 'SIMULATED' | 'COMPLETED' | 'COMPLETED_WITH_WARNINGS' | 'FAILED';

export type DepreciationItemStatus = 'CALCULATED' | 'POSTED' | 'SKIPPED' | 'FAILED';

export interface DepreciationRunInputView {
  companyCode: string;
  fiscalYear: number;
  postingPeriod: number;
  runType: DepreciationRunType;
  testRun: boolean;
  documentType: string;
  postingDate: string;
  restartOfRunId?: string;
}

export interface DepreciationRunItemView {
  assetNumber: string;
  subNumber: string;
  areaCode: string;
  depreciationKey: string;
  calculatedAmount: number;
  previouslyPostedAmount: number;
  adjustmentAmount: number;
  currency: string;
  expenseAccount: string | null;
  accumAccount: string | null;
  costCenter: string | null;
  profitCenter: string | null;
  status: DepreciationItemStatus;
  documentNumber: string | null;
  message: string | null;
}

export interface DepreciationRunResult {
  runId: string;
  status: DepreciationRunStatus;
  testRun: boolean;
  totalCalculated: number;
  totalPosted: number;
  currency: string;
  documentNumber: string | null;
  items: DepreciationRunItemView[];
  warnings: string[];
}

import { and, asc, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { derivePosition, getCompanyCode, getVariant, periodWindows } from '../../platform/periods';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { documentType, fiscalYearPeriod } from '../foundation/schema';
import {
  assetAssignment, assetClass, assetDepreciation, assetDepreciationPosting,
  assetDepreciationRun, assetDepreciationRunItem, assetRetirement, assetTransaction,
  depreciationKey, fixedAsset, glAccount,
} from './schema';

export const ASSET_DEPRECIATION_RUN_CLASS = 'asset_depreciation_run';

export interface AssetDepreciationRunInput extends DepreciationRunInputView {
  client: string;
  changedBy: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

interface CalcItem extends DepreciationRunItemView {
  assetKey: string;
  postAmount: number;
}

function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
}

async function calculateItems(
  tx: Tx, client: string, input: DepreciationRunInputView, company: { currency: string },
  periodEnd: string,
): Promise<CalcItem[]> {
  const assets = await tx.select().from(fixedAsset).where(and(
    eq(fixedAsset.client, client), eq(fixedAsset.companyCode, input.companyCode),
  )).orderBy(asc(fixedAsset.assetNumber), asc(fixedAsset.subNumber));
  const items: CalcItem[] = [];
  for (const asset of assets) {
    const areas = await tx.select().from(assetDepreciation).where(and(
      eq(assetDepreciation.client, client), eq(assetDepreciation.companyCode, input.companyCode),
      eq(assetDepreciation.assetNumber, asset.assetNumber), eq(assetDepreciation.subNumber, asset.subNumber),
    )).orderBy(asc(assetDepreciation.areaCode));
    // Values count from their asset value date: an acquisition
    // effective after the period end does not depreciate in it.
    const acq = await tx.select({ amount: assetTransaction.amount, currency: assetTransaction.currency })
      .from(assetTransaction).where(and(
        eq(assetTransaction.client, client), eq(assetTransaction.companyCode, input.companyCode),
        eq(assetTransaction.assetNumber, asset.assetNumber), eq(assetTransaction.subNumber, asset.subNumber),
        eq(assetTransaction.status, 'ACTIVE'),
        sql`${assetTransaction.assetValueDate} <= ${periodEnd}`,
      ));
    const ret = await tx.select({ value: assetRetirement.retiredAcquisitionValue })
      .from(assetRetirement).where(and(
        eq(assetRetirement.client, client), eq(assetRetirement.companyCode, input.companyCode),
        eq(assetRetirement.assetNumber, asset.assetNumber), eq(assetRetirement.subNumber, asset.subNumber),
        eq(assetRetirement.status, 'ACTIVE'),
        sql`${assetRetirement.assetValueDate} <= ${periodEnd}`,
      ));
    const base = round2(
      acq.reduce((s, r) => s + Number(r.amount), 0) - ret.reduce((s, r) => s + Number(r.value), 0),
    );
    const currencies = [...new Set(acq.map((r) => r.currency.toUpperCase()))];
    const [klass] = await tx.select().from(assetClass).where(and(
      eq(assetClass.client, client), eq(assetClass.assetClass, asset.assetClass),
    ));
    const assignments = await tx.select().from(assetAssignment).where(and(
      eq(assetAssignment.client, client), eq(assetAssignment.companyCode, input.companyCode),
      eq(assetAssignment.assetNumber, asset.assetNumber), eq(assetAssignment.subNumber, asset.subNumber),
    )).orderBy(asc(assetAssignment.validFrom));
    const current = [...assignments].reverse().find(
      (a) => a.validFrom <= input.postingDate && (a.validTo === null || a.validTo > input.postingDate),
    );

    for (const area of areas) {
      const item: CalcItem = {
        assetKey: `${asset.assetNumber}/${asset.subNumber}`,
        assetNumber: asset.assetNumber, subNumber: asset.subNumber,
        areaCode: area.areaCode, depreciationKey: area.depreciationKey,
        calculatedAmount: 0, previouslyPostedAmount: 0, adjustmentAmount: 0,
        currency: currencies[0] ?? company.currency,
        expenseAccount: klass?.depreciationExpenseAccount ?? null,
        accumAccount: klass?.accumDeprAccount ?? null,
        costCenter: current?.costCenter ?? null,
        profitCenter: current?.profitCenter ?? null,
        status: 'SKIPPED', documentNumber: null, message: null, postAmount: 0,
      };
      const fail = (message: string) => { item.status = 'FAILED'; item.message = message; };
      const skip = (message: string) => { item.status = 'SKIPPED'; item.message = message; };

      if (asset.status !== 'ACTIVE') { skip(`Asset stands ${asset.status}; not depreciated.`); items.push(item); continue; }
      if (!klass?.depreciationExpenseAccount || !klass?.accumDeprAccount) {
        fail(`Asset class ${asset.assetClass} carries incomplete depreciation account determination.`);
        items.push(item); continue;
      }
      for (const account of [klass.depreciationExpenseAccount, klass.accumDeprAccount]) {
        const [standing] = await tx.select({ n: glAccount.accountNumber }).from(glAccount)
          .where(and(eq(glAccount.client, client), eq(glAccount.accountNumber, account)));
        if (!standing) { fail(`Determined account ${account} does not stand in this tenant.`); break; }
      }
      if (item.status === 'FAILED') { items.push(item); continue; }
      if (currencies.length > 1 || (currencies[0] && currencies[0] !== company.currency.toUpperCase())) {
        fail(`Asset values stand in ${currencies.join(', ')}, not the company currency ${company.currency}; foreign-currency depreciation is a later round.`);
        items.push(item); continue;
      }
      const postings = await tx.select().from(assetDepreciationPosting).where(and(
        eq(assetDepreciationPosting.client, client), eq(assetDepreciationPosting.companyCode, input.companyCode),
        eq(assetDepreciationPosting.assetNumber, asset.assetNumber), eq(assetDepreciationPosting.subNumber, asset.subNumber),
        eq(assetDepreciationPosting.areaCode, area.areaCode),
      ));
      const totalPosted = round2(postings.reduce((s, r) => s + Number(r.postedAmount), 0));
      const periodRow = postings.find(
        (r) => r.fiscalYear === input.fiscalYear && r.postingPeriod === input.postingPeriod,
      );
      item.previouslyPostedAmount = periodRow ? Number(periodRow.postedAmount) : 0;
      if (base <= 0) { skip('No depreciable value stands (acquisitions less retirements).'); items.push(item); continue; }
      const start = area.depreciationStartDate ?? asset.capitalizationDate;
      if (!start) { skip('No depreciation start date stands.'); items.push(item); continue; }
      if (start > periodEnd) { skip(`Depreciation starts ${start}, after the period end.`); items.push(item); continue; }
      const [key] = await tx.select().from(depreciationKey).where(and(
        eq(depreciationKey.client, client), eq(depreciationKey.keyCode, area.depreciationKey),
      ));
      if (!key || !key.isActive) { fail(`Depreciation key ${area.depreciationKey} is not configured active.`); items.push(item); continue; }
      const lifeMonths = area.usefulLifeYears * 12 + area.usefulLifePeriods;
      const elapsed = monthIndex(periodEnd) - monthIndex(start) + 1;
      if (elapsed > lifeMonths) { skip('Useful life has elapsed.'); items.push(item); continue; }
      const monthly = key.method === 'DECLINING_BALANCE'
        ? ((base - totalPosted) * 2) / lifeMonths
        : base / lifeMonths;
      const planned = round2(Math.min(monthly, base - totalPosted));
      if (planned <= 0) { skip('Fully depreciated.'); items.push(item); continue; }
      item.calculatedAmount = planned;
      if (input.runType === '2') {
        item.adjustmentAmount = round2(planned - item.previouslyPostedAmount);
        if (item.adjustmentAmount === 0) { skip('Already posted at the calculated amount.'); items.push(item); continue; }
        item.postAmount = item.adjustmentAmount;
        item.status = input.testRun ? 'CALCULATED' : 'POSTED';
      } else {
        if (item.previouslyPostedAmount > 0) {
          skip('Depreciation already stands posted for this period; use a repeat run for adjustments.');
          items.push(item); continue;
        }
        item.adjustmentAmount = planned;
        item.postAmount = planned;
        item.status = input.testRun ? 'CALCULATED' : 'POSTED';
      }
      items.push(item);
    }
  }
  return items;
}

export async function executeDepreciationRun(
  input: AssetDepreciationRunInput,
): Promise<DepreciationRunResult> {
  if (input.runType === '4') {
    throw new AssetDepreciationError(
      'Unplanned depreciation takes a separately recorded extraordinary transaction, which this round does not build.',
      'Run planned (1) or repeat (2) depreciation, or record the extraordinary transaction first when that round lands.',
    );
  }
  if (input.runType === '3' && !input.restartOfRunId?.trim()) {
    throw new AssetDepreciationError('A restart run must reference the failed run it resumes.', 'Name the failed run id.');
  }
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 1000 || input.fiscalYear > 9999) {
    throw new AssetDepreciationError('The fiscal year must stand as a four-digit year.');
  }
  if (!Number.isInteger(input.postingPeriod) || input.postingPeriod < 1 || input.postingPeriod > 16) {
    throw new AssetDepreciationError('The posting period must stand between 01 and 16.');
  }
  const runId = crypto.randomUUID();
  const startedAt = new Date();
  try {
    return await withTenant(input.client, async (tx) => {
      const company = await getCompanyCode(tx, input.client, input.companyCode);
      if (!company?.fiscalYearVariant) {
        throw new AssetDepreciationError(`Company code ${input.companyCode} is not configured in this tenant.`);
      }
      const fiscalYearVariant: string = company.fiscalYearVariant;
      const position = await derivePosition(tx, input.client, fiscalYearVariant, input.postingDate);
      if (position.fiscalYear !== input.fiscalYear || position.period !== input.postingPeriod) {
        throw new AssetDepreciationError(
          `Posting date ${input.postingDate} falls in ${position.fiscalYear}/${position.period}, not the selected ${input.fiscalYear}/${input.postingPeriod}.`,
          'Align the posting date with the selected fiscal year and period.',
        );
      }
      if (!input.testRun) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/afab/${input.companyCode}/${input.fiscalYear}/${input.postingPeriod}`}, 0))`);
        const [docType] = await tx.select().from(documentType).where(and(
          eq(documentType.client, input.client), eq(documentType.documentType, input.documentType.toUpperCase()),
        ));
        if (!docType) {
          throw new AssetDepreciationError(`Document type ${input.documentType.toUpperCase()} is not configured for this tenant.`);
        }
      }
      if (input.runType === '3') {
        const [failed] = await tx.select().from(assetDepreciationRun).where(and(
          eq(assetDepreciationRun.client, input.client), eq(assetDepreciationRun.runId, input.restartOfRunId!),
        ));
        if (!failed || failed.status !== 'FAILED'
          || failed.companyCode !== input.companyCode
          || failed.fiscalYear !== input.fiscalYear || failed.postingPeriod !== input.postingPeriod) {
          throw new AssetDepreciationError(
            `Run ${input.restartOfRunId} is not a failed run for this company and period.`,
            'Restart references a failed run of the same company, year and period.',
          );
        }
      }
      const variant = await getVariant(tx, input.client, company.fiscalYearVariant);
      const loadPeriods = async (calendarYear: number) => {
        const rows = await tx.select().from(fiscalYearPeriod).where(and(
          eq(fiscalYearPeriod.client, input.client),
          eq(fiscalYearPeriod.variant, fiscalYearVariant),
          eq(fiscalYearPeriod.calendarYear, calendarYear),
        ));
        return rows.filter((r) => r.periodType === 'REGULAR').sort((a, b) => a.period - b.period);
      };
      let periodRows = await loadPeriods(0);
      if (variant.isYearDependent) {
        const forYear = await loadPeriods(input.fiscalYear);
        if (forYear.length > 0) periodRows = forYear;
      }
      const windows = periodWindows(periodRows, input.fiscalYear);
      const window = windows.find((w) => w.period === input.postingPeriod);
      const periodEnd = window
        ? new Date(window.end).toISOString().slice(0, 10)
        : input.postingDate;

      const items = await calculateItems(tx, input.client, input, company, periodEnd);
      const failedItems = items.filter((i) => i.status === 'FAILED');
      if (failedItems.length > 0) {
        throw new AssetDepreciationError(
          `Account determination or configuration fails for ${failedItems.length} item(s): ${failedItems[0]!.message}`,
          'Complete the asset class determination and configuration, then rerun. Nothing was posted.',
        );
      }
      const postable = items.filter((i) => i.postAmount !== 0);
      let documentNumber: string | null = null;
      if (!input.testRun && postable.length > 0) {
        const debitGroups = new Map<string, { account: string; costCenter?: string; profitCenter?: string; amount: number }>();
        const creditGroups = new Map<string, { account: string; amount: number }>();
        for (const item of postable) {
          const dKey = `${item.expenseAccount}|${item.costCenter ?? ''}|${item.profitCenter ?? ''}`;
          const d = debitGroups.get(dKey) ?? { account: item.expenseAccount!, costCenter: item.costCenter ?? undefined, profitCenter: item.profitCenter ?? undefined, amount: 0 };
          d.amount = round2(d.amount + item.postAmount);
          debitGroups.set(dKey, d);
          const c = creditGroups.get(item.accumAccount!) ?? { account: item.accumAccount!, amount: 0 };
          c.amount = round2(c.amount + item.postAmount);
          creditGroups.set(item.accumAccount!, c);
        }
        const lines: Array<{ glAccount: string; debitCredit: 'S' | 'H'; amount: string; costCenter?: string; profitCenter?: string }> = [];
        for (const g of debitGroups.values()) {
          if (g.amount > 0) lines.push({ glAccount: g.account, debitCredit: 'S', amount: g.amount.toFixed(2), costCenter: g.costCenter, profitCenter: g.profitCenter });
          else if (g.amount < 0) lines.push({ glAccount: g.account, debitCredit: 'H', amount: Math.abs(g.amount).toFixed(2), costCenter: g.costCenter, profitCenter: g.profitCenter });
        }
        for (const g of creditGroups.values()) {
          if (g.amount > 0) lines.push({ glAccount: g.account, debitCredit: 'H', amount: g.amount.toFixed(2) });
          else if (g.amount < 0) lines.push({ glAccount: g.account, debitCredit: 'S', amount: Math.abs(g.amount).toFixed(2) });
        }
        const journal = await postJournalEntry(tx, {
          client: input.client,
          companyCode: input.companyCode,
          documentType: input.documentType.toUpperCase(),
          documentDate: input.postingDate,
          postingDate: input.postingDate,
          fiscalYear: input.fiscalYear,
          postingPeriod: input.postingPeriod,
          currency: company.currency.toUpperCase(),
          localCurrency: company.currency.toUpperCase(),
          headerText: `Depreciation run ${input.fiscalYear}/${input.postingPeriod}`,
          lines,
          origin: { documentClass: ASSET_DEPRECIATION_RUN_CLASS, documentKey: runId },
          postedBy: input.changedBy,
          transactionCode: ASSET_DEPRECIATE_CAPABILITY,
        }).catch((error: unknown) => {
          if (error instanceof PostingError) throw new AssetDepreciationError(error.message, error.remedy);
          if (error instanceof Error && 'remedy' in error) {
            throw new AssetDepreciationError(error.message, (error as { remedy?: string }).remedy);
          }
          throw error;
        });
        documentNumber = journal.documentNumber;
        for (const item of postable) item.documentNumber = documentNumber;
      }

      const totalCalculated = round2(items.reduce((s, i) => s + i.calculatedAmount, 0));
      const totalPosted = input.testRun ? 0 : round2(postable.reduce((s, i) => s + i.postAmount, 0));
      const hasWarnings = items.some((i) => i.status === 'SKIPPED');
      const status: DepreciationRunStatus = input.testRun
        ? 'SIMULATED'
        : hasWarnings ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED';
      await tx.insert(assetDepreciationRun).values({
        client: input.client, runId, companyCode: input.companyCode,
        fiscalYear: input.fiscalYear, postingPeriod: input.postingPeriod,
        runType: input.runType, isTestRun: input.testRun,
        postingDate: input.postingDate,
        documentType: input.testRun ? (input.documentType || null) : input.documentType.toUpperCase(),
        status, totalCalculatedAmount: String(totalCalculated),
        totalPostedAmount: String(totalPosted),
        currency: company.currency.toUpperCase(),
        documentNumber, documentFiscalYear: documentNumber ? input.fiscalYear : null,
        restartOfRunId: input.restartOfRunId ?? null,
        executedBy: input.changedBy, startedAt, completedAt: new Date(),
        createdBy: input.changedBy,
      });
      let itemNumber = 0;
      for (const item of items) {
        itemNumber += 1;
        await tx.insert(assetDepreciationRunItem).values({
          client: input.client, runId, itemNumber,
          companyCode: input.companyCode,
          assetNumber: item.assetNumber, subNumber: item.subNumber,
          areaCode: item.areaCode, depreciationKey: item.depreciationKey,
          calculatedAmount: String(item.calculatedAmount),
          previouslyPostedAmount: String(item.previouslyPostedAmount),
          adjustmentAmount: String(item.adjustmentAmount),
          currency: item.currency.toUpperCase(),
          expenseAccount: item.expenseAccount, accumAccount: item.accumAccount,
          costCenter: item.costCenter, profitCenter: item.profitCenter,
          itemStatus: item.status, documentNumber: item.documentNumber,
          message: item.message, createdBy: input.changedBy,
        });
      }
      if (!input.testRun) {
        for (const item of postable) {
          await tx.insert(assetDepreciationPosting).values({
            client: input.client, companyCode: input.companyCode,
            assetNumber: item.assetNumber, subNumber: item.subNumber,
            areaCode: item.areaCode, fiscalYear: input.fiscalYear,
            postingPeriod: input.postingPeriod,
            postedAmount: String(item.calculatedAmount),
            currency: item.currency.toUpperCase(), runId,
            documentNumber, documentFiscalYear: documentNumber ? input.fiscalYear : null,
            createdBy: input.changedBy,
          }).onConflictDoUpdate({
            target: [
              assetDepreciationPosting.client, assetDepreciationPosting.companyCode,
              assetDepreciationPosting.assetNumber, assetDepreciationPosting.subNumber,
              assetDepreciationPosting.areaCode, assetDepreciationPosting.fiscalYear,
              assetDepreciationPosting.postingPeriod,
            ],
            set: {
              postedAmount: String(item.calculatedAmount), runId,
              documentNumber, documentFiscalYear: documentNumber ? input.fiscalYear : null,
              changedBy: input.changedBy, changedAt: new Date(),
            },
          });
        }
      }
      await recordChange(tx, {
        client: input.client, objectClass: ASSET_DEPRECIATION_RUN_CLASS,
        objectKey: runId,
        changeType: 'CREATE', changedBy: input.changedBy, transactionCode: ASSET_DEPRECIATE_CAPABILITY,
        after: {
          companyCode: input.companyCode, fiscalYear: input.fiscalYear,
          postingPeriod: input.postingPeriod, runType: input.runType,
          testRun: input.testRun, status, totalCalculated, totalPosted,
          documentNumber,
        },
      });
      const warnings: string[] = [];
      if (input.testRun) warnings.push('Test run: the log stands, but no journal, posting record or balance changed.');
      if (hasWarnings) warnings.push(`${items.filter((i) => i.status === 'SKIPPED').length} item(s) skipped — see the run log.`);
      if (!input.testRun && postable.length === 0) warnings.push('Nothing stood to post for this period; no document was created.');
      return {
        runId, status, testRun: input.testRun,
        totalCalculated, totalPosted,
        currency: company.currency.toUpperCase(),
        documentNumber,
        items: items.map(({ postAmount: _p, assetKey: _k, ...view }) => view),
        warnings,
      };
    });
  } catch (error) {
    // A failed run posts nothing; its header is written after the
    // rollback so a restart can reference it.
    try {
      await withTenant(input.client, async (tx) => {
        const company = await getCompanyCode(tx, input.client, input.companyCode).catch(() => null);
        await tx.insert(assetDepreciationRun).values({
          client: input.client, runId, companyCode: input.companyCode,
          fiscalYear: input.fiscalYear, postingPeriod: input.postingPeriod,
          runType: input.runType, isTestRun: input.testRun,
          postingDate: input.postingDate,
          documentType: input.documentType || null,
          status: 'FAILED', totalCalculatedAmount: '0', totalPostedAmount: '0',
          currency: (company?.currency ?? 'XXX').toUpperCase(),
          restartOfRunId: input.restartOfRunId ?? null,
          errorMessage: error instanceof Error ? error.message : String(error),
          executedBy: input.changedBy, startedAt, completedAt: new Date(),
          createdBy: input.changedBy,
        });
      });
    } catch { /* the original error stands */ }
    throw error;
  }
}

export async function listDepreciationRuns(client: string, companyCode?: string, limit = 20) {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(assetDepreciationRun).where(companyCode
      ? and(eq(assetDepreciationRun.client, client), eq(assetDepreciationRun.companyCode, companyCode))
      : eq(assetDepreciationRun.client, client))
      .orderBy(sql`${assetDepreciationRun.startedAt} desc`)
      .limit(limit);
    return rows.map((r) => ({
      runId: r.runId, companyCode: r.companyCode, fiscalYear: r.fiscalYear,
      postingPeriod: r.postingPeriod, runType: r.runType, isTestRun: r.isTestRun,
      status: r.status as DepreciationRunStatus,
      totalCalculated: Number(r.totalCalculatedAmount), totalPosted: Number(r.totalPostedAmount),
      currency: r.currency, documentNumber: r.documentNumber,
      documentFiscalYear: r.documentFiscalYear, executedBy: r.executedBy,
      startedAt: r.startedAt, errorMessage: r.errorMessage,
    }));
  });
}

export async function getDepreciationRunItems(client: string, runId: string) {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(assetDepreciationRunItem).where(and(
      eq(assetDepreciationRunItem.client, client), eq(assetDepreciationRunItem.runId, runId),
    )).orderBy(asc(assetDepreciationRunItem.itemNumber));
    return rows.map((r) => ({
      assetNumber: r.assetNumber, subNumber: r.subNumber, areaCode: r.areaCode,
      depreciationKey: r.depreciationKey,
      calculatedAmount: Number(r.calculatedAmount),
      previouslyPostedAmount: Number(r.previouslyPostedAmount),
      adjustmentAmount: Number(r.adjustmentAmount),
      currency: r.currency, expenseAccount: r.expenseAccount, accumAccount: r.accumAccount,
      costCenter: r.costCenter, profitCenter: r.profitCenter, status: r.itemStatus as DepreciationItemStatus,
      documentNumber: r.documentNumber, message: r.message,
    }));
  });
}

export async function getPostedDepreciation(
  client: string, companyCode: string, assetNumber: string, subNumber: string,
) {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(assetDepreciationPosting).where(and(
      eq(assetDepreciationPosting.client, client), eq(assetDepreciationPosting.companyCode, companyCode),
      eq(assetDepreciationPosting.assetNumber, assetNumber), eq(assetDepreciationPosting.subNumber, subNumber),
    )).orderBy(asc(assetDepreciationPosting.fiscalYear), asc(assetDepreciationPosting.postingPeriod));
    return rows.map((r) => ({
      areaCode: r.areaCode, fiscalYear: r.fiscalYear, postingPeriod: r.postingPeriod,
      postedAmount: Number(r.postedAmount), currency: r.currency,
      runId: r.runId, documentNumber: r.documentNumber,
    }));
  });
}
