/**
 * Purchase order list display — SCR-124 / PROC.PO.LIST (ME2L suite).
 *
 * One engine behind the four SAP perspectives: ME2L (by vendor, the primary),
 * ME2M (by material), ME2N (by purchase order) and ME2C (by material group).
 * The perspective fixes the primary sort and names the primary selector; every
 * other selector stands available at the same time, as SAP's list displays
 * allow combined selection.
 *
 * Read-only over the standing canon — no state, no table, and per the measured
 * stage-2 decision (§26.844) no index. Delivered and invoiced quantities are
 * derived from posted history, never from a status column: a material-document
 * line adds or subtracts by its movement direction and contributes nothing when
 * its document is cancelled, and a supplier-invoice item counts only while its
 * invoice stands posted.
 *
 * Deferred by name (contract §26.843): the Scope-of-List presentation variants
 * (ALV grid against standard list — the single grid ships), the purchase-order
 * history line-item drill beyond the document display, release-strategy detail,
 * and exporting.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { receiptMovementSign, receiptQuantityInOrderUnit, receiptUnitJoins } from './receipt-unit-basis';

export const PO_LIST_CAPABILITY = 'PROC.PO.LIST';
export const PO_LIST_ALIASES = ['ME2L', 'ME2M', 'ME2N', 'ME2C'] as const;

export const DEFAULT_MAX_HITS = 500;
export const MAX_HITS_CAP = 5000;

/** The package's "grouped primarily by" — one engine, four perspectives. */
export const PERSPECTIVES = [
  { code: 'VENDOR', alias: 'ME2L', label: 'By vendor' },
  { code: 'MATERIAL', alias: 'ME2M', label: 'By material' },
  { code: 'ORDER', alias: 'ME2N', label: 'By purchase order' },
  { code: 'MATERIAL_GROUP', alias: 'ME2C', label: 'By material group' },
] as const;
export type PoListPerspective = (typeof PERSPECTIVES)[number]['code'];

/** The package's "Scope of Selection". */
export const SCOPES = [
  { code: 'ALL', label: 'All items' },
  { code: 'STILL_TO_BE_DELIVERED', label: 'Still to be delivered' },
  { code: 'STILL_TO_BE_INVOICED', label: 'Still to be invoiced' },
  { code: 'COMPLETED', label: 'Completed' },
] as const;
export type PoListScope = (typeof SCOPES)[number]['code'];

export type PoListStatus = 'OPEN' | 'PARTIALLY_DELIVERED' | 'DELIVERED' | 'COMPLETED' | 'MARKED';

export interface PoListSelection {
  perspective?: string;
  scope?: string;
  vendorFrom?: string;
  vendorTo?: string;
  purchasingOrgFrom?: string;
  purchasingOrgTo?: string;
  purchasingGroupFrom?: string;
  purchasingGroupTo?: string;
  plantFrom?: string;
  plantTo?: string;
  materialFrom?: string;
  materialTo?: string;
  materialGroupFrom?: string;
  materialGroupTo?: string;
  orderFrom?: string;
  orderTo?: string;
  documentDateFrom?: string;
  documentDateTo?: string;
  maxHits?: number;
}

export interface PoListRow {
  orderNumber: string;
  itemNumber: number;
  supplierNumber: string;
  supplierName: string;
  purchasingOrg: string;
  purchasingGroup: string;
  companyCode: string;
  documentDate: string;
  materialNumber: string;
  shortText: string;
  materialGroup: string;
  plant: string;
  quantity: number;
  unit: string;
  netPrice: number;
  priceUnit: number;
  netValue: number;
  currency: string;
  deliveryDate: string;
  releaseStatus: string;
  markedForDeletion: boolean;
  requisitionNumber: string;
  requisitionItem: number | null;
  requisitionQuantity: number | null;
  deliveredQuantity: number;
  invoicedQuantity: number;
  openDeliveryQuantity: number;
  openInvoiceQuantity: number;
  accountAssignmentCategory: string;
  status: PoListStatus;
  drillDown: string;
}

export interface PoListResult {
  capability: string;
  perspective: string;
  perspectiveAlias: string;
  scope: string;
  selection: PoListSelection;
  rows: PoListRow[];
  rowCount: number;
  truncated: boolean;
  maxHits: number;
  warnings: string[];
  calculatedAt: string;
}

export class PoListError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'PoListError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new PoListError(message, remedy);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkDate(value: string, label: string): string {
  // Date.parse rolls an impossible day over, so the calendar check is the round trip.
  const parsed = ISO_DATE.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`${label} ${value} is not a valid date.`, 'Use the format YYYY-MM-DD.');
  }
  return value;
}

function bound(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? undefined : trimmed;
}

/** The masters each supplied endpoint is judged against. */
const MASTERS: Array<{ key: keyof PoListSelection; table: string; column: string; label: string }> = [
  { key: 'vendorFrom', table: 'business_partner', column: 'partner_number', label: 'vendor' },
  { key: 'vendorTo', table: 'business_partner', column: 'partner_number', label: 'vendor' },
  { key: 'purchasingOrgFrom', table: 'purchasing_org', column: 'purchasing_org', label: 'purchasing organisation' },
  { key: 'purchasingOrgTo', table: 'purchasing_org', column: 'purchasing_org', label: 'purchasing organisation' },
  { key: 'purchasingGroupFrom', table: 'purchasing_group', column: 'purchasing_group', label: 'purchasing group' },
  { key: 'purchasingGroupTo', table: 'purchasing_group', column: 'purchasing_group', label: 'purchasing group' },
  { key: 'plantFrom', table: 'plant', column: 'plant', label: 'plant' },
  { key: 'plantTo', table: 'plant', column: 'plant', label: 'plant' },
  { key: 'materialFrom', table: 'material', column: 'material_number', label: 'material' },
  { key: 'materialTo', table: 'material', column: 'material_number', label: 'material' },
  { key: 'materialGroupFrom', table: 'material_group', column: 'material_group', label: 'material group' },
  { key: 'materialGroupTo', table: 'material_group', column: 'material_group', label: 'material group' },
];

export async function listPurchaseOrders(input: {
  client: string;
  selection: PoListSelection;
}): Promise<PoListResult> {
  const { client } = input;
  const raw = input.selection;
  const s: PoListSelection = {
    perspective: bound(raw.perspective)?.toUpperCase() ?? 'VENDOR',
    scope: bound(raw.scope)?.toUpperCase() ?? 'ALL',
    vendorFrom: bound(raw.vendorFrom),
    vendorTo: bound(raw.vendorTo),
    purchasingOrgFrom: bound(raw.purchasingOrgFrom),
    purchasingOrgTo: bound(raw.purchasingOrgTo),
    purchasingGroupFrom: bound(raw.purchasingGroupFrom),
    purchasingGroupTo: bound(raw.purchasingGroupTo),
    plantFrom: bound(raw.plantFrom),
    plantTo: bound(raw.plantTo),
    materialFrom: bound(raw.materialFrom),
    materialTo: bound(raw.materialTo),
    materialGroupFrom: bound(raw.materialGroupFrom),
    materialGroupTo: bound(raw.materialGroupTo),
    orderFrom: bound(raw.orderFrom),
    orderTo: bound(raw.orderTo),
    documentDateFrom: bound(raw.documentDateFrom),
    documentDateTo: bound(raw.documentDateTo),
    maxHits: raw.maxHits,
  };

  // The perspective answers to its code or to its SAP alias — a user typing
  // ME2N should not have to know the internal name.
  const perspective = PERSPECTIVES.find((p) => p.code === s.perspective || p.alias === s.perspective);
  if (!perspective) {
    fail(
      `The perspective ${s.perspective} does not stand.`,
      `Use one of ${PERSPECTIVES.map((p) => `${p.code} (${p.alias})`).join(', ')}.`,
    );
  }
  if (!SCOPES.some((sc) => sc.code === s.scope)) {
    fail(`The scope of selection ${s.scope} does not stand.`, `Use one of ${SCOPES.map((sc) => sc.code).join(', ')}.`);
  }

  const pairs: Array<[string, string | undefined, string | undefined]> = [
    ['vendor', s.vendorFrom, s.vendorTo],
    ['purchasing organisation', s.purchasingOrgFrom, s.purchasingOrgTo],
    ['purchasing group', s.purchasingGroupFrom, s.purchasingGroupTo],
    ['plant', s.plantFrom, s.plantTo],
    ['material', s.materialFrom, s.materialTo],
    ['material group', s.materialGroupFrom, s.materialGroupTo],
    ['purchase order', s.orderFrom, s.orderTo],
    ['document date', s.documentDateFrom, s.documentDateTo],
  ];
  for (const [label, from, to] of pairs) {
    if (from && to && from > to) fail(`The ${label} range is inverted.`, 'The lower bound must not exceed the upper bound.');
  }
  if (s.documentDateFrom) checkDate(s.documentDateFrom, 'Document date from');
  if (s.documentDateTo) checkDate(s.documentDateTo, 'Document date to');

  const warnings: string[] = [];
  const requested = s.maxHits ?? DEFAULT_MAX_HITS;
  if (!Number.isInteger(requested) || requested < 1) fail('Maximum hits must be a positive number.');
  const maxHits = Math.min(requested, MAX_HITS_CAP);
  if (requested > MAX_HITS_CAP) warnings.push(`Maximum hits capped at ${MAX_HITS_CAP}.`);
  const calculatedAt = new Date().toISOString();

  return withTenant(client, async (tx) => {
    // Every supplied range endpoint is judged against its master, so a key that
    // does not stand refuses by name instead of answering an empty list.
    for (const master of MASTERS) {
      const value = s[master.key] as string | undefined;
      if (!value) continue;
      const rows = await tx.execute(sql`
        select ${sql.raw(master.column)} as key from ${sql.raw(master.table)}
        where client = ${client} and ${sql.raw(master.column)} = ${value}
      `) as unknown as Array<{ key: string }>;
      if (rows.length === 0) {
        fail(`The ${master.label} ${value} does not stand.`, `Maintain the ${master.label} before selecting it.`);
      }
    }
    // A document-number range is a scan, not a master lookup — but a single
    // number that matches no order would answer an empty list that reads as
    // "no commitment", so it refuses by name.
    if (s.orderFrom && s.orderFrom === s.orderTo) {
      const rows = await tx.execute(sql`
        select 1 as hit from purchase_order where client = ${client} and order_number = ${s.orderFrom}
      `) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) {
        fail(`The purchase order ${s.orderFrom} does not stand.`, 'Maintain the order or widen the range.');
      }
    }

    const filters = [sql`i.client = ${client}`];
    const range = (column: string, from?: string, to?: string) => {
      if (!from && !to) return;
      filters.push(sql`${sql.raw(column)} between ${from ?? ''} and ${to ?? '￿'}`);
    };
    range('po.supplier_number', s.vendorFrom, s.vendorTo);
    range('po.purchasing_org', s.purchasingOrgFrom, s.purchasingOrgTo);
    range('po.purchasing_group', s.purchasingGroupFrom, s.purchasingGroupTo);
    range('i.plant', s.plantFrom, s.plantTo);
    range('coalesce(i.material_number, \'\')', s.materialFrom, s.materialTo);
    range('coalesce(i.material_group, \'\')', s.materialGroupFrom, s.materialGroupTo);
    range('po.order_number', s.orderFrom, s.orderTo);
    if (s.documentDateFrom) filters.push(sql`po.document_date >= ${s.documentDateFrom}`);
    if (s.documentDateTo) filters.push(sql`po.document_date <= ${s.documentDateTo}`);
    const where = sql.join(filters, sql` and `);

    // Scope of selection over the derived quantities. A marked item is not
    // outstanding work, so it never stands in a "still to be" or "completed"
    // scope — only under all items, carrying its flag.
    const scopeFilter = s.scope === 'STILL_TO_BE_DELIVERED'
      ? sql`and not marked_for_deletion and delivered < quantity`
      : s.scope === 'STILL_TO_BE_INVOICED'
        ? sql`and not marked_for_deletion and delivered > invoiced`
        : s.scope === 'COMPLETED'
          ? sql`and not marked_for_deletion and delivered >= quantity and invoiced >= quantity`
          : sql``;

    const orderBy = perspective.code === 'MATERIAL'
      ? sql`order by material_number, document_date desc, order_number, item_number`
      : perspective.code === 'ORDER'
        ? sql`order by order_number, item_number`
        : perspective.code === 'MATERIAL_GROUP'
          ? sql`order by material_group, document_date desc, order_number, item_number`
          : sql`order by supplier_number, document_date desc, order_number, item_number`;

    const rows = await tx.execute(sql`
      with gr as (
        select l.purchase_order_number, l.purchase_order_item,
               -- The order line is counted in its own unit; the material's base unit is the stock
               -- figure, which this screen does not compare the ordered quantity with. The movement's
               -- direction decides the sign: a receipt adds, a return takes back, a reversal cancels
               -- the line it points at, so no document header filter stands here.
               sum(${receiptMovementSign('m')} * (${receiptQuantityInOrderUnit})) as delivered
        from material_document_line l
        join movement_type m on m.client = l.client and m.movement_type = l.movement_type
        ${receiptUnitJoins}
        where l.client = ${client} and l.purchase_order_number is not null
        group by l.purchase_order_number, l.purchase_order_item
      ), ir as (
        select si.purchase_order_number, si.purchase_order_item, sum(si.quantity) as invoiced
        from supplier_invoice_item si
        join supplier_invoice s2
          on s2.client = si.client and s2.invoice_number = si.invoice_number and s2.status = 'POSTED'
        where si.client = ${client} and si.purchase_order_number is not null
        group by si.purchase_order_number, si.purchase_order_item
      ), schedule as (
        select order_number, item_number, min(delivery_date)::text as delivery_date
        from purchase_order_schedule_line where client = ${client}
        group by order_number, item_number
      ), rows as (
        select po.order_number, i.item_number, po.supplier_number, po.purchasing_org, po.purchasing_group,
               po.company_code, po.document_date::text as document_date, po.currency, po.release_status,
               coalesce(i.material_number, '') as material_number, i.short_text,
               coalesce(i.material_group, '') as material_group, coalesce(i.plant, '') as plant,
               i.quantity, i.unit, i.net_price, i.price_unit, i.net_value, i.marked_for_deletion,
               coalesce(i.account_assignment_category, '') as account_assignment_category,
               coalesce(i.requisition_number, '') as requisition_number, i.requisition_item,
               case when i.requisition_number is null then null else r.quantity end as requisition_quantity,
               coalesce(gr.delivered, 0) as delivered,
               coalesce(ir.invoiced, 0) as invoiced,
               coalesce(sc.delivery_date, '') as delivery_date
        from purchase_order_item i
        join purchase_order po on po.client = i.client and po.order_number = i.order_number
        left join gr on gr.purchase_order_number = i.order_number and gr.purchase_order_item = i.item_number
        left join ir on ir.purchase_order_number = i.order_number and ir.purchase_order_item = i.item_number
        left join schedule sc on sc.order_number = i.order_number and sc.item_number = i.item_number
        left join purchase_requisition_item r
          on r.client = i.client and r.requisition_number = i.requisition_number and r.item_number = i.requisition_item
        where ${where}
      )
      select rows.*,
             greatest(quantity - delivered, 0) as open_delivery,
             greatest(delivered - invoiced, 0) as open_invoice
      from rows
      where true ${scopeFilter}
      ${orderBy}
      limit ${maxHits + 1}
    `) as unknown as Array<Record<string, unknown>>;

    const truncated = rows.length > maxHits;
    const window = rows.slice(0, maxHits);
    const nameRows = await tx.execute(sql`
      select partner_number, name from business_partner where client = ${client}
    `) as unknown as Array<{ partner_number: string; name: string }>;
    const nameOf = new Map(nameRows.map((r) => [r.partner_number, r.name]));

    const num = (value: unknown, scale = 3) => Number(fromScaled(toScaled(String(value), scale), scale));
    const out: PoListRow[] = window.map((r) => {
      const quantity = num(r.quantity);
      const delivered = num(r.delivered);
      const invoiced = num(r.invoiced);
      const marked = r.marked_for_deletion === true;
      const status: PoListStatus = marked
        ? 'MARKED'
        : delivered >= quantity && invoiced >= quantity
          ? 'COMPLETED'
          : delivered >= quantity
            ? 'DELIVERED'
            : delivered > 0 ? 'PARTIALLY_DELIVERED' : 'OPEN';
      return {
        orderNumber: String(r.order_number),
        itemNumber: Number(r.item_number),
        supplierNumber: String(r.supplier_number),
        supplierName: nameOf.get(String(r.supplier_number)) ?? '',
        purchasingOrg: String(r.purchasing_org ?? ''),
        purchasingGroup: String(r.purchasing_group ?? ''),
        companyCode: String(r.company_code ?? ''),
        documentDate: String(r.document_date),
        materialNumber: String(r.material_number ?? ''),
        shortText: String(r.short_text ?? ''),
        materialGroup: String(r.material_group ?? ''),
        plant: String(r.plant ?? ''),
        quantity,
        unit: String(r.unit ?? ''),
        netPrice: num(r.net_price, 2),
        priceUnit: Number(r.price_unit ?? 1),
        netValue: num(r.net_value, 2),
        currency: String(r.currency ?? ''),
        deliveryDate: String(r.delivery_date ?? ''),
        releaseStatus: String(r.release_status ?? ''),
        markedForDeletion: marked,
        requisitionNumber: String(r.requisition_number ?? ''),
        requisitionItem: r.requisition_item === null ? null : Number(r.requisition_item),
        requisitionQuantity: r.requisition_quantity === null ? null : num(r.requisition_quantity),
        deliveredQuantity: delivered,
        invoicedQuantity: invoiced,
        openDeliveryQuantity: num(r.open_delivery),
        openInvoiceQuantity: num(r.open_invoice),
        accountAssignmentCategory: String(r.account_assignment_category ?? ''),
        status,
        drillDown: `/purchasing/orders?order=${encodeURIComponent(String(r.order_number))}`,
      };
    });

    if (truncated) warnings.push(`The list is truncated at ${maxHits} hits; narrow the selection for the complete list.`);
    if (s.scope === 'ALL') {
      warnings.push('Marked items stand under All items only; they never count as outstanding work.');
    }

    return {
      capability: PO_LIST_CAPABILITY,
      perspective: perspective.code,
      perspectiveAlias: perspective.alias,
      scope: String(s.scope),
      selection: s,
      rows: out,
      rowCount: out.length,
      truncated,
      maxHits,
      warnings,
      calculatedAt,
    };
  });
}
