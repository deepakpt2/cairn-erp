/**
 * The demo company's quality inspection — provisioning phase `D5_QUALITY`.
 *
 * D1 bought the materials, D2 made the biscuits, D3 sold them, D4 closed the
 * month. This phase is the one thing none of those four could show: goods that
 * arrive and are not yet trusted. It buys cocoa, books it into inspection
 * stock rather than onto the shelf, inspects it, and lets the inspection decide
 * where the goods end up.
 *
 * Five things shape it, and each is a constraint rather than a preference.
 *
 * **The goods arrive into inspection stock.** A receipt into unrestricted use is
 * an assertion that the goods are good; the whole point of this phase is a
 * receipt that makes no such claim. The stock therefore stands in the QUALITY
 * segment until somebody has looked at it, which is what makes the two
 * movements at the end of the phase mean anything.
 *
 * **A document is written by the person whose job it is.** The warehouse clerk
 * books the goods in, the inspector opens the lot, records what was found and
 * decides, and the accountant pays the supplier. Each is judged inside the
 * service they call, on the reach they were granted, so a dataset that works is
 * a dataset whose authorisations work too.
 *
 * **One delivery passes and one fails.** An accept posts 321, quality to
 * unrestricted, and the goods are free to use. A reject posts 323, quality to
 * blocked, and the goods stand where a person has to come and decide what
 * happens to them. Two decisions that both say yes would exercise one path and
 * claim two.
 *
 * **Every date is a day inside one of the frozen open periods.** There is not a
 * calendar literal in the plan, and the stock movements are dated by the same
 * rule as everything else — which is why the usage decision carries a posting
 * date at all, rather than taking the day the container ran.
 *
 * **Every step is request-keyed or found by what it says.** A resumed run is
 * handed back the document it posted rather than a second copy of it: the
 * purchase order has no key, so it is found by its signature exactly as D1
 * finds its own.
 *
 * One thing this phase does not do is leave the supplier unpaid in a way the
 * earlier phases would have to explain. Both deliveries are invoiced and paid,
 * so the payables ageing, the GR/IR clearing account and the open-item counts
 * D1 and D4 assert are the ones those phases wrote. The rejected goods are the
 * open end: they stand in blocked stock, paid for, waiting for the credit note
 * the vendor still owes.
 */

import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { postOutgoingPayment, getPayables } from '../../modules/finance/outgoing-payment';
import { postGoodsReceipt } from '../../modules/inventory/goods-receipt';
import { createOrder } from '../../modules/purchasing/orders';
import { listPurchaseOrders } from '../../modules/purchasing/purchase-order-list';
import { postSupplierInvoice } from '../../modules/purchasing/invoice-verification';
import { saveCharacteristic, recordInspectionResult } from '../../modules/quality/inspection-results';
import { openLot } from '../../modules/quality/lot';
import { getUsageDecisionView, postUsageDecisionWithStock } from '../../modules/quality/usage-decision';
import { materialUnit, PURCHASE_PRICES, STANDARD_TAX_CODE } from './demo-masters';
import { DEMO_ACTOR, DEMO_IDENTITY, DEMO_STRUCTURE } from './demo-organisation';
import { withActingUser } from './demo-people';
import type { DemoTimeline } from './demo-provisioning';

/**
 * Who does what, and why it is them.
 *
 * The order and the invoice are the two documents this phase writes without a
 * person behind them: neither `createOrder` nor `postSupplierInvoice` asks who
 * is acting, so both are entered by the provisioner, exactly as D1 enters its
 * own. Everything that moves stock or money — the receipt, the lot, the results,
 * the decision and the payment — is written by the account whose job it is and
 * is judged by the service it calls.
 */
/** The clerk who books goods in at the manufacturing plant. */
const CLERK = 'demo.warehouse1';
/** The inspector: opens the lot, records what was found, and decides. */
const INSPECTOR = 'demo.quality';
/** The accountant, who banks the supplier's money. */
const ACCOUNTANT = 'demo.accountant';

const COMPANY_CODE = DEMO_STRUCTURE.companyCode;
const CURRENCY = DEMO_IDENTITY.currency;
/** Where the goods are received and inspected: the factory, not the warehouse. */
const PLANT = DEMO_STRUCTURE.manufacturingPlant;
const STORAGE_LOCATION = '0001';
const BANK_ACCOUNT = '101000';
/** The rate the standard tax code carries, stated once so a gross can be computed. */
const STANDARD_TAX_RATE = 5;

// ─────────────────────────────────────────────────────────────────────────────
// What is inspected
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The inspection characteristics.
 *
 * Nothing seeds them and a tenant that has never inspected anything has no
 * reason to carry them, so this phase maintains its own — in the same way D4
 * maintains the budget profile and the allocation structure its internal order
 * needs. Two are qualitative, which is what a person looking at a delivery
 * actually does, and two are quantitative with tolerances, which is what turns
 * a measured value into a pass or a fail without anybody's opinion.
 *
 * The units are the tenant's own: `KG` for the weighed bag and `G` for the fat
 * content of a 100 g sample, because a percentage is not a unit of measure and
 * inventing one would be a lie in the master data.
 */
const CHARACTERISTICS = [
  {
    characteristicCode: 'APPEARANCE',
    description: 'Colour and appearance of the delivery',
    characteristicType: 'QUALITATIVE' as const,
  },
  {
    characteristicCode: 'PACKAGING',
    description: 'Packaging intact, sealed and labelled',
    characteristicType: 'QUALITATIVE' as const,
  },
  {
    characteristicCode: 'NET-WEIGHT',
    description: 'Net weight of a weighed bag',
    characteristicType: 'QUANTITATIVE' as const,
    unit: 'KG',
    nominalValue: 25,
    tolerancePlus: 0.25,
    toleranceMinus: -0.25,
  },
  {
    characteristicCode: 'FAT-CONTENT',
    description: 'Fat content, grams per 100 g of sample',
    characteristicType: 'QUANTITATIVE' as const,
    unit: 'G',
    nominalValue: 22,
    tolerancePlus: 1,
    toleranceMinus: -1,
  },
] as const;

/**
 * One result against one characteristic.
 *
 * A qualitative result carries the judgement itself; a quantitative one carries
 * the measured value, and the tolerance on the characteristic decides whether it
 * passed. Nothing here says what the decision will be — the measurements do.
 */
interface ResultPlan {
  characteristicCode: string;
  resultValue: string;
  measuredUnit?: string;
  resultStatus: 'RECORDED' | 'ACCEPTED' | 'REJECTED';
}

interface DeliveryPlan {
  key: string;
  supplier: string;
  material: string;
  quantity: number;
  /** Index into `timeline.openPeriods` for the delivery, the receipt and the invoice. */
  period: number;
  /** Day the goods are due in; written on the order's schedule line. */
  deliveryDay: number;
  /** Day they are booked in, into inspection stock. */
  receiptDay: number;
  /** Day the lot is opened against the receipt. */
  lotDay: number;
  /** Day the results are recorded and the decision is taken. */
  decisionDay: number;
  decisionCode: 'ACCEPT' | 'REJECT';
  results: readonly ResultPlan[];
  /** Day the supplier's invoice is booked. */
  invoiceDay: number;
  /** The payment: the month after the invoice, as the terms say. */
  paymentPeriod: number;
  paymentDay: number;
}

/**
 * Two deliveries of cocoa from the same supplier, a month apart.
 *
 * The first is what a good delivery looks like: it passes, and 321 puts it on
 * the shelf for the factory to use. The second is what a bad one looks like: the
 * bags are light, the fat content is short, the packaging is torn, and 323 puts
 * the whole delivery in blocked stock where it stands until somebody decides
 * what to do with it.
 */
const DELIVERIES: readonly DeliveryPlan[] = [
  {
    key: 'Q1',
    supplier: 'SUP-2000',
    material: 'RAW-COCOA',
    quantity: 300,
    period: 1,
    deliveryDay: 10,
    receiptDay: 12,
    lotDay: 13,
    decisionDay: 14,
    decisionCode: 'ACCEPT',
    results: [
      { characteristicCode: 'APPEARANCE', resultValue: 'PASS', resultStatus: 'ACCEPTED' },
      { characteristicCode: 'PACKAGING', resultValue: 'PASS', resultStatus: 'ACCEPTED' },
      { characteristicCode: 'NET-WEIGHT', resultValue: '25.100', measuredUnit: 'KG', resultStatus: 'RECORDED' },
      { characteristicCode: 'FAT-CONTENT', resultValue: '22.400', measuredUnit: 'G', resultStatus: 'RECORDED' },
    ],
    invoiceDay: 20,
    paymentPeriod: 2,
    paymentDay: 6,
  },
  {
    key: 'Q2',
    supplier: 'SUP-2000',
    material: 'RAW-COCOA',
    quantity: 250,
    period: 2,
    deliveryDay: 2,
    receiptDay: 4,
    lotDay: 5,
    decisionDay: 6,
    decisionCode: 'REJECT',
    results: [
      { characteristicCode: 'APPEARANCE', resultValue: 'FAIL', resultStatus: 'REJECTED' },
      { characteristicCode: 'PACKAGING', resultValue: 'FAIL', resultStatus: 'REJECTED' },
      { characteristicCode: 'NET-WEIGHT', resultValue: '24.600', measuredUnit: 'KG', resultStatus: 'RECORDED' },
      { characteristicCode: 'FAT-CONTENT', resultValue: '20.200', measuredUnit: 'G', resultStatus: 'RECORDED' },
    ],
    invoiceDay: 8,
    paymentPeriod: 2,
    paymentDay: 12,
  },
];

export interface DemoQualityResult {
  client: string;
  /** The inspection characteristics this phase maintains. */
  characteristics: number;
  purchaseOrders: number;
  /** Goods receipts, every one of them into inspection stock. */
  goodsReceipts: number;
  lots: number;
  results: number;
  decisions: number;
  /** The stock movements the decisions posted: 321 on accept, 323 on reject. */
  stockMovements: number;
  invoices: number;
  payments: number;
  /** Every document this phase wrote. */
  documents: number;
}

export interface BuildDemoQualityInput {
  client: string;
  timeline: DemoTimeline;
}

/**
 * Buy, receive into inspection, inspect, decide, and pay.
 *
 * The order the steps run in is the order the goods move in. Nothing is opened
 * for inspection before it has been booked in, nothing is decided before every
 * characteristic has a result, and no invoice is paid before it has been
 * booked. The two deliveries are walked one at a time rather than step by step
 * across both, so an interrupted run leaves a whole delivery's worth of history
 * standing rather than half of each.
 */
export async function buildDemoQuality(input: BuildDemoQualityInput): Promise<DemoQualityResult> {
  const client = input.client;
  const timeline = input.timeline;

  const characteristics = await ensureCharacteristics(client);

  let purchaseOrders = 0;
  let goodsReceipts = 0;
  let lots = 0;
  let results = 0;
  let decisions = 0;
  let stockMovements = 0;
  let invoices = 0;
  let payments = 0;

  for (const plan of DELIVERIES) {
    const order = await ensurePurchaseOrder(client, timeline, plan);
    if (order.created) purchaseOrders += 1;
    if (!order.value) continue;

    if (await ensureGoodsReceipt(client, timeline, plan, order.value)) goodsReceipts += 1;

    const lotNumber = await ensureLot(client, timeline, plan);
    if (lotNumber) {
      lots += 1;
      results += await ensureResults(client, plan, lotNumber);
      const decision = await ensureDecision(client, timeline, plan, lotNumber);
      if (decision.decided) decisions += 1;
      if (decision.moved) stockMovements += 1;
    }

    if (await ensureInvoice(client, timeline, plan, order.value)) invoices += 1;
    if (await ensurePayment(client, timeline, plan)) payments += 1;
  }

  return {
    client,
    characteristics,
    purchaseOrders,
    goodsReceipts,
    lots,
    results,
    decisions,
    stockMovements,
    invoices,
    payments,
    documents: purchaseOrders + goodsReceipts + lots + results + decisions + stockMovements
      + invoices + payments,
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

/** Three decimals, because the demo currency has three. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
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
// What is inspected with
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The inspection characteristics, maintained once.
 *
 * `saveCharacteristic` is an upsert on the code, so this is its own
 * idempotence: a resumed run restates the definitions and carries on.
 */
async function ensureCharacteristics(client: string): Promise<number> {
  for (const definition of CHARACTERISTICS) {
    await saveCharacteristic({ client, changedBy: DEMO_ACTOR, ...definition });
  }
  return CHARACTERISTICS.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// The order
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The order behind a delivery, found or raised.
 *
 * The service that creates an order takes no request key, so a resumed run has
 * no way to ask whether the order it is about to raise was raised already. It is
 * found instead by what it says — the same supplier, material, quantity and
 * delivery date — exactly as D1 finds its own.
 */
async function ensurePurchaseOrder(
  client: string,
  timeline: DemoTimeline,
  plan: DeliveryPlan,
): Promise<{ value: string | null; created: boolean }> {
  const standing = await findStandingOrder(client, timeline, plan);
  if (standing) return { value: standing, created: false };

  const deliveryDate = dateIn(timeline, plan.period, plan.deliveryDay);
  const { orderNumber } = await createOrder({
    client,
    changedBy: DEMO_ACTOR,
    supplierNumber: plan.supplier,
    purchasingOrg: DEMO_STRUCTURE.purchasingOrg,
    purchasingGroup: '001',
    companyCode: COMPANY_CODE,
    items: [{
      materialNumber: plan.material,
      quantity: plan.quantity,
      unit: materialUnit(plan.material),
      // The price the info record carries, stated at the precision the order
      // keeps, so the order, the receipt and the invoice all say one number.
      netPrice: priceOf(plan.material),
      priceUnit: 1,
      plant: PLANT,
      storageLocation: STORAGE_LOCATION,
      taxCode: STANDARD_TAX_CODE,
      scheduleLines: [{ deliveryDate, quantity: plan.quantity }],
    }],
  });
  return { value: orderNumber, created: true };
}

async function findStandingOrder(
  client: string,
  timeline: DemoTimeline,
  plan: DeliveryPlan,
): Promise<string | null> {
  const listed = await listPurchaseOrders({
    client,
    selection: { vendorFrom: plan.supplier, vendorTo: plan.supplier, scope: 'ALL' },
  });
  const wanted = signature({
    material: plan.material,
    quantity: plan.quantity,
    plant: PLANT,
    deliveryDate: dateIn(timeline, plan.period, plan.deliveryDay),
  });
  for (const orderNumber of new Set(listed.rows.map((row) => row.orderNumber))) {
    const rows = listed.rows.filter((row) => row.orderNumber === orderNumber);
    const found = signature({
      material: String(rows[0]?.materialNumber ?? ''),
      quantity: Number(rows[0]?.quantity ?? 0),
      plant: String(rows[0]?.plant ?? ''),
      deliveryDate: String(rows[0]?.deliveryDate ?? ''),
    });
    if (found === wanted) return orderNumber;
  }
  return null;
}

type SignatureLine = { material: string; quantity: number; plant: string; deliveryDate: string };

function signature(line: SignatureLine): string {
  return `${line.material}@${line.plant}:${line.quantity}:${line.deliveryDate}`;
}

function priceOf(materialNumber: string): number {
  return Number(PURCHASE_PRICES[materialNumber] ?? '0');
}

function netOf(plan: DeliveryPlan): number {
  return round3(plan.quantity * priceOf(plan.material));
}

function grossOf(plan: DeliveryPlan): number {
  return round3(netOf(plan) * (1 + STANDARD_TAX_RATE / 100));
}

// ─────────────────────────────────────────────────────────────────────────────
// The receipt, into inspection stock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Book the delivery in — into the quality segment, not onto the shelf.
 *
 * The stock type is the whole difference between this receipt and the eighteen
 * D1 posts. The goods are the company's from the moment they are booked: the
 * inventory account is debited and GR/IR is credited exactly as any other
 * receipt posts them. What is withheld is the claim that they may be used, and
 * that is what the usage decision releases.
 *
 * Posted by the clerk authorised for the plant, because a goods movement is
 * posted by somebody whose reach covers where it happens.
 */
async function ensureGoodsReceipt(
  client: string,
  timeline: DemoTimeline,
  plan: DeliveryPlan,
  orderNumber: string,
): Promise<boolean> {
  const requestKey = `DEMO-QM-GR-${plan.key}`;
  if (await findByRequestKey(client, 'material_document', requestKey, 'material_document_number')) return true;

  const postingDate = dateIn(timeline, plan.period, plan.receiptDay);
  await withActingUser(client, CLERK, (actor) => postGoodsReceipt({
    client,
    changedBy: DEMO_ACTOR,
    orderNumber,
    documentDate: postingDate,
    postingDate,
    headerText: 'GR to quality stock',
    requestKey,
    stockType: 'QUALITY',
    lines: [{
      itemNumber: 10,
      quantity: plan.quantity,
      storageLocation: STORAGE_LOCATION,
    }],
  }, { authorization: actor }));
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// The lot and what was found
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open the lot against the receipt line.
 *
 * A lot names a line; it does not copy one. What it is opened against is the
 * document the receipt wrote, so the quantity, the batch and the plant the
 * inspector is judged against are the ones the inventory engine recorded.
 */
async function ensureLot(
  client: string,
  timeline: DemoTimeline,
  plan: DeliveryPlan,
): Promise<string | null> {
  const requestKey = `DEMO-QM-LOT-${plan.key}`;
  const standing = await findByRequestKey(client, 'quality_lot', requestKey, 'lot_number');
  if (standing) return standing;

  const documentNumber = await findByRequestKey(
    client, 'material_document', `DEMO-QM-GR-${plan.key}`, 'material_document_number',
  );
  if (!documentNumber) return null;

  const lot = await withActingUser(client, INSPECTOR, (actor) => openLot({
    client,
    changedBy: INSPECTOR,
    materialDocumentNumber: documentNumber,
    lineNumber: 1,
    inspectionNote: `Inspect ${plan.quantity} ${materialUnit(plan.material)} of ${plan.material} `
      + `received ${dateIn(timeline, plan.period, plan.receiptDay)}`,
    requestKey,
  }, { authorization: actor }));
  return lot.lotNumber;
}

/**
 * Record what was found, one result per characteristic.
 *
 * A lot carries one result per characteristic, and recording the same pair
 * again restates it rather than adding a second, so this step is its own
 * idempotence. The inspector is judged against the plant the goods stand in,
 * which the service reads from the receipt line the lot names.
 */
async function ensureResults(
  client: string,
  plan: DeliveryPlan,
  lotNumber: string,
): Promise<number> {
  let recorded = 0;
  for (const result of plan.results) {
    await withActingUser(client, INSPECTOR, (actor) => recordInspectionResult({
      client,
      changedBy: INSPECTOR,
      lotNumber,
      characteristicCode: result.characteristicCode,
      resultValue: result.resultValue,
      measuredUnit: result.measuredUnit,
      resultStatus: result.resultStatus,
      requestKey: `DEMO-QM-RES-${plan.key}-${result.characteristicCode}`,
    }, { authorization: actor }));
    recorded += 1;
  }
  return recorded;
}

// ─────────────────────────────────────────────────────────────────────────────
// The decision, and where the goods go
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decide, and move the goods where the decision puts them.
 *
 * An accept posts 321, quality inspection to unrestricted use, and the cocoa is
 * free to be issued to an order. A reject posts 323, quality inspection to
 * blocked, and it stands there: counted, owned, and not to be touched until
 * somebody decides what happens to it.
 *
 * The movement is dated by the decision, not by the clock. A decision taken
 * about goods received last month belongs to last month's stock, and a phase
 * that writes a frozen timeline cannot have one document in it dated the day
 * the container happened to run.
 */
async function ensureDecision(
  client: string,
  timeline: DemoTimeline,
  plan: DeliveryPlan,
  lotNumber: string,
): Promise<{ decided: boolean; moved: boolean }> {
  const standing = await getUsageDecisionView(client, lotNumber);
  if (standing) {
    return { decided: true, moved: standing.stockPosted && standing.stockDocumentNumber !== null };
  }

  const decisionDate = dateIn(timeline, plan.period, plan.decisionDay);
  const decision = await withActingUser(client, INSPECTOR, (actor) => postUsageDecisionWithStock({
    client,
    changedBy: INSPECTOR,
    lotNumber,
    decisionCode: plan.decisionCode,
    decisionDate,
    postingDate: decisionDate,
    requestKey: `DEMO-QM-DEC-${plan.key}`,
  }, { authorization: actor }));
  return {
    decided: true,
    moved: decision.stockPosted && decision.stockDocumentNumber !== null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The invoice and the payment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Book the supplier's invoice, at the price the order carries.
 *
 * Both deliveries are invoiced, and both are paid. That is not an assertion
 * that the goods passed — the second delivery is paid for and then rejected,
 * which is exactly why blocked stock exists and exactly why the credit note is
 * still outstanding. It is what keeps the ledgers the earlier phases assert
 * intact: GR/IR clears, and the payables ageing carries what D1 and D4 left
 * there and nothing from this phase.
 */
async function ensureInvoice(
  client: string,
  timeline: DemoTimeline,
  plan: DeliveryPlan,
  orderNumber: string,
): Promise<boolean> {
  const requestKey = `DEMO-QM-IR-${plan.key}`;
  if (await findByRequestKey(client, 'supplier_invoice', requestKey, 'invoice_number')) return true;

  const postingDate = dateIn(timeline, plan.period, plan.invoiceDay);
  await postSupplierInvoice({
    client,
    changedBy: DEMO_ACTOR,
    orderNumber,
    supplierReference: `INV-QM-${plan.key}`,
    invoiceDate: postingDate,
    postingDate,
    grossAmount: grossOf(plan),
    headerText: 'QM delivery invoice',
    requestKey,
    lines: [{
      itemNumber: 10,
      quantity: plan.quantity,
      netAmount: netOf(plan),
      taxCode: STANDARD_TAX_CODE,
    }],
  });
  return true;
}

/**
 * Pay what the invoice billed, and nothing else.
 *
 * The item is named — the invoice this phase booked — rather than taken as the
 * supplier's oldest, because the supplier has other invoices standing from D1
 * and a payment that quietly settled one of those would change the ageing the
 * earlier phases are written against.
 */
async function ensurePayment(
  client: string,
  timeline: DemoTimeline,
  plan: DeliveryPlan,
): Promise<boolean> {
  const requestKey = `DEMO-QM-PAY-${plan.key}`;
  if (await findByRequestKey(client, 'outgoing_payment', requestKey, 'payment_number')) return true;

  const journal = await findByRequestKey(
    client, 'supplier_invoice', `DEMO-QM-IR-${plan.key}`, 'journal_document_number',
  );
  if (!journal) return false;

  const payable = await getPayables(client, plan.supplier, COMPANY_CODE);
  const open = payable.openItems
    .filter((item) => Number(item.signed) > 0 && item.documentNumber === journal);
  if (open.length === 0) return false;
  const amount = round3(open.reduce((sum, item) => sum + Number(item.amount), 0));
  if (!(amount > 0)) return false;

  const postingDate = dateIn(timeline, plan.paymentPeriod, plan.paymentDay);
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
    items: open.map((item) => ({
      documentNumber: item.documentNumber,
      fiscalYear: item.fiscalYear,
      lineNumber: item.lineNumber,
      applied: Number(item.amount),
    })),
  }, { authorization: actor }));
  return true;
}
