/**
 * The demo company's month-end close — provisioning phase `D4_FINANCE`.
 *
 * D1 bought the materials, D2 made the biscuits, D3 sold and invoiced them. This
 * phase is the accounting those three left behind: the month is closed as far as a
 * month can be closed without shutting the period behind it.
 *
 * Five things shape it, and each is a constraint rather than a preference.
 *
 * **The period is left open.** Nothing here closes a posting period. A demo that
 * shut its own books would be a demo nobody could post into, which is the whole
 * opposite of its use. What stands when this phase ends is a company whose books
 * have been walked to the end of the month and left open for the next one.
 *
 * **A document is written by the person whose job it is.** The accountant posts
 * the journals, banks the suppliers, files the return, reclassifies the goods
 * received not invoiced, and runs the dunning. The controller keeps the internal
 * order, its budget, its settlement rule, and settles it. Each is judged inside
 * the service they call, on the reach they were granted, so a close that works is
 * a close whose authorisations work too.
 *
 * **The open items are the ones the ageing schedule says are open.** The invariant
 * is not "nothing is left outstanding". Three supplier invoices are settled and
 * three are deliberately left standing; the receivables are dunned rather than
 * collected; November's tax is left unreported because November has not ended.
 * What is left open is a list a person can walk into and finish.
 *
 * **Every date is a day inside one of the frozen open periods.** There is not a
 * calendar literal in the plan. The month that is closed is the last one that has
 * ended; the previous month's close stands behind it, already done, so the ledger
 * reads as a company that has been running rather than one that started yesterday.
 *
 * **Every step is request-keyed.** A resumed run is handed back the document it
 * posted rather than a second copy of it.
 */

import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { postAccrualDocument } from '../../modules/finance/accrual';
import {
  finalizeDunningRun, listDunningRuns, proposeDunningRun,
} from '../../modules/finance/dunning';
import { postGlDocument } from '../../modules/finance/gl-document';
import { executeGrIrAnalysis } from '../../modules/finance/grir-reclass';
import { getPayables, postOutgoingPayment } from '../../modules/finance/outgoing-payment';
import { executeTaxReport } from '../../modules/finance/tax-report';
import {
  getCustomerCompany, saveCustomerCompany,
} from '../../modules/foundation/customer-companies';
import {
  assignOrderTypeBudgetProfile, changeOriginalBudget, saveBudgetProfile,
} from '../../modules/foundation/internal-order-budget';
import { createInternalOrder } from '../../modules/foundation/internal-order';
import { settleOrder } from '../../modules/foundation/order-settlement';
import {
  assignOrderTypeSettlementProfile, getAllocationStructure, saveAllocationStructure,
  saveAllocationStructureAssignment, saveSettlementProfile,
} from '../../modules/foundation/settlement-configuration-masters';
import {
  getSettlementConfiguration, saveOrderSettlementConfiguration,
} from '../../modules/foundation/settlement-configuration';
import { DEMO_ACTOR, DEMO_IDENTITY, DEMO_STRUCTURE } from './demo-organisation';
import { withActingUser } from './demo-people';
import type { DemoTimeline } from './demo-provisioning';

/** Who does what, and why it is them. */
const ACCOUNTANT = 'demo.accountant';
/** The controller: the internal order, its budget, its rule, and the settlement. */
const CONTROLLER = 'demo.controller';

const COMPANY_CODE = DEMO_STRUCTURE.companyCode;
const CONTROLLING_AREA = DEMO_STRUCTURE.controllingArea;
const CURRENCY = DEMO_IDENTITY.currency;
const COUNTRY = DEMO_IDENTITY.country;
const BANK_ACCOUNT = '101000';

/** The bank account is where the money goes out of and into; the rest is named per plan. */
const NET_PAY_PAYABLE = '251000';
const ACCRUED_LIABILITIES = '230000';
/** Where the settlement clears what an internal order collected onto a cost centre. */
const SETTLEMENT_CLEARING = '600000';

/** The internal order type the standard structure delivers, and its budget profile. */
const ORDER_TYPE = 'IO01';
const BUDGET_PROFILE = 'BP01';
/** The allocation structure and settlement profile this phase configures. */
const ALLOCATION_STRUCTURE = 'AS01';
const SETTLEMENT_PROFILE = 'SP01';
/** The reversal reason the standing data carries for an accrual or a deferral. */
const REVERSAL_REASON = '03';
/** The journal document type: a general G/L entry, as FB50 posts it. */
const JOURNAL_TYPE = 'SA';

interface CostLine {
  glAccount: string;
  costCenter: string;
  amount: string;
}

/**
 * One month's closing cycle.
 *
 * `period` is an index into the frozen open periods. The month it names is walked
 * to its end: the operating costs are booked on the last day, the payroll they
 * created is paid on the fifth of the month that follows, and the return for the
 * month is filed on the twentieth of the month after that, which is when a return
 * is actually due.
 */
interface CloseCycle {
  /** Identifies the cycle in every request key. */
  key: string;
  period: number;
  /** The month's operating costs, each line on the cost centre that incurred it. */
  costs: CostLine[];
  /** The salaries inside `costs`: what is owed to the staff, and paid next month. */
  payroll: string;
}

/**
 * The two cycles this phase performs.
 *
 * The first is a close that already stands behind the company — the month before
 * last, booked, paid and filed. The second is the month this phase closes: its
 * costs are booked, its payroll is paid, its return is filed, and its accrual and
 * settlement are left standing where a person can see them.
 *
 * The amounts are the same in both months on purpose. A company whose costs are
 * identical to the fils in two consecutive months is not a coincidence a person
 * would believe, but a demo ledger is read for its shape and not its variance, and
 * a steady monthly cost base makes the settlement and the ageing legible.
 */
const CLOSE_CYCLES: readonly CloseCycle[] = [
  {
    key: 'CLO-1',
    period: 0,
    costs: [
      { glAccount: '500000', costCenter: 'CC1000', amount: '4200.000' },
      { glAccount: '500000', costCenter: 'CC1010', amount: '3100.000' },
      { glAccount: '500000', costCenter: 'CC2000', amount: '2400.000' },
      { glAccount: '500000', costCenter: 'CC5000', amount: '5300.000' },
      { glAccount: '510000', costCenter: 'CC5000', amount: '2500.000' },
      { glAccount: '510100', costCenter: 'CC1000', amount: '1350.000' },
    ],
    payroll: '15000.000',
  },
  {
    key: 'CLO-2',
    period: 1,
    costs: [
      { glAccount: '500000', costCenter: 'CC1000', amount: '4200.000' },
      { glAccount: '500000', costCenter: 'CC1010', amount: '3100.000' },
      { glAccount: '500000', costCenter: 'CC2000', amount: '2400.000' },
      { glAccount: '500000', costCenter: 'CC5000', amount: '5300.000' },
      { glAccount: '510000', costCenter: 'CC5000', amount: '2500.000' },
      { glAccount: '510100', costCenter: 'CC1000', amount: '1420.000' },
    ],
    payroll: '15000.000',
  },
];

/** The month this phase closes: the last one that has ended. */
const CLOSING_PERIOD = CLOSE_CYCLES[CLOSE_CYCLES.length - 1]!.period;

/**
 * The accrual the closing month leaves standing.
 *
 * The audit fee is incurred across the year and invoiced after it, so at the
 * close it is accrued and left to reverse itself on the last day of the month
 * that follows. The reversal is pending when this phase ends, which is exactly
 * what a person opening the accrual list should find.
 */
const ACCRUAL = {
  key: 'ACC-1',
  period: CLOSING_PERIOD,
  glAccount: '540100',
  costCenter: 'CC5000',
  amount: '750.000',
  offsetAccount: ACCRUED_LIABILITIES,
};

/**
 * What the suppliers are paid.
 *
 * Each row names a vendor and how many of its oldest open items are settled. The
 * rest are left standing: the payables ageing report is the point of an open item,
 * and a demo that paid everything is a demo with nothing to reconcile.
 */
const PAYMENT_PLAN = [
  { key: 'PAY-1', supplier: 'SUP-1000', items: 2 },
  { key: 'PAY-2', supplier: 'SUP-2000', items: 1 },
] as const;

/**
 * The internal order.
 *
 * A product launch: it collects the agency's fee and the travel it caused, and at
 * the month end what it collected is settled onto the sales cost centre in full.
 * It is the shortest complete story controlling has, and it is the one that shows
 * a cost moving from where it was incurred to where it belongs.
 */
const INTERNAL_ORDER = {
  key: 'IO-1',
  description: 'Product launch — Levant range',
  /** Opens on the first day of the closing month and runs to the end of the next. */
  startDay: 1,
  endPeriod: CLOSING_PERIOD + 1,
  endDay: 28,
  overallBudget: '6000.000',
  costs: [
    {
      key: 'IOC-1', period: CLOSING_PERIOD, day: 8,
      glAccount: '540000', amount: '1250.000', vendor: 'SUP-1000',
      text: 'Launch agency fee',
    },
    {
      key: 'IOC-2', period: CLOSING_PERIOD, day: 22,
      glAccount: '530200', amount: '840.000', vendor: '',
      text: 'Launch travel',
    },
  ] as const,
  /** The receiver: what the launch was for. */
  settleTo: 'CC4000',
} as const;

/** The dunning procedure the customers are given, so that the run may dun them. */
const DUNNING_PROCEDURE = 'D001';

/** The customers the dunning run looks at. */
const CUSTOMERS = ['CUS-1000', 'CUS-2000', 'CUS-3000'] as const;

export interface DemoFinanceResult {
  client: string;
  /** Operating-cost journals and the payroll payments that settled them. */
  costJournals: number;
  payrollPayments: number;
  /** The accrual left standing for the month that follows. */
  accruals: number;
  supplierPayments: number;
  internalOrders: number;
  orderCostJournals: number;
  settlements: number;
  /** GR/IR reclassification runs whose accrual stands. */
  grirRuns: number;
  /** Tax returns filed, each with the transfer that cleared it. */
  taxReturns: number;
  dunningNotices: number;
  /** Every document this phase wrote. */
  documents: number;
}

export interface BuildDemoFinanceInput {
  client: string;
  timeline: DemoTimeline;
}

/**
 * Close the books for the month that has ended, and leave the period open.
 *
 * The order the steps run in is the order a close happens in. The supplier
 * payments are made before the internal order's costs are booked, so that an
 * invoice this phase raises cannot be the one a payment settles. The settlement
 * runs after every cost has landed on the order. The dunning run comes last,
 * because it reads the receivables as they stand when everything else is done.
 */
export async function buildDemoFinance(input: BuildDemoFinanceInput): Promise<DemoFinanceResult> {
  const client = input.client;
  const timeline = input.timeline;

  let costJournals = 0;
  let payrollPayments = 0;

  for (const cycle of CLOSE_CYCLES) {
    if (await ensureOperatingCosts(client, timeline, cycle)) costJournals += 1;
    if (await ensurePayrollPayment(client, timeline, cycle)) payrollPayments += 1;
  }

  const accruals = (await ensureAccrual(client, timeline)) ? 1 : 0;
  const supplierPayments = await ensureSupplierPayments(client, timeline);

  const orders = (await ensureInternalOrder(client, timeline)) ? 1 : 0;
  const orderCostJournals = await ensureOrderCosts(client, timeline);
  const settlements = (await ensureSettlement(client, timeline)) ? 1 : 0;

  const grirRuns = (await ensureGrIrReclass(client, timeline)) ? 1 : 0;
  const taxReturns = await ensureTaxReturns(client, timeline);
  const dunningNotices = await ensureDunningRun(client, timeline);

  return {
    client,
    costJournals,
    payrollPayments,
    accruals,
    supplierPayments,
    internalOrders: orders,
    orderCostJournals,
    settlements,
    grirRuns,
    taxReturns,
    dunningNotices,
    // What a person counts when they walk the demo: every journal, payment,
    // accrual, settlement, reclassification, return and notice this phase wrote.
    documents: costJournals + payrollPayments + accruals + supplierPayments
      + orderCostJournals + settlements + grirRuns + taxReturns + dunningNotices,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The calendar
// ─────────────────────────────────────────────────────────────────────────────

/** A calendar date inside one of the frozen open periods. */
function dateIn(timeline: DemoTimeline, period: number, day: number): string {
  const key = timeline.openPeriods[period];
  if (!key) throw new Error(`The demo timeline has no period at index ${period}.`);
  return `${key.slice(0, 4)}-${key.slice(4)}-${String(day).padStart(2, '0')}`;
}

/** The first day of one of the frozen open periods. */
function monthStart(timeline: DemoTimeline, period: number): string {
  return dateIn(timeline, period, 1);
}

/**
 * The last day of one of the frozen open periods.
 *
 * Taken from the calendar rather than written down, because the whole point of
 * the frozen timeline is that a month ends when the month ends and not when the
 * plan says it does.
 */
function monthEnd(timeline: DemoTimeline, period: number): string {
  const key = timeline.openPeriods[period];
  if (!key) throw new Error(`The demo timeline has no period at index ${period}.`);
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(4));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${key.slice(0, 4)}-${key.slice(4)}-${String(last).padStart(2, '0')}`;
}

/** Only a duplicate is forgiven; anything else stops the run. */
function isAlready(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already (exists|stands|been|holds|links|carries|covers|assigned|initialized)|is already|duplicat/i.test(
    message,
  );
}

/** Three decimals, because the demo currency has three. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** What a table holds under this phase's request keys, whatever wrote it. */
async function countStanding(client: string, table: string, like: string): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(
      sql.raw(`select count(*)::text as n from ${table} where client = '${client}' and request_key like '${like}'`),
    ) as unknown as Array<{ n: string }>;
    return Number(rows[0]?.n ?? 0);
  });
}

/** The number a document of this phase carries, read back rather than remembered. */
async function findByRequestKey(
  client: string,
  table: string,
  requestKey: string,
  column: string,
): Promise<string | null> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select ${sql.raw(column)} as value
        from ${sql.raw(table)}
       where client = ${client} and request_key = ${requestKey}
       limit 1
    `) as unknown as Array<{ value: string | null }>;
    return rows[0]?.value ?? null;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The month's operating costs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The month's operating costs, booked on the last day of the month.
 *
 * The salaries are credited to net pay payable rather than to the bank, because
 * the month that incurs them is not the month that pays them; everything else is
 * paid as it is booked. Each line carries the cost centre that incurred it, which
 * is what makes the cost-centre report say something when it is run.
 */
async function ensureOperatingCosts(
  client: string,
  timeline: DemoTimeline,
  cycle: CloseCycle,
): Promise<boolean> {
  const requestKey = `DEMO-FIN-${cycle.key}-COSTS`;
  if (await findByRequestKey(client, 'journal_posting_request', requestKey, 'document_number')) return true;

  const postingDate = monthEnd(timeline, cycle.period);
  const banked = round3(cycle.costs
    .filter((line) => line.glAccount !== '500000')
    .reduce((sum, line) => sum + Number(line.amount), 0));

  const lines = [
    ...cycle.costs.map((line) => ({
      glAccount: line.glAccount,
      debitCredit: 'S' as const,
      amount: line.amount,
      costCenter: line.costCenter,
    })),
    { glAccount: NET_PAY_PAYABLE, debitCredit: 'H' as const, amount: cycle.payroll },
    { glAccount: BANK_ACCOUNT, debitCredit: 'H' as const, amount: banked.toFixed(3) },
  ];

  await withActingUser(client, ACCOUNTANT, (actor) => postGlDocument({
    client,
    changedBy: ACCOUNTANT,
    requestKey,
    companyCode: COMPANY_CODE,
    documentDate: postingDate,
    postingDate,
    documentType: JOURNAL_TYPE,
    currency: CURRENCY,
    headerText: `Operating costs ${cycle.key}`,
    lines,
  }, { authorization: actor }));
  return true;
}

/**
 * The payroll the previous month created, paid on the fifth of the month after.
 *
 * A salary that was never paid is a liability that never clears, and a demo whose
 * payables are only ever suppliers is a demo with no payroll in it.
 */
async function ensurePayrollPayment(
  client: string,
  timeline: DemoTimeline,
  cycle: CloseCycle,
): Promise<boolean> {
  const requestKey = `DEMO-FIN-${cycle.key}-PAYROLL`;
  if (await findByRequestKey(client, 'journal_posting_request', requestKey, 'document_number')) return true;

  const postingDate = dateIn(timeline, cycle.period + 1, 5);
  await withActingUser(client, ACCOUNTANT, (actor) => postGlDocument({
    client,
    changedBy: ACCOUNTANT,
    requestKey,
    companyCode: COMPANY_CODE,
    documentDate: postingDate,
    postingDate,
    documentType: JOURNAL_TYPE,
    currency: CURRENCY,
    headerText: `Payroll ${cycle.key}`,
    lines: [
      { glAccount: NET_PAY_PAYABLE, debitCredit: 'S' as const, amount: cycle.payroll },
      { glAccount: BANK_ACCOUNT, debitCredit: 'H' as const, amount: cycle.payroll },
    ],
  }, { authorization: actor }));
  return true;
}

/**
 * The audit fee, accrued at the close and left to reverse itself.
 *
 * The reversal date is the last day of the month that follows, so the accrual
 * stands pending when this phase ends — a reversal a person can run, which is the
 * same use as any other open end the demo leaves behind.
 */
async function ensureAccrual(client: string, timeline: DemoTimeline): Promise<boolean> {
  const requestKey = `DEMO-FIN-${ACCRUAL.key}`;
  if (await findByRequestKey(client, 'journal_posting_request', requestKey, 'document_number')) return true;

  const postingDate = monthEnd(timeline, ACCRUAL.period);
  await withActingUser(client, ACCOUNTANT, (actor) => postAccrualDocument({
    client,
    changedBy: ACCOUNTANT,
    authorization: actor,
    requestKey,
    companyCode: COMPANY_CODE,
    documentDate: postingDate,
    postingDate,
    documentType: JOURNAL_TYPE,
    currency: CURRENCY,
    headerText: 'Audit fee accrual',
    reversalDate: monthEnd(timeline, ACCRUAL.period + 1),
    reversalReason: REVERSAL_REASON,
    lines: [
      {
        glAccount: ACCRUAL.glAccount,
        debitCredit: 'S' as const,
        amount: ACCRUAL.amount,
        costCenter: ACCRUAL.costCenter,
      },
      { glAccount: ACCRUAL.offsetAccount, debitCredit: 'H' as const, amount: ACCRUAL.amount },
    ],
  }));
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// What the suppliers are owed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pay the suppliers, and leave the rest standing.
 *
 * The oldest open items of the vendors the plan names are settled in full; what is
 * left is the payables ageing. The guard is the payment document's own request key,
 * and the count reported is what stands under this phase's keys rather than what
 * this run wrote, so a resumed run does not claim to have paid twice.
 */
async function ensureSupplierPayments(client: string, timeline: DemoTimeline): Promise<number> {
  for (const plan of PAYMENT_PLAN) {
    const requestKey = `DEMO-FIN-${plan.key}`;
    if (await findByRequestKey(client, 'outgoing_payment', requestKey, 'payment_number')) continue;

    const view = await getPayables(client, plan.supplier, COMPANY_CODE);
    const open = view.openItems
      .filter((item) => item.signed > 0)
      .sort(
        (a, b) =>
          (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0) ||
          (a.documentNumber < b.documentNumber ? -1 : 1),
      )
      .slice(0, plan.items);
    if (open.length === 0) continue;

    const items = open.map((item) => ({
      documentNumber: item.documentNumber,
      fiscalYear: item.fiscalYear,
      lineNumber: item.lineNumber,
      applied: Number(item.amount),
    }));
    const amount = round3(items.reduce((sum, item) => sum + item.applied, 0));
    if (!(amount > 0)) continue;

    const postingDate = dateIn(timeline, CLOSING_PERIOD, 12);
    await withActingUser(client, ACCOUNTANT, (actor) => postOutgoingPayment({
      client,
      changedBy: ACCOUNTANT,
      vendorNumber: plan.supplier,
      companyCode: COMPANY_CODE,
      documentDate: postingDate,
      postingDate,
      clearingDate: postingDate,
      bankGlAccount: BANK_ACCOUNT,
      amount,
      currency: CURRENCY,
      reference: plan.key,
      requestKey,
      items,
    }, { authorization: actor }));
  }
  return countStanding(client, 'outgoing_payment', 'DEMO-FIN-%');
}

// ─────────────────────────────────────────────────────────────────────────────
// The internal order
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The internal order, made and budgeted by the controller.
 *
 * An order is only worth settling if something has been configured that says where
 * the balance goes, so this step also stands up the three configuration rows the
 * settlement reads: the allocation structure and the account it maps, the
 * settlement profile the order type carries, and the order's own distribution
 * rule. None of them is assumed by the settlement service, and none of them
 * exists in the standard structure, so a phase that settles an order has to
 * configure settlement first.
 */
async function ensureInternalOrder(client: string, timeline: DemoTimeline): Promise<boolean> {
  const requestKey = `DEMO-FIN-${INTERNAL_ORDER.key}-ORDER`;
  const standing = await findByRequestKey(client, 'internal_order', requestKey, 'order_number');

  await ensureSettlementConfiguration(client);

  if (standing) {
    await ensureOrderBudget(client, timeline, standing);
    return true;
  }

  const order = await withActingUser(client, CONTROLLER, (actor) => createInternalOrder({
    client,
    changedBy: CONTROLLER,
    orderType: ORDER_TYPE,
    description: INTERNAL_ORDER.description,
    controllingArea: CONTROLLING_AREA,
    companyCode: COMPANY_CODE,
    startDate: dateIn(timeline, CLOSING_PERIOD, INTERNAL_ORDER.startDay),
    endDate: dateIn(timeline, INTERNAL_ORDER.endPeriod, INTERNAL_ORDER.endDay),
    requestKey,
  }, { authorization: actor })).catch(async (error: unknown) => {
    if (!isAlready(error)) throw error;
    const existing = await findByRequestKey(client, 'internal_order', requestKey, 'order_number');
    if (!existing) throw error;
    return { orderNumber: existing };
  });

  await ensureOrderBudget(client, timeline, order.orderNumber);
  return true;
}

/** The order's original budget: what the launch was allowed to cost. */
async function ensureOrderBudget(
  client: string,
  timeline: DemoTimeline,
  orderNumber: string,
): Promise<void> {
  await saveBudgetProfile({
    client,
    changedBy: DEMO_ACTOR,
    profileCode: BUDGET_PROFILE,
    description: 'Original budget',
    overallBudget: true,
    annualBudget: true,
    annualNotExceedOverall: true,
    availabilityControl: false,
    changeAllowed: true,
  }).catch((error: unknown) => { if (!isAlready(error)) throw error; });

  await assignOrderTypeBudgetProfile({
    client,
    changedBy: DEMO_ACTOR,
    orderType: ORDER_TYPE,
    profileCode: BUDGET_PROFILE,
  }).catch((error: unknown) => { if (!isAlready(error)) throw error; });

  const requestKey = `DEMO-FIN-${INTERNAL_ORDER.key}-BUDGET`;
  const fiscalYear = Number(dateIn(timeline, CLOSING_PERIOD, 1).slice(0, 4));
  await changeOriginalBudget({
    client,
    changedBy: DEMO_ACTOR,
    orderNumber,
    documentDate: dateIn(timeline, CLOSING_PERIOD, 1),
    overallAmount: INTERNAL_ORDER.overallBudget,
    annual: [{ fiscalYear, amount: INTERNAL_ORDER.overallBudget }],
    documentText: 'Launch budget',
    requestKey,
  });
}

/**
 * The three configuration rows a settlement reads.
 *
 * The allocation structure maps each cost element the order can collect onto the
 * account the settlement clears through; the profile names the structure and the
 * document type and says a percentage rule is allowed; the order type carries the
 * profile; and the order's own rule sends the whole balance to the sales cost
 * centre in full.
 */
async function ensureSettlementConfiguration(client: string): Promise<void> {
  await saveAllocationStructure({
    client,
    changedBy: DEMO_ACTOR,
    mode: 'CREATE',
    expectedVersion: 0,
    reason: 'Demo settlement configuration',
    structureCode: ALLOCATION_STRUCTURE,
    description: 'Cost centre allocation',
  }).catch((error: unknown) => { if (!isAlready(error)) throw error; });

  // The assignment rows are versioned, so a second run is handed the version the
  // row stands at rather than the version it had when it was created. A row that
  // already says what this phase wants is left exactly as it is.
  const structure = await getAllocationStructure(client, ALLOCATION_STRUCTURE);
  for (const cost of INTERNAL_ORDER.costs) {
    const standing = structure?.assignments.find(
      (assignment) => assignment.sourceAccount === cost.glAccount
        && assignment.receiverCategory === 'COST_CENTER',
    );
    if (standing && !standing.byOriginalAccount && standing.settlementAccount === SETTLEMENT_CLEARING) {
      continue;
    }
    await saveAllocationStructureAssignment({
      client,
      changedBy: DEMO_ACTOR,
      expectedVersion: standing?.version ?? 0,
      reason: 'Demo settlement configuration',
      structureCode: ALLOCATION_STRUCTURE,
      sourceAccount: cost.glAccount,
      receiverCategory: 'COST_CENTER',
      byOriginalAccount: false,
      settlementAccount: SETTLEMENT_CLEARING,
    });
  }

  await saveSettlementProfile({
    client,
    changedBy: DEMO_ACTOR,
    mode: 'CREATE',
    expectedVersion: 0,
    reason: 'Demo settlement configuration',
    profileCode: SETTLEMENT_PROFILE,
    description: 'Month-end settlement',
    allocationStructure: ALLOCATION_STRUCTURE,
    documentType: JOURNAL_TYPE,
    percentageAllowed: true,
    equivalenceAllowed: true,
    amountAllowed: true,
    isActive: true,
  }).catch((error: unknown) => { if (!isAlready(error)) throw error; });

  await assignOrderTypeSettlementProfile({
    client,
    changedBy: DEMO_ACTOR,
    mode: 'CREATE',
    expectedVersion: 0,
    reason: 'Demo settlement configuration',
    orderType: ORDER_TYPE,
    profileCode: SETTLEMENT_PROFILE,
  }).catch((error: unknown) => { if (!isAlready(error)) throw error; });
}

/**
 * The costs the order collects.
 *
 * The agency's fee is invoiced by a supplier, so it is posted against the trade
 * payable and left open — one more item for the payables ageing, and the reason
 * the supplier payments run before this step. The travel is paid from the bank.
 * Neither line carries a cost centre: an internal order is a cost object in its
 * own right, and the settlement is what moves the cost to one.
 */
async function ensureOrderCosts(client: string, timeline: DemoTimeline): Promise<number> {
  const orderNumber = await findByRequestKey(
    client, 'internal_order', `DEMO-FIN-${INTERNAL_ORDER.key}-ORDER`, 'order_number',
  );
  if (!orderNumber) return 0;

  for (const cost of INTERNAL_ORDER.costs) {
    const requestKey = `DEMO-FIN-${INTERNAL_ORDER.key}-${cost.key}`;
    if (await findByRequestKey(client, 'journal_posting_request', requestKey, 'document_number')) continue;

    const postingDate = dateIn(timeline, cost.period, cost.day);
    const credit = cost.vendor
      ? { glAccount: '200000', businessPartner: cost.vendor }
      : { glAccount: BANK_ACCOUNT, businessPartner: '' };

    await withActingUser(client, ACCOUNTANT, (actor) => postGlDocument({
      client,
      changedBy: ACCOUNTANT,
      requestKey,
      companyCode: COMPANY_CODE,
      documentDate: postingDate,
      postingDate,
      documentType: JOURNAL_TYPE,
      currency: CURRENCY,
      headerText: cost.text,
      lines: [
        {
          glAccount: cost.glAccount,
          debitCredit: 'S' as const,
          amount: cost.amount,
          internalOrder: orderNumber,
          lineText: cost.text,
        },
        {
          glAccount: credit.glAccount,
          debitCredit: 'H' as const,
          amount: cost.amount,
          ...(credit.businessPartner ? { businessPartner: credit.businessPartner } : {}),
        },
      ],
    }, { authorization: actor }));
  }
  return countStanding(client, 'journal_posting_request', 'DEMO-FIN-IO-%');
}

/**
 * The settlement: what the order collected, moved onto the sales cost centre.
 *
 * The rule the order carries sends the whole balance in full, so a second run in
 * the same period finds nothing left to settle and posts nothing.
 */
async function ensureSettlement(client: string, timeline: DemoTimeline): Promise<boolean> {
  const orderNumber = await findByRequestKey(
    client, 'internal_order', `DEMO-FIN-${INTERNAL_ORDER.key}-ORDER`, 'order_number',
  );
  if (!orderNumber) return false;

  const requestKey = `DEMO-FIN-${INTERNAL_ORDER.key}-SETTLE`;
  const fiscalYear = Number(dateIn(timeline, CLOSING_PERIOD, 1).slice(0, 4));
  const settlementPeriod = Number(timeline.openPeriods[CLOSING_PERIOD]!.slice(4));

  await ensureOrderSettlementRule(client, orderNumber, fiscalYear);

  await withActingUser(client, CONTROLLER, (actor) => settleOrder({
    client,
    changedBy: CONTROLLER,
    orderNumber,
    controllingArea: CONTROLLING_AREA,
    fiscalYear,
    settlementPeriod,
    testRun: false,
    requestKey,
  }, { authorization: actor }));

  // Read back rather than remembered: a run that finds the document it already
  // posted is handed that document back and posts no second one, so what counts
  // is whether the settlement stands, not what this run happened to write.
  return (await countStanding(client, 'settlement_document', 'DEMO-FIN-%')) > 0;
}

/** The order's own distribution rule, written once and left standing. */
async function ensureOrderSettlementRule(
  client: string,
  orderNumber: string,
  fiscalYear: number,
): Promise<void> {
  const standing = await getSettlementConfiguration(client, orderNumber);
  if (standing && standing.rules.length > 0) return;

  await saveOrderSettlementConfiguration({
    client,
    changedBy: DEMO_ACTOR,
    orderNumber,
    receiverCategory: 'COST_CENTER',
    receiver: INTERNAL_ORDER.settleTo,
    percentage: '100',
    settlementType: 'FUL',
    validFromYear: fiscalYear,
    validFromPeriod: 1,
    validToYear: fiscalYear,
    validToPeriod: 12,
  }).catch((error: unknown) => { if (!isAlready(error)) throw error; });
}

// ─────────────────────────────────────────────────────────────────────────────
// The balance sheet at the close
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The goods received and not invoiced, reclassified at the close.
 *
 * A goods receipt that has no invoice against it is a liability the ledger has not
 * admitted to yet, so the balance is moved off the GR/IR clearing account and onto
 * an accrual. The reversal is deliberately not named: the reclassification is
 * undone by the next period's run, not by a document dated into the future.
 */
async function ensureGrIrReclass(client: string, timeline: DemoTimeline): Promise<boolean> {
  const requestKey = `DEMO-FIN-GRIR`;
  const standing = await findByRequestKey(client, 'grir_reclass_run', requestKey, 'run_id');
  if (standing) return true;

  const keyDate = dateIn(timeline, CLOSING_PERIOD + 1, 11);
  const result = await withActingUser(client, ACCOUNTANT, (actor) => executeGrIrAnalysis({
    client,
    changedBy: ACCOUNTANT,
    selection: {
      companyCode: COMPANY_CODE,
      keyDate,
      postingDate: keyDate,
      testRun: false,
      createAccruals: true,
      accrualDocumentType: JOURNAL_TYPE,
      accrualAccount: ACCRUED_LIABILITIES,
      requestKey,
    },
  }, { authorization: actor }));

  return result.accrualDocument !== null;
}

/**
 * The value-added tax returns, one for each month that has ended.
 *
 * The return for a month is filed in the month that follows, which is both when a
 * return is due and the only reason the clearing document for September can be
 * dated in October. The clearing account is chosen from what the return finds: an
 * amount the company owes is a payable, and an amount the authority owes back is a
 * receivable, which is what a company that buys more than it sells is left with.
 * November is left unreported, because November has not ended.
 */
async function ensureTaxReturns(client: string, timeline: DemoTimeline): Promise<number> {
  let filed = 0;
  for (const cycle of CLOSE_CYCLES) {
    const requestKey = `DEMO-FIN-${cycle.key}-TAX`;
    const from = monthStart(timeline, cycle.period);
    const to = monthEnd(timeline, cycle.period);
    if (await taxReturnStands(client, from, to)) {
      filed += 1;
      continue;
    }

    const preview = await withActingUser(client, ACCOUNTANT, (actor) => executeTaxReport({
      client,
      changedBy: ACCOUNTANT,
      selection: {
        companyCode: COMPANY_CODE,
        postingDateFrom: from,
        postingDateTo: to,
        taxReturnCountry: COUNTRY,
        testRun: true,
        doNotUpdateDocuments: true,
        electronicReturn: false,
        correctedReturn: false,
      },
    }, { authorization: actor }));
    if (preview.lines.length === 0) continue;

    const clearingAccount = preview.netTax > 0 ? '201000' : '110200';
    await withActingUser(client, ACCOUNTANT, (actor) => executeTaxReport({
      client,
      changedBy: ACCOUNTANT,
      selection: {
        companyCode: COMPANY_CODE,
        postingDateFrom: from,
        postingDateTo: to,
        taxReturnCountry: COUNTRY,
        testRun: false,
        doNotUpdateDocuments: false,
        electronicReturn: false,
        correctedReturn: false,
        clearingAccount,
      },
    }, { authorization: actor }));
    filed += 1;
  }
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select count(*)::text as n from tax_return_run
       where client = ${client} and is_test_run = false
    `) as unknown as Array<{ n: string }>;
    return Number(rows[0]?.n ?? 0);
  });
}

/** Whether a productive return already stands for this company and window. */
async function taxReturnStands(client: string, from: string, to: string): Promise<boolean> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select count(*)::text as n from tax_return_run
       where client = ${client} and company_code = ${COMPANY_CODE}
         and posting_date_from = ${from} and posting_date_to = ${to}
         and is_test_run = false
    `) as unknown as Array<{ n: string }>;
    return Number(rows[0]?.n ?? 0) > 0;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The dunning run
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The dunning run over what the customers still owe.
 *
 * A run is proposed, then finalized, and only a finalized run writes a notice and
 * advances a level: a proposal is a list a person reads, and a notice is a record
 * the company sends. The customers are given a dunning procedure first, because an
 * account without one is excluded with its reason rather than dunned by default —
 * which is right, and which would make this run say nothing at all.
 *
 * The dunning date is the close date, and every document posted up to it counts.
 * What is left standing afterwards is the receivables ageing, with the items this
 * run chased marked at the level they earned.
 */
async function ensureDunningRun(client: string, timeline: DemoTimeline): Promise<number> {
  await ensureDunningProcedures(client);

  const runDate = dateIn(timeline, CLOSING_PERIOD + 1, 10);
  const runId = 'NOV01';
  const standing = (await listDunningRuns(client))
    .find((run) => run.runDate === runDate && run.runId === runId);
  if (standing) return standing.notices.length;

  await withActingUser(client, ACCOUNTANT, (actor) => proposeDunningRun({
    client,
    changedBy: ACCOUNTANT,
    runDate,
    runId,
    dunningDate: runDate,
    postedThrough: runDate,
    companyCodes: [COMPANY_CODE],
  }, { authorization: actor }));

  const finalized = await withActingUser(client, ACCOUNTANT, (actor) => finalizeDunningRun({
    client,
    changedBy: ACCOUNTANT,
    runDate,
    runId,
    confirmed: true,
  }, { authorization: actor }));

  return finalized.notices.length;
}

/**
 * The dunning procedure the customers are given.
 *
 * It is a field on the customer's company extension, and the run reads it there.
 * This phase sets it rather than the masters phase having done so, because the
 * dunning run is the first thing in the dataset that asks for it and a company
 * that was provisioned before dunning existed still has to be able to dun.
 */
async function ensureDunningProcedures(client: string): Promise<void> {
  for (const customer of CUSTOMERS) {
    const extension = await getCustomerCompany(client, customer, COMPANY_CODE);
    if (!extension || extension.dunningProcedure) continue;
    await saveCustomerCompany({
      client,
      partnerNumber: customer,
      companyCode: COMPANY_CODE,
      expectedVersion: extension.version,
      changedBy: DEMO_ACTOR,
      reason: 'Demo dunning procedure',
      reconciliationAccount: extension.reconciliationAccount ?? '',
      paymentTermsCode: extension.paymentTermsCode ?? '',
      paymentMethods: extension.paymentMethods ?? '',
      dunningProcedure: DUNNING_PROCEDURE,
      isBlocked: extension.isBlocked,
    });
  }
}
