/**
 * The demo company's sales and receivables — provisioning phase `D3_SALES`.
 *
 * D1 bought the raw materials; D2 turned them into biscuits and left them on the
 * shelf. This phase is what the shelf was for: the goods are sold, shipped,
 * billed and — mostly — paid for.
 *
 * Four things shape it, and each is a constraint rather than a preference.
 *
 * **A document is written by the person whose job it is.** The sales clerk
 * raises the order and the billing document; the warehouse clerk at the plant
 * the goods stand in confirms the pick and posts the goods issue; the accountant
 * banks the money. Each acts inside the reach they were granted, which is the
 * point of granting it: the factory's clerk cannot ship from the distribution
 * centre, and neither of them can raise an order.
 *
 * **The last two open periods are the only ones still accepting a movement.**
 * D1 walked the first open period to its end and closed it behind itself. Sales
 * therefore runs through the second and third, the same two production ran
 * through, and every date here is a day inside one of them — there is not a
 * calendar literal in the plan.
 *
 * **A chain stops where a real chain stops.** The demo's invariant is not "no
 * open items"; it is "the open items are the ones the ageing schedule says are
 * open". So the first period's orders are taken all the way to a cleared
 * receivable, and the second period's are deliberately left standing where a
 * business leaves them: one billed and unpaid, one shipped and not yet billed,
 * one ordered and not yet shipped. Three open ends that a person can walk into
 * and finish, which is the whole use of a demo dataset.
 *
 * **Goods cannot be sold out of a shelf that is empty.** An order line names
 * the plant the goods will come from, and the plan names the plant that holds
 * them: the distribution centre for what was bought in and for what was made
 * earliest, the factory for the wafers, which have never been moved to the
 * centre at all.
 */

import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { saveAccountDetermination } from '../../modules/foundation/account-determination';
import { getReceivables, postIncomingPayment } from '../../modules/finance/incoming-payment';
import { postBillingDocument } from '../../modules/sales/billing';
import {
  confirmDeliveryPicks, createDelivery, getDelivery, listDeliverableOrderLines,
  postDeliveryGoodsIssue,
} from '../../modules/sales/delivery';
import { createSalesOrder } from '../../modules/sales/sales-order';
import { DEMO_ACTOR, DEMO_STRUCTURE } from './demo-organisation';
import { withActingUser } from './demo-people';
import type { DemoTimeline } from './demo-provisioning';

/** Who does what, and why it is them. */
const SALES_CLERK = 'demo.sales';
/** The clerk at the factory: ships what the factory holds (the wafers). */
const WAREHOUSE_CLERK_FACTORY = 'demo.warehouse1';
/** The clerk at the distribution centre: ships what the centre holds. */
const WAREHOUSE_CLERK_CENTRE = 'demo.warehouse2';
/** The accountant: banks the money, and nothing else here. */
const ACCOUNTANT = 'demo.accountant';

const SALES_ORG = DEMO_STRUCTURE.salesOrg;
const DISTRIBUTION_CHANNEL = DEMO_STRUCTURE.distributionChannel;
const DIVISION = DEMO_STRUCTURE.division;
const COMPANY_CODE = DEMO_STRUCTURE.companyCode;
const CURRENCY = 'KWD';
const TAX_CODE = 'S5';
/** Where every plant keeps its unrestricted stock in this dataset. */
const STORAGE_LOCATION = '0001';
/** The bank account the money is paid into. */
const BANK_ACCOUNT = '101000';

/**
 * The account determination sales needs.
 *
 * Revenue is what the customer was charged; the cost of goods sold is what the
 * goods cost the company, read on the material's own valuation class at the
 * moment the goods issue leaves the plant. Both are named here rather than
 * inherited from somewhere else, because a chart that has no revenue account
 * configured is a company that cannot invoice.
 */
const SALES_DETERMINATION = [
  { event: 'SALES_REVENUE', valuationClass: '', glAccount: '300000' },
  { event: 'SALES_ISSUE', valuationClass: 'FINISHED_INVENTORY', glAccount: '400000' },
  { event: 'SALES_ISSUE', valuationClass: 'TRADE_INVENTORY', glAccount: '400000' },
] as const;

interface SalesLine {
  material: string;
  quantity: number;
  unit: string;
}

interface SalesPlan {
  /** Identifies the chain in every request key, so a resumed run finds its own work. */
  key: string;
  /** Index into the frozen open periods: 1 is the second, 2 the third. */
  period: number;
  customer: string;
  /** The plant the goods come from. Every line of an order ships from one plant. */
  plant: string;
  lines: SalesLine[];
  orderDay: number;
  deliveryDay: number;
  pickDay: number;
  issueDay: number;
  billingDay: number;
  /** How the receivable is left standing. Omitted means the order is not billed at all. */
  payment?: {
    day: number;
    /** The fraction of the open balance the customer settles. */
    settle: number;
  };
  /** Left unshipped on purpose: an order the backlog reports. */
  stopAfter?: 'ORDER' | 'DELIVERY' | 'GOODS_ISSUE';
}

/**
 * What is sold, and where each chain stops.
 *
 * The first period is the complete story: three customers, three orders, three
 * payments, nothing left open. The second period is the one a person walks
 * into: it ends with a billed unpaid invoice, a shipped delivery waiting on the
 * billing due list, and an order that has not been picked up yet.
 *
 * Nothing here is dated with a literal, and nothing is sized against the total
 * stock: the plan sells what the plants were left holding, which is a few
 * hundred units against shelves holding thousands.
 */
const SALES_PLAN: readonly SalesPlan[] = [
  // ── The second open period: three complete chains. ────────────────────────
  {
    key: 'SLS-11', period: 1, customer: 'CUS-1000', plant: DEMO_STRUCTURE.distributionPlant,
    lines: [{ material: 'FG-CREAM', quantity: 400, unit: 'PC' }],
    orderDay: 12, deliveryDay: 14, pickDay: 14, issueDay: 14, billingDay: 15,
    payment: { day: 22, settle: 1 },
  },
  {
    key: 'SLS-12', period: 1, customer: 'CUS-2000', plant: DEMO_STRUCTURE.distributionPlant,
    lines: [
      { material: 'FG-CHOC', quantity: 300, unit: 'PC' },
      { material: 'TRAD-JUICE', quantity: 50, unit: 'BOX' },
    ],
    orderDay: 12, deliveryDay: 14, pickDay: 14, issueDay: 14, billingDay: 15,
    payment: { day: 22, settle: 1 },
  },
  {
    // The wafers have never left the factory, so this order ships from the plant
    // that made them — and it is the factory's clerk who confirms the pick.
    key: 'SLS-13', period: 1, customer: 'CUS-3000', plant: DEMO_STRUCTURE.manufacturingPlant,
    lines: [{ material: 'FG-WAFER', quantity: 600, unit: 'PC' }],
    orderDay: 13, deliveryDay: 15, pickDay: 15, issueDay: 15, billingDay: 16,
    payment: { day: 24, settle: 1 },
  },

  // ── The third open period: what a person is left to finish. ───────────────
  {
    key: 'SLS-21', period: 2, customer: 'CUS-1000', plant: DEMO_STRUCTURE.distributionPlant,
    lines: [
      { material: 'FG-CREAM', quantity: 600, unit: 'PC' },
      { material: 'FG-CHOC', quantity: 500, unit: 'PC' },
    ],
    orderDay: 6, deliveryDay: 8, pickDay: 8, issueDay: 8, billingDay: 9,
    // Billed and unpaid: this is the invoice the ageing report shows as current.
  },
  {
    key: 'SLS-22', period: 2, customer: 'CUS-2000', plant: DEMO_STRUCTURE.manufacturingPlant,
    lines: [{ material: 'FG-WAFER', quantity: 900, unit: 'PC' }],
    orderDay: 7, deliveryDay: 9, pickDay: 9, issueDay: 9, billingDay: 10,
    stopAfter: 'GOODS_ISSUE', // shipped, and still sitting on the billing due list
  },
  {
    key: 'SLS-23', period: 2, customer: 'CUS-3000', plant: DEMO_STRUCTURE.distributionPlant,
    lines: [{ material: 'TRAD-JUICE', quantity: 120, unit: 'BOX' }],
    orderDay: 10, deliveryDay: 12, pickDay: 12, issueDay: 12, billingDay: 13,
    stopAfter: 'ORDER', // raised and not yet delivered: the backlog
  },
];

export interface DemoSalesResult {
  client: string;
  determinationRows: number;
  orders: number;
  deliveries: number;
  picks: number;
  goodsIssues: number;
  billingDocuments: number;
  payments: number;
  /** Every document this phase wrote. */
  documents: number;
}

export interface BuildDemoSalesInput {
  client: string;
  timeline: DemoTimeline;
}

/**
 * Build the sales and receivables history.
 *
 * Every step is request-keyed and every step is guarded by what already stands,
 * so a resumed run is handed back the document it posted rather than a second
 * copy of it. The guards are reads against the tenant, not counters on the
 * result: a run that died between the pick and the goods issue has to find the
 * pick it already wrote.
 */
export async function buildDemoSales(input: BuildDemoSalesInput): Promise<DemoSalesResult> {
  const client = input.client;

  const determinationRows = await ensurePostingConfiguration(client);

  let orders = 0;
  let deliveries = 0;
  let picks = 0;
  let goodsIssues = 0;
  let billingDocuments = 0;
  let payments = 0;

  for (const plan of SALES_PLAN) {
    const order = await ensureOrder(client, plan, input.timeline);
    if (order) orders += 1;
    if (plan.stopAfter === 'ORDER') continue;
    if (!order) continue;

    const delivery = await ensureDelivery(client, plan, input.timeline, order);
    if (delivery) deliveries += 1;
    if (plan.stopAfter === 'DELIVERY') continue;
    if (!delivery) continue;

    if (await ensurePicks(client, plan, input.timeline, delivery)) picks += 1;

    const issued = await ensureGoodsIssue(client, plan, input.timeline, delivery);
    if (issued) goodsIssues += 1;
    if (plan.stopAfter === 'GOODS_ISSUE') continue;
    if (!issued) continue;

    if (await ensureBilling(client, plan, input.timeline, delivery)) billingDocuments += 1;
    if (!plan.payment) continue;

    if (await ensurePayment(client, plan, input.timeline)) payments += 1;
  }

  // Reported as what stands when the phase is done, not as what this run wrote:
  // on a resumed run most of the chain is already there, and a phase that reports
  // fewer documents than the tenant holds is a phase that lost its own history.
  const standing = {
    orders: await countStanding(client, 'sales_order', 'DEMO-SLS-%'),
    deliveries: await countStanding(client, 'delivery', 'DEMO-SLS-%'),
    picks: await countDelivered(client, "status in ('PICKED', 'GOODS_ISSUED')"),
    goodsIssues: await countDelivered(client, "status = 'GOODS_ISSUED'"),
    billingDocuments: await countStanding(client, 'billing_document', 'DEMO-SLS-%'),
    payments: await countStanding(client, 'incoming_payment', 'DEMO-SLS-%'),
  };

  return {
    client,
    determinationRows,
    ...standing,
    // What a person counts when they walk the demo: the orders, the deliveries
    // that left the plant, the invoices and the money in. The picks are the
    // deliveries' own work and are not counted twice.
    documents: standing.orders + standing.goodsIssues + standing.billingDocuments + standing.payments,
  };
}

/** A calendar date inside one of the frozen open periods. */
function dateIn(timeline: DemoTimeline, period: number, day: number): string {
  const key = timeline.openPeriods[period];
  if (!key) throw new Error(`The demo timeline has no period at index ${period}.`);
  return `${key.slice(0, 4)}-${key.slice(4)}-${String(day).padStart(2, '0')}`;
}

/** Only a duplicate is forgiven; anything else stops the run. */
function isAlready(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already stands|already exists|already been|already posted|is already/i.test(message);
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

/** How many of this phase's deliveries have reached a given point in the chain. */
async function countDelivered(client: string, where: string): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(
      sql.raw(`select count(*)::text as n from delivery where client = '${client}' and request_key like 'DEMO-SLS-%' and ${where}`),
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
// The chain, one guarded step at a time
// ─────────────────────────────────────────────────────────────────────────────

/** The order. Raised by the sales clerk, in the reach they were granted. */
async function ensureOrder(
  client: string,
  plan: SalesPlan,
  timeline: DemoTimeline,
): Promise<string | null> {
  const requestKey = `DEMO-SLS-${plan.key}-ORDER`;
  const standing = await findByRequestKey(client, 'sales_order', requestKey, 'order_number');
  if (standing) return standing;

  const orderDate = dateIn(timeline, plan.period, plan.orderDay);
  const created = await withActingUser(client, SALES_CLERK, (actor) => (
    createSalesOrder({
      client,
      changedBy: SALES_CLERK,
      salesOrg: SALES_ORG,
      distributionChannel: DISTRIBUTION_CHANNEL,
      division: DIVISION,
      customerNumber: plan.customer,
      companyCode: COMPANY_CODE,
      creditControlArea: DEMO_STRUCTURE.creditControlArea,
      currency: CURRENCY,
      orderDate,
      requestedDate: dateIn(timeline, plan.period, plan.deliveryDay),
      headerText: `Demo ${plan.key}`,
      requestKey,
      lines: plan.lines.map((line) => ({
        materialNumber: line.material,
        plant: plan.plant,
        orderQuantity: line.quantity,
        quantityUnit: line.unit,
        taxCode: TAX_CODE,
        requestedDeliveryDate: dateIn(timeline, plan.period, plan.deliveryDay),
      })),
    }, { authorization: actor })
  ));
  return created.orderNumber;
}

/** The delivery. Raised by the sales clerk from the order's open items. */
async function ensureDelivery(
  client: string,
  plan: SalesPlan,
  timeline: DemoTimeline,
  orderNumber: string,
): Promise<string | null> {
  const requestKey = `DEMO-SLS-${plan.key}-DELIVERY`;
  const standing = await findByRequestKey(client, 'delivery', requestKey, 'delivery_number');
  if (standing) return standing;

  const open = await listDeliverableOrderLines(client, { orderNumber });
  const items = open.map((line) => ({
    orderLineNumber: line.lineNumber,
    quantity: line.remainingQuantity,
  }));
  if (items.length === 0) return null;

  const created = await withActingUser(client, SALES_CLERK, (actor) => (
    createDelivery({
      client,
      changedBy: SALES_CLERK,
      orderNumber,
      deliveryDate: dateIn(timeline, plan.period, plan.deliveryDay),
      goodsMovementDate: dateIn(timeline, plan.period, plan.issueDay),
      headerText: `Demo ${plan.key}`,
      items,
      requestKey,
    }, { authorization: actor })
  ));
  return created.deliveryNumber;
}

/**
 * The pick. Confirmed by the warehouse clerk at the plant the goods stand in:
 * the factory's clerk for a factory delivery, the centre's for a centre one.
 */
async function ensurePicks(
  client: string,
  plan: SalesPlan,
  timeline: DemoTimeline,
  deliveryNumber: string,
): Promise<boolean> {
  const requestKey = `DEMO-SLS-${plan.key}-PICK`;
  const header = await getDelivery(client, deliveryNumber);
  if (!header) return false;
  // A delivery that has already been picked — by this run or by the one that died
  // before it finished — is work that stands. Only a delivery still asking for its
  // goods is picked again.
  if (header.status === 'PICKED' || header.status === 'GOODS_ISSUED') return true;
  if (header.status !== 'OPEN' && header.status !== 'PARTIALLY_PICKED') return false;

  const clerk = plan.plant === DEMO_STRUCTURE.manufacturingPlant
    ? WAREHOUSE_CLERK_FACTORY
    : WAREHOUSE_CLERK_CENTRE;

  const remaining = header.lines
    .map((line) => ({
      lineNumber: line.lineNumber,
      quantity: String(
        Math.max(0, Number(line.deliveryQuantity) - Number(line.pickedQuantity)),
      ),
    }))
    .filter((line) => Number(line.quantity) > 0);
  if (remaining.length === 0) return false;

  await withActingUser(client, clerk, () => (
    confirmDeliveryPicks({
      client,
      changedBy: clerk,
      deliveryNumber,
      expectedVersion: header.version,
      requestKey,
      items: remaining.map((line) => ({
        ...line,
        storageLocation: STORAGE_LOCATION,
      })),
    })
  ));
  return true;
}

/** The goods issue. Posted by the same clerk who picked, in the plant they stand in. */
async function ensureGoodsIssue(
  client: string,
  plan: SalesPlan,
  timeline: DemoTimeline,
  deliveryNumber: string,
): Promise<boolean> {
  const header = await getDelivery(client, deliveryNumber);
  if (!header) return false;
  // The movement is the delivery's own to key — a goods issue is keyed by the
  // delivery and the version it was posted against, so a second submission of the
  // same issue is answered by the document the first one wrote. What this step has
  // to know is whether the goods have gone, and the delivery is the one that knows.
  if (header.status === 'GOODS_ISSUED') return true;
  if (header.status !== 'PICKED') return false;

  const clerk = plan.plant === DEMO_STRUCTURE.manufacturingPlant
    ? WAREHOUSE_CLERK_FACTORY
    : WAREHOUSE_CLERK_CENTRE;

  await withActingUser(client, clerk, (actor) => (
    postDeliveryGoodsIssue({
      client,
      changedBy: clerk,
      deliveryNumber,
      expectedVersion: header.version,
      postingDate: dateIn(timeline, plan.period, plan.issueDay),
      documentDate: dateIn(timeline, plan.period, plan.issueDay),
    }, { authorization: actor })
  ));
  return true;
}

/** The billing document. Raised by the sales clerk against the issued delivery. */
async function ensureBilling(
  client: string,
  plan: SalesPlan,
  timeline: DemoTimeline,
  deliveryNumber: string,
): Promise<boolean> {
  const requestKey = `DEMO-SLS-${plan.key}-BILL`;
  const standing = await findByRequestKey(client, 'billing_document', requestKey, 'billing_number');
  if (standing) return true;

  const billingDate = dateIn(timeline, plan.period, plan.billingDay);
  const created = await withActingUser(client, SALES_CLERK, (actor) => (
    postBillingDocument({
      client,
      changedBy: SALES_CLERK,
      deliveryNumber,
      billingDate,
      postingDate: billingDate,
      requestKey,
    }, { authorization: actor })
  ));
  return Boolean(created.billing?.billingNumber);
}

/**
 * The payment. Banked by the accountant, against the customer's open items, for
 * the share of them the plan says were settled.
 *
 * A payment is a company's and not a plant's, so the accountant's reach is the
 * company code alone — which is exactly the reach they were granted.
 */
async function ensurePayment(
  client: string,
  plan: SalesPlan,
  timeline: DemoTimeline,
): Promise<boolean> {
  if (!plan.payment) return false;
  const requestKey = `DEMO-SLS-${plan.key}-PAY`;
  if (await findByRequestKey(client, 'incoming_payment', requestKey, 'payment_number')) return true;

  // What the customer owes for the goods this phase sold them, and nothing else.
  //
  // The opening balances brought these customers' receivables forward, so every
  // one of them is already carrying an open item this plan never raised. Paying
  // that too would be tidy and useless: the ageing report would have nothing old
  // on it, and a receivables ledger with no age is not the ledger a company has.
  // The payment settles the invoice this chain billed and leaves what the company
  // started with standing, which is what a customer actually does.
  const raised = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select i.journal_document_number as document, i.fiscal_year as year
        from customer_invoice i
        join billing_document b
          on b.client = i.client and b.customer_invoice_number = i.invoice_number
       where i.client = ${client} and i.customer_number = ${plan.customer}
         and b.request_key = ${`DEMO-SLS-${plan.key}-BILL`}
    `) as unknown as Array<{ document: string; year: number }>;
    return rows;
  });
  if (raised.length === 0) return false;

  const view = await getReceivables(client, plan.customer, COMPANY_CODE);
  const open = view.openItems.filter((item) => Number(item.signed) > 0
    && raised.some((row) => row.document === item.documentNumber && Number(row.year) === Number(item.fiscalYear)));
  if (open.length === 0) return false;

  const clearingDate = dateIn(timeline, plan.period, plan.payment.day);
  const amount = plan.payment.settle >= 1
    ? open.reduce((sum, item) => sum + Number(item.signed), 0)
    : open[0].signed;

  await withActingUser(client, ACCOUNTANT, (actor) => (
    postIncomingPayment({
      client,
      changedBy: ACCOUNTANT,
      customerNumber: plan.customer,
      companyCode: COMPANY_CODE,
      documentDate: clearingDate,
      postingDate: clearingDate,
      clearingDate,
      bankGlAccount: BANK_ACCOUNT,
      amount,
      currency: CURRENCY,
      reference: `Demo ${plan.key}`,
      requestKey,
      items: (plan.payment!.settle >= 1 ? open : open.slice(0, 1)).map((item) => ({
        documentNumber: item.documentNumber,
        fiscalYear: item.fiscalYear,
        lineNumber: item.lineNumber,
      })),
      authorization: actor,
    })
  ));
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration the demo has to define for itself
// ─────────────────────────────────────────────────────────────────────────────

async function ensurePostingConfiguration(client: string): Promise<number> {
  for (const row of SALES_DETERMINATION) {
    try {
      await saveAccountDetermination({
        client,
        changedBy: DEMO_ACTOR,
        mode: 'CREATE',
        chartOfAccounts: DEMO_STRUCTURE.chartOfAccounts,
        event: row.event,
        valuationClass: row.valuationClass,
        generalModifier: '',
        glAccount: row.glAccount,
        reason: 'Demo company posting configuration',
      });
    } catch (error) {
      if (!isAlready(error)) throw error;
    }
  }
  const standing = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select count(*)::text as n
        from account_determination
       where client = ${client} and event in ('SALES_REVENUE', 'SALES_ISSUE')
    `) as unknown as Array<{ n: string }>;
    return Number(rows[0]?.n ?? 0);
  });
  return standing;
}
