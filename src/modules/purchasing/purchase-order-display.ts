/**
 * Display a purchase order — SCR-164.
 *
 * A read of the order that already stands. It introduces no table and no
 * status column. Received and invoiced quantities follow the purchase-order
 * list: a posted receipt adds, a posted reversal subtracts, and a posted
 * invoice quantity is summed. Cancelled invoices and reversed documents stay
 * in the history. They are not erased. This module writes nothing.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { getDocumentRelease, type DocumentReleaseState } from './release';
import { receiptMovementSign, receiptQuantityInOrderUnit, receiptUnitJoins } from './receipt-unit-basis';

export const PO_DISPLAY_CAPABILITY = 'PROC.PO.DISPLAY';
export const PO_DISPLAY_ROUTE = '/purchasing/purchase-order-display';
const PO_CLASS = 'purchase_order';
const HISTORY_LIMIT = 200;
const SEARCH_LIMIT = 50;
const RECENT_LIMIT = 10;

const REFUSED: Record<string, string> = {
  supplierReference: 'A supplier reference is not stored on the purchase order.',
  exchangeRate: 'An exchange rate is not stored. Historical values are not recalculated.',
  incoterms: 'Delivery terms are not stored on the purchase order.',
  paymentTerms: 'Payment terms are not stored on the purchase order.',
  attachment: 'Attachments are not stored.',
  condition: 'A pricing condition is not stored. The item net value is the stored baseline.',
  export: 'An export is not this display.',
  revision: 'There is no revision stack. The change history is the record.',
  approval: 'This display does not release a purchase order.',
  deliveryCompleted: 'A delivery-completed indicator is not stored. The quantities are derived.',
  finalInvoice: 'A final-invoice indicator is not stored. The quantities are derived.',
  goodsReceiptIndicator: 'A goods-receipt indicator is not stored. The quantities are derived.',
  invoiceReceiptIndicator: 'An invoice-receipt indicator is not stored. The quantities are derived.',
  deliveryCost: 'A delivery cost is not this display.',
  consignment: 'Consignment is not this display.',
  service: 'A service item is not this document. Only a standard item stands.',
  stock: 'This display does not change stock.',
  uuid: 'A uuid key is not a field on this display.',
  outbox: 'An outbox is not this display.',
};

const KNOWN = new Set([
  'order', 'supplier', 'purchasingOrg', 'documentDateFrom', 'documentDateTo', 'plant', 'releaseStatus', 'itemState',
]);

const RELEASE = new Set(['UNRELEASED', 'RELEASED']);
const ITEM_STATE = new Set(['OPEN', 'PARTIALLY_DELIVERED', 'DELIVERED', 'COMPLETED', 'MARKED', 'MIXED']);

export class PurchaseOrderDisplayError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'PurchaseOrderDisplayError';
  }
}

export interface DisplayedSchedule {
  lineNumber: number;
  deliveryDate: string;
  quantity: string;
}

export interface DisplayedAssignment {
  lineNumber: number;
  glAccount: string;
  costCenter: string;
  distributionPercentage: string;
  /** Share of the stored item net value, rounded at the line. Not a second item total. */
  assignedValue: string;
}

export interface DisplayedConversion {
  baseUnit: string | null;
  /** Stored numerator and denominator, or null when no conversion row stands. */
  numerator: number | null;
  denominator: number | null;
  sameUnit: boolean;
}

export interface DisplayedItem {
  itemNumber: number;
  itemCategory: string;
  materialNumber: string | null;
  shortText: string;
  plant: string;
  storageLocation: string | null;
  batch: string;
  orderedQuantity: string;
  unit: string;
  netPrice: string;
  priceUnit: string;
  /** The value stored on the item. Not recalculated. */
  netValue: string;
  taxCode: string | null;
  markedForDeletion: boolean;
  accountAssignmentCategory: string | null;
  requisitionNumber: string | null;
  requisitionItem: number | null;
  infoRecordNumber: string | null;
  sourceNumber: string | null;
  receivedQuantity: string;
  invoicedQuantity: string;
  remainingToDeliver: string;
  remainingToInvoice: string;
  state: string;
  conversion: DisplayedConversion;
  schedules: DisplayedSchedule[];
  assignments: DisplayedAssignment[];
}

export interface DisplayedGoodsEvent {
  documentNumber: string;
  documentYear: number;
  postingDate: string;
  status: string;
  itemNumber: number;
  lineNumber: number;
  movementType: string;
  direction: string;
  lineDirection: string;
  entryQuantity: string;
  entryUnit: string;
  baseQuantity: string;
  baseUnit: string;
  reversalOf: string | null;
  reversedBy: string | null;
  returnOf: string | null;
  journalDocumentNumber: string | null;
}

export interface DisplayedInvoiceEvent {
  invoiceNumber: string;
  fiscalYear: number;
  category: string;
  status: string;
  itemNumber: number;
  lineNumber: number;
  postingDate: string;
  quantity: string;
  unit: string;
  netAmount: string;
  currency: string;
  cancellationOf: string | null;
  cancelledBy: string | null;
  journalDocumentNumber: string | null;
}

export interface DisplayedPark {
  parkedNumber: string;
  fiscalYear: number;
  itemNumber: number;
  quantity: string;
  netAmount: string;
  currency: string;
}

export interface DisplayedClearing {
  documentNumber: string;
  fiscalYear: number;
  itemNumber: number;
  postingDate: string;
  allocatedAmount: string;
  currency: string;
  reversedBy: string | null;
}

export interface DisplayedChange {
  changeType: string;
  changedBy: string;
  changedAt: string;
  reason: string | null;
  fieldName: string | null;
  oldValue: string | null;
  newValue: string | null;
}

export interface DisplayedOrder {
  orderNumber: string;
  documentType: string;
  supplierNumber: string;
  supplierName: string;
  companyCode: string;
  purchasingOrg: string;
  purchasingGroup: string;
  documentDate: string;
  createdBy: string;
  createdAt: string;
  currency: string;
  releaseStatus: string;
  release: DocumentReleaseState;
  headerState: string;
  items: DisplayedItem[];
  goods: DisplayedGoodsEvent[];
  invoices: DisplayedInvoiceEvent[];
  parks: DisplayedPark[];
  clearings: DisplayedClearing[];
  changes: DisplayedChange[];
  historyTruncated: boolean;
}

export interface PurchaseOrderHit {
  orderNumber: string;
  supplierNumber: string;
  supplierName: string;
  purchasingOrg: string;
  companyCode: string;
  documentDate: string;
  currency: string;
  releaseStatus: string;
  headerState: string;
}

export type PurchaseOrderDisplayResult =
  | { found: true; order: DisplayedOrder }
  | { found: false; message: string };

export interface PurchaseOrderSearchResult {
  rows: PurchaseOrderHit[];
  truncated: boolean;
  recent: boolean;
}

function fail(message: string, remedy?: string): never {
  throw new PurchaseOrderDisplayError(message, remedy);
}

function key(value: string | undefined): string {
  return value?.trim().toUpperCase() ?? '';
}

function date(value: string | undefined, label: string): string {
  const text = value?.trim() ?? '';
  if (!text) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail(`${label} is not a date.`, 'Use a calendar date.');
  return text;
}

function when(value: Date | string | null | undefined): string {
  if (value == null || value === '') return '';
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function text(value: unknown): string {
  return value == null ? '' : String(value);
}

function money(value: string): string {
  return fromScaled(toScaled(value || '0', 2), 2);
}

function qty(value: string): string {
  return fromScaled(toScaled(value || '0', 3), 3);
}

function sub(left: string, right: string, scale = 3): string {
  return fromScaled(toScaled(left || '0', scale) - toScaled(right || '0', scale), scale);
}

function compare(left: string, right: string, scale = 3): number {
  const a = toScaled(left || '0', scale);
  const b = toScaled(right || '0', scale);
  return a < b ? -1 : a > b ? 1 : 0;
}

function itemState(marked: boolean, quantity: string, received: string, invoiced: string): string {
  if (marked) return 'MARKED';
  if (compare(received, quantity) >= 0 && compare(invoiced, quantity) >= 0) return 'COMPLETED';
  if (compare(received, quantity) >= 0) return 'DELIVERED';
  if (compare(received, '0') > 0) return 'PARTIALLY_DELIVERED';
  return 'OPEN';
}

function headerState(states: string[]): string {
  if (states.length === 0) return 'OPEN';
  return states.every((state) => state === states[0]) ? states[0] : 'MIXED';
}

/** Share of the stored net value. Rounded half-up at the cent. Not added back onto the item. */
export function assignedShare(netValue: string, percent: string): string {
  const net = toScaled(netValue || '0', 2);
  const pct = toScaled(percent || '0', 2);
  const product = net * pct;
  const divisor = 10000n;
  const negative = product < 0n;
  const absolute = negative ? -product : product;
  const quotient = absolute / divisor;
  const remainder = absolute % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  return fromScaled(negative ? -rounded : rounded, 2);
}

function refuseNamed(params: Record<string, string>): void {
  for (const [name, value] of Object.entries(params)) {
    if (!value.trim() || KNOWN.has(name)) continue;
    const message = REFUSED[name] ?? `${name} is not a field on this display.`;
    fail(message, 'Open the purchase order by its number. A missing optional value is not a zero.');
  }
}

function selection(params: Record<string, string>) {
  const orderNumber = key(params.order);
  const supplier = key(params.supplier);
  const purchasingOrg = key(params.purchasingOrg);
  const plant = key(params.plant);
  const releaseStatus = key(params.releaseStatus);
  const itemStateFilter = key(params.itemState);
  const documentDateFrom = date(params.documentDateFrom, 'The document date from');
  const documentDateTo = date(params.documentDateTo, 'The document date to');
  if (orderNumber.length > 20) fail('The purchase order number is too long.');
  if (supplier.length > 40) fail('The supplier is too long.');
  if (purchasingOrg.length > 10) fail('The purchasing organisation is too long.');
  if (plant.length > 10) fail('The plant is too long.');
  if (releaseStatus && !RELEASE.has(releaseStatus)) {
    fail(`The release status ${releaseStatus} does not stand.`, 'Use UNRELEASED or RELEASED. A derived delivery state is not that flag.');
  }
  if (itemStateFilter && !ITEM_STATE.has(itemStateFilter)) {
    fail(`The item state ${itemStateFilter} does not stand.`, `Use one of ${[...ITEM_STATE].join(', ')}.`);
  }
  if (documentDateFrom && documentDateTo && documentDateFrom > documentDateTo) {
    fail('The document date from is after the document date to.');
  }
  return { orderNumber, supplier, purchasingOrg, plant, releaseStatus, itemState: itemStateFilter, documentDateFrom, documentDateTo };
}

const MISSING = 'Purchase order does not exist or is not available to this user.';

export async function displayPurchaseOrder(client: string, orderNumber: string): Promise<PurchaseOrderDisplayResult> {
  const number = key(orderNumber);
  if (!number) return { found: false, message: MISSING };
  const loaded = await withTenant(client, async (tx) => {
    const [header] = await tx.execute(sql`
      select po.order_number, po.document_type, po.supplier_number, coalesce(bp.name, '') as supplier_name,
             po.company_code, po.purchasing_org, po.purchasing_group, po.document_date::text as document_date,
             po.currency, po.release_status, po.created_by, po.created_at
        from purchase_order po
        left join business_partner bp
          on bp.client = po.client and bp.partner_number = po.supplier_number
       where po.client = ${client} and po.order_number = ${number}
    `) as unknown as Array<Record<string, unknown>>;
    if (!header) return null;

    const items = await tx.execute(sql`
      select i.item_number, i.item_category, i.material_number, i.short_text, i.plant, i.storage_location, i.batch_number,
             i.quantity::text as quantity, i.unit, i.net_price::text as net_price, i.price_unit::text as price_unit,
             i.net_value::text as net_value, i.tax_code, i.marked_for_deletion, i.account_assignment_category,
             i.requisition_number, i.requisition_item, i.info_record_number, i.source_number,
             coalesce(gr.delivered, 0)::text as received, coalesce(ir.invoiced, 0)::text as invoiced,
             m.base_unit, c.numerator, c.denominator
        from purchase_order_item i
        left join (
          select l.purchase_order_item,
                 -- Received is read in the unit the order line counts in, not in the material's
                 -- base unit, so an alternative-unit receipt is not twelve times its order figure.
                 -- The movement's direction decides the sign, and a reversal cancels through the line
                 -- it points at, so the document header is joined for nothing but its existence.
                 sum(${receiptMovementSign('mv')} * (${receiptQuantityInOrderUnit})) as delivered
            from material_document_line l
            join movement_type mv on mv.client = l.client and mv.movement_type = l.movement_type
           ${receiptUnitJoins}
           where l.client = ${client} and l.purchase_order_number = ${number}
           group by l.purchase_order_item
        ) gr on gr.purchase_order_item = i.item_number
        left join (
          select si.purchase_order_item, sum(si.quantity) as invoiced
            from supplier_invoice_item si
            join supplier_invoice s2
              on s2.client = si.client and s2.invoice_number = si.invoice_number and s2.status = 'POSTED'
           where si.client = ${client} and si.purchase_order_number = ${number}
           group by si.purchase_order_item
        ) ir on ir.purchase_order_item = i.item_number
        left join material m on m.client = i.client and m.material_number = i.material_number
        left join material_uom_conversion c
          on c.client = i.client and c.material_number = i.material_number and c.alternative_unit = i.unit
       where i.client = ${client} and i.order_number = ${number}
       order by i.item_number
    `) as unknown as Array<Record<string, unknown>>;

    const schedules = await tx.execute(sql`
      select item_number, line_number, delivery_date::text as delivery_date, quantity::text as quantity
        from purchase_order_schedule_line
       where client = ${client} and order_number = ${number}
       order by item_number, line_number
    `) as unknown as Array<Record<string, unknown>>;
    const assignments = await tx.execute(sql`
      select item_number, line_number, gl_account, cost_center, distribution_percentage::text as distribution_percentage
        from purchase_order_assignment
       where client = ${client} and order_number = ${number}
       order by item_number, line_number
    `) as unknown as Array<Record<string, unknown>>;
    const goods = await tx.execute(sql`
      select d.material_document_number, d.document_year, d.posting_date, d.status, d.reversal_of, d.reversed_by,
             d.journal_document_number, l.purchase_order_item, l.line_number, l.movement_type, mv.direction,
             l.line_direction, l.entry_quantity::text as entry_quantity, l.entry_unit,
             l.base_quantity::text as base_quantity, l.base_unit, l.reversal_of_document, l.return_of_document
        from material_document_line l
        join material_document d
          on d.client = l.client and d.material_document_number = l.material_document_number
        join movement_type mv on mv.client = l.client and mv.movement_type = l.movement_type
       where l.client = ${client} and l.purchase_order_number = ${number}
       order by d.posting_date, d.material_document_number, l.line_number
       limit ${HISTORY_LIMIT + 1}
    `) as unknown as Array<Record<string, unknown>>;
    const invoices = await tx.execute(sql`
      select s2.invoice_number, s2.fiscal_year, s2.category, s2.status, s2.posting_date::text as posting_date,
             s2.currency, s2.cancellation_of, s2.cancelled_by, s2.journal_document_number,
             si.purchase_order_item, si.line_number, si.quantity::text as quantity, si.unit, si.net_amount::text as net_amount
        from supplier_invoice_item si
        join supplier_invoice s2 on s2.client = si.client and s2.invoice_number = si.invoice_number
       where si.client = ${client} and si.purchase_order_number = ${number}
       order by s2.posting_date, s2.invoice_number, si.line_number
       limit ${HISTORY_LIMIT + 1}
    `) as unknown as Array<Record<string, unknown>>;
    const parks = await tx.execute(sql`
      select p.parked_number, p.fiscal_year, p.currency, i.purchase_order_item, i.quantity::text as quantity,
             i.net_amount::text as net_amount
        from parked_supplier_invoice_item i
        join parked_supplier_invoice p on p.client = i.client and p.parked_number = i.parked_number
       where i.client = ${client} and i.purchase_order_number = ${number}
       order by p.parked_number, i.purchase_order_item
       limit ${HISTORY_LIMIT + 1}
    `) as unknown as Array<Record<string, unknown>>;
    const clearings = await tx.execute(sql`
      select document_number, fiscal_year, item_number, posting_date::text as posting_date,
             allocated_amount::text as allocated_amount, currency, reversed_by
        from gr_ir_maintenance_link
       where client = ${client} and order_number = ${number}
       order by posting_date, document_number
       limit ${HISTORY_LIMIT + 1}
    `) as unknown as Array<Record<string, unknown>>;
    const changes = await tx.execute(sql`
      select d.change_type, d.changed_by, d.changed_at, d.reason, i.field_name, i.old_value, i.new_value
        from change_document d
        left join change_document_item i
          on i.client = d.client and i.change_document_id = d.id
       where d.client = ${client} and d.object_class = ${PO_CLASS} and d.object_key = ${number}
       order by d.changed_at, i.field_name
       limit ${HISTORY_LIMIT + 1}
    `) as unknown as Array<Record<string, unknown>>;
    return { header, items, schedules, assignments, goods, invoices, parks, clearings, changes };
  });
  if (!loaded) return { found: false, message: MISSING };

  const release = await getDocumentRelease(client, 'PURCHASE_ORDER', number);
  const schedulesByItem = new Map<number, DisplayedSchedule[]>();
  for (const row of loaded.schedules) {
    const itemNumber = Number(row.item_number);
    const list = schedulesByItem.get(itemNumber) ?? [];
    list.push({ lineNumber: Number(row.line_number), deliveryDate: text(row.delivery_date), quantity: text(row.quantity) });
    schedulesByItem.set(itemNumber, list);
  }
  const netByItem = new Map(loaded.items.map((row) => [Number(row.item_number), text(row.net_value)]));
  const assignmentsByItem = new Map<number, DisplayedAssignment[]>();
  for (const row of loaded.assignments) {
    const itemNumber = Number(row.item_number);
    const list = assignmentsByItem.get(itemNumber) ?? [];
    const percent = text(row.distribution_percentage);
    list.push({
      lineNumber: Number(row.line_number),
      glAccount: text(row.gl_account),
      costCenter: text(row.cost_center),
      distributionPercentage: percent,
      assignedValue: assignedShare(netByItem.get(itemNumber) ?? '0', percent),
    });
    assignmentsByItem.set(itemNumber, list);
  }
  const displayedItems: DisplayedItem[] = loaded.items.map((row) => {
    const quantity = text(row.quantity);
    const received = text(row.received);
    const invoiced = text(row.invoiced);
    const unit = text(row.unit);
    const baseUnit = row.base_unit == null ? null : text(row.base_unit);
    return {
      itemNumber: Number(row.item_number),
      itemCategory: text(row.item_category),
      materialNumber: row.material_number == null ? null : text(row.material_number),
      shortText: text(row.short_text),
      plant: text(row.plant),
      storageLocation: row.storage_location == null ? null : text(row.storage_location),
      batch: text(row.batch_number),
      orderedQuantity: qty(quantity),
      unit,
      netPrice: money(text(row.net_price)),
      priceUnit: text(row.price_unit),
      netValue: money(text(row.net_value)),
      taxCode: row.tax_code == null ? null : text(row.tax_code),
      markedForDeletion: row.marked_for_deletion === true,
      accountAssignmentCategory: row.account_assignment_category == null ? null : text(row.account_assignment_category),
      requisitionNumber: row.requisition_number == null ? null : text(row.requisition_number),
      requisitionItem: row.requisition_item == null ? null : Number(row.requisition_item),
      infoRecordNumber: row.info_record_number == null ? null : text(row.info_record_number),
      sourceNumber: row.source_number == null ? null : text(row.source_number),
      receivedQuantity: qty(received),
      invoicedQuantity: qty(invoiced),
      remainingToDeliver: sub(quantity, received),
      remainingToInvoice: sub(received, invoiced),
      state: itemState(row.marked_for_deletion === true, quantity, received, invoiced),
      conversion: {
        baseUnit,
        numerator: row.numerator == null ? null : Number(row.numerator),
        denominator: row.denominator == null ? null : Number(row.denominator),
        sameUnit: baseUnit != null && baseUnit === unit,
      },
      schedules: schedulesByItem.get(Number(row.item_number)) ?? [],
      assignments: assignmentsByItem.get(Number(row.item_number)) ?? [],
    };
  });
  const historyTruncated = loaded.goods.length > HISTORY_LIMIT
    || loaded.invoices.length > HISTORY_LIMIT
    || loaded.parks.length > HISTORY_LIMIT
    || loaded.clearings.length > HISTORY_LIMIT
    || loaded.changes.length > HISTORY_LIMIT;
  return {
    found: true,
    order: {
      orderNumber: text(loaded.header.order_number),
      documentType: text(loaded.header.document_type),
      supplierNumber: text(loaded.header.supplier_number),
      supplierName: text(loaded.header.supplier_name),
      companyCode: text(loaded.header.company_code),
      purchasingOrg: text(loaded.header.purchasing_org),
      purchasingGroup: text(loaded.header.purchasing_group),
      documentDate: text(loaded.header.document_date),
      createdBy: text(loaded.header.created_by),
      createdAt: when(loaded.header.created_at as string),
      currency: text(loaded.header.currency),
      releaseStatus: text(loaded.header.release_status),
      release,
      headerState: headerState(displayedItems.map((item) => item.state)),
      items: displayedItems,
      goods: loaded.goods.slice(0, HISTORY_LIMIT).map((row) => ({
        documentNumber: text(row.material_document_number),
        documentYear: Number(row.document_year),
        postingDate: text(row.posting_date),
        status: text(row.status),
        itemNumber: Number(row.purchase_order_item),
        lineNumber: Number(row.line_number),
        movementType: text(row.movement_type),
        direction: text(row.direction),
        lineDirection: text(row.line_direction),
        entryQuantity: text(row.entry_quantity),
        entryUnit: text(row.entry_unit),
        baseQuantity: text(row.base_quantity),
        baseUnit: text(row.base_unit),
        reversalOf: row.reversal_of == null ? (row.reversal_of_document == null ? null : text(row.reversal_of_document)) : text(row.reversal_of),
        reversedBy: row.reversed_by == null ? null : text(row.reversed_by),
        returnOf: row.return_of_document == null ? null : text(row.return_of_document),
        journalDocumentNumber: row.journal_document_number == null ? null : text(row.journal_document_number),
      })),
      invoices: loaded.invoices.slice(0, HISTORY_LIMIT).map((row) => ({
        invoiceNumber: text(row.invoice_number),
        fiscalYear: Number(row.fiscal_year),
        category: text(row.category),
        status: text(row.status),
        itemNumber: Number(row.purchase_order_item),
        lineNumber: Number(row.line_number),
        postingDate: text(row.posting_date),
        quantity: text(row.quantity),
        unit: text(row.unit),
        netAmount: text(row.net_amount),
        currency: text(row.currency),
        cancellationOf: row.cancellation_of == null ? null : text(row.cancellation_of),
        cancelledBy: row.cancelled_by == null ? null : text(row.cancelled_by),
        journalDocumentNumber: row.journal_document_number == null ? null : text(row.journal_document_number),
      })),
      parks: loaded.parks.slice(0, HISTORY_LIMIT).map((row) => ({
        parkedNumber: text(row.parked_number),
        fiscalYear: Number(row.fiscal_year),
        itemNumber: Number(row.purchase_order_item),
        quantity: text(row.quantity),
        netAmount: text(row.net_amount),
        currency: text(row.currency),
      })),
      clearings: loaded.clearings.slice(0, HISTORY_LIMIT).map((row) => ({
        documentNumber: text(row.document_number),
        fiscalYear: Number(row.fiscal_year),
        itemNumber: Number(row.item_number),
        postingDate: text(row.posting_date),
        allocatedAmount: text(row.allocated_amount),
        currency: text(row.currency),
        reversedBy: row.reversed_by == null ? null : text(row.reversed_by),
      })),
      changes: loaded.changes.slice(0, HISTORY_LIMIT).map((row) => ({
        changeType: text(row.change_type),
        changedBy: text(row.changed_by),
        changedAt: when(row.changed_at as string),
        reason: row.reason == null ? null : text(row.reason),
        fieldName: row.field_name == null ? null : text(row.field_name),
        oldValue: row.old_value == null ? null : text(row.old_value),
        newValue: row.new_value == null ? null : text(row.new_value),
      })),
      historyTruncated,
    },
  };
}

export async function searchPurchaseOrders(
  client: string,
  params: Record<string, string>,
): Promise<PurchaseOrderSearchResult> {
  refuseNamed(params);
  const chosen = selection(params);
  const recent = !chosen.supplier && !chosen.purchasingOrg && !chosen.plant && !chosen.releaseStatus
    && !chosen.itemState && !chosen.documentDateFrom && !chosen.documentDateTo;
  const limit = recent ? RECENT_LIMIT : SEARCH_LIMIT;
  return withTenant(client, async (tx) => {
    if (chosen.supplier) {
      const [partner] = await tx.execute(sql`
        select 1 as hit from business_partner where client = ${client} and partner_number = ${chosen.supplier}
      `) as unknown as Array<{ hit: number }>;
      if (!partner) fail(`Supplier ${chosen.supplier} does not stand.`, 'Choose a supplier that stands, or leave the supplier empty.');
    }
    if (chosen.purchasingOrg) {
      const [org] = await tx.execute(sql`
        select 1 as hit from purchasing_org where client = ${client} and purchasing_org = ${chosen.purchasingOrg}
      `) as unknown as Array<{ hit: number }>;
      if (!org) fail(`Purchasing organisation ${chosen.purchasingOrg} does not stand.`);
    }
    if (chosen.plant) {
      const [plant] = await tx.execute(sql`
        select 1 as hit from plant where client = ${client} and plant = ${chosen.plant}
      `) as unknown as Array<{ hit: number }>;
      if (!plant) fail(`Plant ${chosen.plant} does not stand.`);
    }
    const rows = await tx.execute(sql`
      with gr as (
        select l.purchase_order_number, l.purchase_order_item,
               sum(${receiptMovementSign('mv')} * (${receiptQuantityInOrderUnit})) as delivered
          from material_document_line l
          join movement_type mv on mv.client = l.client and mv.movement_type = l.movement_type
          ${receiptUnitJoins}
         where l.client = ${client} and l.purchase_order_number is not null
         group by l.purchase_order_number, l.purchase_order_item
      ),
      ir as (
        select si.purchase_order_number, si.purchase_order_item, sum(si.quantity) as invoiced
          from supplier_invoice_item si
          join supplier_invoice s2
            on s2.client = si.client and s2.invoice_number = si.invoice_number and s2.status = 'POSTED'
         where si.client = ${client} and si.purchase_order_number is not null
         group by si.purchase_order_number, si.purchase_order_item
      ),
      item_state as (
        select i.order_number,
               case
                 when i.marked_for_deletion then 'MARKED'
                 when coalesce(gr.delivered, 0) >= i.quantity and coalesce(ir.invoiced, 0) >= i.quantity then 'COMPLETED'
                 when coalesce(gr.delivered, 0) >= i.quantity then 'DELIVERED'
                 when coalesce(gr.delivered, 0) > 0 then 'PARTIALLY_DELIVERED'
                 else 'OPEN'
               end as state
          from purchase_order_item i
          left join gr on gr.purchase_order_number = i.order_number and gr.purchase_order_item = i.item_number
          left join ir on ir.purchase_order_number = i.order_number and ir.purchase_order_item = i.item_number
         where i.client = ${client}
      ),
      header_state as (
        select order_number,
               case when count(distinct state) = 1 then min(state) else 'MIXED' end as header_state
          from item_state
         group by order_number
      )
      select po.order_number, po.supplier_number, coalesce(bp.name, '') as supplier_name,
             po.purchasing_org, po.company_code, po.document_date::text as document_date,
             po.currency, po.release_status, coalesce(hs.header_state, 'OPEN') as header_state
        from purchase_order po
        left join business_partner bp
          on bp.client = po.client and bp.partner_number = po.supplier_number
        left join header_state hs on hs.order_number = po.order_number
       where po.client = ${client}
         and (${chosen.supplier || null}::varchar is null or po.supplier_number = ${chosen.supplier || null})
         and (${chosen.purchasingOrg || null}::varchar is null or po.purchasing_org = ${chosen.purchasingOrg || null})
         and (${chosen.releaseStatus || null}::varchar is null or po.release_status = ${chosen.releaseStatus || null})
         and (${chosen.documentDateFrom || null}::date is null or po.document_date >= ${chosen.documentDateFrom || null})
         and (${chosen.documentDateTo || null}::date is null or po.document_date <= ${chosen.documentDateTo || null})
         and (${chosen.plant || null}::varchar is null or exists (
               select 1 from purchase_order_item pi
                where pi.client = po.client and pi.order_number = po.order_number and pi.plant = ${chosen.plant || null}
             ))
         and (${chosen.itemState || null}::varchar is null or coalesce(hs.header_state, 'OPEN') = ${chosen.itemState || null})
       order by po.created_at desc, po.order_number
       limit ${limit + 1}
    `) as unknown as Array<Record<string, unknown>>;
    return {
      recent,
      truncated: rows.length > limit,
      rows: rows.slice(0, limit).map((row) => ({
        orderNumber: text(row.order_number),
        supplierNumber: text(row.supplier_number),
        supplierName: text(row.supplier_name),
        purchasingOrg: text(row.purchasing_org),
        companyCode: text(row.company_code),
        documentDate: text(row.document_date),
        currency: text(row.currency),
        releaseStatus: text(row.release_status),
        headerState: text(row.header_state),
      })),
    };
  });
}

export async function openPurchaseOrderDisplay(client: string, params: Record<string, string>): Promise<{
  refusal: { message: string; remedy?: string } | null;
  order: PurchaseOrderDisplayResult | null;
  search: PurchaseOrderSearchResult | null;
}> {
  try {
    refuseNamed(params);
    const chosen = selection(params);
    if (chosen.orderNumber) {
      return { refusal: null, order: await displayPurchaseOrder(client, chosen.orderNumber), search: null };
    }
    return { refusal: null, order: null, search: await searchPurchaseOrders(client, params) };
  } catch (error) {
    if (error instanceof PurchaseOrderDisplayError) {
      return { refusal: { message: error.message, remedy: error.remedy }, order: null, search: null };
    }
    throw error;
  }
}
