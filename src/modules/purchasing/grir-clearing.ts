/**
 * Maintain GR/IR clearing — SCR-163 / PROC.GRIR.MAINTAIN.
 *
 * A goods receipt credits GR/IR at the price on that receipt. An invoice
 * debits GR/IR at the expected amount stored on the invoice. The residual
 * is that posted difference, less any maintenance document that still
 * stands. A price variance that invoice verification already sent to price
 * difference is not cleared again.
 *
 * A check writes nothing. A post writes one balanced journal through the
 * canonical posting service and links it to the purchase-order item. It
 * does not create a material document and it does not change stock. A
 * reversal is a compensating journal. The original is not deleted.
 *
 * F.19 remains the period-end accrual. This is not that write.
 */
import { sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, reverseJournalEntry, PostingError } from '../../platform/posting';
import { getMaterialPeriodControlInTx } from '../inventory/goods-issue';
import { postingValuationRefusal } from '../inventory/valuation-class-definition';
import { materialPeriodAllows } from '../inventory/material-period-control';

export const GRIR_CLEARING_CAPABILITY = 'PROC.GRIR.MAINTAIN';
export const GRIR_CLEARING_POST_CAPABILITY = 'PROC.GRIR.MAINTAIN.POST';
export const GRIR_CLEARING_REVERSE_CAPABILITY = 'PROC.GRIR.MAINTAIN.REVERSE';
export const GRIR_CLEARING_ROUTE = '/purchasing/grir-clearing';
export const GRIR_CLEARING_ALIASES = ['MR11'] as const;
const JOURNAL_DOCUMENT_TYPE = 'SA';
const ORIGIN_CLASS = 'gr_ir_maintenance';

export class GrIrClearingError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'GrIrClearingError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new GrIrClearingError(message, remedy);
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const MONEY = 0.005;
const QTY = 0.0005;

const REFUSED: Record<string, string> = {
  deliveryCost: 'A delivery cost is not a GR/IR residual this round.',
  consignment: 'Consignment is not a GR/IR residual this round.',
  service: 'A service item is not a GR/IR residual this round.',
  accountAssignment: 'An account assignment is not cleared through GR/IR this round.',
  currency: 'A currency is not an input. The residual stays in the order currency.',
  exchangeRate: 'An exchange rate is not read.',
  quantity: 'A quantity adjustment is not a material movement. Stock is not changed.',
  stock: 'Stock is not changed to clear GR/IR.',
  movement: 'A material movement is not posted.',
  approval: 'An approval is not a GR/IR clearing.',
  batch: 'A batch is not a GR/IR clearing.',
  export: 'An export is not a GR/IR clearing.',
  paymentBlock: 'A payment block is not a GR/IR clearing.',
  outbox: 'An outbox is not written.',
  uuid: 'A uuid is not an identifier.',
  valueOnly: 'A value difference is not posted from a named amount. The residual is the posted GR/IR difference.',
};

export function refuseNamed(named: Record<string, string | undefined> | undefined): void {
  if (!named) return;
  for (const [key, message] of Object.entries(REFUSED)) {
    if (named[key] !== undefined && named[key] !== '') fail(message);
  }
}

export interface GrIrSelection {
  companyFrom: string;
  companyTo?: string;
  orderFrom?: string;
  orderTo?: string;
  itemNumber?: string;
  plantFrom?: string;
  plantTo?: string;
  keyDate: string;
  surplus?: string;
}

export interface GrIrResidual {
  orderNumber: string;
  itemNumber: number;
  companyCode: string;
  supplier: string;
  materialNumber: string | null;
  shortText: string;
  plant: string;
  unit: string;
  currency: string;
  orderedQuantity: number;
  receivedQuantity: number;
  invoicedQuantity: number;
  openQuantity: number;
  grIrValue: number;
  remaining: number;
  surplus: 'DELIVERY' | 'INVOICE';
  category: 'QUANTITY' | 'VALUE';
  fingerprint: string;
  eligible: boolean;
  furtherActivity: string | null;
  refusal: string | null;
  grIrAccount: string | null;
  offsetAccount: string | null;
  valuationClass: string | null;
}

export interface GrIrMaintenanceRow {
  documentNumber: string;
  fiscalYear: number;
  orderNumber: string;
  itemNumber: number;
  companyCode: string;
  postingDate: string;
  surplus: string;
  allocatedAmount: string;
  currency: string;
  comment: string;
  createdBy: string;
  reversedBy: string | null;
}

export interface GrIrPostResult {
  wrote: boolean;
  documentNumber: string;
  fiscalYear: number;
  orderNumber: string;
  itemNumber: number;
  amount: string;
  surplus: 'DELIVERY' | 'INVOICE';
  grIrAccount: string;
  offsetAccount: string;
}

function date(value: string, label: string): string {
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail(`${label} ${value} is not a calendar date.`);
  return text;
}

function bound(value: string | undefined): string {
  return (value ?? '').trim().toUpperCase();
}

function selectionOf(input: GrIrSelection): GrIrSelection & { companyFrom: string; keyDate: string } {
  const companyFrom = bound(input.companyFrom);
  const companyTo = bound(input.companyTo);
  const orderFrom = bound(input.orderFrom);
  const orderTo = bound(input.orderTo);
  const plantFrom = bound(input.plantFrom);
  const plantTo = bound(input.plantTo);
  const itemNumber = (input.itemNumber ?? '').trim();
  const surplus = bound(input.surplus) || 'BOTH';
  if (!companyFrom) fail('A company code is required.');
  if (companyTo && companyTo < companyFrom) fail('Company code to is before company code from.');
  if (orderTo && orderFrom && orderTo < orderFrom) fail('Purchasing document to is before purchasing document from.');
  if (plantTo && plantFrom && plantTo < plantFrom) fail('Plant to is before plant from.');
  if (itemNumber && !/^\d+$/.test(itemNumber)) fail('The purchasing document item is not a number.');
  if (!['DELIVERY', 'INVOICE', 'BOTH'].includes(surplus)) {
    fail('The surplus direction is delivery, invoice, or both.');
  }
  if (['DELIVERY_COST', 'CONSIGNMENT', 'SERVICE'].includes(surplus)) {
    fail('That clearing category is not supported this round.');
  }
  return {
    companyFrom,
    companyTo,
    orderFrom,
    orderTo,
    plantFrom,
    plantTo,
    itemNumber,
    keyDate: date(input.keyDate, 'The key date'),
    surplus,
  };
}

interface ItemFact {
  order_number: string;
  item_number: number;
  company_code: string;
  supplier_number: string;
  currency: string;
  material_number: string | null;
  short_text: string;
  plant: string;
  unit: string;
  ordered_qty: string;
  item_category: string;
  account_assignment_category: string | null;
  chart_of_accounts: string;
  company_currency: string;
  valuation_class: string | null;
  overdelivery_tolerance: string | null;
}

interface MoveLine {
  order_number: string;
  item_number: number;
  document_number: string;
  line_number: number;
  movement_type: string;
  line_direction: string;
  reversal_of_document: string | null;
  reversal_of_line: number | null;
  quantity: string;
  unit_price: string;
  price_unit: string;
}

interface InvoiceLine {
  order_number: string;
  item_number: number;
  quantity: string;
  expected_amount: string;
  category: string;
}

interface PriorLine {
  order_number: string;
  item_number: number;
  allocated_amount: string;
}

function keyOf(order: string, item: number): string {
  return `${order}|${item}`;
}

function postedValue(quantity: number, unitPrice: number, priceUnit: number): number {
  const unit = priceUnit > 0 ? priceUnit : 1;
  return round2((quantity * unitPrice) / unit);
}

async function loadResiduals(tx: Tx, client: string, selection: ReturnType<typeof selectionOf>): Promise<GrIrResidual[]> {
  const items = await tx.execute(sql`
    select po.order_number, poi.item_number, po.company_code, po.supplier_number, po.currency,
           poi.material_number, poi.short_text, poi.plant, poi.unit, poi.quantity as ordered_qty,
           poi.item_category, poi.account_assignment_category,
           cc.chart_of_accounts, cc.currency as company_currency,
           mv.valuation_class, mp.overdelivery_tolerance
      from purchase_order po
      join purchase_order_item poi
        on poi.client = po.client and poi.order_number = po.order_number
      join company_code cc
        on cc.client = po.client and cc.company_code = po.company_code
      left join material_valuation mv
        on mv.client = poi.client and mv.material_number = poi.material_number and mv.valuation_area = poi.plant
      left join material_plant mp
        on mp.client = poi.client and mp.material_number = poi.material_number and mp.plant = poi.plant
     where po.client = ${client}
       and po.company_code >= ${selection.companyFrom}
       and (${selection.companyTo || null}::varchar is null or po.company_code <= ${selection.companyTo || null})
       and (${selection.orderFrom || null}::varchar is null or po.order_number >= ${selection.orderFrom || null})
       and (${selection.orderTo || null}::varchar is null or po.order_number <= ${selection.orderTo || null})
       and (${selection.plantFrom || null}::varchar is null or poi.plant >= ${selection.plantFrom || null})
       and (${selection.plantTo || null}::varchar is null or poi.plant <= ${selection.plantTo || null})
       and (${selection.itemNumber || null}::int is null or poi.item_number = ${selection.itemNumber ? Number(selection.itemNumber) : null})
     order by po.order_number, poi.item_number
  `) as unknown as ItemFact[];
  if (items.length === 0) return [];

  const moves = await tx.execute(sql`
    select l.purchase_order_number as order_number, l.purchase_order_item as item_number,
           l.material_document_number as document_number, l.line_number,
           l.movement_type, l.line_direction, l.reversal_of_document, l.reversal_of_line,
           l.base_quantity as quantity, l.unit_price, l.price_unit
      from material_document_line l
      join material_document h
        on h.client = l.client and h.material_document_number = l.material_document_number
      join purchase_order po
        on po.client = l.client and po.order_number = l.purchase_order_number
     where l.client = ${client}
       and l.purchase_order_number is not null
       and h.posting_date <= ${selection.keyDate}
       and po.company_code >= ${selection.companyFrom}
       and (${selection.companyTo || null}::varchar is null or po.company_code <= ${selection.companyTo || null})
  `) as unknown as MoveLine[];
  const directions = new Map<string, string>();
  const movementRows = await tx.execute(sql`
    select movement_type, direction from movement_type where client = ${client}
  `) as unknown as Array<{ movement_type: string; direction: string }>;
  for (const row of movementRows) directions.set(row.movement_type, row.direction);

  const sign = new Map<string, number>();
  for (const row of moves) {
    const configured = directions.get(row.movement_type) ?? row.line_direction;
    if (configured === 'REVERSAL') continue;
    sign.set(`${row.document_number}/${row.line_number}`, configured === 'ISSUE' ? -1 : 1);
  }
  for (const row of moves) {
    const configured = directions.get(row.movement_type) ?? row.line_direction;
    if (configured !== 'REVERSAL' || !row.reversal_of_document || row.reversal_of_line == null) continue;
    sign.set(
      `${row.document_number}/${row.line_number}`,
      -(sign.get(`${row.reversal_of_document}/${row.reversal_of_line}`) ?? 1),
    );
  }
  const received = new Map<string, { qty: number; value: number }>();
  for (const row of moves) {
    if (row.item_number == null) continue;
    const rowSign = sign.get(`${row.document_number}/${row.line_number}`) ?? 1;
    const qty = rowSign * Number(row.quantity);
    const value = rowSign * postedValue(Number(row.quantity), Number(row.unit_price), Number(row.price_unit));
    const current = received.get(keyOf(row.order_number, row.item_number)) ?? { qty: 0, value: 0 };
    current.qty = round3(current.qty + qty);
    current.value = round2(current.value + value);
    received.set(keyOf(row.order_number, row.item_number), current);
  }

  const invoices = await tx.execute(sql`
    select i.purchase_order_number as order_number, i.purchase_order_item as item_number,
           i.quantity, i.expected_amount, h.category
      from supplier_invoice_item i
      join supplier_invoice h
        on h.client = i.client and h.invoice_number = i.invoice_number
      join purchase_order po
        on po.client = i.client and po.order_number = i.purchase_order_number
     where i.client = ${client}
       and h.status = 'POSTED'
       and h.cancellation_of is null
       and h.posting_date <= ${selection.keyDate}
       and po.company_code >= ${selection.companyFrom}
       and (${selection.companyTo || null}::varchar is null or po.company_code <= ${selection.companyTo || null})
  `) as unknown as InvoiceLine[];
  const invoiced = new Map<string, { qty: number; value: number; other: boolean }>();
  for (const row of invoices) {
    const current = invoiced.get(keyOf(row.order_number, row.item_number)) ?? { qty: 0, value: 0, other: false };
    if (row.category !== 'INVOICE') {
      current.other = true;
    } else {
      current.qty = round3(current.qty + Number(row.quantity));
      current.value = round2(current.value + Number(row.expected_amount));
    }
    invoiced.set(keyOf(row.order_number, row.item_number), current);
  }

  const priors = await tx.execute(sql`
    select l.order_number, l.item_number, l.allocated_amount
      from gr_ir_maintenance_link l
      join journal_entry j
        on j.client = l.client and j.document_number = l.document_number and j.fiscal_year = l.fiscal_year
     where l.client = ${client}
       and l.reversed_by is null
       and j.status <> 'REVERSED'
  `) as unknown as PriorLine[];
  const cleared = new Map<string, number>();
  for (const row of priors) {
    const id = keyOf(row.order_number, row.item_number);
    cleared.set(id, round2((cleared.get(id) ?? 0) + Number(row.allocated_amount)));
  }

  const accounts = await tx.execute(sql`
    select chart_of_accounts, event, valuation_class, gl_account
      from account_determination
     where client = ${client}
       and event in ('GR_IR_CLEARING', 'PRICE_DIFFERENCE')
  `) as unknown as Array<{ chart_of_accounts: string; event: string; valuation_class: string; gl_account: string }>;

  const rows: GrIrResidual[] = [];
  for (const item of items) {
    const id = keyOf(item.order_number, item.item_number);
    const got = received.get(id) ?? { qty: 0, value: 0 };
    const billed = invoiced.get(id) ?? { qty: 0, value: 0, other: false };
    const history = round2(got.value - billed.value);
    const remaining = round2(history - (cleared.get(id) ?? 0));
    const openQuantity = round3(got.qty - billed.qty);
    if (Math.abs(remaining) <= MONEY && Math.abs(history) <= MONEY) continue;
    if (Math.abs(remaining) <= MONEY) continue;

    const surplus: 'DELIVERY' | 'INVOICE' = remaining > 0 ? 'DELIVERY' : 'INVOICE';
    if (selection.surplus !== 'BOTH' && selection.surplus !== surplus) continue;
    const category: 'QUANTITY' | 'VALUE' = Math.abs(openQuantity) > QTY ? 'QUANTITY' : 'VALUE';
    const fingerprint = `${got.qty.toFixed(3)}|${billed.qty.toFixed(3)}|${remaining.toFixed(2)}`;
    const grIr = accounts.find((row) => row.chart_of_accounts === item.chart_of_accounts && row.event === 'GR_IR_CLEARING' && row.valuation_class === '');
    const offset = item.valuation_class
      ? accounts.find((row) => row.chart_of_accounts === item.chart_of_accounts && row.event === 'PRICE_DIFFERENCE' && row.valuation_class === item.valuation_class)
      : undefined;

    let refusal: string | null = null;
    let furtherActivity: string | null = null;
    if (item.item_category !== 'STANDARD') refusal = 'A service item is not a GR/IR residual this round.';
    else if (item.account_assignment_category) refusal = 'Account-assigned items do not post GR/IR.';
    else if (!item.material_number) refusal = 'A text item has no GR/IR residual.';
    else if (billed.other) refusal = 'A credit memo is not a GR/IR posting this round.';
    else if (item.currency !== item.company_currency) refusal = `The order currency ${item.currency} does not agree with the company currency ${item.company_currency}.`;
    else if (!grIr) refusal = `Account determination for GR_IR_CLEARING does not stand in chart ${item.chart_of_accounts}.`;
    else if (!item.valuation_class) refusal = `Material ${item.material_number} carries no valuation class in plant ${item.plant}.`;
    else refusal = await postingValuationRefusal(tx, client, item.material_number, item.valuation_class)
      ?? (!offset ? `Account determination for PRICE_DIFFERENCE and valuation class ${item.valuation_class} does not stand in chart ${item.chart_of_accounts}.` : null);

    const tolerance = Number(item.overdelivery_tolerance ?? 0);
    const toleranceMax = Number(item.ordered_qty) * (1 + tolerance / 100);
    if (!refusal && openQuantity > QTY) {
      furtherActivity = 'Further invoice can still be posted for the open quantity. Clearing it is not automatic.';
    } else if (!refusal && openQuantity < -QTY && got.qty + Math.abs(openQuantity) <= toleranceMax + 1e-9) {
      furtherActivity = 'Further goods receipt can still match the open quantity. Clearing it is not automatic.';
    }

    rows.push({
      orderNumber: item.order_number,
      itemNumber: item.item_number,
      companyCode: item.company_code,
      supplier: item.supplier_number,
      materialNumber: item.material_number,
      shortText: item.short_text,
      plant: item.plant,
      unit: item.unit,
      currency: item.currency,
      orderedQuantity: Number(item.ordered_qty),
      receivedQuantity: got.qty,
      invoicedQuantity: billed.qty,
      openQuantity,
      grIrValue: history,
      remaining,
      surplus,
      category,
      fingerprint,
      eligible: !refusal,
      furtherActivity,
      refusal,
      grIrAccount: grIr?.gl_account ?? null,
      offsetAccount: offset?.gl_account ?? null,
      valuationClass: item.valuation_class,
    });
  }
  return rows;
}

export async function listGrIrResiduals(input: { client: string } & GrIrSelection): Promise<GrIrResidual[]> {
  const selection = selectionOf(input);
  return withTenant(input.client, (tx) => loadResiduals(tx, input.client, selection));
}

export async function listGrIrMaintenance(input: { client: string } & GrIrSelection): Promise<GrIrMaintenanceRow[]> {
  const selection = selectionOf(input);
  return withTenant(input.client, async (tx) => {
    const rows = await tx.execute(sql`
      select l.document_number as "documentNumber", l.fiscal_year as "fiscalYear",
             l.order_number as "orderNumber", l.item_number as "itemNumber",
             l.company_code as "companyCode", l.posting_date::text as "postingDate",
             l.surplus, l.allocated_amount::text as "allocatedAmount",
             l.currency, l.comment, l.created_by as "createdBy", l.reversed_by as "reversedBy"
        from gr_ir_maintenance_link l
        join purchase_order po
          on po.client = l.client and po.order_number = l.order_number
       where l.client = ${input.client}
         and po.company_code >= ${selection.companyFrom}
         and (${selection.companyTo || null}::varchar is null or po.company_code <= ${selection.companyTo || null})
         and (${selection.orderFrom || null}::varchar is null or l.order_number >= ${selection.orderFrom || null})
         and (${selection.orderTo || null}::varchar is null or l.order_number <= ${selection.orderTo || null})
       order by l.document_number
    `) as unknown as GrIrMaintenanceRow[];
    return rows;
  });
}

export interface GrIrPreview {
  wouldWrite: false;
  residual: GrIrResidual | null;
  message: string;
}

export async function previewGrIrClearing(input: {
  client: string;
  orderNumber: string;
  itemNumber: number;
  keyDate: string;
  named?: Record<string, string | undefined>;
}): Promise<GrIrPreview> {
  refuseNamed(input.named);
  const found = await withTenant(input.client, async (tx) => {
    const [header] = await tx.execute(sql`
      select company_code from purchase_order
       where client = ${input.client} and order_number = ${input.orderNumber.trim().toUpperCase()}
    `) as unknown as Array<{ company_code: string }>;
    return header?.company_code ?? '';
  });
  if (!found) fail(`Purchase order ${input.orderNumber} does not stand.`);
  const listed = await listGrIrResiduals({
    client: input.client,
    companyFrom: found,
    companyTo: found,
    orderFrom: input.orderNumber,
    orderTo: input.orderNumber,
    itemNumber: String(input.itemNumber),
    keyDate: input.keyDate,
  });
  const residual = listed[0] ?? null;
  if (!residual) {
    return { wouldWrite: false, residual: null, message: 'No GR/IR residual stands for this item. Nothing was written.' };
  }
  const reason = residual.refusal ?? residual.furtherActivity ?? 'A manual clearing would post the residual. The journal would balance.';
  return { wouldWrite: false, residual, message: `${reason} Nothing was written.` };
}

async function oneResidual(tx: Tx, client: string, orderNumber: string, itemNumber: number, keyDate: string): Promise<GrIrResidual | null> {
  const [header] = await tx.execute(sql`
    select company_code from purchase_order
     where client = ${client} and order_number = ${orderNumber}
  `) as unknown as Array<{ company_code: string }>;
  if (!header) return null;
  const rows = await loadResiduals(tx, client, selectionOf({
    companyFrom: header.company_code,
    companyTo: header.company_code,
    orderFrom: orderNumber,
    orderTo: orderNumber,
    itemNumber: String(itemNumber),
    keyDate,
  }));
  return rows[0] ?? null;
}

async function byRequestKey(tx: Tx, client: string, requestKey: string): Promise<GrIrPostResult | null> {
  const [row] = await tx.execute(sql`
    select document_number, fiscal_year, order_number, item_number, allocated_amount::text as amount,
           surplus, gr_ir_account, offset_account
      from gr_ir_maintenance_link
     where client = ${client} and request_key = ${requestKey}
  `) as unknown as Array<{
    document_number: string; fiscal_year: number; order_number: string; item_number: number;
    amount: string; surplus: 'DELIVERY' | 'INVOICE'; gr_ir_account: string; offset_account: string;
  }>;
  if (!row) return null;
  return {
    wrote: false,
    documentNumber: row.document_number,
    fiscalYear: row.fiscal_year,
    orderNumber: row.order_number,
    itemNumber: row.item_number,
    amount: row.amount,
    surplus: row.surplus,
    grIrAccount: row.gr_ir_account,
    offsetAccount: row.offset_account,
  };
}

export async function postGrIrClearing(input: {
  client: string;
  changedBy: string;
  orderNumber: string;
  itemNumber: number;
  keyDate: string;
  postingDate: string;
  fingerprint: string;
  comment: string;
  requestKey: string;
  acknowledgeFurtherActivity?: boolean;
  named?: Record<string, string | undefined>;
}): Promise<GrIrPostResult> {
  refuseNamed(input.named);
  const orderNumber = bound(input.orderNumber);
  const keyDate = date(input.keyDate, 'The key date');
  const postingDate = date(input.postingDate, 'The posting date');
  const comment = input.comment.trim();
  const requestKey = input.requestKey.trim();
  if (!orderNumber) fail('A purchasing document is required.');
  if (!Number.isInteger(input.itemNumber) || input.itemNumber <= 0) fail('The purchasing document item is required.');
  if (!input.fingerprint.trim()) fail('The proposal is stale. List the residual again.');
  if (!comment || comment.length > 100) fail('A reason is required.');
  if (!requestKey) fail('A request key is required.');

  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, requestKey);
    if (replay) return replay;

    await tx.execute(sql`
      select item_number from purchase_order_item
       where client = ${input.client} and order_number = ${orderNumber} and item_number = ${input.itemNumber}
       for update
    `);
    const residual = await oneResidual(tx, input.client, orderNumber, input.itemNumber, keyDate);
    if (!residual) fail('No GR/IR residual stands for this item.', 'List the selection again.');
    if (residual.fingerprint !== input.fingerprint.trim()) {
      fail('The proposal is stale. The posted history changed. List the residual again.');
    }
    if (residual.refusal || !residual.eligible || !residual.grIrAccount || !residual.offsetAccount) {
      fail(residual.refusal ?? 'The residual cannot be cleared.');
    }
    if (residual.furtherActivity && !input.acknowledgeFurtherActivity) {
      fail(residual.furtherActivity, 'Confirm the clearing. It is not automatic.');
    }

    const company = await getCompanyCode(tx, input.client, residual.companyCode);
    if (!company?.fiscalYearVariant) fail(`Company code ${residual.companyCode} is not configured.`);
    const position = await derivePosition(tx, input.client, company.fiscalYearVariant, postingDate)
      .catch((error: unknown) => fail(error instanceof Error ? error.message : 'The posting date cannot be judged.'));
    const materialPeriod = await getMaterialPeriodControlInTx(tx, input.client, residual.companyCode);
    if (!materialPeriodAllows(materialPeriod, position.fiscalYear, position.period)) {
      fail(
        `The material posting period ${position.fiscalYear}/${position.period} is closed for company ${residual.companyCode}.`,
        'Post into the open material period, or shift the material period first.',
      );
    }

    const amount = Math.abs(residual.remaining);
    const grIrSide = residual.remaining > 0 ? 'S' : 'H';
    const offsetSide = grIrSide === 'S' ? 'H' : 'S';
    const journal = await postJournalEntry(tx, {
      client: input.client,
      companyCode: residual.companyCode,
      documentType: JOURNAL_DOCUMENT_TYPE,
      documentDate: postingDate,
      postingDate,
      fiscalYear: position.fiscalYear,
      postingPeriod: position.period,
      currency: residual.currency,
      localCurrency: company.currency,
      reference: orderNumber,
      headerText: `GR/IR ${orderNumber}/${residual.itemNumber}`.slice(0, 100),
      lines: [
        {
          glAccount: residual.grIrAccount,
          debitCredit: grIrSide,
          amount: amount.toFixed(2),
          material: residual.materialNumber ?? undefined,
          plant: residual.plant,
          lineText: `GR/IR ${orderNumber}/${residual.itemNumber}`,
        },
        {
          glAccount: residual.offsetAccount,
          debitCredit: offsetSide,
          amount: amount.toFixed(2),
          material: residual.materialNumber ?? undefined,
          plant: residual.plant,
          lineText: 'GR/IR maintenance',
        },
      ],
      origin: { documentClass: ORIGIN_CLASS, documentKey: `${orderNumber}/${residual.itemNumber}` },
      postedBy: input.changedBy,
      transactionCode: GRIR_CLEARING_POST_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) fail(error.message, error.remedy);
      throw error;
    });

    await tx.execute(sql`
      insert into gr_ir_maintenance_link (
        client, document_number, fiscal_year, order_number, item_number, company_code,
        posting_date, key_date, surplus, allocated_amount, currency, allocated_quantity,
        quantity_unit, gr_ir_account, offset_account, fingerprint, request_key, comment, created_by
      ) values (
        ${input.client}, ${journal.documentNumber}, ${position.fiscalYear}, ${orderNumber}, ${residual.itemNumber},
        ${residual.companyCode}, ${postingDate}, ${keyDate}, ${residual.surplus}, ${residual.remaining.toFixed(4)},
        ${residual.currency}, ${residual.openQuantity.toFixed(3)}, ${residual.unit}, ${residual.grIrAccount},
        ${residual.offsetAccount}, ${residual.fingerprint}, ${requestKey}, ${comment}, ${input.changedBy}
      )
    `);
    await recordChange(tx, {
      client: input.client,
      objectClass: ORIGIN_CLASS,
      objectKey: journal.documentNumber,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: GRIR_CLEARING_POST_CAPABILITY,
      reason: comment,
      after: {
        order: orderNumber,
        item: residual.itemNumber,
        amount: residual.remaining.toFixed(2),
        surplus: residual.surplus,
        journal: journal.documentNumber,
      },
    });
    return {
      wrote: true,
      documentNumber: journal.documentNumber,
      fiscalYear: position.fiscalYear,
      orderNumber,
      itemNumber: residual.itemNumber,
      amount: residual.remaining.toFixed(4),
      surplus: residual.surplus,
      grIrAccount: residual.grIrAccount,
      offsetAccount: residual.offsetAccount,
    };
  });
}

export async function reverseGrIrClearing(input: {
  client: string;
  changedBy: string;
  documentNumber: string;
  fiscalYear: number;
  reversalDate: string;
  comment: string;
  requestKey: string;
  named?: Record<string, string | undefined>;
}): Promise<GrIrPostResult> {
  refuseNamed(input.named);
  const documentNumber = input.documentNumber.trim();
  const reversalDate = date(input.reversalDate, 'The reversal date');
  const comment = input.comment.trim();
  const requestKey = input.requestKey.trim();
  if (!documentNumber) fail('An accounting document is required.');
  if (!Number.isInteger(input.fiscalYear)) fail('A fiscal year is required.');
  if (!comment || comment.length > 100) fail('A reason is required.');
  if (!requestKey) fail('A request key is required.');

  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, requestKey);
    if (replay) return replay;
    const [link] = await tx.execute(sql`
      select document_number, fiscal_year, order_number, item_number, company_code,
             allocated_amount::text as amount, surplus, gr_ir_account, offset_account, reversed_by
        from gr_ir_maintenance_link
       where client = ${input.client} and document_number = ${documentNumber} and fiscal_year = ${input.fiscalYear}
       for update
    `) as unknown as Array<{
      document_number: string; fiscal_year: number; order_number: string; item_number: number;
      company_code: string; amount: string; surplus: 'DELIVERY' | 'INVOICE';
      gr_ir_account: string; offset_account: string; reversed_by: string | null;
    }>;
    if (!link) fail(`Maintenance document ${documentNumber} does not stand.`);
    if (link.reversed_by) fail(`Maintenance document ${documentNumber} was already reversed by ${link.reversed_by}.`);

    const company = await getCompanyCode(tx, input.client, link.company_code);
    if (!company?.fiscalYearVariant) fail(`Company code ${link.company_code} is not configured.`);
    const position = await derivePosition(tx, input.client, company.fiscalYearVariant, reversalDate)
      .catch((error: unknown) => fail(error instanceof Error ? error.message : 'The reversal date cannot be judged.'));
    const materialPeriod = await getMaterialPeriodControlInTx(tx, input.client, link.company_code);
    if (!materialPeriodAllows(materialPeriod, position.fiscalYear, position.period)) {
      fail(
        `The material posting period ${position.fiscalYear}/${position.period} is closed for company ${link.company_code}.`,
        'Reverse into the open material period, or shift the material period first.',
      );
    }

    const reversed = await reverseJournalEntry(tx, {
      client: input.client,
      documentNumber,
      fiscalYear: input.fiscalYear,
      reversalDate,
      reversalDocumentDate: reversalDate,
      reason: comment,
      reversedBy: input.changedBy,
      transactionCode: GRIR_CLEARING_REVERSE_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) fail(error.message, error.remedy);
      throw error;
    });
    await tx.execute(sql`
      update gr_ir_maintenance_link
         set reversed_by = ${reversed.documentNumber}, changed_by = ${input.changedBy}, changed_at = now()
       where client = ${input.client} and document_number = ${documentNumber} and fiscal_year = ${input.fiscalYear}
    `);
    await tx.execute(sql`
      insert into gr_ir_maintenance_link (
        client, document_number, fiscal_year, order_number, item_number, company_code,
        posting_date, key_date, surplus, allocated_amount, currency, allocated_quantity,
        quantity_unit, gr_ir_account, offset_account, fingerprint, request_key, comment,
        reversed_by, created_by
      )
      select ${input.client}, ${reversed.documentNumber}, ${reversed.fiscalYear}, order_number, item_number,
             company_code, ${reversalDate}, key_date, surplus, (-allocated_amount), currency,
             (-allocated_quantity), quantity_unit, gr_ir_account, offset_account, fingerprint,
             ${requestKey}, ${comment}, ${documentNumber}, ${input.changedBy}
        from gr_ir_maintenance_link
       where client = ${input.client} and document_number = ${documentNumber} and fiscal_year = ${input.fiscalYear}
    `);
    await recordChange(tx, {
      client: input.client,
      objectClass: ORIGIN_CLASS,
      objectKey: reversed.documentNumber,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: GRIR_CLEARING_REVERSE_CAPABILITY,
      reason: comment,
      after: { reversalOf: documentNumber, journal: reversed.documentNumber },
    });
    return {
      wrote: true,
      documentNumber: reversed.documentNumber,
      fiscalYear: reversed.fiscalYear,
      orderNumber: link.order_number,
      itemNumber: link.item_number,
      amount: String(-Number(link.amount)),
      surplus: link.surplus,
      grIrAccount: link.gr_ir_account,
      offsetAccount: link.offset_account,
    };
  });
}
