/**
 * KO88 individual actual settlement and KO8G collective actual settlement.
 *
 * Both call settleOne. KO88 names one internal order and rejects a collective
 * selection. KO8G selects internal orders and calls the same function. An update
 * posts only through postJournalEntry, and only when a stored profile, allocation
 * assignment, and distribution rule say where the balance goes. A receiver, a
 * percentage, and an account are not assumed. Production and process orders are
 * not selected. Maintenance orders are not stored. CO88, CJ88, KO8B, and KO9E
 * are not this service.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { type Tx, withTenant } from '../../platform/db/client';
import { periodWindows } from '../../platform/periods';
import { derivePosition } from '../../platform/periods';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { glAccount } from '../finance/schema';
import {
  allocationStructureAssignment,
  companyCode,
  controllingArea,
  costCenter,
  fiscalYearPeriod,
  fiscalYearVariant,
  internalOrder,
  internalOrderType,
  internalOrderTypeSettlementProfile,
  settlementDistributionRule,
  settlementDocument,
  settlementProfile,
} from './schema';
import { lockSettlementRuleForOrder } from './settlement-configuration';

export const ORDER_SETTLEMENT_CAPABILITY = 'CO.SETTLE.ORDER';
export const ORDER_SETTLEMENT_COLLECTIVE_CAPABILITY = 'CO.SETTLE.COLLECTIVE';
export const ORDER_SETTLEMENT_ROUTE = '/controlling/order-settlement';
export const ORDER_SETTLEMENT_COLLECTIVE_ROUTE = '/controlling/order-settlement-collective';

export class OrderSettlementError extends Error {
  readonly remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'OrderSettlementError';
    this.remedy = remedy;
  }
}

export interface OrderSettlementInput {
  client: string;
  changedBy: string;
  orderNumber?: string;
  orderFrom?: string;
  orderTo?: string;
  orderType?: string;
  controllingArea?: string;
  fiscalYear: number;
  settlementPeriod: number;
  postingPeriod?: number;
  processingType?: string;
  assetValueDate?: string;
  testRun: boolean;
  detailList?: boolean;
  checkTransactionData?: boolean;
  background?: boolean;
  selectionVariant?: string;
  orderGroup?: string;
  requestKey?: string;
}

export interface SettlementReceiverResult {
  receiverCategory: string;
  receiver: string;
  amount: string;
}

export interface SettlementOrderResult {
  orderNumber: string;
  orderType: string;
  controllingArea: string;
  companyCode: string;
  currency: string;
  outcome: 'NOT_SETTLED' | 'SIMULATED' | 'SETTLED' | 'NOTHING_TO_SETTLE' | 'FAILED';
  reasons: string[];
  amount: string | null;
  receivers: SettlementReceiverResult[];
}

export interface SettlementDocumentRef {
  orderNumber: string;
  documentNumber: string;
  fiscalYear: number;
  amount: string;
  postingDate: string;
  created: boolean;
}

export interface SettlementRunResult {
  mode: 'INDIVIDUAL' | 'COLLECTIVE';
  transactionCode: 'KO88' | 'KO8G';
  testRun: boolean;
  posted: boolean;
  documents: SettlementDocumentRef[];
  fiscalYear: number;
  settlementPeriod: number;
  postingPeriod: null;
  selected: number;
  eligible: number;
  settled: number;
  orders: SettlementOrderResult[];
  outcome: 'INVALID_SELECTION' | 'NO_ELIGIBLE_ORDERS' | 'NOT_POSTED' | 'SIMULATED' | 'POSTED' | 'NOTHING_TO_SETTLE';
  gaps: string[];
  message: string;
}

const MISSING_PROFILE = 'No settlement profile is configured for this order type.';
const MISSING_RULE = 'No distribution rule is stored. A receiver and a percentage are not assumed.';
const MISSING_ALLOCATION = 'No allocation structure is configured. A settlement account is not assumed.';
const MISSING_STATUS = 'No order status profile is configured. Release was not checked.';

const BASE_GAPS = [
  'Maintenance orders are not configured and were not selected.',
  'Production and process orders are not selected. CO88 is not this run.',
  'Posted ledger entries are not deleted.',
  'A reversal is not offered. KO8B, KO9E, and CJ88 are not this run.',
];

export function orderSettlementPosting(): { posts: false; reason: string } {
  return {
    posts: false,
    reason: 'A settlement posts only when a profile, an allocation assignment, and a distribution rule are stored. None is assumed.',
  };
}

type RunOptions = {
  fiscalYear: number;
  settlementPeriod: number;
  testRun: boolean;
  detailList: boolean;
  checkTransactionData: boolean;
  requestKey: string;
};

function text(value: string | undefined): string {
  return value?.trim() ?? '';
}

function requireRun(input: OrderSettlementInput): RunOptions {
  if (!input.client?.trim() || !input.changedBy?.trim()) {
    throw new OrderSettlementError('A client and a user are required.');
  }
  if (typeof input.testRun !== 'boolean') {
    throw new OrderSettlementError('Say whether this is a test run. An update is not assumed.');
  }
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 1000 || input.fiscalYear > 9999) {
    throw new OrderSettlementError('The fiscal year is not a four-digit year. It was not replaced.');
  }
  if (!Number.isInteger(input.settlementPeriod) || input.settlementPeriod < 1 || input.settlementPeriod > 16) {
    throw new OrderSettlementError('The settlement period must be from 1 to 16. It was not replaced.');
  }
  if (text(input.processingType)) {
    throw new OrderSettlementError(
      'Processing type is not configured. Automatic and full settlement are not assumed.',
    );
  }
  if (text(input.assetValueDate)) {
    throw new OrderSettlementError('Asset settlement is not configured. An asset value date is not accepted.');
  }
  if (input.background) {
    throw new OrderSettlementError('Background execution is not available.');
  }
  if (text(input.selectionVariant)) {
    throw new OrderSettlementError(
      'Selection variants are not configured. A settlement-only variant store was not created.',
    );
  }
  if (text(input.orderGroup)) {
    throw new OrderSettlementError('Order groups are not configured.');
  }
  if (input.postingPeriod !== undefined) {
    throw new OrderSettlementError(
      'A posting period is not configured separately from the settlement period.',
      'The entered settlement period was not used as a posting period.',
    );
  }
  return {
    fiscalYear: input.fiscalYear,
    settlementPeriod: input.settlementPeriod,
    testRun: input.testRun,
    detailList: input.detailList !== false,
    checkTransactionData: input.checkTransactionData === true,
    requestKey: text(input.requestKey),
  };
}

function gaps(checkTransactionData: boolean): string[] {
  return checkTransactionData
    ? [...BASE_GAPS, 'Transaction-data checks beyond the order master and its citing journals are not configured.']
    : [...BASE_GAPS];
}

function blockedReasons(order: { orderNumber: string; statistical: boolean; markedForDeletion: boolean }): string[] {
  const reasons: string[] = [];
  if (order.statistical) reasons.push(`Internal order ${order.orderNumber} is statistical and cannot be settled.`);
  if (order.markedForDeletion) reasons.push(`Internal order ${order.orderNumber} is marked for deletion.`);
  return reasons;
}

function finish(
  mode: 'INDIVIDUAL' | 'COLLECTIVE',
  run: RunOptions,
  outcome: SettlementRunResult['outcome'],
  orders: SettlementOrderResult[],
  documents: SettlementDocumentRef[],
  message: string,
  eligible: number,
): SettlementRunResult {
  const created = documents.filter((document) => document.created);
  return {
    mode,
    transactionCode: mode === 'INDIVIDUAL' ? 'KO88' : 'KO8G',
    testRun: run.testRun,
    posted: created.length > 0,
    documents,
    fiscalYear: run.fiscalYear,
    settlementPeriod: run.settlementPeriod,
    postingPeriod: null,
    selected: orders.length,
    eligible,
    settled: created.length,
    orders: run.detailList ? orders : [],
    outcome,
    gaps: gaps(run.checkTransactionData),
    message,
  };
}

async function assertAreaPeriod(tx: Tx, client: string, areaCode: string, period: number): Promise<void> {
  const [area] = await tx.select().from(controllingArea).where(and(
    eq(controllingArea.client, client),
    eq(controllingArea.controllingArea, areaCode),
  ));
  if (!area?.isActive) throw new OrderSettlementError(`Controlling area ${areaCode} does not exist or is inactive.`);
  const [variant] = await tx.select().from(fiscalYearVariant).where(and(
    eq(fiscalYearVariant.client, client),
    eq(fiscalYearVariant.variant, area.fiscalYearVariant),
  ));
  if (!variant) throw new OrderSettlementError(`Fiscal year variant ${area.fiscalYearVariant} does not exist.`);
  if (period > variant.regularPeriods) {
    throw new OrderSettlementError(
      `Settlement period ${period} is outside fiscal year variant ${variant.variant}.`,
      'The entered fiscal year and period were not replaced.',
    );
  }
}

async function periodEnd(tx: Tx, client: string, variantCode: string, fiscalYear: number, period: number): Promise<string> {
  const [variant] = await tx.select().from(fiscalYearVariant).where(and(
    eq(fiscalYearVariant.client, client),
    eq(fiscalYearVariant.variant, variantCode),
  ));
  if (!variant) throw new OrderSettlementError(`Fiscal year variant ${variantCode} does not exist.`);
  const load = async (calendarYear: number) => tx.select().from(fiscalYearPeriod).where(and(
    eq(fiscalYearPeriod.client, client),
    eq(fiscalYearPeriod.variant, variantCode),
    eq(fiscalYearPeriod.calendarYear, calendarYear),
  ));
  let rows = await load(variant.isYearDependent ? fiscalYear : 0);
  if (variant.isYearDependent && rows.length === 0) rows = await load(0);
  const regular = rows.filter((row) => row.periodType === 'REGULAR').sort((left, right) => left.period - right.period);
  const window = periodWindows(regular, fiscalYear).find((item) => item.period === period);
  if (!window) {
    throw new OrderSettlementError(
      `Settlement period ${period} is outside fiscal year variant ${variantCode}.`,
      'The entered fiscal year and period were not replaced.',
    );
  }
  return new Date(window.end).toISOString().slice(0, 10);
}

function inScope(year: number, period: number, settlementType: string, fiscalYear: number, settlementPeriod: number): boolean {
  if (settlementType === 'PER') return year === fiscalYear && period === settlementPeriod;
  return year < fiscalYear || (year === fiscalYear && period <= settlementPeriod);
}

function sharesOf(total: bigint, weights: bigint[]): bigint[] {
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0n);
  if (weightTotal <= 0n || total <= 0n) {
    throw new OrderSettlementError('The distribution does not settle a positive balance.');
  }
  const shares = weights.map((weight) => (total * weight) / weightTotal);
  const allocated = shares.reduce((sum, share) => sum + share, 0n);
  const last = shares.length - 1;
  shares[last] = (shares[last] ?? 0n) + (total - allocated);
  if (shares.some((share) => share <= 0n)) {
    throw new OrderSettlementError('A receiver share rounded to zero. Nothing was posted.');
  }
  return shares;
}

async function settleOne(
  tx: Tx,
  input: OrderSettlementInput,
  run: RunOptions,
  mode: 'INDIVIDUAL' | 'COLLECTIVE',
  row: typeof internalOrder.$inferSelect,
): Promise<{ order: SettlementOrderResult; document: SettlementDocumentRef | null; eligible: boolean }> {
  // The profile assignment, the allocation assignment and the distribution rule are one condition, so
  // they are read under the key the rule screen holds while it writes them: an update cannot post
  // against a profile from one save and a rule from the next. A test run reports rather than decides,
  // so it does not take the key.
  if (!run.testRun) {
    await lockSettlementRuleForOrder(tx, input.client, row.orderNumber);
  }
  const base = {
    orderNumber: row.orderNumber,
    orderType: row.orderType,
    controllingArea: row.controllingArea,
    companyCode: row.companyCode,
    currency: row.currency.trim(),
    amount: null,
    receivers: [] as SettlementReceiverResult[],
  };
  // The header was selected before this transaction opened — a collective run reads its whole range
  // first and settles each order afterwards — so the copy handed down is a starting point, not the
  // state to be judged. What may be settled is what the header says when the document is posted, so
  // the two refusal flags are read again, and while an update is being posted the header save waits
  // behind that read the way the configuration paths wait behind it. A test run decides nothing, so
  // it reads without locking.
  const header = tx.select({
    statistical: internalOrder.statistical,
    markedForDeletion: internalOrder.markedForDeletion,
  }).from(internalOrder).where(and(
    eq(internalOrder.client, input.client),
    eq(internalOrder.orderNumber, row.orderNumber),
  ));
  const [current] = run.testRun ? await header : await header.for('share');
  if (!current) {
    return {
      eligible: false,
      document: null,
      order: {
        ...base,
        outcome: 'NOT_SETTLED',
        reasons: [`Internal order ${row.orderNumber} does not exist any more. Nothing was posted.`],
      },
    };
  }
  const blocked = blockedReasons({
    orderNumber: row.orderNumber,
    statistical: current.statistical,
    markedForDeletion: current.markedForDeletion,
  });
  if (blocked.length > 0) {
    return {
      eligible: false,
      document: null,
      order: { ...base, outcome: 'NOT_SETTLED', reasons: [...blocked, MISSING_PROFILE, MISSING_RULE, MISSING_ALLOCATION, MISSING_STATUS] },
    };
  }
  // The three shared rows are read for share, exactly as the header above is: an update that is about
  // to post must not have the order type's profile, the profile, or the allocation mapping change under
  // it between the decision and the commit, while two runs — and a test run, which decides nothing and
  // takes no lock — keep reading them side by side. A master save takes `for update` on the same rows,
  // so it waits for the run rather than slipping into it.
  const typeLink = tx.select().from(internalOrderTypeSettlementProfile).where(and(
    eq(internalOrderTypeSettlementProfile.client, input.client),
    eq(internalOrderTypeSettlementProfile.orderType, row.orderType),
  ));
  const [assignment] = run.testRun ? await typeLink : await typeLink.for('share');
  const profileRows = tx.select().from(settlementProfile).where(and(
    eq(settlementProfile.client, input.client),
    eq(settlementProfile.profileCode, assignment?.profileCode ?? ''),
    eq(settlementProfile.isActive, true),
  ));
  const [profile] = assignment
    ? run.testRun ? await profileRows : await profileRows.for('share')
    : [];
  if (!profile) {
    return {
      eligible: false,
      document: null,
      order: { ...base, outcome: 'NOT_SETTLED', reasons: [MISSING_PROFILE, MISSING_RULE, MISSING_ALLOCATION, MISSING_STATUS] },
    };
  }
  const rules = (await tx.select().from(settlementDistributionRule).where(and(
    eq(settlementDistributionRule.client, input.client),
    eq(settlementDistributionRule.orderNumber, row.orderNumber),
  )).orderBy(asc(settlementDistributionRule.ruleNumber))).filter((rule) => {
    const from = rule.validFromYear * 100 + rule.validFromPeriod;
    const to = rule.validToYear * 100 + rule.validToPeriod;
    const at = run.fiscalYear * 100 + run.settlementPeriod;
    return at >= from && at <= to;
  });
  if (rules.length === 0) {
    return {
      eligible: false,
      document: null,
      order: { ...base, outcome: 'NOT_SETTLED', reasons: [MISSING_RULE, MISSING_ALLOCATION, MISSING_STATUS] },
    };
  }
  const types = [...new Set(rules.map((rule) => rule.settlementType))];
  if (types.length !== 1) {
    return {
      eligible: false,
      document: null,
      order: {
        ...base,
        outcome: 'NOT_SETTLED',
        reasons: ['Periodic and full rules both apply. A processing type was not chosen, and one was not assumed.'],
      },
    };
  }
  const settlementType = types[0] ?? 'PER';
  const methods = rules.map((rule) => rule.percentage !== null ? 'PERCENT' : rule.equivalence !== null ? 'EQUIVALENCE' : 'AMOUNT');
  if (new Set(methods).size !== 1) {
    return {
      eligible: false,
      document: null,
      order: { ...base, outcome: 'NOT_SETTLED', reasons: ['A rule uses a percentage, an equivalence number, or an amount, not a mix.'] },
    };
  }
  const method = methods[0];
  if (
    (method === 'PERCENT' && !profile.percentageAllowed)
    || (method === 'EQUIVALENCE' && !profile.equivalenceAllowed)
    || (method === 'AMOUNT' && !profile.amountAllowed)
  ) {
    return {
      eligible: false,
      document: null,
      order: { ...base, outcome: 'NOT_SETTLED', reasons: ['The settlement profile does not allow this distribution method.'] },
    };
  }
  if (method === 'PERCENT') {
    const total = rules.reduce((sum, rule) => sum + toScaled(rule.percentage ?? '0'), 0n);
    if (total !== toScaled('100')) {
      return {
        eligible: false,
        document: null,
        order: {
          ...base,
          outcome: 'NOT_SETTLED',
          reasons: [`The percentage rules total ${fromScaled(total)}, not 100. The remainder was not assumed.`],
        },
      };
    }
  }
  const assignmentRows = tx.select().from(allocationStructureAssignment).where(and(
    eq(allocationStructureAssignment.client, input.client),
    eq(allocationStructureAssignment.structureCode, profile.allocationStructure),
  ));
  const assignments = run.testRun ? await assignmentRows : await assignmentRows.for('share');
  if (assignments.length === 0) {
    return {
      eligible: false,
      document: null,
      order: { ...base, outcome: 'NOT_SETTLED', reasons: [MISSING_ALLOCATION, MISSING_STATUS] },
    };
  }
  const [company] = await tx.select().from(companyCode).where(and(
    eq(companyCode.client, input.client),
    eq(companyCode.companyCode, row.companyCode),
  ));
  if (!company?.chartOfAccounts || !company.fiscalYearVariant) {
    throw new OrderSettlementError(`Company code ${row.companyCode} is missing its chart or fiscal year variant.`);
  }
  if (company.currency.trim() !== row.currency.trim()) {
    return {
      eligible: false,
      document: null,
      order: {
        ...base,
        outcome: 'NOT_SETTLED',
        reasons: [`The order currency is ${row.currency.trim()} and the company currency is ${company.currency.trim()}. No exchange rate was assumed.`],
      },
    };
  }
  const [area] = await tx.select().from(controllingArea).where(and(
    eq(controllingArea.client, input.client),
    eq(controllingArea.controllingArea, row.controllingArea),
  ));
  if (!area) throw new OrderSettlementError(`Controlling area ${row.controllingArea} does not exist.`);
  const postingDate = await periodEnd(tx, input.client, area.fiscalYearVariant, run.fiscalYear, run.settlementPeriod);
  const position = await derivePosition(tx, input.client, company.fiscalYearVariant, postingDate);
  if (position.fiscalYear !== run.fiscalYear || position.period !== run.settlementPeriod) {
    throw new OrderSettlementError(
      `The settlement period ends on ${postingDate}, which is fiscal year ${position.fiscalYear} period ${position.period} for company ${row.companyCode}.`,
      'The entered fiscal year and period were not replaced.',
    );
  }

  const requestKey = run.requestKey ? `${run.requestKey}/${row.orderNumber}` : '';
  if (!run.testRun && requestKey) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/order-settlement/${row.orderNumber}/${run.fiscalYear}/${run.settlementPeriod}`}, 0))`);
    const [existing] = await tx.select().from(settlementDocument).where(and(
      eq(settlementDocument.client, input.client),
      eq(settlementDocument.requestKey, requestKey),
    ));
    if (existing) {
      return {
        eligible: true,
        document: {
          orderNumber: row.orderNumber,
          documentNumber: existing.documentNumber,
          fiscalYear: existing.fiscalYear,
          amount: existing.amount,
          postingDate,
          created: false,
        },
        order: {
          ...base,
          outcome: 'SETTLED',
          amount: existing.amount,
          reasons: [`This request was already posted as ${existing.documentNumber}. No second document was created.`],
        },
      };
    }
  } else if (!run.testRun) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/order-settlement/${row.orderNumber}/${run.fiscalYear}/${run.settlementPeriod}`}, 0))`);
  }

  const nets = new Map<string, bigint>();
  const postedLines = await tx.execute(sql`
    select j.fiscal_year::int as fiscal_year, j.posting_period::int as posting_period, j.status,
           l.gl_account as account, l.debit_credit as side, l.amount_local::text as amount, l.currency as currency
      from journal_entry_line l
      join journal_entry j
        on j.client = l.client and j.document_number = l.document_number and j.fiscal_year = l.fiscal_year
     where l.client = ${input.client}
       and l.internal_order = ${row.orderNumber}
       and j.company_code = ${row.companyCode}
       and j.status in ('POSTED', 'REVERSED')
  `) as unknown as Array<{
    fiscal_year: number;
    posting_period: number;
    status: string;
    account: string;
    side: string;
    amount: string;
    currency: string;
  }>;
  for (const line of postedLines) {
    if (line.currency.trim() !== row.currency.trim()) {
      return {
        eligible: true,
        document: null,
        order: {
          ...base,
          outcome: 'NOT_SETTLED',
          reasons: [`A journal line citing this order is in ${line.currency.trim()}. No exchange rate was assumed.`],
        },
      };
    }
    if (!inScope(Number(line.fiscal_year), Number(line.posting_period), settlementType, run.fiscalYear, run.settlementPeriod)) continue;
    const signed = toScaled(String(line.amount)) * (line.side === 'S' ? 1n : -1n);
    nets.set(line.account, (nets.get(line.account) ?? 0n) + signed);
  }
  const sources = [...nets.entries()].filter(([, net]) => net !== 0n);
  if (method === 'AMOUNT' && sources.length > 1) {
    return {
      eligible: true,
      document: null,
      order: {
        ...base,
        outcome: 'NOT_SETTLED',
        reasons: ['An amount rule cannot be split across source accounts. An allocation was not assumed.'],
      },
    };
  }
  if (sources.length === 0) {
    return {
      eligible: true,
      document: null,
      order: { ...base, outcome: 'NOTHING_TO_SETTLE', reasons: ['Nothing to settle. No document was posted.'] },
    };
  }
  const weights = method === 'PERCENT'
    ? rules.map((rule) => toScaled(rule.percentage ?? '0'))
    : method === 'EQUIVALENCE'
      ? rules.map((rule) => toScaled(rule.equivalence ?? '0'))
      : [];
  const lines: Array<{
    glAccount: string;
    debitCredit: 'S' | 'H';
    amount: string;
    internalOrder?: string;
    costCenter?: string;
  }> = [];
  const receiverResults: SettlementReceiverResult[] = rules.map((rule) => ({
    receiverCategory: rule.receiverCategory,
    receiver: rule.receiver,
    amount: '0.0000',
  }));
  const receiverTotals = rules.map(() => 0n);
  for (const [account, net] of sources) {
    const absolute = net < 0n ? -net : net;
    const portions = method === 'AMOUNT'
      ? rules.map((rule) => toScaled(rule.amount ?? '0'))
      : sharesOf(absolute, weights);
    if (method === 'AMOUNT') {
      const requested = portions.reduce((sum, portion) => sum + portion, 0n);
      if (requested > absolute) {
        return {
          eligible: true,
          document: null,
          order: {
            ...base,
            outcome: 'NOT_SETTLED',
            reasons: ['The amount rules exceed the unsettled balance. The balance was not increased.'],
          },
        };
      }
    }
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index];
      const portion = portions[index] ?? 0n;
      if (portion === 0n) continue;
      const mapped = assignments.find((item) => item.sourceAccount === account && item.receiverCategory === rule?.receiverCategory);
      if (!mapped || !rule) {
        return {
          eligible: true,
          document: null,
          order: {
            ...base,
            outcome: 'NOT_SETTLED',
            reasons: [`Account ${account} has no allocation assignment for ${rule?.receiverCategory ?? 'the receiver'}. A settlement account was not assumed.`],
          },
        };
      }
      const settlementAccount = mapped.byOriginalAccount ? account : mapped.settlementAccount;
      if (!settlementAccount) {
        return {
          eligible: true,
          document: null,
          order: { ...base, outcome: 'NOT_SETTLED', reasons: [MISSING_ALLOCATION] },
        };
      }
      const receiverAccount = rule.receiverCategory === 'GL_ACCOUNT' ? rule.receiver : settlementAccount;
      const [receiverAccountRow] = await tx.select().from(glAccount).where(and(
        eq(glAccount.client, input.client),
        eq(glAccount.chartOfAccounts, company.chartOfAccounts),
        eq(glAccount.accountNumber, receiverAccount),
      ));
      if (!receiverAccountRow) {
        return {
          eligible: true,
          document: null,
          order: { ...base, outcome: 'NOT_SETTLED', reasons: [`Account ${receiverAccount} is not in chart ${company.chartOfAccounts}.`] },
        };
      }
      if (rule.receiverCategory === 'GL_ACCOUNT' && receiverAccountRow.requiresCostObject) {
        return {
          eligible: true,
          document: null,
          order: {
            ...base,
            outcome: 'NOT_SETTLED',
            reasons: [`Account ${receiverAccount} requires a cost object. A G/L receiver does not supply one.`],
          },
        };
      }
      if (rule.receiverCategory === 'COST_CENTER') {
        const centers = await tx.select().from(costCenter).where(and(
          eq(costCenter.client, input.client),
          eq(costCenter.controllingArea, row.controllingArea),
          eq(costCenter.costCenter, rule.receiver),
          eq(costCenter.companyCode, row.companyCode),
        ));
        const open = centers.find((center) => String(center.validFrom) <= postingDate && String(center.validTo) >= postingDate && !center.isPostingLocked);
        if (!open) {
          return {
            eligible: true,
            document: null,
            order: { ...base, outcome: 'NOT_SETTLED', reasons: [`Cost center ${rule.receiver} is not open for posting on ${postingDate}.`] },
          };
        }
      }
      const amount = fromScaled(portion);
      const orderSide = net > 0n ? 'H' : 'S';
      const receiverSide = net > 0n ? 'S' : 'H';
      lines.push({
        glAccount: settlementAccount,
        debitCredit: orderSide,
        amount,
        internalOrder: row.orderNumber,
      });
      lines.push({
        glAccount: receiverAccount,
        debitCredit: receiverSide,
        amount,
        ...(rule.receiverCategory === 'COST_CENTER' ? { costCenter: rule.receiver } : {}),
        ...(rule.receiverCategory === 'INTERNAL_ORDER' ? { internalOrder: rule.receiver } : {}),
      });
      receiverTotals[index] = (receiverTotals[index] ?? 0n) + portion;
    }
  }
  const settledAmount = receiverTotals.reduce((sum, amount) => sum + amount, 0n);
  receiverResults.forEach((receiver, index) => {
    receiver.amount = fromScaled(receiverTotals[index] ?? 0n);
  });
  if (lines.length === 0 || settledAmount <= 0n) {
    return {
      eligible: true,
      document: null,
      order: { ...base, outcome: 'NOTHING_TO_SETTLE', reasons: ['Nothing to settle. No document was posted.'] },
    };
  }
  if (run.testRun) {
    return {
      eligible: true,
      document: null,
      order: {
        ...base,
        outcome: 'SIMULATED',
        amount: fromScaled(settledAmount),
        receivers: receiverResults,
        reasons: ['Test run. Nothing was posted.'],
      },
    };
  }
  const posted = await postJournalEntry(tx, {
    client: input.client,
    companyCode: row.companyCode,
    documentType: profile.documentType,
    documentDate: postingDate,
    postingDate,
    fiscalYear: run.fiscalYear,
    postingPeriod: run.settlementPeriod,
    currency: row.currency.trim(),
    localCurrency: company.currency.trim(),
    headerText: `Settlement ${row.orderNumber}`,
    postedBy: input.changedBy,
    transactionCode: mode === 'INDIVIDUAL' ? 'KO88' : 'KO8G',
    origin: { documentClass: 'order_settlement', documentKey: `${row.orderNumber}/${run.fiscalYear}/${run.settlementPeriod}` },
    lines,
  });
  await tx.insert(settlementDocument).values({
    client: input.client,
    documentNumber: posted.documentNumber,
    fiscalYear: posted.fiscalYear,
    orderNumber: row.orderNumber,
    settlementPeriod: run.settlementPeriod,
    currency: row.currency.trim(),
    amount: fromScaled(settledAmount),
    requestKey: requestKey || null,
    createdBy: input.changedBy,
  });
  return {
    eligible: true,
    document: {
      orderNumber: row.orderNumber,
      documentNumber: posted.documentNumber,
      fiscalYear: posted.fiscalYear,
      amount: fromScaled(settledAmount),
      postingDate,
      created: true,
    },
    order: {
      ...base,
      outcome: 'SETTLED',
      amount: fromScaled(settledAmount),
      receivers: receiverResults,
      reasons: [`Posted ${posted.documentNumber}.`],
    },
  };
}

function runMessage(
  run: RunOptions,
  outcome: SettlementRunResult['outcome'],
  orders: SettlementOrderResult[],
): string {
  if (outcome === 'NO_ELIGIBLE_ORDERS') {
    return 'No internal order matches the selection. This is not an invalid order number. Nothing was posted.';
  }
  if (outcome === 'POSTED') return 'Update run. The settlement document was posted.';
  if (outcome === 'SIMULATED') return 'Test run. Nothing was posted.';
  if (outcome === 'NOTHING_TO_SETTLE') {
    return `${run.testRun ? 'Test run' : 'Update run'}. Nothing to settle. No document was posted.`;
  }
  const label = run.testRun ? 'Test run' : 'Update run';
  if (orders.some((order) => order.reasons.some((reason) => reason.includes('not assumed')))) {
    return `${label}. Nothing was posted. No settlement rule is configured.`;
  }
  return `${label}. Nothing was posted.`;
}

async function settleRows(
  input: OrderSettlementInput,
  run: RunOptions,
  mode: 'INDIVIDUAL' | 'COLLECTIVE',
  rows: Array<typeof internalOrder.$inferSelect>,
): Promise<SettlementRunResult> {
  const orders: SettlementOrderResult[] = [];
  const documents: SettlementDocumentRef[] = [];
  let eligible = 0;
  for (const row of rows) {
    try {
      const settled = await withTenant(input.client, (tx) => settleOne(tx, input, run, mode, row));
      orders.push(settled.order);
      if (settled.document) documents.push(settled.document);
      if (settled.eligible) eligible += 1;
    } catch (error) {
      if (error instanceof OrderSettlementError) throw error;
      const message = error instanceof PostingError || error instanceof Error
        ? error.message
        : 'The settlement could not be posted.';
      orders.push({
        orderNumber: row.orderNumber,
        orderType: row.orderType,
        controllingArea: row.controllingArea,
        companyCode: row.companyCode,
        currency: row.currency.trim(),
        outcome: 'FAILED',
        reasons: [message],
        amount: null,
        receivers: [],
      });
    }
  }
  const outcome: SettlementRunResult['outcome'] = documents.some((document) => document.created)
    ? 'POSTED'
    : orders.some((order) => order.outcome === 'SIMULATED')
      ? 'SIMULATED'
      : orders.length > 0 && orders.every((order) => order.outcome === 'NOTHING_TO_SETTLE')
        ? 'NOTHING_TO_SETTLE'
        : 'NOT_POSTED';
  return finish(mode, run, outcome, orders, documents, runMessage(run, outcome, orders), eligible);
}

export async function settleOrder(input: OrderSettlementInput): Promise<SettlementRunResult> {
  const run = requireRun(input);
  const orderNumber = text(input.orderNumber);
  if (!orderNumber) throw new OrderSettlementError('KO88 requires one order number.');
  if (text(input.orderFrom) || text(input.orderTo) || text(input.orderType)) {
    throw new OrderSettlementError('KO88 settles one order. It does not start a collective selection.');
  }
  const requestedArea = text(input.controllingArea).toUpperCase();
  return withTenant(input.client, async (tx) => {
    const [row] = await tx.select().from(internalOrder).where(and(
      eq(internalOrder.client, input.client),
      eq(internalOrder.orderNumber, orderNumber),
    ));
    if (!row) {
      return finish('INDIVIDUAL', run, 'INVALID_SELECTION', [], [], `Internal order ${orderNumber} does not exist. Nothing was posted.`, 0);
    }
    if (requestedArea && row.controllingArea !== requestedArea) {
      throw new OrderSettlementError(
        `Internal order ${row.orderNumber} is in controlling area ${row.controllingArea}, not ${requestedArea}.`,
        'The order was not settled, and the controlling area was not changed.',
      );
    }
    await assertAreaPeriod(tx, input.client, row.controllingArea, run.settlementPeriod);
    return { row };
  }).then(async (found) => {
    if ('outcome' in found) return found;
    return settleRows(input, run, 'INDIVIDUAL', [found.row]);
  });
}

export async function settleOrdersCollective(input: OrderSettlementInput): Promise<SettlementRunResult> {
  const run = requireRun(input);
  const orderNumber = text(input.orderNumber);
  const orderFrom = text(input.orderFrom);
  const orderTo = text(input.orderTo);
  const orderType = text(input.orderType).toUpperCase();
  const areaCode = text(input.controllingArea).toUpperCase();
  if (!orderNumber && !orderFrom && !orderTo && !orderType && !areaCode) {
    throw new OrderSettlementError(
      'A collective settlement needs a selection. An order group and a selection variant are not configured.',
    );
  }
  if (orderFrom && orderTo && orderFrom > orderTo) {
    throw new OrderSettlementError('The order range is empty. The bounds were not swapped.');
  }
  const rows = await withTenant(input.client, async (tx) => {
    if (areaCode) await assertAreaPeriod(tx, input.client, areaCode, run.settlementPeriod);
    if (orderType) {
      const [type] = await tx.select().from(internalOrderType).where(and(
        eq(internalOrderType.client, input.client),
        eq(internalOrderType.orderType, orderType),
        eq(internalOrderType.isActive, true),
      ));
      if (!type) {
        throw new OrderSettlementError(
          `Order type ${orderType} is not an active internal-order type.`,
          'IO01 is not assumed when it is not configured.',
        );
      }
    }
    const selected = await tx.select().from(internalOrder).where(and(
      eq(internalOrder.client, input.client),
      areaCode ? eq(internalOrder.controllingArea, areaCode) : undefined,
      orderType ? eq(internalOrder.orderType, orderType) : undefined,
    )).orderBy(asc(internalOrder.orderNumber));
    return selected.filter((row) => {
      if (orderNumber && row.orderNumber !== orderNumber) return false;
      if (orderFrom && row.orderNumber < orderFrom) return false;
      if (orderTo && row.orderNumber > orderTo) return false;
      return true;
    });
  });
  if (rows.length === 0) {
    return finish('COLLECTIVE', run, 'NO_ELIGIBLE_ORDERS', [], [], 'No internal order matches the selection. This is not an invalid order number. Nothing was posted.', 0);
  }
  return settleRows(input, run, 'COLLECTIVE', rows);
}
