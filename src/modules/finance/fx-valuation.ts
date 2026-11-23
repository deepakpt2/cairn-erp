/**
 * Foreign currency valuation — SCR-098 / R-146 (FAGL_FC_VAL as a
 * search alias only).
 *
 * Stage 1 vocabulary. The valuation service lands in stage 3.
 */
export const FX_VALUATION_CAPABILITY = 'FIN.FX.VALUATE';

export class FxValuationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FxValuationError';
  }
}

export const FX_RATE_TYPES = ['AVERAGE', 'BUYING', 'SELLING'] as const;
export type FxRateType = (typeof FX_RATE_TYPES)[number];

export interface FxValuationSelection {
  companyCode: string;
  valuationArea: string;
  valuationKeyDate: string;
  postingDate: string;
  fiscalYear: number;
  valuationMethod: FxRateType;
  includeOpenItems: boolean;
  includeBalances: boolean;
  testRun: boolean;
  documentType: string;
  reversalDate?: string;
  requestKey: string;
}

export type FxItemStatus = 'CALCULATED' | 'POSTED' | 'SKIPPED' | 'ERROR';

/**
 * The required local value of a foreign amount, expressed at the four-decimal storage scale but
 * rounded once at the local currency's configured minor unit. Exact rational arithmetic; no binary
 * floating point and no use of the storage scale as the currency scale.
 */
export function valuationRequiredUnits(
  foreignUnits: bigint,
  rate: ResolvedExchangeRate,
  localScale: number,
): bigint {
  const minor = 10n ** BigInt(MONEY_SCALE - localScale);
  const requiredMinor = divideRound(
    foreignUnits * rate.numerator * 10n ** BigInt(localScale),
    rate.denominator * 10n ** BigInt(MONEY_SCALE),
  );
  return requiredMinor * minor;
}

export interface FxValuationItem {
  itemNumber: number;
  sourceKind: 'OPEN_ITEM' | 'BALANCE';
  accountNumber: string;
  sourceDocument: string | null;
  sourceLine: number | null;
  currency: string;
  foreignAmount: number;
  carryingAmount: number;
  valuationRate: number | null;
  rateType: string;
  requiredAmount: number | null;
  adjustmentAmount: number | null;
  classification: 'GAIN' | 'LOSS' | 'NONE' | null;
  status: FxItemStatus;
  error: string | null;
  postingDocument: string | null;
}

export interface FxValuationResult {
  runId: string;
  status: 'TEST' | 'COMPLETED' | 'REVERSED';
  companyCode: string;
  valuationArea: string;
  valuationKeyDate: string;
  postingDate: string;
  fiscalYear: number;
  valuationMethod: string;
  currency: string;
  items: FxValuationItem[];
  totalGain: number;
  totalLoss: number;
  postingDocument: string | null;
  reversalDocument: string | null;
  warnings: string[];
}

import { and, eq, sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { authorizeCompaniesInTx, verifyCompanyAuthorityInTx, refuseCompaniesOutsideScopeInTx } from '../../platform/auth/company-scope';
import type { ServiceAuthorityContext } from '../../platform/auth/service-authority';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, reverseJournalEntry, PostingError } from '../../platform/posting';
import { MONEY_SCALE, divideRound, fromScaled, toScaled } from '../../platform/posting/decimal';
import { moneyFor } from '../../platform/posting/money';
import { accountDetermination, bankAccount } from '../foundation/schema';
import { clearingReset, fxValuationItem, fxValuationRun, journalEntry, journalEntryLine } from './schema';
import {
  resolveExchangeRate, type ResolvedExchangeRate,
} from './exchange-rate-lookup';
import { lockValuationSettlement } from './fx-settlement';

interface CandidateRow {
  document_number: string;
  fiscal_year: number;
  line_number: number;
  gl_account: string;
  debit_credit: string;
  amount_document: string;
  amount_local: string;
  currency: string;
  is_open_item: boolean;
  is_balance_sheet: boolean;
  clearing_document: string | null;
  clearing_date: string | null;
  status: string;
  reversal_of: string | null;
  posting_date: string;
  reversal_posting_date: string | null;
}

interface ClearingInterval {
  clearingDate: string;
  resetDate: string;
}

async function loadClearingIntervals(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  client: string,
  companyCode: string,
): Promise<Map<string, ClearingInterval[]>> {
  const rows = (await tx.execute(sql`
    select clearing_date::text as clearing_date, created_at::date::text as reset_date, item_refs
      from clearing_reset
     where client = ${client} and company_code = ${companyCode}
  `)) as unknown as Array<{ clearing_date: string; reset_date: string; item_refs: string }>;
  const map = new Map<string, ClearingInterval[]>();
  for (const row of rows) {
    for (const ref of row.item_refs.split(',').map((part) => part.trim()).filter(Boolean)) {
      const list = map.get(ref) ?? [];
      list.push({ clearingDate: row.clearing_date, resetDate: row.reset_date });
      map.set(ref, list);
    }
  }
  return map;
}

function clearedAsOf(
  row: CandidateRow,
  keyDate: string,
  intervals: Map<string, ClearingInterval[]>,
): boolean {
  if (row.clearing_document) {
    if (!row.clearing_date) {
      throw new FxValuationError(
        `Line ${row.document_number}/${row.line_number} stands stamped by clearing document ${row.clearing_document} without a clearing date; its position at ${keyDate} cannot be proved.`,
      );
    }
    return row.clearing_date <= keyDate;
  }
  const ref = `${row.document_number}/${row.fiscal_year}/${row.line_number}`;
  for (const interval of intervals.get(ref) ?? []) {
    if (interval.clearingDate <= keyDate && keyDate < interval.resetDate) return true;
  }
  return false;
}

async function loadRun(tx: Parameters<Parameters<typeof withTenant>[1]>[0], client: string, runId: string): Promise<FxValuationResult | null> {
  const [run] = await tx.select().from(fxValuationRun).where(and(
    eq(fxValuationRun.client, client), eq(fxValuationRun.runId, runId),
  ));
  if (!run) return null;
  const items = await tx.select().from(fxValuationItem).where(and(
    eq(fxValuationItem.client, client), eq(fxValuationItem.runId, runId),
  )).orderBy(fxValuationItem.itemNumber);
  const [company] = await tx.select().from(journalEntry).where(and(
    eq(journalEntry.client, client), eq(journalEntry.companyCode, run.companyCode),
  )).limit(1);
  return {
    runId: run.runId, status: run.status as FxValuationResult['status'],
    companyCode: run.companyCode, valuationArea: run.valuationArea,
    valuationKeyDate: run.valuationKeyDate, postingDate: run.postingDate,
    fiscalYear: run.fiscalYear, valuationMethod: run.valuationMethod,
    currency: company?.localCurrency ?? '',
    items: items.map((i) => ({
      itemNumber: i.itemNumber, sourceKind: i.sourceKind as 'OPEN_ITEM' | 'BALANCE',
      accountNumber: i.accountNumber, sourceDocument: i.sourceDocument, sourceLine: i.sourceLine,
      currency: i.currency, foreignAmount: Number(i.foreignAmount), carryingAmount: Number(i.carryingAmount),
      valuationRate: i.valuationRate === null ? null : Number(i.valuationRate), rateType: i.rateType,
      requiredAmount: i.requiredAmount === null ? null : Number(i.requiredAmount),
      adjustmentAmount: i.adjustmentAmount === null ? null : Number(i.adjustmentAmount),
      classification: i.classification as FxValuationItem['classification'],
      status: i.status as FxItemStatus, error: i.error, postingDocument: i.postingDocument,
    })),
    totalGain: Number(run.totalGainAmount), totalLoss: Number(run.totalLossAmount),
    postingDocument: run.postingDocumentNumber, reversalDocument: run.reversalDocumentNumber,
    warnings: [],
  };
}

/**
 * Execute the foreign-currency valuation for a judged selection.
 * Test runs persist only the protocol; live runs additionally post
 * one balanced adjustment document atomically, and optionally
 * reverse it on the named date through the canonical workflow.
 */
export async function executeFxValuation(input: {
  client: string; changedBy: string; selection: FxValuationSelection;
  /** Verified session or job lease; capability and Company Code scope are judged in the posting transaction. */
  authorization: ServiceAuthorityContext | undefined;
}): Promise<FxValuationResult> {
  const s = input.selection;
  if (!FX_RATE_TYPES.includes(s.valuationMethod)) {
    throw new FxValuationError(`Valuation method ${s.valuationMethod} is not a configured rate type.`);
  }
  if (!s.valuationArea || s.valuationArea.length > 6) {
    throw new FxValuationError('A valuation area of at most six characters is required.');
  }
  if (!s.includeOpenItems && !s.includeBalances) {
    throw new FxValuationError('Select open items, G/L balances, or both.');
  }
  if (!s.requestKey?.trim()) throw new FxValuationError('A request key is required.');

  return withTenant(input.client, async (tx) => {
    const scope = await authorizeCompaniesInTx(tx, input.client, input.authorization, FX_VALUATION_CAPABILITY, [s.companyCode]);
    if (!scope.ok) throw new FxValuationError(`${scope.refusal.message} ${scope.refusal.remedy}`);
    const actor = scope.username;
    const [existing] = await tx.select().from(fxValuationRun).where(and(
      eq(fxValuationRun.client, input.client), eq(fxValuationRun.requestKey, s.requestKey),
    ));
    if (existing) {
      if (existing.companyCode !== s.companyCode) {
        throw new FxValuationError('The request key already stands against another valuation run.');
      }
      const replay = await loadRun(tx, input.client, existing.runId);
      if (replay) return replay;
    }

    const company = await getCompanyCode(tx, input.client, s.companyCode);
    if (!company?.isActive) {
      throw new FxValuationError(`Company code ${s.companyCode} is not active or does not exist.`);
    }
    const position = await derivePosition(tx, input.client, company.fiscalYearVariant!, s.postingDate)
      .catch((e: unknown) => { throw new FxValuationError(e instanceof Error ? e.message : 'Posting date cannot be judged.'); });
    if (position.fiscalYear !== s.fiscalYear) {
      throw new FxValuationError(
        `Posting date ${s.postingDate} belongs to fiscal year ${position.fiscalYear}, not ${s.fiscalYear}.`,
      );
    }
    if (s.valuationKeyDate > s.postingDate) {
      throw new FxValuationError(
        `Valuation key date ${s.valuationKeyDate} stands after the posting date ${s.postingDate}. A valuation cannot post before the position it values.`,
      );
    }
    if (s.reversalDate && s.reversalDate < s.postingDate) {
      throw new FxValuationError(
        `Valuation reversal date ${s.reversalDate} stands before the posting date ${s.postingDate}.`,
      );
    }
    const local = company.currency;
    const chart = company.chartOfAccounts ?? '';
    const localMoney = await moneyFor(tx, local);
    // Serialize valuation and settlement for this company: neither may pass its "no active
    // valuation" check while the other is still inside its transaction.
    await lockValuationSettlement(tx, input.client, s.companyCode);
    const roundLocal = (value: string | number) => localMoney.round(value);
    const localScale = localMoney.scale;
    const minor = 10n ** BigInt(MONEY_SCALE - localScale);
    const foreignMoney = new Map<string, Awaited<ReturnType<typeof moneyFor>>>();

    // Bank G/L ownership and currency, so exposure is judged by the money the account actually
    // holds, not by the currency of the document that happened to touch it.
    const bankRows = await tx.select({
      glAccount: bankAccount.glAccount, currency: bankAccount.currency,
    }).from(bankAccount).where(and(
      eq(bankAccount.client, input.client),
      eq(bankAccount.companyCode, s.companyCode),
    ));
    const bankByGl = new Map<string, string[]>();
    for (const bank of bankRows) {
      const key = bank.glAccount.trim();
      const list = bankByGl.get(key) ?? [];
      list.push(bank.currency.trim().toUpperCase());
      bankByGl.set(key, list);
    }

    const clearingIntervals = await loadClearingIntervals(tx, input.client, s.companyCode);
    const raw = await tx.execute(sql`
      select l.document_number, l.fiscal_year, l.line_number, l.gl_account, l.debit_credit,
             l.amount_document, l.amount_local, l.currency,
             g.is_open_item_managed as is_open_item, g.is_balance_sheet,
             l.clearing_document, l.clearing_date::text as clearing_date,
             h.status, h.reversal_of, h.posting_date::text as posting_date,
             (select rev.posting_date::text from journal_entry rev
               where rev.client = h.client and rev.document_number = h.reversed_by
                 and rev.reversal_of = h.document_number and rev.status = 'POSTED'
               order by rev.posting_date limit 1) as reversal_posting_date
      from journal_entry_line l
      join journal_entry h
        on h.client = l.client and h.document_number = l.document_number and h.fiscal_year = l.fiscal_year
      join gl_account g
        on g.client = l.client and g.chart_of_accounts = ${chart} and g.account_number = l.gl_account
      where l.client = ${input.client}
        and h.company_code = ${s.companyCode}
        and h.posting_date <= ${s.valuationKeyDate}
        and h.status in ('POSTED', 'REVERSED')
        and h.is_fx_valuation = false
      order by l.gl_account, l.currency, l.document_number, l.line_number
    `);
    const candidates = raw as unknown as CandidateRow[];

    interface WorkItem extends FxValuationItem {
      signedForeign: number; signedCarrying: number;
      signedForeignUnits: bigint; signedCarryingUnits: bigint;
      signedAdjustmentUnits?: bigint;
    }
    const work: WorkItem[] = [];
    const balanceGroups = new Map<string, WorkItem>();
    for (const row of candidates) {
      const sign = row.debit_credit === 'S' ? 1 : -1;
      const lineCurrency = row.currency.trim().toUpperCase();
      const reversalEffective = row.status === 'REVERSED'
        && row.reversal_posting_date !== null && row.reversal_posting_date <= s.valuationKeyDate;
      const reversalUnproven = row.status === 'REVERSED' && row.reversal_posting_date === null;
      if (row.is_open_item) {
        if (!s.includeOpenItems) continue;
        // Mirrors are not open items. A reversed original is included only while its reversal is
        // still in the future at the key date; after that the item no longer stood open.
        if (row.reversal_of) continue;
        if (reversalUnproven) {
          throw new FxValuationError(
            `Open item ${row.document_number}/${row.line_number} stands reversed without a provable mirror; its position at ${s.valuationKeyDate} cannot be valued.`,
          );
        }
        if (reversalEffective) continue;
        if (clearedAsOf(row, s.valuationKeyDate, clearingIntervals)) continue;
        if (lineCurrency === local) continue;
        work.push({
          itemNumber: 0, sourceKind: 'OPEN_ITEM', accountNumber: row.gl_account,
          sourceDocument: row.document_number, sourceLine: row.line_number,
          currency: lineCurrency, foreignAmount: 0, carryingAmount: 0,
          valuationRate: null, rateType: s.valuationMethod, requiredAmount: null,
          adjustmentAmount: null, classification: null, status: 'CALCULATED',
          error: null, postingDocument: null,
          signedForeign: sign * Number(row.amount_document), signedCarrying: sign * Number(row.amount_local),
          signedForeignUnits: BigInt(sign) * toScaled(row.amount_document),
          signedCarryingUnits: BigInt(sign) * toScaled(row.amount_local),
        });
      } else if (row.is_balance_sheet) {
        if (!s.includeBalances) continue;
        const bankCurrencies = bankByGl.get(row.gl_account);
        let exposureCurrency = lineCurrency;
        if (bankCurrencies) {
          if (bankCurrencies.length > 1) {
            throw new FxValuationError(
              `Bank G/L ${row.gl_account} is shared by ${bankCurrencies.length} bank accounts in company ${s.companyCode}, so its currency exposure cannot be attributed. Give each bank account its own G/L before valuing.`,
            );
          }
          const bankCurrency = bankCurrencies[0]!;
          // A local-currency bank is not a foreign position merely because a foreign document touched
          // it; its actual KWD movement is already the carrying amount.
          if (bankCurrency === local) continue;
          if (lineCurrency !== bankCurrency) {
            throw new FxValuationError(
              `Bank G/L ${row.gl_account} is held in ${bankCurrency}, but line ${row.document_number}/${row.line_number} stands in ${lineCurrency}. A third-currency bank movement cannot be valued without inventing an account-currency amount.`,
            );
          }
          exposureCurrency = bankCurrency;
        } else if (lineCurrency === local) {
          continue;
        }
        if (reversalUnproven) {
          throw new FxValuationError(
            `Balance line ${row.document_number}/${row.line_number} stands reversed without a provable mirror; its position at ${s.valuationKeyDate} cannot be valued.`,
          );
        }
        // Both the original and its mirror are dated movements. The query filters by posting date,
        // so a reversal after the key date leaves only the original, while an effective reversal
        // brings both and the pair nets to zero.
        const key = `${row.gl_account}|${exposureCurrency}`;
        const group = balanceGroups.get(key) ?? {
          itemNumber: 0, sourceKind: 'BALANCE' as const, accountNumber: row.gl_account,
          sourceDocument: null, sourceLine: null, currency: exposureCurrency,
          foreignAmount: 0, carryingAmount: 0, valuationRate: null,
          rateType: s.valuationMethod, requiredAmount: null, adjustmentAmount: null,
          classification: null, status: 'CALCULATED' as FxItemStatus, error: null,
          postingDocument: null, signedForeign: 0, signedCarrying: 0,
          signedForeignUnits: 0n, signedCarryingUnits: 0n,
        };
        group.signedForeign += sign * Number(row.amount_document);
        group.signedCarrying += sign * Number(row.amount_local);
        group.signedForeignUnits += BigInt(sign) * toScaled(row.amount_document);
        group.signedCarryingUnits += BigInt(sign) * toScaled(row.amount_local);
        balanceGroups.set(key, group);
      }
    }
    work.push(...balanceGroups.values());

    // A new live valuation may not overlap an earlier live valuation of the same basis, in either
    // time direction. Each posting is effective over [posting date, reversal date); a backdated run
    // after a later one, or an earlier run whose reversal is future, would double-count. Different
    // areas and key dates do not bypass the conflict.
    if (!s.testRun) {
      const prior = (await tx.execute(sql`
        select i.source_kind, i.source_document, i.source_line, i.account_number, i.currency,
               r.run_id, r.valuation_key_date::text as valuation_key_date,
               v.posting_date::text as posting_date,
               (select rev.posting_date::text from journal_entry rev
                 where rev.client = v.client and rev.document_number = v.reversed_by
                   and rev.reversal_of = v.document_number and rev.status = 'POSTED'
                 order by rev.posting_date limit 1) as reversal_date
          from fx_valuation_item i
          join fx_valuation_run r on r.client = i.client and r.run_id = i.run_id
          join journal_entry v
            on v.client = i.client and v.document_number = r.posting_document_number
           and v.company_code = r.company_code
         where i.client = ${input.client} and r.company_code = ${s.companyCode}
           and r.is_test_run = false and i.status = 'POSTED'
           and r.posting_document_number is not null
           and v.status in ('POSTED', 'REVERSED')
      `)) as unknown as Array<{
        source_kind: string; source_document: string | null; source_line: number | null;
        account_number: string; currency: string; run_id: string;
        valuation_key_date: string; posting_date: string; reversal_date: string | null;
      }>;
      const openPrior = new Map<string, typeof prior>();
      const balancePrior = new Map<string, typeof prior>();
      for (const row of prior) {
        if (row.source_kind === 'BALANCE') {
          const key = `${row.account_number}|${row.currency}`;
          balancePrior.set(key, [...(balancePrior.get(key) ?? []), row]);
        } else {
          const key = `${row.source_document}|${row.source_line}`;
          openPrior.set(key, [...(openPrior.get(key) ?? []), row]);
        }
      }
      const newStart = s.postingDate;
      const newEnd = s.reversalDate ?? '9999-12-31';
      for (const item of work) {
        const basis = item.sourceKind === 'BALANCE'
          ? `balance ${item.accountNumber}/${item.currency}`
          : `open item ${item.sourceDocument}/${item.sourceLine}`;
        const rows = item.sourceKind === 'BALANCE'
          ? balancePrior.get(`${item.accountNumber}|${item.currency}`)
          : openPrior.get(`${item.sourceDocument}|${item.sourceLine}`);
        for (const row of rows ?? []) {
          const priorEnd = row.reversal_date ?? '9999-12-31';
          // A same-day posting and reversal is an empty interval: it adjusted nothing at any date.
          if (row.posting_date >= priorEnd) continue;
          if (newStart < priorEnd && row.posting_date < newEnd) {
            throw new FxValuationError(
              `The ${basis} overlaps valuation run ${row.run_id} (key date ${row.valuation_key_date}), which is effective ${row.posting_date} to ${row.reversal_date ?? 'open'}. Reverse or correct that valuation before posting an overlapping or backdated run; otherwise the same basis would be adjusted twice. Nothing was posted.`,
            );
          }
        }
      }
    }

    // Rates: the newest validity on or before the key date, honouring ratios and direct/indirect
    // quotation. A future-dated row never hides an earlier valid one.
    const rateByCurrency = new Map<string, ResolvedExchangeRate>();
    const missingRates = new Set<string>();
    for (const item of work) {
      if (rateByCurrency.has(item.currency) || missingRates.has(item.currency)) continue;
      const resolved = await resolveExchangeRate(
        tx, input.client, item.currency, local, s.valuationKeyDate, s.valuationMethod,
      );
      if (!resolved) missingRates.add(item.currency);
      else rateByCurrency.set(item.currency, resolved);
    }
    for (const item of work) {
      if (!foreignMoney.has(item.currency)) foreignMoney.set(item.currency, await moneyFor(tx, item.currency));
    }

    const warnings: string[] = [];
    let totalGainUnits = 0n;
    let totalLossUnits = 0n;
    work.forEach((item, index) => {
      item.itemNumber = index + 1;
      const foreign = foreignMoney.get(item.currency)!;
      item.foreignAmount = foreign.round(Math.abs(item.signedForeign));
      item.carryingAmount = roundLocal(Math.abs(item.signedCarrying));
      const rate = rateByCurrency.get(item.currency);
      if (rate === undefined) {
        item.status = 'ERROR';
        item.error = `No ${s.valuationMethod} rate for ${item.currency}/${local} stands valid on or before ${s.valuationKeyDate}.`;
        return;
      }
      item.valuationRate = Number(rate.effectiveRate);
      // The existing carrying amount must already stand at the local currency's minor unit; a legacy
      // fourth decimal is surfaced, never silently rounded away or posted.
      if (item.signedCarryingUnits % minor !== 0n) {
        item.status = 'ERROR';
        item.error = `The carrying amount ${fromScaled(item.signedCarryingUnits < 0n ? -item.signedCarryingUnits : item.signedCarryingUnits, 4)} has more decimals than ${local} allows (${localScale}); correct the source document before valuing.`;
        return;
      }
      // One exact rational calculation, rounded once at the local currency's configured minor unit.
      const requiredUnits = valuationRequiredUnits(item.signedForeignUnits, rate, localScale);
      const adjustmentUnits = requiredUnits - item.signedCarryingUnits;
      item.requiredAmount = roundLocal(fromScaled(requiredUnits < 0n ? -requiredUnits : requiredUnits, MONEY_SCALE));
      item.adjustmentAmount = roundLocal(fromScaled(adjustmentUnits < 0n ? -adjustmentUnits : adjustmentUnits, MONEY_SCALE));
      if (adjustmentUnits < 0n) item.adjustmentAmount = -item.adjustmentAmount!;
      item.classification = adjustmentUnits > 0n ? 'GAIN' : adjustmentUnits < 0n ? 'LOSS' : 'NONE';
      if (adjustmentUnits > 0n) totalGainUnits += adjustmentUnits;
      if (adjustmentUnits < 0n) totalLossUnits += -adjustmentUnits;
      item.signedAdjustmentUnits = adjustmentUnits;
    });
    const totalGain = roundLocal(fromScaled(totalGainUnits, MONEY_SCALE));
    const totalLoss = roundLocal(fromScaled(totalLossUnits, MONEY_SCALE));
    if (missingRates.size > 0) {
      warnings.push(`No valuation rate stands for: ${[...missingRates].join(', ')}. Those items are errors, never valued at a substituted rate.`);
    }

    const runId = `FX${Date.now().toString(36).toUpperCase()}`.slice(0, 24);
    await tx.insert(fxValuationRun).values({
      client: input.client, runId, requestKey: s.requestKey,
      companyCode: s.companyCode, fiscalYear: s.fiscalYear, valuationArea: s.valuationArea,
      valuationKeyDate: s.valuationKeyDate, postingDate: s.postingDate,
      reversalDate: s.reversalDate ?? null, valuationMethod: s.valuationMethod,
      documentType: s.documentType, isTestRun: s.testRun,
      includeOpenItems: s.includeOpenItems, includeBalances: s.includeBalances,
      status: s.testRun ? 'TEST' : 'COMPLETED',
      totalGainAmount: String(totalGain), totalLossAmount: String(totalLoss),
      createdBy: actor, completedAt: s.testRun ? null : new Date(),
    });

    let postingDocument: string | null = null;
    let reversalDocument: string | null = null;
    if (!s.testRun) {
      const postable = work.filter((i) => i.status === 'CALCULATED'
        && i.signedAdjustmentUnits !== undefined && i.signedAdjustmentUnits !== 0n);
      const failed = work.filter((i) => i.status === 'ERROR');
      if (failed.length > 0) {
        throw new FxValuationError(
          `Valuation cannot post: ${failed.length} item(s) carry errors (first: ${failed[0].error}). Nothing was posted.`,
        );
      }
      if (postable.length > 0) {
        const determination = async (event: string) => {
          const [row] = await tx.select().from(accountDetermination).where(and(
            eq(accountDetermination.client, input.client),
            eq(accountDetermination.chartOfAccounts, chart),
            eq(accountDetermination.event, event),
          ));
          if (!row) throw new FxValuationError(`Account determination for ${event} does not stand in chart ${chart}.`);
          return row.glAccount;
        };
        const lines: Array<{ glAccount: string; debitCredit: 'S' | 'H'; amount: string; lineText?: string }> = [];
        const gainAccount = totalGain > 0 ? await determination('FXGAIN') : null;
        const lossAccount = totalLoss > 0 ? await determination('FXLOSS') : null;
        for (const item of postable) {
          const units = item.signedAdjustmentUnits!;
          const amount = fromScaled(units < 0n ? -units : units, MONEY_SCALE);
          if (units > 0n) {
            lines.push({ glAccount: item.accountNumber, debitCredit: 'S', amount, lineText: `FX valuation ${item.currency}` });
            lines.push({ glAccount: gainAccount!, debitCredit: 'H', amount, lineText: 'FX gain' });
          } else {
            lines.push({ glAccount: item.accountNumber, debitCredit: 'H', amount, lineText: `FX valuation ${item.currency}` });
            lines.push({ glAccount: lossAccount!, debitCredit: 'S', amount, lineText: 'FX loss' });
          }
        }
        const posted = await postJournalEntry(tx, {
          client: input.client, companyCode: s.companyCode, documentType: s.documentType,
          documentDate: s.postingDate, postingDate: s.postingDate,
          fiscalYear: position.fiscalYear, postingPeriod: position.period,
          currency: local, localCurrency: local,
          headerText: `FX valuation ${s.valuationArea} ${s.valuationKeyDate}`,
          lines, postedBy: actor, transactionCode: FX_VALUATION_CAPABILITY,
          isFxValuation: true, precision: 'CURRENCY',
        }).catch((error: unknown) => {
          if (error instanceof PostingError) throw new FxValuationError(`${error.message} ${error.remedy}`);
          throw error;
        });
        postingDocument = posted.documentNumber;
        for (const item of postable) {
          item.status = 'POSTED';
          item.postingDocument = postingDocument;
        }
        if (s.reversalDate) {
          const reversal = await reverseJournalEntry(tx, {
            client: input.client, documentNumber: postingDocument, fiscalYear: position.fiscalYear,
            reversalDate: s.reversalDate, reason: `FX valuation reversal ${runId}`,
            reversedBy: actor, transactionCode: FX_VALUATION_CAPABILITY,
          }).catch((error: unknown) => {
            if (error instanceof PostingError) throw new FxValuationError(`${error.message} ${error.remedy}`);
            throw error;
          });
          reversalDocument = reversal.documentNumber;
        }
      }
    }

    for (const item of work) {
      await tx.insert(fxValuationItem).values({
        client: input.client, runId, companyCode: s.companyCode, fiscalYear: s.fiscalYear,
        valuationArea: s.valuationArea, itemNumber: item.itemNumber,
        sourceKind: item.sourceKind, accountNumber: item.accountNumber,
        sourceDocument: item.sourceDocument, sourceLine: item.sourceLine,
        currency: item.currency, foreignAmount: String(item.foreignAmount),
        carryingAmount: String(item.carryingAmount),
        valuationRate: item.valuationRate === null ? null : String(item.valuationRate),
        rateType: s.valuationMethod,
        requiredAmount: item.requiredAmount === null ? null : String(item.requiredAmount),
        adjustmentAmount: item.adjustmentAmount === null ? null : String(item.adjustmentAmount),
        classification: item.classification, postingDocument: item.postingDocument,
        status: item.status, error: item.error,
      });
    }
    if (postingDocument) {
      await tx.update(fxValuationRun).set({
        postingDocumentNumber: postingDocument, reversalDocumentNumber: reversalDocument,
        status: reversalDocument ? 'REVERSED' : 'COMPLETED',
      }).where(and(eq(fxValuationRun.client, input.client), eq(fxValuationRun.runId, runId)));
    }

    return {
      runId, status: reversalDocument ? 'REVERSED' : s.testRun ? 'TEST' : 'COMPLETED',
      companyCode: s.companyCode, valuationArea: s.valuationArea,
      valuationKeyDate: s.valuationKeyDate, postingDate: s.postingDate,
      fiscalYear: s.fiscalYear, valuationMethod: s.valuationMethod, currency: local,
      items: work.map(({ signedForeign: _f, signedCarrying: _c, ...item }) => item),
      totalGain, totalLoss, postingDocument, reversalDocument, warnings,
    };
  });
}

/** A run of a company outside the caller's scope reads as absent; a missing capability or session refuses. */
export async function getFxValuationRun(
  client: string, runId: string, authorization: ServiceAuthorityContext | undefined,
): Promise<FxValuationResult | null> {
  return withTenant(client, async (tx) => {
    const verdict = await verifyCompanyAuthorityInTx(tx, client, authorization, FX_VALUATION_CAPABILITY);
    if (!verdict.ok) throw new FxValuationError(`${verdict.refusal.message} ${verdict.refusal.remedy}`);
    const run = await loadRun(tx, client, runId);
    if (!run) return null;
    const refusal = await refuseCompaniesOutsideScopeInTx(tx, client, verdict, [run.companyCode]);
    return refusal ? null : run;
  });
}

export function fxValuationCsv(result: FxValuationResult): string {
  const esc = (v: string | number | null) => {
    const s = v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = 'Item,Kind,Account,Source Document,Source Line,Currency,Foreign Amount,Carrying Amount,Rate,Required Amount,Adjustment,Classification,Status,Error,Posting Document';
  const lines = result.items.map((i) => [
    i.itemNumber, i.sourceKind, i.accountNumber, i.sourceDocument ?? '', i.sourceLine ?? '',
    i.currency, i.foreignAmount, i.carryingAmount, i.valuationRate ?? '', i.requiredAmount ?? '',
    i.adjustmentAmount ?? '', i.classification ?? '', i.status, i.error ?? '', i.postingDocument ?? '',
  ].map(esc).join(','));
  return [header, ...lines].join('\n') + '\n';
}
