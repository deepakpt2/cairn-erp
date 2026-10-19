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
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, reverseJournalEntry, PostingError } from '../../platform/posting';
import { accountDetermination, exchangeRate } from '../foundation/schema';
import { fxValuationItem, fxValuationRun, journalEntry, journalEntryLine } from './schema';

const round2 = (n: number) => Math.round(n * 100) / 100;

interface CandidateRow {
  document_number: string;
  line_number: number;
  gl_account: string;
  debit_credit: string;
  amount_document: string;
  amount_local: string;
  currency: string;
  is_open_item: boolean;
  is_balance_sheet: boolean;
  clearing_document: string | null;
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
    const [existing] = await tx.select().from(fxValuationRun).where(and(
      eq(fxValuationRun.client, input.client), eq(fxValuationRun.requestKey, s.requestKey),
    ));
    if (existing) {
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
    const local = company.currency;
    const chart = company.chartOfAccounts ?? '';

    const raw = await tx.execute(sql`
      select l.document_number, l.line_number, l.gl_account, l.debit_credit,
             l.amount_document, l.amount_local, l.currency,
             g.is_open_item_managed as is_open_item, g.is_balance_sheet,
             l.clearing_document
      from journal_entry_line l
      join journal_entry h
        on h.client = l.client and h.document_number = l.document_number and h.fiscal_year = l.fiscal_year
      join gl_account g
        on g.client = l.client and g.chart_of_accounts = ${chart} and g.account_number = l.gl_account
      where l.client = ${input.client}
        and h.company_code = ${s.companyCode}
        and h.posting_date <= ${s.valuationKeyDate}
        and h.status = 'POSTED' and h.reversal_of is null
        and l.currency <> ${local}
      order by l.gl_account, l.currency, l.document_number, l.line_number
    `);
    const candidates = raw as unknown as CandidateRow[];

    interface WorkItem extends FxValuationItem { signedForeign: number; signedCarrying: number }
    const work: WorkItem[] = [];
    const balanceGroups = new Map<string, WorkItem>();
    for (const row of candidates) {
      const sign = row.debit_credit === 'S' ? 1 : -1;
      if (row.is_open_item) {
        if (!s.includeOpenItems || row.clearing_document) continue;
        work.push({
          itemNumber: 0, sourceKind: 'OPEN_ITEM', accountNumber: row.gl_account,
          sourceDocument: row.document_number, sourceLine: row.line_number,
          currency: row.currency, foreignAmount: 0, carryingAmount: 0,
          valuationRate: null, rateType: s.valuationMethod, requiredAmount: null,
          adjustmentAmount: null, classification: null, status: 'CALCULATED',
          error: null, postingDocument: null,
          signedForeign: sign * Number(row.amount_document), signedCarrying: sign * Number(row.amount_local),
        });
      } else if (row.is_balance_sheet) {
        if (!s.includeBalances) continue;
        const key = `${row.gl_account}|${row.currency}`;
        const group = balanceGroups.get(key) ?? {
          itemNumber: 0, sourceKind: 'BALANCE' as const, accountNumber: row.gl_account,
          sourceDocument: null, sourceLine: null, currency: row.currency,
          foreignAmount: 0, carryingAmount: 0, valuationRate: null,
          rateType: s.valuationMethod, requiredAmount: null, adjustmentAmount: null,
          classification: null, status: 'CALCULATED' as FxItemStatus, error: null,
          postingDocument: null, signedForeign: 0, signedCarrying: 0,
        };
        group.signedForeign += sign * Number(row.amount_document);
        group.signedCarrying += sign * Number(row.amount_local);
        balanceGroups.set(key, group);
      }
    }
    work.push(...balanceGroups.values());

    // Rates: latest validity on or before the key date, per currency.
    const rateByCurrency = new Map<string, number>();
    const missingRates = new Set<string>();
    for (const item of work) {
      if (rateByCurrency.has(item.currency) || missingRates.has(item.currency)) continue;
      const [rate] = await tx.select().from(exchangeRate).where(and(
        eq(exchangeRate.client, input.client), eq(exchangeRate.rateType, s.valuationMethod),
        eq(exchangeRate.fromCurrency, item.currency), eq(exchangeRate.toCurrency, local),
      )).orderBy(sql`${exchangeRate.validFrom} desc`);
      const valid = rate && rate.validFrom <= s.valuationKeyDate ? rate : null;
      if (!valid) missingRates.add(item.currency);
      else rateByCurrency.set(item.currency, Number(valid.rate) * valid.ratioTo / valid.ratioFrom);
    }

    // Duplicate live valuation guard, per source item.
    const priorLive = await tx.execute(sql`
      select i.source_document, i.source_line, i.account_number, i.currency, i.source_kind
      from fx_valuation_item i
      join fx_valuation_run r on r.client = i.client and r.run_id = i.run_id
      where i.client = ${input.client} and r.company_code = ${s.companyCode}
        and r.valuation_area = ${s.valuationArea} and r.valuation_key_date = ${s.valuationKeyDate}
        and r.is_test_run = false and i.status = 'POSTED'
    `);
    const priorKeys = new Set((priorLive as unknown as Array<Record<string, unknown>>).map((r) =>
      r.source_kind === 'BALANCE' ? `B|${r.account_number}|${r.currency}` : `O|${r.source_document}|${r.source_line}`));

    const warnings: string[] = [];
    let totalGain = 0;
    let totalLoss = 0;
    work.forEach((item, index) => {
      item.itemNumber = index + 1;
      item.foreignAmount = round2(Math.abs(item.signedForeign));
      item.carryingAmount = round2(Math.abs(item.signedCarrying));
      const rate = rateByCurrency.get(item.currency);
      if (rate === undefined) {
        item.status = 'ERROR';
        item.error = `No ${s.valuationMethod} rate for ${item.currency}/${local} stands valid on or before ${s.valuationKeyDate}.`;
        return;
      }
      item.valuationRate = rate;
      const requiredSigned = round2(item.signedForeign * rate);
      item.requiredAmount = round2(Math.abs(requiredSigned));
      const adjustmentSigned = round2(requiredSigned - item.signedCarrying);
      item.adjustmentAmount = adjustmentSigned;
      item.classification = adjustmentSigned > 0 ? 'GAIN' : adjustmentSigned < 0 ? 'LOSS' : 'NONE';
      if (adjustmentSigned > 0) totalGain = round2(totalGain + adjustmentSigned);
      if (adjustmentSigned < 0) totalLoss = round2(totalLoss - adjustmentSigned);
      const key = item.sourceKind === 'BALANCE'
        ? `B|${item.accountNumber}|${item.currency}` : `O|${item.sourceDocument}|${item.sourceLine}`;
      if (!s.testRun && priorKeys.has(key)) {
        item.status = 'SKIPPED';
        item.error = 'Already valued live for this area and key date; reverse the earlier posting to rerun.';
      }
      // Signed amounts ride on the item for posting; display keeps magnitudes.
      (item as unknown as { signedAdjustment: number }).signedAdjustment = adjustmentSigned;
      (item as unknown as { signedRequired: number }).signedRequired = requiredSigned;
    });
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
      createdBy: input.changedBy, completedAt: s.testRun ? null : new Date(),
    });

    let postingDocument: string | null = null;
    let reversalDocument: string | null = null;
    if (!s.testRun) {
      const postable = work.filter((i) => i.status === 'CALCULATED' && (i.adjustmentAmount ?? 0) !== 0);
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
          const adj = (item as unknown as { signedAdjustment: number }).signedAdjustment;
          const amount = Math.abs(adj).toFixed(2);
          if (adj > 0) {
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
          lines, postedBy: input.changedBy, transactionCode: FX_VALUATION_CAPABILITY,
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
            reversedBy: input.changedBy, transactionCode: FX_VALUATION_CAPABILITY,
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

export async function getFxValuationRun(client: string, runId: string): Promise<FxValuationResult | null> {
  return withTenant(client, async (tx) => loadRun(tx, client, runId));
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
