/**
 * The demo company's production — provisioning phase `D2_PRODUCTION`.
 *
 * D1 left the company holding flour, sugar, cocoa, cartons and wrappers, and
 * nothing that had ever been made. This phase turns the raw materials into
 * biscuits: production orders are raised and released, components are issued to
 * them, operations are confirmed, and the finished goods are received into
 * stock.
 *
 * Three things shape it, and each is a constraint rather than a preference.
 *
 * **A material period that has been advanced cannot be re-opened.** The control
 * says so in as many words, and it is right to: a company that could post into
 * any period at any time has no period control at all. D1 walked the three open
 * periods to their end, and by the time this phase runs only the last two still
 * accept a goods movement. Production therefore runs through October and
 * November, and September stays the month the company bought its materials.
 * Each later document phase gets the periods that are still open when it runs.
 *
 * **Production is not free.** The system posts no activity cost — a confirmation
 * records that an operation happened, not what the labour and the machine cost —
 * so the difference between the standard price of what an order produces and the
 * standard price of what it consumes is never charged to the order. It shows up
 * where the two postings meet: the consumption account. That difference is the
 * conversion cost baked into the standard prices, and it is visible, not hidden.
 *
 * **The shop floor is not one person.** The planner raises and releases the
 * order; the warehouse issues the components into it; the production clerk
 * confirms the work and receives what was made. Each acts within the reach they
 * were given, which is why the manufacturing plant's warehouse clerk signs in
 * for the issues and the production clerk for the receipts.
 */

import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { saveAccountDetermination } from '../../modules/foundation/account-determination';
import {
  createProductionOrder, getProductionOrder, releaseProductionOrder,
} from '../../modules/inventory/production-orders';
import { postProductionReceipt } from '../../modules/inventory/production-receipt';
import { postGoodsIssue } from '../../modules/inventory/goods-issue';
import { enterOrderConfirmation } from '../../modules/production/order-confirmation';
import { technicallyCompleteProductionOrder } from '../../modules/production/production-order-change';
import { saveOrderTypeParameter } from '../../modules/production/order-type-parameters';
import { saveProductionOrderType } from '../../modules/production/production-order-type';
import { DEMO_ACTOR, DEMO_STRUCTURE } from './demo-organisation';
import { materialUnit } from './demo-masters';
import type { DemoTimeline } from './demo-provisioning';
import { withActingUser } from './demo-people';

/** The plant every order runs at: the factory, not the distribution centre. */
const PLANT = DEMO_STRUCTURE.manufacturingPlant;

/** The production order type the demo defines for itself, SAP's PP01. */
const ORDER_TYPE = 'PP01';

/**
 * Every made material stands at production version 0001, written by Phase C.
 *
 * Four characters, zero-padded: the version code is a key, not a counter, and
 * asking for `1` would be asking for a version that does not stand.
 */
const PRODUCTION_VERSION = '0001';

/** The routing task list type Phase C defined. */
const TASK_LIST_TYPE = 'N';

/** Where produced stock lands. */
const RECEIVING_STORAGE_LOCATION = '0001';

/** The movement that issues a component into an order, and the one that scraps. */
const COMPONENT_ISSUE = '261';
const SCRAP_MOVEMENT = '551';

/**
 * Who does what, and why it is them.
 *
 * The production loop is deliberately not one person: the planner raises and
 * releases the order and closes it, the production clerk issues components into it
 * and receives what it made, and the warehouse clerk moves stock that belongs to no
 * order. Each of them holds the authority for their own part and no more, and each
 * is restricted to the plant they work at — so a service that judges authority
 * sees a real person with a real mandate, not a provisioning script.
 */
const PLANNER = 'demo.planner';
const PRODUCTION_CLERK = 'demo.production';
const WAREHOUSE_CLERK = 'demo.warehouse1';

/**
 * The account determination production needs.
 *
 * The consumption of a component and the receipt of what it made both read the
 * same account, which is the product's own convention: the two legs of
 * production meet on one line, and what is left there when the dust settles is
 * the production result. Scrapping is named for what it is.
 */
const PRODUCTION_DETERMINATION = [
  { event: 'PRODUCTION_CONSUMPTION', valuationClass: 'RAW_INVENTORY', glAccount: '410000' },
  { event: 'PRODUCTION_CONSUMPTION', valuationClass: 'SEMI_INVENTORY', glAccount: '410000' },
  { event: 'PRODUCTION_CONSUMPTION', valuationClass: 'FINISHED_INVENTORY', glAccount: '410000' },
  { event: 'PRODUCTION_OUTPUT', valuationClass: 'SEMI_INVENTORY', glAccount: '410000' },
  { event: 'PRODUCTION_OUTPUT', valuationClass: 'FINISHED_INVENTORY', glAccount: '410000' },
  { event: 'SCRAP', valuationClass: 'RAW_INVENTORY', glAccount: '410300' },
  { event: 'SCRAP', valuationClass: 'SEMI_INVENTORY', glAccount: '410300' },
  { event: 'SCRAP', valuationClass: 'FINISHED_INVENTORY', glAccount: '410300' },
] as const;

interface ProductionPlan {
  key: string;
  period: number;
  material: string;
  quantity: number;
  startDay: number;
  issueDay: number;
  confirmDay: number;
  receiptDay: number;
  /** Left standing at the end: work in progress the last period closes with. */
  openAtEnd?: boolean;
}

/**
 * What gets made, and when.
 *
 * Every date is a day inside one of the frozen open periods — there is not a
 * calendar literal in the plan, because a plan written in literal dates would be
 * wrong the moment the deployment happened in another month.
 *
 * The dough runs first each period and the biscuits after it, which is not
 * decoration: a biscuit order consumes dough, and an order that consumed dough
 * it had not made yet would be refused for want of stock.
 */
const PRODUCTION_PLAN: readonly ProductionPlan[] = [
  // October — dough first, then the cream and chocolate lines.
  { key: 'PRD-11', period: 1, material: 'SEMI-DOUGH', quantity: 2600, startDay: 2, issueDay: 3, confirmDay: 4, receiptDay: 4 },
  { key: 'PRD-12', period: 1, material: 'FG-CREAM', quantity: 9600, startDay: 6, issueDay: 7, confirmDay: 8, receiptDay: 8 },
  { key: 'PRD-13', period: 1, material: 'FG-CHOC', quantity: 4800, startDay: 6, issueDay: 7, confirmDay: 9, receiptDay: 9 },

  // November — two dough runs, because three biscuit orders follow them.
  { key: 'PRD-21', period: 2, material: 'SEMI-DOUGH', quantity: 3000, startDay: 2, issueDay: 3, confirmDay: 4, receiptDay: 4 },
  { key: 'PRD-22', period: 2, material: 'SEMI-DOUGH', quantity: 2000, startDay: 3, issueDay: 4, confirmDay: 5, receiptDay: 5 },
  { key: 'PRD-23', period: 2, material: 'FG-WAFER', quantity: 9600, startDay: 7, issueDay: 8, confirmDay: 9, receiptDay: 9 },
  { key: 'PRD-24', period: 2, material: 'FG-CREAM', quantity: 4800, startDay: 7, issueDay: 8, confirmDay: 10, receiptDay: 10 },
  { key: 'PRD-25', period: 2, material: 'FG-CHOC', quantity: 7200, startDay: 8, issueDay: 9, confirmDay: 11, receiptDay: 11 },
  // Deliberately left open: an order the period closes with work still on it.
  { key: 'PRD-26', period: 2, material: 'FG-WAFER', quantity: 4800, startDay: 8, issueDay: 9, confirmDay: 12, receiptDay: 12, openAtEnd: true },
];

interface ScrapPlan {
  key: string;
  period: number;
  day: number;
  material: string;
  quantity: number;
}

/**
 * What is thrown away.
 *
 * Flour spoiled in the store and a tray of wafers that did not make the grade.
 * A demo with no waste is a demo of a factory that does not exist, and a
 * scrapping is the one movement that names no beneficiary: it charges nothing
 * and credits stock.
 */
const SCRAP_PLAN: readonly ScrapPlan[] = [
  { key: 'SCR-01', period: 1, day: 10, material: 'RAW-FLOUR', quantity: 180 },
  { key: 'SCR-02', period: 2, day: 11, material: 'FG-WAFER', quantity: 150 },
];

// ─────────────────────────────────────────────────────────────────────────────

export interface DemoProductionResult {
  client: string;
  determinationRows: number;
  orderTypes: number;
  orders: number;
  releases: number;
  componentIssues: number;
  confirmations: number;
  receipts: number;
  completions: number;
  scrap: number;
  /** Every document this phase wrote. */
  documents: number;
}

export interface BuildDemoProductionInput {
  client: string;
  timeline: DemoTimeline;
}

/**
 * Build the production history.
 *
 * Orders are raised in the order the plan lists them, because the dough an
 * order consumes has to exist before the order that consumes it is issued.
 * Everything here is request-keyed, so a resumed run that already posted a step
 * is handed back what it posted rather than a second copy of it.
 */
export async function buildDemoProduction(
  input: BuildDemoProductionInput,
): Promise<DemoProductionResult> {
  const client = input.client;

  const determinationRows = await ensurePostingConfiguration(client);
  const orderTypes = await ensureOrderType(client);
  await ensureOrderTypeParameters(client);

  let releases = 0;
  let componentIssues = 0;
  let confirmations = 0;
  let receipts = 0;
  let completions = 0;

  for (const plan of PRODUCTION_PLAN) {
    const order = await ensureOrder(client, plan, input.timeline);

    if (await ensureRelease(client, order.orderNumber)) releases += 1;
    if (await issueComponents(client, plan, input.timeline, order.orderNumber)) {
      componentIssues += 1;
    }
    if (await confirmOrder(client, plan, input.timeline, order.orderNumber)) {
      confirmations += 1;
    }
    if (await receiveOutput(client, plan, input.timeline, order.orderNumber)) {
      receipts += 1;
    }
    if (!plan.openAtEnd && await completeOrder(client, order.orderNumber)) {
      completions += 1;
    }
  }

  let scrap = 0;
  for (const plan of SCRAP_PLAN) {
    if (await scrapMaterial(client, plan, input.timeline)) scrap += 1;
  }

  // Orders and completions are reported as what stands when the phase is done,
  // not as what this run wrote: on a resumed run every order is already there
  // and nothing is created, and a report that showed zero orders next to nine
  // posted receipts would read as a failure that did not happen.
  const orders = await countStandingOrders(client);
  const closed = await countCompletedOrders(client);

  return {
    client,
    determinationRows,
    orderTypes,
    orders,
    releases,
    componentIssues,
    confirmations,
    receipts,
    completions: closed > 0 ? closed : completions,
    scrap,
    documents: componentIssues + confirmations + receipts + scrap,
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

async function countStandingOrders(client: string): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select count(*)::text as n
        from production_order
       where client = ${client} and request_key like 'DEMO-PO-%'
    `) as unknown as Array<{ n: string }>;
    return Number(rows[0]?.n ?? 0);
  });
}

async function countCompletedOrders(client: string): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select count(*)::text as n
        from production_order
       where client = ${client}
         and request_key like 'DEMO-PO-%'
         and status = 'TECHNICALLY_COMPLETED'
    `) as unknown as Array<{ n: string }>;
    return Number(rows[0]?.n ?? 0);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration the demo has to define for itself
// ─────────────────────────────────────────────────────────────────────────────

async function ensurePostingConfiguration(client: string): Promise<number> {
  let created = 0;
  for (const row of PRODUCTION_DETERMINATION) {
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
      created += 1;
    } catch (error) {
      if (!isAlready(error)) throw error;
    }
  }
  // What stands, not what was written: on a resumed run every row is already
  // there, and a report that said zero while eight rows stood would read as a
  // failure that did not happen.
  const standing = await countDetermination(client);
  return standing ?? created;
}

async function countDetermination(client: string): Promise<number | null> {
  try {
    return await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::text as n
          from account_determination
         where client = ${client}
           and event in ('PRODUCTION_CONSUMPTION', 'PRODUCTION_OUTPUT', 'SCRAP')
      `) as unknown as Array<{ n: string }>;
      return Number(rows[0]?.n ?? 0);
    });
  } catch {
    return null;
  }
}

/**
 * The production order type.
 *
 * Empty in a new tenant and created by no seed, and `createProductionOrder`
 * asks for one by name: "a blank value is not a type."
 */
async function ensureOrderType(client: string): Promise<number> {
  const standing = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select order_type from production_order_type
       where client = ${client} and order_type = ${ORDER_TYPE}
       limit 1
    `) as unknown as Array<{ order_type: string }>;
    return rows[0]?.order_type ?? null;
  });
  if (standing) return 1;

  await saveProductionOrderType({
    client,
    changedBy: DEMO_ACTOR,
    mode: 'CREATE',
    orderType: ORDER_TYPE,
    description: 'Standard production order',
    version: 0,
    reason: 'Demo company production configuration',
  });
  return 1;
}

/**
 * The order type parameters — the plant's half of the order type.
 *
 * The type alone is not enough: an order is created against a plant and a type,
 * and the parameters say how that pair behaves. Empty in a new tenant and
 * created by no seed, so without them the order is refused before it exists.
 *
 * Production version selection is manual, because this phase names the version
 * it wants rather than asking the system to guess one.
 */
async function ensureOrderTypeParameters(client: string): Promise<void> {
  // Asked, not guessed. A resumed run reaches this point with both records
  // already standing, and `saveOrderTypeParameter` refuses a second create —
  // so the run has to know before it asks, not discover it from the refusal.
  const standing = await withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select order_type from production_order_type_parameter
       where client = ${client} and plant = ${PLANT} and order_type = ${ORDER_TYPE}
       limit 1
    `) as unknown as Array<{ order_type: string }>;
    return rows[0]?.order_type ?? null;
  });
  if (standing) return;

  await saveOrderTypeParameter({
    client,
    changedBy: DEMO_ACTOR,
    mode: 'CREATE',
    plant: PLANT,
    orderType: ORDER_TYPE,
    taskListType: TASK_LIST_TYPE,
    productionVersionSelection: '1',
    version: 0,
    reason: 'Demo company production configuration',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The order's life
// ─────────────────────────────────────────────────────────────────────────────

async function ensureOrder(
  client: string,
  plan: ProductionPlan,
  timeline: DemoTimeline,
): Promise<{ orderNumber: string; created: boolean }> {
  const standing = await findStandingOrder(client, `DEMO-PO-${plan.key}`);
  if (standing) return { orderNumber: standing, created: false };

  // The planner raises the order under the planner's own authority and plant reach.
  const created = await withActingUser(client, PLANNER, (actor) => createProductionOrder({
    client,
    createdBy: DEMO_ACTOR,
    requestKey: `DEMO-PO-${plan.key}`,
    materialNumber: plan.material,
    plant: PLANT,
    orderQuantity: plan.quantity,
    scheduledStart: dateIn(timeline, plan.period, plan.startDay),
    scheduledFinish: dateIn(timeline, plan.period, plan.receiptDay),
    productionVersion: PRODUCTION_VERSION,
    orderType: ORDER_TYPE,
  }, { authorization: actor }));
  return { orderNumber: created.orderNumber, created: true };
}

async function findStandingOrder(client: string, requestKey: string): Promise<string | null> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select order_number from production_order
       where client = ${client} and request_key = ${requestKey}
       limit 1
    `) as unknown as Array<{ order_number: string }>;
    return rows[0]?.order_number ?? null;
  });
}

/**
 * Release the order — the one act that lets work be charged to it.
 *
 * A release of a released order is not an error: the service returns the order
 * as it stands, so a resumed run neither fails nor rewrites the release.
 */
async function ensureRelease(client: string, orderNumber: string): Promise<boolean> {
  const view = await getProductionOrder(client, orderNumber);
  if (view && (view.status === 'RELEASED' || view.status === 'TECHNICALLY_COMPLETED')) {
    return false;
  }
  await withActingUser(client, PLANNER, (actor) => releaseProductionOrder(
    { client, orderNumber, releasedBy: DEMO_ACTOR },
    { authorization: actor },
  ));
  return true;
}

/**
 * Issue the components into the order — movement 261, posted by the production
 * clerk who holds PROD.ORDER.GI.
 *
 * Not the warehouse clerk, deliberately: an issue to a production order is an act
 * on the order as much as a movement of stock, so it asks for the order authority
 * as well as the goods-issue one. A clerk who may issue to a cost centre cannot
 * empty a shelf into a shop order.
 *
 * The issue names the order and the component item it satisfies, so the order
 * records what it has been given and refuses a second helping.
 */
async function issueComponents(
  client: string,
  plan: ProductionPlan,
  timeline: DemoTimeline,
  orderNumber: string,
): Promise<boolean> {
  const view = await getProductionOrder(client, orderNumber);
  if (!view || view.components.length === 0) return false;

  const postingDate = dateIn(timeline, plan.period, plan.issueDay);
  await withActingUser(client, PRODUCTION_CLERK, async (actor) => {
    await postGoodsIssue(
      {
        client,
        changedBy: DEMO_ACTOR,
        movementTypeCode: COMPONENT_ISSUE,
        postingDate,
        documentDate: postingDate,
        headerText: 'Issue to order',
        requestKey: `DEMO-GI-${plan.key}`,
        lines: view.components.map((component) => ({
          materialNumber: component.materialNumber,
          plant: component.plant,
          storageLocation: component.storageLocation ?? RECEIVING_STORAGE_LOCATION,
          quantity: Number(component.requiredQuantity),
          productionOrderNumber: orderNumber,
          productionOrderItem: component.itemNumber,
        })),
      },
      'MIGO',
      { authorization: actor },
    );
  });
  return true;
}

/**
 * Confirm the order's operations — the record that the work happened.
 *
 * A header confirmation posts no goods movement and no cost; the receipt and the
 * issue are their own documents. It is recorded because a factory that never
 * confirmed anything is a factory whose shop floor was never there.
 */
async function confirmOrder(
  client: string,
  plan: ProductionPlan,
  timeline: DemoTimeline,
  orderNumber: string,
): Promise<boolean> {
  const view = await getProductionOrder(client, orderNumber);
  if (!view) return false;

  await enterOrderConfirmation(client, {
    requestedBy: DEMO_ACTOR,
    requestKey: `DEMO-CF-${plan.key}`,
    orderNumber,
    productionVersion: PRODUCTION_VERSION,
    confirmationType: 'FINAL',
    confirmFinal: true,
    yieldQuantity: String(plan.quantity),
    unit: materialUnit(plan.material),
    postingDate: dateIn(timeline, plan.period, plan.confirmDay),
    expectedVersion: view.version,
    note: 'Demo production confirmation',
  });
  return true;
}

/**
 * Receive what the order made — movement 101, posted by the production clerk.
 *
 * The stock is valued at the standard price the material carries, which is the
 * price every later movement will use.
 */
async function receiveOutput(
  client: string,
  plan: ProductionPlan,
  timeline: DemoTimeline,
  orderNumber: string,
): Promise<boolean> {
  const postingDate = dateIn(timeline, plan.period, plan.receiptDay);
  // Received by the production clerk, who holds PROD.ORDER.GR and is restricted to
  // the plant that made the goods.
  await withActingUser(client, PRODUCTION_CLERK, (actor) => postProductionReceipt({
    client,
    changedBy: DEMO_ACTOR,
    orderNumber,
    postingDate,
    documentDate: postingDate,
    headerText: 'Receipt from order',
    requestKey: `DEMO-GR-${plan.key}`,
    lines: [{ quantity: plan.quantity, storageLocation: RECEIVING_STORAGE_LOCATION }],
  }, { authorization: actor }));
  return true;
}

/**
 * Close the order.
 *
 * Not every order is closed: the last one is left standing, because a factory
 * at a month end has work in progress, and a demo whose every order was neatly
 * finished is a demo of a factory that stops before the whistle.
 */
async function completeOrder(client: string, orderNumber: string): Promise<boolean> {
  const view = await getProductionOrder(client, orderNumber);
  if (!view || view.status === 'TECHNICALLY_COMPLETED') return false;

  await withActingUser(client, PLANNER, (actor) => technicallyCompleteProductionOrder({
    client,
    changedBy: DEMO_ACTOR,
    orderNumber,
    expectedVersion: view.version,
    held: ['PROD.*'],
    confirmed: true,
    authorization: actor,
  }));
  return true;
}

/**
 * Scrap something — movement 551, charged to no one.
 *
 * Posted by the warehouse clerk, because it is a movement of stock at their
 * plant and it is judged by the same authority as any other.
 */
async function scrapMaterial(
  client: string,
  plan: ScrapPlan,
  timeline: DemoTimeline,
): Promise<boolean> {
  const postingDate = dateIn(timeline, plan.period, plan.day);
  await withActingUser(client, WAREHOUSE_CLERK, async (actor) => {
    await postGoodsIssue(
      {
        client,
        changedBy: DEMO_ACTOR,
        movementTypeCode: SCRAP_MOVEMENT,
        postingDate,
        documentDate: postingDate,
        headerText: 'Scrapping',
        requestKey: `DEMO-SC-${plan.key}`,
        lines: [{
          materialNumber: plan.material,
          plant: PLANT,
          storageLocation: RECEIVING_STORAGE_LOCATION,
          quantity: plan.quantity,
        }],
      },
      'MB1A',
      { authorization: actor },
    );
  });
  return true;
}
