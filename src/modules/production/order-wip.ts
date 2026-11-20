/**
 * Financial work in process (WIP) of unfinished production orders — one explicit, limited method.
 *
 * This is FINANCIAL WIP (a balance-sheet capitalisation of what an unfinished order has cost). It is not the
 * batch-management WIP-batch activation (`wip-batch.ts`), which is unrelated.
 *
 * THE SUPPORTED METHOD — `ACTUAL_COST_NET_BALANCE`
 *   For a RELEASED order, as of the end of a fiscal period of its company, the eligible WIP is
 *
 *       eligible WIP = Σ qualifying cost debits − Σ qualifying production-output credits
 *
 *   over the order's POSTED or REVERSED journal documents (a reversal is a mirrored document, so it nets) whose
 *   posting date is on or before the period end, in the order's company, read from the same journal lines the order
 *   cost report shows. Classification is by ACCOUNT, from the tenant's own account determination:
 *     · cost      — the accounts of posting events PRODUCTION_CONSUMPTION (material issued to the order) and
 *                   PRODUCTION_ACTIVITY (activity cost allocated from a confirmation);
 *     · output    — the accounts of posting event PRODUCTION_OUTPUT (goods received from the order, at the value
 *                   the receipt posted).
 *   The inventory account of a receipt that cites the order is the receipt's balance-sheet leg (it mirrors the output credit)
 *   and is not read as cost or output.
 *   Documents of an earlier WIP posting and of a settlement are never read as costs (a WIP posting carries no
 *   production order; a settlement is recognised by its origin), so nothing is counted twice.
 *
 *     An account that both events resolve to (the two legs meeting on one account) contributes its net.
 *
 *   NOT supported, and refused for that order with the remedy (never guessed, never silently expensed):
 *     a posting on the order whose account is neither a cost nor an output account (a manual or unclassified
 *     posting); a negative cost or output net on separate accounts; output credits exceeding cost (that is a
 *     variance, settled — not WIP); a journal line in another currency than the company's; an order that already
 *     stands settled; a special fiscal period; a period whose company posting period is closed; a missing company,
 *     chart, currency or WIP account. A CREATED order carries no actuals; a TECHNICALLY_COMPLETED order is not
 *     WIP (target 0): it is settled, and its WIP is unwound.
 *
 * POSTING — only the DELTA. The ledger (`production_order_wip_posting`) holds the cumulative balance the order's
 * WIP stands at. A run for period P posts target(P) − cumulative: debit PRODUCTION_WIP / credit
 * PRODUCTION_WIP_CHANGE for an increase, the mirror for a decrease or a full unwind. The same period run again is
 * a no-op when the calculation is unchanged and an explained adjustment when a late cost or a reversal changed it.
 * A later period that already carries a posting refuses a rerun of an earlier one (history is not rewritten).
 * Accounts: while a balance stands, its postings keep the accounts it was posted on (the stored ones, never
 * today's configuration); a configured change is reported and takes effect once the balance is zero.
 * Final settlement of a technically completed order unwinds the standing balance in the same transaction, so the
 * balance can never be both capitalised and settled as a final variance.
 *
 * Out of scope (stated, not implied): detailed variance categories, overhead / costing sheets, WIP by cost
 * element, target-cost or percentage-of-completion WIP, and any full product-costing parity.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { acquireLock } from '../../platform/lock';
import { derivePosition, periodWindows } from '../../platform/periods';
import { fiscalYearPeriod, fiscalYearVariant } from '../foundation/schema';
import { PostingError, postJournalEntry } from '../../platform/posting';
import { MoneyError } from '../../platform/posting/money';
import {
  type ServiceAuthorityContext, refusePlantOutsideScopeInTx, verifyServiceAuthorityInTx,
} from '../../platform/auth/service-authority';

export const WIP_METHOD = 'ACTUAL_COST_NET_BALANCE';
export const WIP_CAPABILITY = 'PROD.ORDER.SETTLE';
export const WIP_BALANCE_EVENT = 'PRODUCTION_WIP';
export const WIP_CHANGE_EVENT = 'PRODUCTION_WIP_CHANGE';
export const WIP_ORIGIN_CLASS = 'production_order_wip';
export const SETTLEMENT_ORIGIN_CLASS = 'production_order_settlement';
export const WIP_DOCUMENT_TYPE = 'SA';
export const ACCOUNT_DETERMINATION_ROUTE = '/config/account-determination';
export const WIP_MAX_ORDERS = 200;

export const WIP_METHOD_STATEMENT =
  'Actual-cost WIP (limited, enabled per production order type): for a released order at the end of the period, eligible WIP = posted material and activity cost debits − production-output credits '
  + '(posting events PRODUCTION_CONSUMPTION, PRODUCTION_ACTIVITY and PRODUCTION_OUTPUT), net of reversals, excluding earlier WIP postings and settlements. '
  + 'Only the delta to the previously posted WIP is posted (debit WIP, credit change in WIP; the mirror when it falls). A technically completed order is settled, not capitalised, and its WIP is unwound. '
  + 'Manual or unclassified postings, negative balances, output above cost, other currencies, special periods and closed periods are refused with a remedy. '
  + 'Not supported: variance categories, overhead, costing sheets, percentage-of-completion or target-cost WIP.';

export class WipError extends Error {
  readonly remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'WipError';
    this.remedy = remedy;
  }
}

export type WipStatus = 'POST' | 'UNWIND' | 'NO_CHANGE' | 'NOT_CONFIGURED' | 'NOT_ELIGIBLE' | 'UNSUPPORTED' | 'REFUSED';

export interface WipComponent {
  account: string;
  /** INVENTORY: the balance-sheet leg of a goods receipt that cites the order; it mirrors the output credit and is not read. */
  role: 'COST' | 'OUTPUT' | 'NET' | 'INVENTORY' | 'EXCLUDED';
  debit: string;
  credit: string;
  net: string;
}

export interface WipCalculation {
  orderNumber: string;
  orderStatus: string;
  plant: string;
  companyCode: string | null;
  currency: string | null;
  fiscalYear: number;
  period: number;
  periodEnd: string | null;
  status: WipStatus;
  /** Why the status is what it is, and what to do. Never empty for a status other than POST / NO_CHANGE. */
  reasons: string[];
  remedy: string | null;
  costTotal: string;
  outputTotal: string;
  eligibleWip: string;
  /** The WIP the order's earlier postings stand at (the ledger's cumulative balance). */
  previousPosted: string;
  /** Target − previous: what an update posts. */
  delta: string;
  wipAccount: string | null;
  changeAccount: string | null;
  accountsAsPosted: boolean;
  components: WipComponent[];
  /** The order's net on every posted line the method read, for reconciliation to the cost report (local currency). */
  reportNet: string;
  journalLinesRead: number;
  /** Set on an update that posted: the document, and the ledger row. */
  document: { documentNumber: string; fiscalYear: number; postingId: string } | null;
}

const S = 4;
const toUnits = (value: unknown): bigint => {
  const text = String(value ?? '0').trim();
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const n = BigInt(whole || '0') * 10n ** BigInt(S) + BigInt((fraction + '0'.repeat(S)).slice(0, S) || '0');
  return negative ? -n : n;
};
const shown = (value: bigint): string => {
  const negative = value < 0n;
  const text = (negative ? -value : value).toString().padStart(S + 1, '0');
  return `${negative ? '-' : ''}${text.slice(0, text.length - S)}.${text.slice(text.length - S)}`;
};

interface OrderContext {
  orderNumber: string;
  status: string;
  plant: string;
  companyCode: string;
  chart: string;
  currency: string;
  variant: string;
  postingVariant: string;
}

async function loadOrder(tx: Tx, client: string, orderNumber: string): Promise<OrderContext | { error: string; remedy: string; status?: string; plant?: string; companyCode?: string | null }> {
  const [order] = await tx.execute(sql`
    select o.order_number, o.status, o.plant, p.company_code
      from production_order o left join plant p on p.client = o.client and p.plant = o.plant
     where o.client = ${client} and o.order_number = ${orderNumber}
  `) as unknown as Array<{ order_number: string; status: string; plant: string; company_code: string | null }>;
  if (!order) return { error: `Production order ${orderNumber} does not stand in this tenant.`, remedy: 'Choose an order of this tenant; no other tenant was searched.' };
  const companyCode = order.company_code?.trim() ?? '';
  if (!companyCode) {
    return { error: `The plant ${order.plant.trim()} of order ${orderNumber} names no company code.`, remedy: 'Assign the plant to a company code.', status: order.status, plant: order.plant.trim(), companyCode: null };
  }
  const [company] = await tx.execute(sql`
    select chart_of_accounts, currency, fiscal_year_variant, posting_period_variant from company_code
     where client = ${client} and company_code = ${companyCode}
  `) as unknown as Array<{ chart_of_accounts: string | null; currency: string; fiscal_year_variant: string | null; posting_period_variant: string | null }>;
  if (!company?.chart_of_accounts || !company.fiscal_year_variant || !company.currency) {
    return { error: `Company ${companyCode} lacks a chart of accounts, currency or fiscal year variant.`, remedy: 'Complete the company code.', status: order.status, plant: order.plant.trim(), companyCode };
  }
  return {
    orderNumber: order.order_number, status: order.status, plant: order.plant.trim(), companyCode,
    chart: company.chart_of_accounts.trim(), currency: company.currency.trim(),
    variant: company.fiscal_year_variant.trim(), postingVariant: (company.posting_period_variant ?? '').trim(),
  };
}

/** The last calendar day of a regular fiscal period of the company's variant; an error text when it is not one. */
async function periodEndOf(tx: Tx, client: string, variantCode: string, fiscalYear: number, period: number): Promise<{ end: string } | { error: string }> {
  const [variant] = await tx.select().from(fiscalYearVariant).where(and(
    eq(fiscalYearVariant.client, client), eq(fiscalYearVariant.variant, variantCode),
  ));
  if (!variant) return { error: `Fiscal year variant ${variantCode} does not exist.` };
  if (period > variant.regularPeriods) return { error: `Period ${period} is a special period of variant ${variantCode}; WIP is not calculated in a special period.` };
  const load = async (calendarYear: number) => tx.select().from(fiscalYearPeriod).where(and(
    eq(fiscalYearPeriod.client, client), eq(fiscalYearPeriod.variant, variantCode), eq(fiscalYearPeriod.calendarYear, calendarYear),
  ));
  let rows = await load(variant.isYearDependent ? fiscalYear : 0);
  if (variant.isYearDependent && rows.length === 0) rows = await load(0);
  const regular = rows.filter((row) => row.periodType === 'REGULAR').sort((left, right) => left.period - right.period);
  const window = periodWindows(regular, fiscalYear).find((item) => item.period === period);
  if (!window) return { error: `Period ${period} is outside fiscal year variant ${variantCode}.` };
  return { end: new Date(window.end).toISOString().slice(0, 10) };
}

interface Accounts { cost: Set<string>; output: Set<string>; inventory: Set<string>; wip: string | null; change: string | null }

async function accountsOf(tx: Tx, client: string, chart: string): Promise<Accounts> {
  const rows = await tx.execute(sql`
    select event, valuation_class, general_modifier, gl_account from account_determination
     where client = ${client} and chart_of_accounts = ${chart}
       and event in ('PRODUCTION_CONSUMPTION', 'PRODUCTION_ACTIVITY', 'PRODUCTION_OUTPUT', 'INVENTORY', ${WIP_BALANCE_EVENT}, ${WIP_CHANGE_EVENT})
  `) as unknown as Array<{ event: string; valuation_class: string; general_modifier: string; gl_account: string }>;
  const accounts: Accounts = { cost: new Set(), output: new Set(), inventory: new Set(), wip: null, change: null };
  for (const row of rows) {
    const account = row.gl_account.trim();
    if (row.event === 'PRODUCTION_CONSUMPTION' || row.event === 'PRODUCTION_ACTIVITY') accounts.cost.add(account);
    else if (row.event === 'PRODUCTION_OUTPUT') accounts.output.add(account);
    else if (row.event === 'INVENTORY') accounts.inventory.add(account);
    else if (row.valuation_class === '' && row.general_modifier === '') {
      if (row.event === WIP_BALANCE_EVENT) accounts.wip = account;
      if (row.event === WIP_CHANGE_EVENT) accounts.change = account;
    }
  }
  return accounts;
}

export interface ProductionOrderWipPostingRow {
  postingId: string;
  seq: number;
  companyCode: string;
  fiscalYear: number;
  period: number;
  postingDate: string;
  kind: string;
  currency: string;
  costTotal: string;
  outputTotal: string;
  eligibleWip: string;
  previousCumulative: string;
  delta: string;
  cumulativeAfter: string;
  wipAccount: string;
  changeAccount: string;
  journalDocument: string;
  journalYear: number;
  previousPostingId: string | null;
  createdBy: string;
  explanation: string;
}

export async function wipPostingsOfOrder(tx: Tx, client: string, orderNumber: string, fiscalYear?: number | null): Promise<ProductionOrderWipPostingRow[]> {
  const rows = await tx.execute(sql`
    select posting_id, seq, company_code, fiscal_year, period, posting_date::text as posting_date, kind, trim(currency) as currency,
           cost_total::text as cost_total, output_total::text as output_total, eligible_wip::text as eligible_wip,
           previous_cumulative::text as previous_cumulative, delta::text as delta, cumulative_after::text as cumulative_after,
           wip_account, change_account, journal_document, journal_year, previous_posting_id, created_by,
           coalesce(evidence->>'explanation', '') as explanation
      from production_order_wip_posting
     where client = ${client} and order_number = ${orderNumber} and (${fiscalYear ?? null}::int is null or fiscal_year = ${fiscalYear ?? null})
     order by seq
  `) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    postingId: String(row.posting_id), seq: Number(row.seq), companyCode: String(row.company_code).trim(), fiscalYear: Number(row.fiscal_year), period: Number(row.period),
    postingDate: String(row.posting_date), kind: String(row.kind), currency: String(row.currency), costTotal: String(row.cost_total),
    outputTotal: String(row.output_total), eligibleWip: String(row.eligible_wip), previousCumulative: String(row.previous_cumulative),
    delta: String(row.delta), cumulativeAfter: String(row.cumulative_after), wipAccount: String(row.wip_account).trim(),
    changeAccount: String(row.change_account).trim(), journalDocument: String(row.journal_document), journalYear: Number(row.journal_year),
    previousPostingId: row.previous_posting_id === null ? null : String(row.previous_posting_id), createdBy: String(row.created_by),
    explanation: String(row.explanation),
  }));
}

/** The balance the order's WIP stands at, from the ledger. */
export async function postedWip(tx: Tx, client: string, orderNumber: string): Promise<{ cumulative: bigint; last: ProductionOrderWipPostingRow | null; count: number }> {
  return ledgerOf(await wipPostingsOfOrder(tx, client, orderNumber));
}

function ledgerOf(rows: ProductionOrderWipPostingRow[]): { cumulative: bigint; last: ProductionOrderWipPostingRow | null; count: number } {
  const last = rows[rows.length - 1] ?? null;
  return { cumulative: last ? toUnits(last.cumulativeAfter) : 0n, last, count: rows.length };
}

function blank(orderNumber: string, fiscalYear: number, period: number, base: Partial<WipCalculation>): WipCalculation {
  return {
    orderNumber, orderStatus: '', plant: '', companyCode: null, currency: null, fiscalYear, period, periodEnd: null,
    status: 'NOT_ELIGIBLE', reasons: [], remedy: null, costTotal: shown(0n), outputTotal: shown(0n), eligibleWip: shown(0n),
    previousPosted: shown(0n), delta: shown(0n), wipAccount: null, changeAccount: null, accountsAsPosted: false,
    components: [], reportNet: shown(0n), journalLinesRead: 0, document: null, ...base,
  };
}

/**
 * Calculate (read-only) the WIP of one order as of a period end and what an update would post. Reads under the
 * caller's transaction; the caller decides whether to lock first.
 */
export async function calculateWip(tx: Tx, client: string, orderNumber: string, fiscalYear: number, period: number): Promise<WipCalculation> {
  const ctx = await loadOrder(tx, client, orderNumber);
  if ('error' in ctx) {
    return blank(orderNumber, fiscalYear, period, {
      orderStatus: ctx.status ?? '', plant: ctx.plant ?? '', companyCode: ctx.companyCode ?? null,
      status: ctx.status === undefined ? 'NOT_ELIGIBLE' : 'UNSUPPORTED', reasons: [ctx.error], remedy: ctx.remedy,
    });
  }
  const base = { orderStatus: ctx.status, plant: ctx.plant, companyCode: ctx.companyCode, currency: ctx.currency };
  const end = await periodEndOf(tx, client, ctx.variant, fiscalYear, period);
  if ('error' in end) return blank(orderNumber, fiscalYear, period, { ...base, status: 'UNSUPPORTED', reasons: [end.error], remedy: 'Choose a regular period of the company\'s fiscal year.' });
  const position = await derivePosition(tx, client, ctx.variant, end.end);
  if (position.fiscalYear !== fiscalYear || position.period !== period) {
    return blank(orderNumber, fiscalYear, period, { ...base, periodEnd: end.end, status: 'UNSUPPORTED', reasons: [`Period ${period}/${fiscalYear} ends ${end.end}, which company ${ctx.companyCode} places in ${position.period}/${position.fiscalYear}.`], remedy: 'Choose the period as the company\'s fiscal year defines it.' });
  }
  const withEnd = { ...base, periodEnd: end.end };

  const [typeRow] = await tx.execute(sql`
    select o.order_type, coalesce(t.wip_method, '') as wip_method
      from production_order o
      left join production_order_type t on t.client = o.client and t.order_type = o.order_type
     where o.client = ${client} and o.order_number = ${orderNumber}
  `) as unknown as Array<{ order_type: string | null; wip_method: string }>;
  if (typeRow?.wip_method !== WIP_METHOD) {
    return blank(orderNumber, fiscalYear, period, {
      ...withEnd, status: 'NOT_ELIGIBLE',
      reasons: [`Financial WIP is not enabled for order type ${typeRow?.order_type?.trim() || '(none)'} of order ${orderNumber}.`],
      remedy: 'Set the WIP method of the order type to ACTUAL_COST_NET_BALANCE on the production order type screen (/config/production-order-types). A balance already capitalised is unwound by the final settlement.',
    });
  }

  if (ctx.status === 'CREATED') {
    return blank(orderNumber, fiscalYear, period, { ...withEnd, status: 'NOT_ELIGIBLE', reasons: [`Order ${orderNumber} is only created; it carries no actuals, so there is no WIP.`], remedy: 'Release the order.' });
  }

  const history = await wipPostingsOfOrder(tx, client, orderNumber);
  const ledger = ledgerOf(history);
  const later = history.find((row) => row.fiscalYear * 100 + row.period > fiscalYear * 100 + period);
  const accounts = await accountsOf(tx, client, ctx.chart);

  // Accounts: while a balance stands, its own accounts; otherwise the configuration (never invented).
  let wipAccount = accounts.wip;
  let changeAccount = accounts.change;
  let accountsAsPosted = false;
  const reasons: string[] = [];
  if (ledger.last && ledger.cumulative !== 0n) {
    accountsAsPosted = true;
    if ((accounts.wip && accounts.wip !== ledger.last.wipAccount) || (accounts.change && accounts.change !== ledger.last.changeAccount)) {
      reasons.push(`The WIP accounts configured now differ from the accounts the standing balance was posted on; ${ledger.last.wipAccount} / ${ledger.last.changeAccount} (as posted) are used until the balance is zero.`);
    }
    wipAccount = ledger.last.wipAccount;
    changeAccount = ledger.last.changeAccount;
  }
  const accountBase = { ...withEnd, wipAccount, changeAccount, accountsAsPosted, previousPosted: shown(ledger.cumulative) };
  if (!wipAccount || !changeAccount) {
    return blank(orderNumber, fiscalYear, period, {
      ...accountBase, status: 'NOT_CONFIGURED',
      reasons: [`No account is determined for ${!wipAccount ? WIP_BALANCE_EVENT : WIP_CHANGE_EVENT} in chart ${ctx.chart}. WIP is not configured for this company and no account was invented.`],
      remedy: `Name the WIP balance-sheet account (${WIP_BALANCE_EVENT}) and the change-in-WIP profit-and-loss account (${WIP_CHANGE_EVENT}) at ${ACCOUNT_DETERMINATION_ROUTE}.`,
    });
  }
  if (later) {
    return blank(orderNumber, fiscalYear, period, {
      ...accountBase, status: 'REFUSED',
      reasons: [`WIP of order ${orderNumber} is already posted for period ${later.period}/${later.fiscalYear}, later than ${period}/${fiscalYear}. History is not rewritten.`],
      remedy: `Run the latest period (${later.period}/${later.fiscalYear}); it adjusts the balance by the delta.`,
    });
  }

  // The journal lines the method reads: this order, this company, on or before the period end.
  const lines = await tx.execute(sql`
    select l.gl_account as account, l.debit_credit as side, l.amount_local::text as amount, trim(j.local_currency) as currency,
           j.origin_class, j.status
      from journal_entry_line l
      join journal_entry j on j.client = l.client and j.document_number = l.document_number and j.fiscal_year = l.fiscal_year
     where l.client = ${client} and l.production_order = ${orderNumber} and j.company_code = ${ctx.companyCode}
       and j.status in ('POSTED', 'REVERSED') and j.posting_date <= ${end.end}::date
  `) as unknown as Array<{ account: string; side: string; amount: string; currency: string; origin_class: string | null; status: string }>;

  const settled = lines.some((line) => line.origin_class === SETTLEMENT_ORIGIN_CLASS);
  const foreign = lines.find((line) => line.currency !== ctx.currency);
  const byAccount = new Map<string, { debit: bigint; credit: bigint }>();
  let reportNet = 0n;
  for (const line of lines) {
    if (line.origin_class === SETTLEMENT_ORIGIN_CLASS || line.origin_class === WIP_ORIGIN_CLASS) continue;
    const entry = byAccount.get(line.account.trim()) ?? { debit: 0n, credit: 0n };
    const amount = toUnits(line.amount);
    if (line.side === 'S') entry.debit += amount; else entry.credit += amount;
    byAccount.set(line.account.trim(), entry);
  }
  for (const line of lines) reportNet += (line.side === 'S' ? 1n : -1n) * toUnits(line.amount);

  const components: WipComponent[] = [];
  let costTotal = 0n;
  let outputTotal = 0n;
  const unsupported: string[] = [];
  for (const [account, sums] of [...byAccount.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const net = sums.debit - sums.credit;
    const isCost = accounts.cost.has(account);
    const isOutput = accounts.output.has(account);
    const isInventory = accounts.inventory.has(account) && !isCost && !isOutput;
    const role: WipComponent['role'] = isCost && isOutput ? 'NET' : isCost ? 'COST' : isOutput ? 'OUTPUT' : isInventory ? 'INVENTORY' : 'EXCLUDED';
    components.push({ account, role, debit: shown(sums.debit), credit: shown(sums.credit), net: shown(net) });
    if (isCost && isOutput) {
      // The two legs of production meet on one account (a tenant's own convention): the debits are the cost, the credits
      // the output, and what is eligible is exactly the account's net. A reversal cannot be told from the other leg here,
      // so the split is shown as posted and only the net is relied on.
      costTotal += sums.debit;
      outputTotal += sums.credit;
      reasons.push(`Account ${account} serves both production consumption and production output; its debits are read as cost and its credits as output, and the eligible WIP is their net.`);
    } else if (isCost) costTotal += net;
    else if (isOutput) outputTotal -= net;
    else if (isInventory) continue;
    else if (net !== 0n) unsupported.push(`Account ${account} carries a net of ${shown(net)} on the order and is neither a material/activity cost account nor the production-output account (a manual or unclassified posting).`);
  }
  const common = {
    ...accountBase, components, reportNet: shown(reportNet), journalLinesRead: lines.length,
    costTotal: shown(costTotal), outputTotal: shown(outputTotal),
  };
  const refuse = (status: WipStatus, why: string[], remedy: string): WipCalculation => blank(orderNumber, fiscalYear, period, {
    ...common, status, reasons: [...reasons, ...why], remedy,
  });
  if (settled) return refuse('UNSUPPORTED', [`Order ${orderNumber} already carries a settlement posting; WIP is not calculated after settlement.`], 'Reverse the settlement if the order is to be reopened.');
  if (foreign) return refuse('UNSUPPORTED', [`A journal line citing the order is in ${foreign.currency}, the company currency is ${ctx.currency}. No exchange rate is assumed.`], 'Correct or settle the foreign-currency postings; WIP is calculated in the company currency only.');
  if (unsupported.length > 0) return refuse('UNSUPPORTED', unsupported, 'Reclassify or reverse the posting, or settle the order; no WIP was guessed.');
  if (costTotal < 0n) return refuse('UNSUPPORTED', [`The cost accounts net to a credit of ${shown(-costTotal)}: more cost was reversed than posted.`], 'Check the reversals on the order.');
  if (outputTotal < 0n) return refuse('UNSUPPORTED', [`The output account nets to a debit of ${shown(-outputTotal)}: more output was reversed than received.`], 'Check the goods receipts and their reversals.');

  const technicallyComplete = ctx.status === 'TECHNICALLY_COMPLETED';
  const eligibleBeforeTarget = costTotal - outputTotal;
  if (!technicallyComplete && eligibleBeforeTarget < 0n) {
    return refuse('UNSUPPORTED', [`Output credits (${shown(outputTotal)}) exceed cost (${shown(costTotal)}) by ${shown(-eligibleBeforeTarget)}. That is a variance for settlement, not work in process, and it was not capitalised.`], 'Settle the order (technically complete it first) instead of running WIP.');
  }
  const target = technicallyComplete ? 0n : eligibleBeforeTarget;
  if (technicallyComplete) reasons.push('The order is technically completed: it is settled, not capitalised, so its target WIP is zero.');
  const delta = target - ledger.cumulative;
  const status: WipStatus = delta === 0n ? 'NO_CHANGE' : target === 0n ? 'UNWIND' : 'POST';
  return {
    ...blank(orderNumber, fiscalYear, period, common),
    status, reasons: [...reasons, delta === 0n ? 'The posted WIP already equals the calculation. Nothing would be posted.' : `Posts ${shown(delta)} to bring the posted WIP from ${shown(ledger.cumulative)} to ${shown(target)}.`],
    eligibleWip: shown(target), delta: shown(delta), remedy: null,
  };
}

function explanationOf(calc: WipCalculation, firstPosting: boolean): string {
  const delta = toUnits(calc.delta);
  if (calc.status === 'UNWIND') return `Full unwind: the order no longer carries WIP (${calc.orderStatus === 'TECHNICALLY_COMPLETED' ? 'technically completed' : 'eligible WIP is zero'}).`;
  if (firstPosting) return 'First capitalisation of the order\'s eligible actual-cost balance.';
  return delta > 0n ? 'Increase: the eligible balance rose since the last posting (later cost or lower output).' : 'Decrease: the eligible balance fell since the last posting (more output, or a cost reversal).';
}

/**
 * Post the delta of a calculation, in the caller's transaction (after it holds the order lock and has recalculated).
 * Returns the document. Used by the period run and by the settlement's unwind.
 */
export async function postWipDelta(
  tx: Tx, client: string, calc: WipCalculation, by: string,
  options: { requestKey?: string | null; postingDate: string; fiscalYear: number; period: number },
): Promise<{ documentNumber: string; fiscalYear: number; postingId: string }> {
  const delta = toUnits(calc.delta);
  if (delta === 0n || !calc.wipAccount || !calc.changeAccount || !calc.currency || !calc.companyCode) {
    throw new WipError('There is nothing to post.');
  }
  const history = await wipPostingsOfOrder(tx, client, calc.orderNumber);
  const previous = history[history.length - 1] ?? null;
  const amount = shown(delta < 0n ? -delta : delta);
  const increase = delta > 0n;
  const seq = (previous?.seq ?? 0) + 1;
  const posted = await postJournalEntry(tx, {
    client, companyCode: calc.companyCode, documentType: WIP_DOCUMENT_TYPE,
    documentDate: options.postingDate, postingDate: options.postingDate, fiscalYear: options.fiscalYear, postingPeriod: options.period,
    currency: calc.currency, localCurrency: calc.currency, precision: 'CURRENCY',
    reference: previous ? previous.journalDocument : calc.orderNumber,
    headerText: `WIP ${calc.orderNumber} ${options.period}/${options.fiscalYear}`.slice(0, 25),
    lines: [
      { glAccount: calc.wipAccount, debitCredit: increase ? 'S' : 'H', amount, plant: calc.plant, lineText: `WIP order ${calc.orderNumber}` },
      { glAccount: calc.changeAccount, debitCredit: increase ? 'H' : 'S', amount, plant: calc.plant, lineText: `Change in WIP order ${calc.orderNumber}` },
    ],
    origin: { documentClass: WIP_ORIGIN_CLASS, documentKey: `${calc.orderNumber}/${seq}` },
    postedBy: by, transactionCode: 'KO88',
  });
  const postingId = randomUUID();
  const cumulativeAfter = toUnits(calc.previousPosted) + delta;
  await tx.execute(sql`
    insert into production_order_wip_posting (
      client, posting_id, order_number, seq, company_code, fiscal_year, period, posting_date, kind, currency, cost_total, output_total,
      eligible_wip, previous_cumulative, delta, cumulative_after, wip_account, change_account, journal_document, journal_year,
      previous_posting_id, evidence, request_key, created_by
    ) values (
      ${client}, ${postingId}, ${calc.orderNumber}, ${seq}, ${calc.companyCode}, ${options.fiscalYear}, ${options.period}, ${options.postingDate}::date,
      ${calc.status === 'UNWIND' ? 'UNWIND' : 'PERIOD'}, ${calc.currency}, ${calc.costTotal}::numeric, ${calc.outputTotal}::numeric,
      ${calc.eligibleWip}::numeric, ${calc.previousPosted}::numeric, ${shown(delta)}::numeric, ${shown(cumulativeAfter)}::numeric,
      ${calc.wipAccount}, ${calc.changeAccount}, ${posted.documentNumber}, ${posted.fiscalYear}, ${previous?.postingId ?? null},
      ${JSON.stringify({
        method: WIP_METHOD, explanation: explanationOf(calc, previous === null), components: calc.components, reportNet: calc.reportNet,
        journalLinesRead: calc.journalLinesRead, orderStatus: calc.orderStatus, accountsAsPosted: calc.accountsAsPosted,
      })}::jsonb,
      ${options.requestKey ?? null}, ${by}
    )
  `);
  await recordChange(tx, {
    client, objectClass: 'production_order_wip_posting', objectKey: `${calc.orderNumber}/${seq}`, changeType: 'CREATE', changedBy: by,
    transactionCode: 'KO88', reason: explanationOf(calc, previous === null),
    after: { order: calc.orderNumber, period: `${options.period}/${options.fiscalYear}`, delta: shown(delta), cumulativeAfter: shown(cumulativeAfter), document: posted.documentNumber },
  });
  return { documentNumber: posted.documentNumber, fiscalYear: posted.fiscalYear, postingId };
}

export interface WipRunInput {
  client: string;
  by: string;
  authorization?: ServiceAuthorityContext;
  orderNumber?: string;
  orderFrom?: string;
  orderTo?: string;
  fiscalYear: number;
  period: number;
  /** True: calculate and report, write nothing. */
  testRun: boolean;
  requestKey?: string;
}

export interface WipRunResult {
  testRun: boolean;
  method: string;
  methodStatement: string;
  fiscalYear: number;
  period: number;
  orders: WipCalculation[];
  posted: number;
  message: string;
}

function periodArgs(input: WipRunInput) {
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 1000 || input.fiscalYear > 9999) throw new WipError('The fiscal year is not a year.', 'Enter a four-digit fiscal year.');
  if (!Number.isInteger(input.period) || input.period < 1 || input.period > 16) throw new WipError('The period must be between 1 and 16.', 'Enter a posting period of the company\'s fiscal year.');
}

async function selectOrders(client: string, input: WipRunInput): Promise<string[]> {
  const one = (input.orderNumber ?? '').trim().toUpperCase();
  const from = (input.orderFrom ?? '').trim().toUpperCase();
  const to = (input.orderTo ?? '').trim().toUpperCase();
  if (!one && !from && !to) throw new WipError('Name an order or an order range.', 'WIP is calculated for named orders; no selection is assumed.');
  if (from && to && from > to) throw new WipError('The order range is empty.', 'The bounds were not swapped.');
  // A named order is always answered: an order that does not stand in this tenant is reported, not silently skipped.
  if (one) return [one];
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select order_number from production_order
       where client = ${client}
         and (${one || null}::text is null or order_number = ${one})
         and (${from || null}::text is null or order_number >= ${from})
         and (${to || null}::text is null or order_number <= ${to})
       order by order_number limit ${WIP_MAX_ORDERS + 1}
    `) as unknown as Array<{ order_number: string }>;
    if (rows.length > WIP_MAX_ORDERS) throw new WipError(`The range selects more than ${WIP_MAX_ORDERS} orders.`, 'Narrow the range; a large close belongs in a background run.');
    return rows.map((row) => row.order_number);
  });
}

/**
 * The WIP test run and update. A test run calculates in one read-only transaction and writes nothing. An update is
 * one transaction per order: it takes the order-wide lock (the one confirmation and its cancellation take), checks the
 * actor's authority and plant reach, RECALCULATES under the lock and posts only the delta — so a repeated or concurrent
 * run finds the delta already posted and posts nothing. A refusal of one order (closed period, missing account) is
 * reported for that order and never blocks another.
 */
export async function runWip(input: WipRunInput): Promise<WipRunResult> {
  periodArgs(input);
  const client = input.client;
  const orders = await selectOrders(client, input);
  const results: WipCalculation[] = [];
  let posted = 0;
  for (const orderNumber of orders) {
    if (input.testRun) {
      results.push(await withTenant(client, (tx) => calculateWip(tx, client, orderNumber, input.fiscalYear, input.period)));
      continue;
    }
    try {
      const result = await withTenant(client, async (tx) => {
        const [found] = await tx.execute(sql`select plant from production_order where client = ${client} and order_number = ${orderNumber}`) as unknown as Array<{ plant: string }>;
        const verdict = await verifyServiceAuthorityInTx(tx, client, input.authorization, WIP_CAPABILITY);
        if (!verdict.ok) throw new WipError(verdict.refusal.message, verdict.refusal.remedy);
        const out = found ? await refusePlantOutsideScopeInTx(tx, client, found.plant.trim(), verdict.restrictions) : null;
        if (out) throw new WipError(out.message, out.remedy);
        await acquireLock(tx, { objectCode: 'PRODUCTION_ORDER', keys: [client, orderNumber] }, { client, requestedBy: input.by, transactionCode: 'KO88' });
        const key = input.requestKey ? `${input.requestKey}/${orderNumber}`.slice(0, 64) : null;
        if (key) {
          const [replay] = await tx.execute(sql`
            select journal_document, journal_year, posting_id from production_order_wip_posting where client = ${client} and request_key = ${key}
          `) as unknown as Array<{ journal_document: string; journal_year: number; posting_id: string }>;
          if (replay) {
            const again = await calculateWip(tx, client, orderNumber, input.fiscalYear, input.period);
            return { ...again, status: 'NO_CHANGE' as WipStatus, reasons: [`This request was already posted as ${replay.journal_document}. No second document was created.`], document: { documentNumber: replay.journal_document, fiscalYear: Number(replay.journal_year), postingId: replay.posting_id } };
          }
        }
        const calc = await calculateWip(tx, client, orderNumber, input.fiscalYear, input.period);
        if (calc.status !== 'POST' && calc.status !== 'UNWIND') return calc;
        const document = await tx.transaction(async (savepoint) => postWipDelta(savepoint as unknown as Tx, client, calc, input.by, {
          requestKey: key, postingDate: calc.periodEnd!, fiscalYear: input.fiscalYear, period: input.period,
        }));
        return { ...calc, document, reasons: [...calc.reasons, `Posted ${document.documentNumber}.`] };
      });
      if (result.document && result.status !== 'NO_CHANGE') posted += 1;
      results.push(result);
    } catch (error) {
      if (!(error instanceof WipError) && !(error instanceof PostingError) && !(error instanceof MoneyError)) throw error;
      const preview = await withTenant(client, (tx) => calculateWip(tx, client, orderNumber, input.fiscalYear, input.period));
      results.push({
        ...preview, status: 'REFUSED', document: null,
        reasons: [error.message], remedy: (error as { remedy?: string }).remedy ?? 'Resolve the cause; nothing was posted for this order.',
      });
    }
  }
  const message = input.testRun
    ? 'Test run. Nothing was posted.'
    : posted > 0 ? `Update run. ${posted} WIP document(s) posted.` : 'Update run. Nothing was posted.';
  return { testRun: input.testRun, method: WIP_METHOD, methodStatement: WIP_METHOD_STATEMENT, fiscalYear: input.fiscalYear, period: input.period, orders: results, posted, message };
}

/**
 * Final settlement of a technically completed order: unwind its standing WIP in the settlement's transaction, at the
 * settlement's posting date and period, on the accounts the balance was posted on. Returns the unwind (or null when
 * there is no balance). Throws WipError when the unwind cannot be posted safely — the settlement is then refused.
 */
export async function unwindWipForSettlementInTx(
  tx: Tx, client: string, orderNumber: string, by: string,
  settlement: { fiscalYear: number; period: number; postingDate: string },
): Promise<{ documentNumber: string; amount: string } | null> {
  const ledger = await postedWip(tx, client, orderNumber);
  if (!ledger.last || ledger.cumulative === 0n) return null;
  const later = (await wipPostingsOfOrder(tx, client, orderNumber)).find((row) => row.fiscalYear * 100 + row.period > settlement.fiscalYear * 100 + settlement.period);
  if (later) throw new WipError(`WIP of order ${orderNumber} is posted for period ${later.period}/${later.fiscalYear}, later than the settlement period.`, 'Settle in the latest period with WIP; the order cannot be settled earlier.');
  const [order] = await tx.execute(sql`
    select o.status, o.plant from production_order o where o.client = ${client} and o.order_number = ${orderNumber}
  `) as unknown as Array<{ status: string; plant: string }>;
  const last = ledger.last;
  const calc: WipCalculation = blank(orderNumber, settlement.fiscalYear, settlement.period, {
    orderStatus: order?.status ?? '', plant: order?.plant?.trim() ?? '', companyCode: last.companyCode,
    currency: last.currency, status: 'UNWIND', wipAccount: last.wipAccount, changeAccount: last.changeAccount, accountsAsPosted: true,
    costTotal: last.costTotal, outputTotal: last.outputTotal, eligibleWip: shown(0n), previousPosted: shown(ledger.cumulative),
    delta: shown(-ledger.cumulative), periodEnd: settlement.postingDate, reasons: ['Unwound by the final settlement of the order.'],
  });
  const document = await postWipDelta(tx, client, calc, by, { postingDate: settlement.postingDate, fiscalYear: settlement.fiscalYear, period: settlement.period });
  return { documentNumber: document.documentNumber, amount: shown(ledger.cumulative) };
}
