/**
 * Development-only walkthrough asset procurement.
 *
 * The walkthrough seed proper (`walkthrough-seed.ts`) buys stock: goods receipt,
 * then invoice, then payment. This module is the other kind of purchase — the one
 * that buys no stock at all. One order item is assigned to a fixed asset, takes no
 * goods receipt because there is nothing to receive, and capitalizes as the
 * supplier invoice is verified: the value is charged to the asset and the supplier
 * is credited, with no stock movement and no GR/IR balance either side of it.
 *
 * Everything goes through the same ordinary domain services the screens use —
 * `createAsset` (AS01), `createOrder` (ME21N), invoice verification (MIRO) and
 * outgoing payment. Nothing is written with SQL: the reads below only check what
 * the services posted. No authorization check is bypassed, and the invoice is
 * handed the capability the walkthrough administrator holds.
 *
 * Every document carries its own request key, so a re-run with the same database,
 * tenant and date resumes where a previous attempt stopped without posting a
 * second acquisition against the same asset.
 */

import { sql } from 'drizzle-orm';

import { withTenant, type Tx } from '../platform/db/client';

import { createAsset } from '../modules/finance/asset-master';
import { getPayables, postOutgoingPayment } from '../modules/finance/outgoing-payment';
import { getVendorClearing } from '../modules/finance/vendor-clearing';
import { createOrder, getOrder } from '../modules/purchasing/orders';
import { getInvoiceOrder, postSupplierInvoice } from '../modules/purchasing/invoice-verification';

export interface AssetContext {
  tenant: string;
  /** The signed-in walkthrough administrator; used as `changedBy` on every write. */
  actor: string;
  company: string;
  plant: string;
  chart: string;
  purchasingOrg: string;
  purchasingGroup: string;
  supplier: string;
  currency: string;
  taxCode: string;
  /** Active asset transaction type of kind ACQUISITION, ensured before this runs. */
  transactionType: string;
  /** Active asset class carrying a reconciliation account, ensured before this runs. */
  assetClass: string;
  /** The account that class capitalizes on. An asset assignment row carries it too. */
  assetAccount: string;
  requestPrefix: string;
  invoiceDate: string;
  postingDate: string;
  paymentDate: string;
  record: (label: string, created: boolean) => void;
}

export interface AssetProcurementResult {
  assetNumber: string;
  subNumber: string;
  orderNumber: string;
  invoiceNumber: string;
  paymentNumber: string;
  netAmount: number;
  taxAmount: number;
  grossAmount: number;
  /** What the invoice capitalized on the asset: the net value, no tax. */
  acquiredValue: number;
  /** Goods movements recorded against the order. Must be zero. */
  goodsMovements: number;
  /** Lines on the GR/IR clearing account in the invoice journal. Must be zero. */
  grIrLines: number;
}

/** What the machine costs, net of tax. One unit, so the figures stay readable. */
const NET_AMOUNT = 5000;
const QUANTITY = 1;
const UNIT = 'PC';
const DESCRIPTION = 'Walkthrough machine';
const BANK_ACCOUNT = '101000';

const phase = (name: string, error: unknown): never => {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(`Walkthrough asset procurement ${name} failed: ${detail}`);
};

/* ── Entry point ────────────────────────────────────────────────────────────── */

export async function runWalkthroughAssetProcurement(ctx: AssetContext): Promise<AssetProcurementResult> {
  const key = (name: string) => `${ctx.requestPrefix}-${ctx.tenant.toLowerCase()}-asset-${name}`;

  const asset = await ensureAsset(ctx);
  const order = await ensureOrder(ctx, asset);
  const invoice = await ensureInvoice(ctx, order, key('invoice'));
  const accounting = await assertAssetAccounting(ctx, order, invoice);
  const paymentNumber = await ensurePayment(ctx, invoice, key('payment'));

  return {
    assetNumber: asset.assetNumber,
    subNumber: asset.subNumber,
    orderNumber: order.orderNumber,
    invoiceNumber: invoice.invoiceNumber,
    paymentNumber,
    netAmount: invoice.netAmount,
    taxAmount: invoice.taxAmount,
    grossAmount: invoice.grossAmount,
    acquiredValue: accounting.acquiredValue,
    goodsMovements: accounting.goodsMovements,
    grIrLines: accounting.grIrLines,
  };
}

/* ── The asset ──────────────────────────────────────────────────────────────── */

interface AssetRef { assetNumber: string; subNumber: string }

/**
 * The machine the order capitalizes, created once and adopted on a re-run. An
 * asset cannot be acquired before it exists, so there is no way to discover this
 * one from a posted document: it is found by its own description, and two of them
 * is a hard stop rather than a guess at which was intended.
 */
async function ensureAsset(ctx: AssetContext): Promise<AssetRef> {
  try {
    const rows = await withTenant(ctx.tenant, (tx: Tx) => tx.execute(sql`
      select asset_number, sub_number
        from public.fixed_asset
       where client = ${ctx.tenant} and company_code = ${ctx.company}
         and asset_class = ${ctx.assetClass} and description_1 = ${DESCRIPTION}
         and status = 'ACTIVE'
       order by asset_number, sub_number
    `) as unknown as Promise<Array<{ asset_number: string; sub_number: string }>>);
    if (rows.length > 1) {
      throw new Error(`More than one ${DESCRIPTION} stands in company ${ctx.company}; refusing to guess which one the order capitalizes.`);
    }
    if (rows.length === 1) {
      const found = { assetNumber: rows[0]!.asset_number, subNumber: rows[0]!.sub_number };
      ctx.record(`asset ${found.assetNumber}/${found.subNumber}`, false);
      return found;
    }
    const [created] = await createAsset({
      client: ctx.tenant, changedBy: ctx.actor, companyCode: ctx.company, assetClass: ctx.assetClass,
      description1: DESCRIPTION, description2: 'Walkthrough',
      capitalizationDate: ctx.invoiceDate,
      assignment: { validFrom: ctx.invoiceDate, plant: ctx.plant },
    });
    if (!created) throw new Error('The asset master did not return the created asset.');
    ctx.record(`asset ${created.assetNumber}/${created.subNumber}`, true);
    return { assetNumber: created.assetNumber, subNumber: created.subNumber };
  } catch (error) {
    return phase('asset master', error);
  }
}

/* ── The order ──────────────────────────────────────────────────────────────── */

interface AssetOrder { orderNumber: string; itemNumber: number }

/**
 * The order that buys the machine. It carries no material: the item is a text
 * item assigned to the asset, which is exactly what makes a goods receipt
 * meaningless for it.
 */
async function ensureOrder(ctx: AssetContext, asset: AssetRef): Promise<AssetOrder> {
  try {
    const candidates = await withTenant(ctx.tenant, (tx: Tx) => tx.execute(sql`
      select o.order_number
        from public.purchase_order o
        join public.purchase_order_item i
          on i.client = o.client and i.order_number = o.order_number
       where o.client = ${ctx.tenant} and o.created_by = ${ctx.actor}
         and o.company_code = ${ctx.company} and o.supplier_number = ${ctx.supplier}
         and i.account_assignment_category = 'ASSET'
       order by o.order_number
    `) as unknown as Promise<Array<{ order_number: string }>>);
    if (candidates.length > 1) {
      throw new Error('More than one asset-assigned purchase order exists under the seed actor/supplier; refusing to guess which is the walkthrough order.');
    }
    if (candidates.length === 1) {
      const orderNumber = candidates[0]!.order_number;
      const order = await getOrder(ctx.tenant, orderNumber);
      if (!order) throw new Error(`Asset purchase order ${orderNumber} is not readable.`);
      const item = order.items[0];
      if (order.supplierNumber !== ctx.supplier || order.companyCode !== ctx.company || order.currency !== ctx.currency ||
          order.items.length !== 1 || !item || item.accountAssignmentCategory !== 'ASSET' ||
          !moneyEqual(Number(item.quantity), QUANTITY, 0.0005) || !moneyEqual(Number(item.netPrice), NET_AMOUNT, 0.0005) ||
          item.plant !== ctx.plant || item.taxCode !== ctx.taxCode ||
          item.assignments.length !== 1 || item.assignments[0]!.assetNumber !== asset.assetNumber ||
          item.assignments[0]!.assetSubNumber !== asset.subNumber ||
          item.assignments[0]!.assetTransactionType !== ctx.transactionType) {
        throw new Error(`Asset purchase order ${orderNumber} differs from the expected payload; refusing to modify or replay it.`);
      }
      ctx.record(`asset purchase order ${orderNumber}`, false);
      return { orderNumber, itemNumber: item.itemNumber };
    }
    const created = await createOrder({
      client: ctx.tenant, changedBy: ctx.actor, supplierNumber: ctx.supplier,
      purchasingOrg: ctx.purchasingOrg, purchasingGroup: ctx.purchasingGroup,
      companyCode: ctx.company, currency: ctx.currency,
      items: [{
        // No material and no storage location: the item buys a machine, not stock,
        // so there is nothing to receive and nowhere to receive it.
        shortText: `${DESCRIPTION} (capital)`, quantity: QUANTITY, unit: UNIT,
        netPrice: NET_AMOUNT, priceUnit: 1, plant: ctx.plant, taxCode: ctx.taxCode,
        accountAssignmentCategory: 'ASSET',
        assignments: [{
          // The class decides the account an asset is capitalized on, not the buyer;
          // the row carries it so the order can say where the value is going.
          glAccount: ctx.assetAccount,
          assetNumber: asset.assetNumber, assetSubNumber: asset.subNumber,
          assetTransactionType: ctx.transactionType, distributionPercentage: 100,
        }],
        scheduleLines: [{ deliveryDate: ctx.invoiceDate, quantity: QUANTITY }],
      }],
    });
    const order = await getOrder(ctx.tenant, created.orderNumber);
    const item = order?.items[0];
    if (!order || !item) throw new Error(`Asset purchase order ${created.orderNumber} was not readable after creation.`);
    if (item.accountAssignmentCategory !== 'ASSET') throw new Error(`Asset purchase order ${order.orderNumber} did not keep the asset assignment.`);
    ctx.record(`asset purchase order ${order.orderNumber}`, true);
    return { orderNumber: order.orderNumber, itemNumber: item.itemNumber };
  } catch (error) {
    return phase('purchase order', error);
  }
}

/* ── The invoice ────────────────────────────────────────────────────────────── */

interface AssetInvoice {
  invoiceNumber: string;
  fiscalYear: number;
  journalDocumentNumber: string;
  netAmount: number;
  taxAmount: number;
  grossAmount: number;
}

/**
 * The invoice that capitalizes the machine. It is posted against the order and
 * not against a goods receipt, because there is no goods receipt: the item was
 * assigned to an asset precisely so that no stock would be involved.
 */
async function ensureInvoice(ctx: AssetContext, order: AssetOrder, requestKey: string): Promise<AssetInvoice> {
  try {
    const existing = await withTenant(ctx.tenant, (tx: Tx) => tx.execute(sql`
      select invoice_number, fiscal_year, journal_document_number, gross_amount, tax_amount, status
        from public.supplier_invoice
       where client = ${ctx.tenant} and request_key = ${requestKey}
    `) as unknown as Promise<Array<{ invoice_number: string; fiscal_year: number; journal_document_number: string; gross_amount: string; tax_amount: string; status: string }>>);
    if (existing.length > 1) throw new Error(`More than one supplier invoice stands under request key ${requestKey}.`);
    if (existing.length === 1) {
      const row = existing[0]!;
      if (row.status !== 'POSTED' || !row.journal_document_number) {
        throw new Error(`Asset supplier invoice ${row.invoice_number} stands ${row.status} without a journal document.`);
      }
      const gross = Number(row.gross_amount);
      const tax = Number(row.tax_amount);
      if (!moneyEqual(gross - tax, NET_AMOUNT, 0.01)) {
        throw new Error(`Asset supplier invoice ${row.invoice_number} carries net ${gross - tax}; expected ${NET_AMOUNT}.`);
      }
      ctx.record(`asset supplier invoice ${row.invoice_number}`, false);
      return {
        invoiceNumber: row.invoice_number, fiscalYear: row.fiscal_year,
        journalDocumentNumber: row.journal_document_number,
        netAmount: round2(gross - tax), taxAmount: round2(tax), grossAmount: round2(gross),
      };
    }
    // Eligibility is read before posting so the reason is visible if it changes: an
    // account-assigned item is invoiceable for what was ordered, not what was received.
    const view = await getInvoiceOrder(ctx.tenant, order.orderNumber);
    const line = view?.items.find((item) => item.itemNumber === order.itemNumber);
    if (!view || !line) throw new Error(`Order ${order.orderNumber} item ${order.itemNumber} is not readable for invoicing.`);
    if (!moneyEqual(line.invoiceable, QUANTITY, 0.0005)) {
      throw new Error(`Order ${order.orderNumber} item ${order.itemNumber} offers ${line.invoiceable} to invoice; expected ${QUANTITY}.`);
    }
    const taxAmount = round2(NET_AMOUNT * TAX_RATE);
    const grossAmount = round2(NET_AMOUNT + taxAmount);
    const posted = await postSupplierInvoice({
      client: ctx.tenant, changedBy: ctx.actor, orderNumber: order.orderNumber,
      supplierReference: `${ctx.tenant}-AS-INV-01`,
      invoiceDate: ctx.invoiceDate, postingDate: ctx.postingDate,
      grossAmount, requestKey,
      lines: [{ itemNumber: order.itemNumber, quantity: QUANTITY, netAmount: NET_AMOUNT, taxCode: ctx.taxCode }],
    });
    if (posted.status !== 'POSTED' || !posted.journalDocumentNumber) {
      throw new Error(`Asset supplier invoice ${posted.invoiceNumber} stands ${posted.status} without a journal document.`);
    }
    if (!moneyEqual(Number(posted.taxAmount), taxAmount, 0.01) || !moneyEqual(Number(posted.grossAmount), grossAmount, 0.01)) {
      throw new Error(`Asset supplier invoice ${posted.invoiceNumber} carried ${posted.grossAmount} gross of ${posted.taxAmount} tax; expected ${grossAmount} gross of ${taxAmount} tax.`);
    }
    ctx.record(`asset supplier invoice ${posted.invoiceNumber}`, true);
    return {
      invoiceNumber: posted.invoiceNumber, fiscalYear: posted.fiscalYear,
      journalDocumentNumber: posted.journalDocumentNumber,
      netAmount: NET_AMOUNT, taxAmount, grossAmount,
    };
  } catch (error) {
    return phase('invoice verification', error);
  }
}

/**
 * The tax rate the walkthrough's input tax code applies. It is a property of the
 * tenant's tax configuration, and the posting above refuses the invoice if the
 * service disagrees, so this is only used to state the expected gross amount.
 */
const TAX_RATE = 0.05;

/* ── What the invoice posted ────────────────────────────────────────────────── */

interface AccountingCheck { acquiredValue: number; goodsMovements: number; grIrLines: number }

/**
 * Read back what the invoice did, which is the whole point of the path:
 *  - the asset carries the net value, capitalized by the invoice itself;
 *  - no goods movement stands against the order, because none was posted and none
 *    is possible for an account-assigned item;
 *  - the invoice journal touches neither the GR/IR clearing account nor any stock
 *    account, so no balance is left for anyone to explain later.
 */
async function assertAssetAccounting(ctx: AssetContext, order: AssetOrder, invoice: AssetInvoice): Promise<AccountingCheck> {
  try {
    const [acquisition] = await withTenant(ctx.tenant, (tx: Tx) => tx.execute(sql`
      select amount::text as amount, status
        from public.asset_transaction
       where client = ${ctx.tenant} and company_code = ${ctx.company}
         and transaction_type = ${ctx.transactionType}
         and document_number = ${invoice.journalDocumentNumber}
         and fiscal_year = ${invoice.fiscalYear}
    `) as unknown as Promise<Array<{ amount: string; status: string }>>);
    if (!acquisition) {
      throw new Error(`No ${ctx.transactionType} acquisition stands on journal ${invoice.journalDocumentNumber}; the invoice did not capitalize the asset.`);
    }
    if (acquisition.status !== 'ACTIVE') throw new Error(`The acquisition on journal ${invoice.journalDocumentNumber} stands ${acquisition.status}.`);
    const acquiredValue = Number(acquisition.amount);
    if (!moneyEqual(acquiredValue, invoice.netAmount, 0.01)) {
      throw new Error(`The acquisition capitalized ${acquiredValue}; expected the net invoice value ${invoice.netAmount}.`);
    }

    const [movements] = await withTenant(ctx.tenant, (tx: Tx) => tx.execute(sql`
      select count(*)::int as movements
        from public.material_document_line
       where client = ${ctx.tenant} and purchase_order_number = ${order.orderNumber}
    `) as unknown as Promise<Array<{ movements: number }>>);
    const goodsMovements = Number(movements?.movements ?? 0);
    if (goodsMovements !== 0) {
      throw new Error(`Order ${order.orderNumber} stands with ${goodsMovements} goods movement line(s); an asset-assigned item receives nothing.`);
    }

    const [lines] = await withTenant(ctx.tenant, (tx: Tx) => tx.execute(sql`
      select coalesce(sum(case when l.gl_account in (select gl_account from public.account_determination
                                                      where client = ${ctx.tenant} and chart_of_accounts = ${ctx.chart}
                                                        and event in ('GR_IR_CLEARING', 'INVENTORY'))
                               then 1 else 0 end), 0)::int as clearing_lines
        from public.journal_entry_line l
       where l.client = ${ctx.tenant} and l.document_number = ${invoice.journalDocumentNumber}
         and l.fiscal_year = ${invoice.fiscalYear}
    `) as unknown as Promise<Array<{ clearing_lines: number }>>);
    const grIrLines = Number(lines?.clearing_lines ?? 0);
    if (grIrLines !== 0) {
      throw new Error(`Invoice journal ${invoice.journalDocumentNumber} carries ${grIrLines} GR/IR or stock line(s); an asset-assigned invoice clears no goods-received balance.`);
    }
    return { acquiredValue, goodsMovements, grIrLines };
  } catch (error) {
    return phase('accounting verification', error);
  }
}

/* ── Settling it ────────────────────────────────────────────────────────────── */

/**
 * Pay the invoice, so the tenant that reconciles to zero open items at the end
 * still does. The payment settles the one line this invoice left open, not
 * whatever else happens to be outstanding for the supplier.
 */
async function ensurePayment(ctx: AssetContext, invoice: AssetInvoice, requestKey: string): Promise<string> {
  try {
    const existing = await withTenant(ctx.tenant, (tx: Tx) => tx.execute(sql`
      select payment_number from public.outgoing_payment
       where client = ${ctx.tenant} and request_key = ${requestKey}
    `) as unknown as Promise<Array<{ payment_number: string }>>);
    if (existing.length > 1) throw new Error(`More than one payment stands under request key ${requestKey}.`);
    if (existing.length === 1) {
      const clearing = await getVendorClearing(ctx.tenant, ctx.supplier, ctx.company);
      if (!clearing.clearedItems.some((item) => item.documentNumber === invoice.journalDocumentNumber)) {
        throw new Error(`Payment ${existing[0]!.payment_number} did not clear invoice ${invoice.invoiceNumber}.`);
      }
      ctx.record(`asset supplier payment ${existing[0]!.payment_number}`, false);
      return existing[0]!.payment_number;
    }
    const payables = await getPayables(ctx.tenant, ctx.supplier, ctx.company);
    const open = payables.openItems.filter((item) => item.documentNumber === invoice.journalDocumentNumber);
    if (open.length !== 1 || !moneyEqual(Number(open[0]!.amount), invoice.grossAmount, 0.01)) {
      throw new Error(`Expected one open ${ctx.supplier} line of ${invoice.grossAmount} for asset invoice ${invoice.invoiceNumber}; found ${open.length}.`);
    }
    const payment = await postOutgoingPayment({
      client: ctx.tenant, changedBy: ctx.actor, vendorNumber: ctx.supplier, companyCode: ctx.company,
      documentDate: ctx.paymentDate, postingDate: ctx.paymentDate, clearingDate: ctx.paymentDate,
      bankGlAccount: BANK_ACCOUNT, amount: invoice.grossAmount, currency: ctx.currency,
      reference: `${ctx.tenant}-AS-PAY`, requestKey,
      items: [{ documentNumber: invoice.journalDocumentNumber, fiscalYear: invoice.fiscalYear, lineNumber: open[0]!.lineNumber }],
    });
    if (!moneyEqual(Number(payment.amount), invoice.grossAmount) || payment.itemsCleared !== 1) {
      throw new Error(`Asset supplier payment ${payment.paymentNumber} did not settle the invoice.`);
    }
    const clearing = await getVendorClearing(ctx.tenant, ctx.supplier, ctx.company);
    if (clearing.openItems.some((item) => item.documentNumber === invoice.journalDocumentNumber)) {
      throw new Error(`Invoice ${invoice.invoiceNumber} stands open after payment ${payment.paymentNumber}.`);
    }
    ctx.record(`asset supplier payment ${payment.paymentNumber}`, true);
    return payment.paymentNumber;
  } catch (error) {
    return phase('payment', error);
  }
}

/* ── Small helpers ──────────────────────────────────────────────────────────── */

const round2 = (value: number) => Math.round(value * 100) / 100;

const moneyEqual = (a: number, b: number, tolerance = 0.01) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
