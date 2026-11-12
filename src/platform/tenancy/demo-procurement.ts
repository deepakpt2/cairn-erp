/**
 * The demo company's first documents — provisioning phase `D1_PROCUREMENT`.
 *
 * Procurement and inventory: opening balances, then the purchase orders, goods
 * receipts, supplier invoices, payments and consumable issues of three open
 * periods. It is the phase that turns the empty company Phase C left into one
 * with stock on the shelves and money owed.
 *
 * Three things shape it, and each is a decision rather than an accident.
 *
 * **It posts opening balances.** The company did not come into being on the first
 * day of the first open period; it was trading before then, and what it owned and
 * owed arrives as one balanced journal on that date. The shelves, though, are
 * filled by goods receipts rather than asserted by a journal line: a stock figure
 * is a quantity the inventory ledger holds, and a journal cannot put one there.
 *
 * **A purchase order carries today's date, not the date it belongs to.** The
 * service that creates one resolves its document date itself and offers no way to
 * say otherwise, so every order this phase raises is dated the day provisioning
 * ran. The receipts and the invoices take their own dates and are posted where
 * they belong. Accepted rather than worked around: changing the product to suit a
 * demo is a worse trade than an order whose date is later than its own delivery.
 *
 * **It stops at the goods movement.** Production, sales and their accounting are
 * later phases. What this phase must leave behind is reconciled: stock that ties
 * to the inventory accounts, GR/IR that ties to what has been received but not
 * invoiced, and payables that tie to the invoices that stand open against them.
 */

import {
  listAccountDeterminations,
  saveAccountDetermination,
} from '../../modules/foundation/account-determination';
import { postGlDocument } from '../../modules/finance/gl-document';
import { getPayables, postOutgoingPayment } from '../../modules/finance/outgoing-payment';
import { createOrder } from '../../modules/purchasing/orders';
import { listPurchaseOrders } from '../../modules/purchasing/purchase-order-list';
import { postSupplierInvoice } from '../../modules/purchasing/invoice-verification';
import { postGoodsReceipt } from '../../modules/inventory/goods-receipt';
import { postGoodsIssue } from '../../modules/inventory/goods-issue';
import { postInitialStock } from '../../modules/inventory/initial-stock';
import {
  getMaterialPeriodControl,
  initializeMaterialPeriodControl,
  setMaterialPeriodIndicators,
  shiftMaterialPeriod,
} from '../../modules/inventory/material-period-control';
import { materialUnit, PURCHASE_PRICES, STANDARD_TAX_CODE } from './demo-masters';
import { withActingUser } from './demo-people';
import { DEMO_ACTOR, DEMO_IDENTITY, DEMO_STRUCTURE } from './demo-organisation';
import type { DemoTimeline } from './demo-provisioning';

// ─────────────────────────────────────────────────────────────────────────────
// Posting configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a movement's value lands.
 *
 * Nothing in the product seeds this, and without it no goods movement can be
 * posted at all: a receipt asks for the inventory account of the material's
 * valuation class and for the GR/IR account it offsets, and refuses when neither
 * is configured. Phase C's acceptance was that every prerequisite for the planned
 * transactions validates; it did not, and this is the gap.
 *
 * The accounts are the standard chart's own, chosen for what they are named for.
 */
const ACCOUNT_DETERMINATION: ReadonlyArray<{
  event: string;
  valuationClass: string;
  glAccount: string;
}> = [
  { event: 'INVENTORY', valuationClass: 'RAW_INVENTORY', glAccount: '120000' },
  { event: 'INVENTORY', valuationClass: 'SEMI_INVENTORY', glAccount: '120100' },
  { event: 'INVENTORY', valuationClass: 'FINISHED_INVENTORY', glAccount: '120200' },
  { event: 'INVENTORY', valuationClass: 'TRADE_INVENTORY', glAccount: '120300' },
  { event: 'GR_IR_CLEARING', valuationClass: '', glAccount: '210000' },
  { event: 'PRICE_DIFFERENCE', valuationClass: '', glAccount: '410200' },
  { event: 'TAX', valuationClass: '', glAccount: '220000' },
  { event: 'CONSUMPTION', valuationClass: 'RAW_INVENTORY', glAccount: '410000' },
  { event: 'CONSUMPTION', valuationClass: 'SEMI_INVENTORY', glAccount: '410000' },
  { event: 'CONSUMPTION', valuationClass: 'FINISHED_INVENTORY', glAccount: '400000' },
  { event: 'CONSUMPTION', valuationClass: 'TRADE_INVENTORY', glAccount: '400000' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Opening balances
// ─────────────────────────────────────────────────────────────────────────────

interface OpeningLine {
  glAccount: string;
  debitCredit: 'S' | 'H';
  amount: string;
  businessPartner?: string;
  lineText: string;
}

/**
 * What the company owned and owed on the first day of the first open period.
 *
 * Fixed assets at cost with their accumulated depreciation carried against them,
 * money in the bank, customers owing, suppliers owed, a loan, and the equity
 * that is left. It balances to the fils, and a test asserts that it does — a
 * demo whose opening balance sheet does not balance is not a demo of an ERP.
 *
 * Receivables and payables name their partners, so the ageing reports have
 * someone to age against and the oldest bucket of the schedule means something.
 */
const OPENING_AR: ReadonlyArray<{ partner: string; amount: number }> = [
  { partner: 'CUS-1000', amount: 52_000 },
  { partner: 'CUS-2000', amount: 41_000 },
  { partner: 'CUS-3000', amount: 25_000 },
];

const OPENING_AP: ReadonlyArray<{ partner: string; amount: number }> = [
  { partner: 'SUP-1000', amount: 28_000 },
  { partner: 'SUP-2000', amount: 24_000 },
  { partner: 'SUP-3000', amount: 19_000 },
  { partner: 'SUP-4000', amount: 15_000 },
];

function openingLines(): OpeningLine[] {
  const lines: OpeningLine[] = [
    { glAccount: '101000', debitCredit: 'S', amount: '92000.000', lineText: 'Cash at bank' },
    { glAccount: '150000', debitCredit: 'S', amount: '340000.000', lineText: 'Plant and machinery at cost' },
    { glAccount: '151000', debitCredit: 'S', amount: '45000.000', lineText: 'Office equipment at cost' },
    { glAccount: '152000', debitCredit: 'S', amount: '60000.000', lineText: 'Motor vehicles at cost' },
    { glAccount: '150100', debitCredit: 'H', amount: '78000.000', lineText: 'Accumulated depreciation' },
    { glAccount: '151100', debitCredit: 'H', amount: '18000.000', lineText: 'Accumulated depreciation' },
    { glAccount: '152100', debitCredit: 'H', amount: '22000.000', lineText: 'Accumulated depreciation' },
    { glAccount: '260000', debitCredit: 'H', amount: '48000.000', lineText: 'Term loan' },
    { glAccount: '280000', debitCredit: 'H', amount: '300000.000', lineText: 'Share capital' },
    { glAccount: '290000', debitCredit: 'H', amount: '103000.000', lineText: 'Retained earnings b/f' },
  ];
  for (const row of OPENING_AR) {
    lines.push({
      glAccount: '110000',
      debitCredit: 'S',
      amount: row.amount.toFixed(3),
      businessPartner: row.partner,
      lineText: 'Trading balance brought forward',
    });
  }
  for (const row of OPENING_AP) {
    lines.push({
      glAccount: '200000',
      debitCredit: 'H',
      amount: row.amount.toFixed(3),
      businessPartner: row.partner,
      lineText: 'Trading balance brought forward',
    });
  }
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// The plan, in periods rather than in dates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every date in this phase is an offset into the frozen timeline, never a literal.
 *
 * The claim fixes the three open periods once, and a resumed run uses the periods
 * the first run chose. A plan written in calendar dates would be wrong the moment
 * the deployment happened in another month, and wrong in a way that looked like
 * data rather than like a bug.
 */
interface PlanLine {
  material: string;
  quantity: number;
  plant: string;
  storageLocation: string;
}

interface PurchasePlan {
  key: string;
  supplier: string;
  /** Index into `timeline.openPeriods`. */
  period: number;
  /** Day of that month the goods are due in. */
  deliveryDay: number;
  /** Day of that month they are booked in. */
  receiptDay: number;
  /**
   * Day the invoice is booked. Null leaves the receipt billed by nothing, so its
   * value sits in GR/IR and the last period closes with a receipt that has not
   * yet been invoiced — a real state, and the reconciliation the demo exists to
   * show.
   */
  invoiceDay: number | null;
  lines: readonly PlanLine[];
}

/**
 * Eighteen orders across the three periods.
 *
 * The first period is the build: enough raw material, packaging and traded stock
 * to fill the shelves before anything is made or sold. The second and third
 * replenish what the factory and the warehouse use. Traded goods go to the
 * distribution centre, and crates only there, because holding finished and traded
 * stock away from where it is made is the whole reason the second plant exists.
 */
const PURCHASE_PLAN: readonly PurchasePlan[] = [
  { key: 'P1-01', supplier: 'SUP-1000', period: 0, deliveryDay: 3, receiptDay: 3, invoiceDay: 5,
    lines: [{ material: 'RAW-FLOUR', quantity: 12_000, plant: '1000', storageLocation: '0001' },
            { material: 'RAW-SUGAR', quantity: 4_000, plant: '1000', storageLocation: '0001' }] },
  { key: 'P1-02', supplier: 'SUP-2000', period: 0, deliveryDay: 4, receiptDay: 4, invoiceDay: 6,
    lines: [{ material: 'RAW-FAT', quantity: 3_000, plant: '1000', storageLocation: '0001' },
            { material: 'RAW-COCOA', quantity: 900, plant: '1000', storageLocation: '0001' }] },
  { key: 'P1-03', supplier: 'SUP-3000', period: 0, deliveryDay: 5, receiptDay: 5, invoiceDay: 7,
    lines: [{ material: 'PACK-CARTON', quantity: 8_000, plant: '1000', storageLocation: '0001' },
            { material: 'PACK-WRAP', quantity: 60_000, plant: '1000', storageLocation: '0001' }] },
  { key: 'P1-04', supplier: 'SUP-4000', period: 0, deliveryDay: 6, receiptDay: 6, invoiceDay: 8,
    lines: [{ material: 'TRAD-JUICE', quantity: 1_200, plant: '1000', storageLocation: '0001' }] },
  { key: 'P1-05', supplier: 'SUP-3000', period: 0, deliveryDay: 8, receiptDay: 8, invoiceDay: 10,
    lines: [{ material: 'TRAD-CRATE', quantity: 400, plant: '2000', storageLocation: '0001' }] },
  { key: 'P1-06', supplier: 'SUP-1000', period: 0, deliveryDay: 24, receiptDay: 24, invoiceDay: 26,
    lines: [{ material: 'RAW-FLOUR', quantity: 6_000, plant: '1000', storageLocation: '0001' }] },

  { key: 'P2-01', supplier: 'SUP-1000', period: 1, deliveryDay: 5, receiptDay: 5, invoiceDay: 7,
    lines: [{ material: 'RAW-FLOUR', quantity: 10_000, plant: '1000', storageLocation: '0001' },
            { material: 'RAW-SUGAR', quantity: 3_000, plant: '1000', storageLocation: '0001' }] },
  { key: 'P2-02', supplier: 'SUP-2000', period: 1, deliveryDay: 7, receiptDay: 7, invoiceDay: 9,
    lines: [{ material: 'RAW-FAT', quantity: 2_500, plant: '1000', storageLocation: '0001' },
            { material: 'RAW-COCOA', quantity: 700, plant: '1000', storageLocation: '0001' }] },
  { key: 'P2-03', supplier: 'SUP-3000', period: 1, deliveryDay: 9, receiptDay: 9, invoiceDay: 11,
    lines: [{ material: 'PACK-CARTON', quantity: 6_000, plant: '1000', storageLocation: '0001' },
            { material: 'PACK-WRAP', quantity: 48_000, plant: '1000', storageLocation: '0001' }] },
  { key: 'P2-04', supplier: 'SUP-4000', period: 1, deliveryDay: 12, receiptDay: 12, invoiceDay: 14,
    lines: [{ material: 'TRAD-JUICE', quantity: 900, plant: '2000', storageLocation: '0001' }] },
  { key: 'P2-05', supplier: 'SUP-1000', period: 1, deliveryDay: 20, receiptDay: 20, invoiceDay: 22,
    lines: [{ material: 'RAW-FLOUR', quantity: 8_000, plant: '1000', storageLocation: '0001' }] },
  { key: 'P2-06', supplier: 'SUP-2000', period: 1, deliveryDay: 26, receiptDay: 26, invoiceDay: 28,
    lines: [{ material: 'RAW-COCOA', quantity: 500, plant: '1000', storageLocation: '0001' }] },

  { key: 'P3-01', supplier: 'SUP-1000', period: 2, deliveryDay: 2, receiptDay: 2, invoiceDay: 4,
    lines: [{ material: 'RAW-FLOUR', quantity: 9_000, plant: '1000', storageLocation: '0001' },
            { material: 'RAW-SUGAR', quantity: 2_800, plant: '1000', storageLocation: '0001' }] },
  { key: 'P3-02', supplier: 'SUP-2000', period: 2, deliveryDay: 4, receiptDay: 4, invoiceDay: 6,
    lines: [{ material: 'RAW-FAT', quantity: 2_200, plant: '1000', storageLocation: '0001' },
            { material: 'RAW-COCOA', quantity: 600, plant: '1000', storageLocation: '0001' }] },
  { key: 'P3-03', supplier: 'SUP-3000', period: 2, deliveryDay: 5, receiptDay: 5, invoiceDay: 7,
    lines: [{ material: 'PACK-CARTON', quantity: 5_000, plant: '1000', storageLocation: '0001' },
            { material: 'PACK-WRAP', quantity: 40_000, plant: '1000', storageLocation: '0001' }] },
  { key: 'P3-04', supplier: 'SUP-4000', period: 2, deliveryDay: 6, receiptDay: 6, invoiceDay: 8,
    lines: [{ material: 'TRAD-JUICE', quantity: 800, plant: '2000', storageLocation: '0001' }] },
  { key: 'P3-05', supplier: 'SUP-3000', period: 2, deliveryDay: 9, receiptDay: 9, invoiceDay: 11,
    lines: [{ material: 'PACK-WRAP', quantity: 20_000, plant: '1000', storageLocation: '0001' }] },
  { key: 'P3-06', supplier: 'SUP-1000', period: 2, deliveryDay: 10, receiptDay: 10, invoiceDay: null,
    lines: [{ material: 'RAW-FLOUR', quantity: 5_000, plant: '1000', storageLocation: '0001' }] },
];

interface PaymentPlan {
  key: string;
  supplier: string;
  period: number;
  day: number;
  /** How many of the supplier's oldest open items this payment settles. */
  items: number;
}

/**
 * Seven payments, each clearing the supplier's oldest open items on its date.
 *
 * Not every invoice is paid. What stands open at the end *is* the ageing
 * schedule, and the invariant the demo is written against is that the open items
 * equal the expected schedule — not that there are none.
 */
const PAYMENT_PLAN: readonly PaymentPlan[] = [
  { key: 'PAY-01', supplier: 'SUP-1000', period: 0, day: 30, items: 2 },
  { key: 'PAY-02', supplier: 'SUP-2000', period: 1, day: 15, items: 2 },
  { key: 'PAY-03', supplier: 'SUP-3000', period: 1, day: 31, items: 3 },
  { key: 'PAY-04', supplier: 'SUP-1000', period: 2, day: 5, items: 2 },
  { key: 'PAY-05', supplier: 'SUP-4000', period: 2, day: 6, items: 2 },
  { key: 'PAY-06', supplier: 'SUP-2000', period: 2, day: 11, items: 2 },
  { key: 'PAY-07', supplier: 'SUP-3000', period: 2, day: 12, items: 2 },
];

/** Where the money goes out of. */
const BANK_ACCOUNT = '101000';

interface IssuePlan {
  key: string;
  period: number;
  day: number;
  material: string;
  quantity: number;
  plant: string;
  storageLocation: string;
  costCenter: string;
}

/**
 * Three issues of packaging and crates to cost centres — stock a warehouse and a
 * packing line use rather than sell.
 *
 * They exist so the inventory ledger has a credit movement that is neither a
 * production issue nor a sale: a movement with no document behind it, charged
 * straight to a controlling object, which is the third thing stock does.
 */
const ISSUE_PLAN: readonly IssuePlan[] = [
  { key: 'ISS-01', period: 0, day: 30, material: 'PACK-WRAP', quantity: 2_000, plant: '1000', storageLocation: '0001', costCenter: 'CC2000' },
  { key: 'ISS-02', period: 1, day: 31, material: 'PACK-CARTON', quantity: 300, plant: '1000', storageLocation: '0001', costCenter: 'CC1010' },
  { key: 'ISS-03', period: 2, day: 8, material: 'TRAD-CRATE', quantity: 40, plant: '2000', storageLocation: '0001', costCenter: 'CC2000' },
];

/** The cost-centre issue. Movement 201: goods out, charged to a controlling object. */
const COST_CENTER_ISSUE = '201';

/** The rate the standard tax code carries, stated once so a gross can be computed. */
const STANDARD_TAX_RATE = 5;

// ─────────────────────────────────────────────────────────────────────────────

export interface DemoProcurementResult {
  client: string;
  /** The account-determination rows that stand, whether written now or found. */
  determinationRows: number;
  openingJournal: string | null;
  /** The initial stock documents: one per plant, dated the first day. */
  openingStock: number;
  /** The purchase orders of this phase that stand, raised now or found. */
  purchaseOrders: number;
  goodsReceipts: number;
  supplierInvoices: number;
  payments: number;
  goodsIssues: number;
  /** Every document that stands when the phase is done. */
  documents: number;
}

export interface BuildDemoProcurementInput {
  client: string;
  timeline: DemoTimeline;
}

/**
 * Build the procurement and inventory history, one open period at a time.
 *
 * The material period is walked forward rather than held open: only the current
 * period and, where backposting is allowed, the one before it ever accept a goods
 * movement. Three periods cannot stand open at once for inventory, and a dataset
 * that pretended otherwise would not have been postable by any client. So each
 * period is opened, its documents written, and the period shifted — which is what
 * a company does at its month end anyway.
 */
export async function buildDemoProcurement(
  input: BuildDemoProcurementInput,
): Promise<DemoProcurementResult> {
  const client = input.client;

  const determinationRows = await ensurePostingConfiguration(client);
  const openingJournal = await postOpeningBalances(client, input.timeline);
  let openingStock = 0;

  let purchaseOrders = 0;
  let goodsReceipts = 0;
  let supplierInvoices = 0;
  let payments = 0;
  let goodsIssues = 0;

  for (let index = 0; index < input.timeline.openPeriods.length; index += 1) {
    const openPeriod = input.timeline.openPeriods[index] ?? '';
    await ensureMaterialPeriod(client, Number(openPeriod.slice(0, 4)), Number(openPeriod.slice(4)), input.timeline);

    // The shelves are filled on the first day of the first open period, before
    // anything is bought. A company arrives with stock already on hand; the
    // buying that follows adds to it rather than starting it.
    if (index === 0) openingStock = await postOpeningStock(client, input.timeline);

    const orders = await runPurchaseOrders(client, input.timeline, index);
    const receipts = await postReceipts(client, input.timeline, index, orders);
    const invoices = await postInvoices(client, input.timeline, index, orders);
    const paid = await runPayments(client, input.timeline, index);
    const issues = await runIssues(client, input.timeline, index);

    purchaseOrders += orders.standing;
    goodsReceipts += receipts;
    supplierInvoices += invoices;
    payments += paid;
    goodsIssues += issues;
  }

  return {
    client,
    determinationRows,
    openingJournal,
    openingStock,
    purchaseOrders,
    goodsReceipts,
    supplierInvoices,
    payments,
    goodsIssues,
    documents:
      (openingJournal ? 1 : 0) +
      openingStock +
      purchaseOrders +
      goodsReceipts +
      supplierInvoices +
      payments +
      goodsIssues,
  };
}

/** A calendar date inside one of the frozen open periods. */
function dateIn(timeline: DemoTimeline, period: number, day: number): string {
  const key = timeline.openPeriods[period];
  if (!key) throw new Error(`The demo timeline has no period at index ${period}.`);
  return `${key.slice(0, 4)}-${key.slice(4)}-${String(day).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Posting configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The posting configuration the phase needs, written once.
 *
 * Returns the rows that stand when it is done, not the rows it created: on a
 * resumed run every row is already there and nothing is created, and a phase
 * report that said `0` while eleven rows stood would be read as a failure that
 * did not happen.
 */
async function ensurePostingConfiguration(client: string): Promise<number> {
  let created = 0;
  for (const row of ACCOUNT_DETERMINATION) {
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
  // What stands, not what was written — see the note above. Scoped to the events
  // this phase configures: a later phase adds rows of its own, and this phase's
  // report must not grow when production is built on top of it.
  const mine = new Set(ACCOUNT_DETERMINATION.map((row) => row.event));
  const standing = await listAccountDeterminations(client).catch(() => null);
  if (!standing) return created;
  return standing.filter((row) => mine.has(row.event)).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// The material period
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Make the period current, initializing the record the first time and shifting it
 * thereafter.
 *
 * Backposting is left allowed. It has to be: an invoice can arrive in the period
 * after the one its goods receipt landed in, and a company that could not book
 * that invoice could not close a month.
 */
async function ensureMaterialPeriod(
  client: string,
  fiscalYear: number,
  period: number,
  timeline: DemoTimeline,
): Promise<void> {
  void timeline;
  const company = DEMO_STRUCTURE.companyCode;
  let record = await getMaterialPeriodControl(client, company);

  if (!record) {
    await initializeMaterialPeriodControl({
      client,
      changedBy: DEMO_ACTOR,
      companyCode: company,
      fiscalYear,
      period,
      reason: 'Demo company opens its first material period',
    });
    await setMaterialPeriodIndicators({
      client,
      changedBy: DEMO_ACTOR,
      companyCode: company,
      allowBackposting: true,
      disallowBackpostingAfterChange: false,
      reason: 'Demo company allows posting into the previous period',
    }).catch(() => undefined);
    return;
  }

  // Shifted one period at a time, because that is the only act the product
  // offers: a period is closed by moving past it, never by reopening it.
  while (record.currentFiscalYear < fiscalYear || (record.currentFiscalYear === fiscalYear && record.currentPeriod < period)) {
    await shiftMaterialPeriod({
      client,
      changedBy: DEMO_ACTOR,
      companyCode: company,
      reason: 'Demo company closes the material period',
    });
    const moved = await getMaterialPeriodControl(client, company);
    if (!moved) throw new Error('The material period control record vanished while it was being shifted.');
    if (moved.currentFiscalYear === record.currentFiscalYear && moved.currentPeriod === record.currentPeriod) {
      throw new Error(`The material period could not be shifted past ${record.currentFiscalYear}/${record.currentPeriod}.`);
    }
    record = moved;
  }

  if (!record.allowBackposting) {
    await setMaterialPeriodIndicators({
      client,
      changedBy: DEMO_ACTOR,
      companyCode: company,
      allowBackposting: true,
      disallowBackpostingAfterChange: false,
      reason: 'Demo company allows posting into the previous period',
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Opening balances
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one journal the company opens with.
 *
 * Request-keyed, so a resumed run that already posted it is handed the same
 * document back rather than a second opening balance.
 */
async function postOpeningBalances(client: string, timeline: DemoTimeline): Promise<string | null> {
  const posted = await postGlDocument({
    client,
    changedBy: DEMO_ACTOR,
    requestKey: 'DEMO-OPENING-BALANCES',
    companyCode: DEMO_STRUCTURE.companyCode,
    documentDate: timeline.startDate,
    postingDate: timeline.startDate,
    documentType: 'SA',
    currency: DEMO_IDENTITY.currency,
    reference: 'OPENING',
    headerText: 'Opening balances',
    lines: openingLines(),
  });
  return posted.displayNumber;
}

// ─────────────────────────────────────────────────────────────────────────────
// Opening stock
// ─────────────────────────────────────────────────────────────────────────────

interface OpeningStockLine {
  material: string;
  plant: string;
  storageLocation: string;
  quantity: number;
}

/**
 * What was already on the shelves on the first day of the first open period.
 *
 * A journal can state a value but it cannot put a quantity on a shelf, and the
 * two have to agree or the inventory accounts stop tying to the stock they are
 * supposed to represent. So the stock arrives as a goods movement — movement 561,
 * the initial stock entry — valued at the price each material carries, with
 * retained earnings on the other side because stock the company already held on
 * the day the books opened is part of the equity it opened with.
 *
 * Raw materials and packaging at the factory, trading goods at both sites, and
 * finished goods waiting to be sold: a company does not begin empty-handed, and
 * a demo that showed one would be showing a company that does not exist.
 */
const OPENING_STOCK: readonly OpeningStockLine[] = [
  { material: 'RAW-FLOUR', plant: '1000', storageLocation: '0001', quantity: 8000 },
  { material: 'RAW-SUGAR', plant: '1000', storageLocation: '0001', quantity: 2400 },
  { material: 'RAW-FAT', plant: '1000', storageLocation: '0001', quantity: 1800 },
  { material: 'RAW-COCOA', plant: '1000', storageLocation: '0001', quantity: 900 },
  { material: 'PACK-CARTON', plant: '1000', storageLocation: '0001', quantity: 6000 },
  { material: 'PACK-WRAP', plant: '1000', storageLocation: '0001', quantity: 40000 },
  { material: 'SEMI-DOUGH', plant: '1000', storageLocation: '0001', quantity: 1200 },
  { material: 'FG-CREAM', plant: '1000', storageLocation: '0001', quantity: 5000 },
  { material: 'FG-CHOC', plant: '1000', storageLocation: '0001', quantity: 4000 },
  { material: 'FG-WAFER', plant: '1000', storageLocation: '0001', quantity: 3000 },
  { material: 'TRAD-JUICE', plant: '1000', storageLocation: '0001', quantity: 300 },
  { material: 'FG-CHOC', plant: '2000', storageLocation: '0001', quantity: 2000 },
  { material: 'FG-CREAM', plant: '2000', storageLocation: '0001', quantity: 2500 },
  { material: 'TRAD-JUICE', plant: '2000', storageLocation: '0001', quantity: 500 },
  { material: 'TRAD-CRATE', plant: '2000', storageLocation: '0001', quantity: 120 },
];

/**
 * Put the opening stock on the shelves.
 *
 * One document per plant, and not because the movement could not carry both: it
 * is because the clerk who posts it is restricted to one plant, and a document
 * spanning two plants would need a poster whose reach covered both. The
 * restriction is therefore on the path the movement takes, the same way it is
 * for every receipt and issue that follows.
 */
async function postOpeningStock(client: string, timeline: DemoTimeline): Promise<number> {
  let posted = 0;
  const postingDate = dateIn(timeline, 0, 1);

  for (const plant of [DEMO_STRUCTURE.manufacturingPlant, DEMO_STRUCTURE.distributionPlant]) {
    const lines = OPENING_STOCK.filter((line) => line.plant === plant);
    if (lines.length === 0) continue;

    await withActingUser(client, clerkFor(plant), async (actor) => {
      await postInitialStock(
        {
          client,
          changedBy: DEMO_ACTOR,
          postingDate,
          documentDate: postingDate,
          headerText: 'Opening stock',
          requestKey: `DEMO-OPENING-STOCK-${plant}`,
          lines: lines.map((line) => ({
            materialNumber: line.material,
            plant: line.plant,
            storageLocation: line.storageLocation,
            quantity: line.quantity,
            entryUnit: materialUnit(line.material),
          })),
        },
        { authorization: actor },
      );
    });
    posted += 1;
  }
  return posted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Purchase orders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raise the orders of one period.
 *
 * An order is a commitment: it writes no journal and moves no stock, so it needs
 * no open material period and no authorisation beyond being able to buy. It is
 * raised before anything else in its period because both the receipt and the
 * invoice name it.
 */
async function runPurchaseOrders(
  client: string,
  timeline: DemoTimeline,
  period: number,
): Promise<{ created: number; standing: number; numbers: Map<string, string> }> {
  const numbers = new Map<string, string>();
  let created = 0;

  for (const plan of PURCHASE_PLAN.filter((row) => row.period === period)) {
    const result = await ensurePurchaseOrder(client, plan, timeline);
    numbers.set(plan.key, result.value);
    if (result.created) created += 1;
  }
  // The orders of this period that stand, whether raised now or found already
  // there — the figure a report should show.
  return { created, standing: numbers.size, numbers };
}

/**
 * The order behind a plan line, found or raised.
 *
 * The service that creates an order takes no request key, so a resumed run has no
 * way to ask whether the order it is about to raise was raised already. It is
 * found instead by what it says: the same supplier, the same materials, the same
 * quantities, the same delivery date. The plan is fixed, so that is a signature
 * rather than a guess — and an order that is found is left exactly as it stands.
 */
async function ensurePurchaseOrder(
  client: string,
  plan: PurchasePlan,
  timeline: DemoTimeline,
): Promise<{ value: string; created: boolean }> {
  const standing = await findStandingOrder(client, plan, timeline);
  if (standing) return { value: standing, created: false };

  const deliveryDate = dateIn(timeline, plan.period, plan.deliveryDay);
  const { orderNumber } = await createOrder({
    client,
    changedBy: DEMO_ACTOR,
    supplierNumber: plan.supplier,
    purchasingOrg: DEMO_STRUCTURE.purchasingOrg,
    purchasingGroup: '001',
    companyCode: DEMO_STRUCTURE.companyCode,
    items: plan.lines.map((line) => ({
      materialNumber: line.material,
      quantity: line.quantity,
      unit: materialUnit(line.material),
      // Stated, not left to be found: a buyer types what the supplier quoted.
      // It is the price the info record carries, so the order and the invoice
      // that follows it agree.
      netPrice: priceOf(line.material),
      priceUnit: 1,
      plant: line.plant,
      storageLocation: line.storageLocation,
      taxCode: STANDARD_TAX_CODE,
      scheduleLines: [{ lineNumber: 1, deliveryDate, quantity: line.quantity }],
    })),
  });
  return { value: orderNumber, created: true };
}

async function findStandingOrder(
  client: string,
  plan: PurchasePlan,
  timeline: DemoTimeline,
): Promise<string | null> {
  const listed = await listPurchaseOrders({
    client,
    selection: { vendorFrom: plan.supplier, vendorTo: plan.supplier, scope: 'ALL' },
  });
  const deliveryDate = dateIn(timeline, plan.period, plan.deliveryDay);
  const wanted = signature(
    plan.lines.map((line) => ({ ...line, deliveryDate })),
  );

  for (const orderNumber of new Set(listed.rows.map((row) => row.orderNumber))) {
    const rows = listed.rows.filter((row) => row.orderNumber === orderNumber);
    const found = signature(
      rows.map((row) => ({
        material: row.materialNumber,
        quantity: row.quantity,
        plant: row.plant,
        deliveryDate: row.deliveryDate,
      })),
    );
    if (found === wanted) return orderNumber;
  }
  return null;
}

type SignatureLine = { material: string; quantity: number; plant: string; deliveryDate: string };

function signature(lines: readonly SignatureLine[]): string {
  return lines
    .map((line) => `${line.material}@${line.plant}:${line.quantity}:${line.deliveryDate}`)
    .sort()
    .join('|');
}

function priceOf(materialNumber: string): number {
  return Number(PURCHASE_PRICES[materialNumber] ?? '0');
}

function netOf(line: PlanLine): number {
  return round3(line.quantity * priceOf(line.material));
}

function grossOf(plan: PurchasePlan): number {
  const net = plan.lines.reduce((sum, line) => sum + netOf(line), 0);
  return round3(net * (1 + STANDARD_TAX_RATE / 100));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Goods receipts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The receipts of one period, posted by the clerk authorised for the plant they
 * land in.
 *
 * A goods movement is not a data load: the service asks who is posting it and
 * whether that person's organisational reach covers the plant, and refuses when it
 * does not. So the manufacturing clerk is signed in for what arrives at the
 * factory and the distribution clerk for what arrives at the warehouse, and each
 * session is revoked the moment its own movements are done.
 *
 * That is the two-plant isolation the demo was built to show, exercised by the
 * dataset rather than only asserted by a test.
 */
async function postReceipts(
  client: string,
  timeline: DemoTimeline,
  period: number,
  orders: { numbers: Map<string, string> },
): Promise<number> {
  let posted = 0;
  const plans = PURCHASE_PLAN.filter((row) => row.period === period);

  for (const plant of [DEMO_STRUCTURE.manufacturingPlant, DEMO_STRUCTURE.distributionPlant]) {
    const mine = plans.filter((plan) => plan.lines.some((line) => line.plant === plant));
    if (mine.length === 0) continue;

    await withActingUser(client, clerkFor(plant), async (actor) => {
      for (const plan of mine) {
        const orderNumber = orders.numbers.get(plan.key);
        if (!orderNumber) continue;
        const postingDate = dateIn(timeline, plan.period, plan.receiptDay);
        await postGoodsReceipt(
          {
            client,
            changedBy: DEMO_ACTOR,
            orderNumber,
            documentDate: postingDate,
            postingDate,
            headerText: 'Demo goods receipt',
            requestKey: `DEMO-GR-${plan.key}`,
            lines: plan.lines
              .filter((line) => line.plant === plant)
              .map((line, index) => ({
                itemNumber: (index + 1) * 10,
                quantity: line.quantity,
                storageLocation: line.storageLocation,
              })),
          },
          { authorization: actor },
        );
        posted += 1;
      }
    });
  }
  return posted;
}

/** The clerk who may move stock at a plant. */
function clerkFor(plant: string): string {
  return plant === DEMO_STRUCTURE.distributionPlant ? 'demo.warehouse2' : 'demo.warehouse1';
}

// ─────────────────────────────────────────────────────────────────────────────
// Supplier invoices
// ─────────────────────────────────────────────────────────────────────────────

async function postInvoices(
  client: string,
  timeline: DemoTimeline,
  period: number,
  orders: { numbers: Map<string, string> },
): Promise<number> {
  let posted = 0;
  for (const plan of PURCHASE_PLAN.filter((row) => row.period === period)) {
    if (plan.invoiceDay === null) continue;
    const orderNumber = orders.numbers.get(plan.key);
    if (!orderNumber) continue;

    const postingDate = dateIn(timeline, plan.period, plan.invoiceDay);
    await postSupplierInvoice({
      client,
      changedBy: DEMO_ACTOR,
      orderNumber,
      supplierReference: `INV-${plan.key}`,
      invoiceDate: postingDate,
      postingDate,
      grossAmount: grossOf(plan),
      headerText: 'Demo supplier invoice',
      requestKey: `DEMO-IR-${plan.key}`,
      lines: plan.lines.map((line, index) => ({
        itemNumber: (index + 1) * 10,
        quantity: line.quantity,
        netAmount: netOf(line),
        taxCode: STANDARD_TAX_CODE,
      })),
    });
    posted += 1;
  }
  return posted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payments
// ─────────────────────────────────────────────────────────────────────────────

async function runPayments(client: string, timeline: DemoTimeline, period: number): Promise<number> {
  let posted = 0;
  for (const plan of PAYMENT_PLAN.filter((row) => row.period === period)) {
    const view = await getPayables(client, plan.supplier, DEMO_STRUCTURE.companyCode);
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

    const postingDate = dateIn(timeline, plan.period, plan.day);
    await postOutgoingPayment({
      client,
      changedBy: DEMO_ACTOR,
      vendorNumber: plan.supplier,
      companyCode: DEMO_STRUCTURE.companyCode,
      documentDate: postingDate,
      postingDate,
      clearingDate: postingDate,
      bankGlAccount: BANK_ACCOUNT,
      amount,
      currency: DEMO_IDENTITY.currency,
      reference: plan.key,
      requestKey: `DEMO-PAY-${plan.key}`,
      items,
    });
    posted += 1;
  }
  return posted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Consumable issues
// ─────────────────────────────────────────────────────────────────────────────

async function runIssues(client: string, timeline: DemoTimeline, period: number): Promise<number> {
  let posted = 0;
  const plans = ISSUE_PLAN.filter((row) => row.period === period);

  for (const plant of [DEMO_STRUCTURE.manufacturingPlant, DEMO_STRUCTURE.distributionPlant]) {
    const mine = plans.filter((plan) => plan.plant === plant);
    if (mine.length === 0) continue;

    // The same clerk, for the same reason: a stock movement is posted by someone
    // whose reach covers the plant it happens at.
    await withActingUser(client, clerkFor(plant), async (actor) => {
      for (const plan of mine) {
        const postingDate = dateIn(timeline, plan.period, plan.day);
        await postGoodsIssue(
          {
            client,
            changedBy: DEMO_ACTOR,
            movementTypeCode: COST_CENTER_ISSUE,
            postingDate,
            documentDate: postingDate,
            headerText: 'Demo consumable issue',
            requestKey: `DEMO-ISS-${plan.key}`,
            lines: [
              {
                materialNumber: plan.material,
                plant: plan.plant,
                storageLocation: plan.storageLocation,
                quantity: plan.quantity,
                costCenter: plan.costCenter,
              },
            ],
          },
          'MB1A',
          { authorization: actor },
        );
        posted += 1;
      }
    });
  }
  return posted;
}

/**
 * A write that found the row already there is not a failure.
 *
 * Only a duplicate is forgiven. Anything else — a period that is shut, an account
 * that is blocked, a quantity that does not stand — stops the run, because a demo
 * that quietly skipped a document it could not post would leave the books out of
 * balance for a reason nobody could trace back to here.
 */
function isAlready(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already (exists|stands|been|holds|links|carries|covers|assigned|initialized)|is already|EXISTS|duplicate/i.test(
    message,
  );
}
