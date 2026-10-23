/**
 * Material document list — SCR-125 / INV.MATERIALDOC.LIST (MB51).
 *
 * Read-only over the standing ledger: material document headers and their line
 * segments, joined to movement types, the material master and its description.
 * No state, no table of its own; the one index the round adds is the header
 * posting-date path measured in stage 2 (§26.847), and it is the required
 * posting-date range that keeps the query on it.
 *
 * History is never hidden: a document that stands REVERSED is listed with that
 * status and its reversal is a document of its own carrying the REVERSAL
 * direction. Closed posting periods never suppress history.
 *
 * A named batch filters and shows the batch already stored on the line. It does
 * not create a batch. Deferred by name: Scope-of-List presentation variants,
 * project and sales-order special stock, serial-number selection, and exporting.
 * A sales order, a delivery, a billing document, and a scheduling agreement are
 * refused by name. Those documents are not on the material document.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';

export const MATERIAL_DOC_LIST_CAPABILITY = 'INV.MATERIALDOC.LIST';
export const MATERIAL_DOC_LIST_ALIAS = 'MB51';

export const DEFAULT_MAX_HITS = 500;
export const MAX_HITS_CAP = 5000;

export interface MaterialDocListSelection {
  materialFrom?: string;
  materialTo?: string;
  plantFrom?: string;
  plantTo?: string;
  storageLocationFrom?: string;
  storageLocationTo?: string;
  movementTypeFrom?: string;
  movementTypeTo?: string;
  /** Required: a list over an unbounded ledger is a scan of history. */
  postingDateFrom?: string;
  postingDateTo?: string;
  documentDateFrom?: string;
  documentDateTo?: string;
  stockType?: string;
  /** Exact batch already stored on the line. Blank means every batch, including none. */
  batch?: string;
  purchaseOrderFrom?: string;
  purchaseOrderTo?: string;
  userName?: string;
  maxHits?: number;
  salesOrder?: string;
  delivery?: string;
  billingDocument?: string;
  schedulingAgreement?: string;
  serialNumber?: string;
}

export interface MaterialDocListRow {
  materialDocumentNumber: string;
  documentYear: number;
  lineNumber: number;
  movementType: string;
  movementDirection: string;
  materialNumber: string;
  materialDescription: string;
  entryQuantity: number;
  entryUnit: string;
  baseQuantity: number;
  baseUnit: string;
  unitPrice: number;
  priceUnit: number;
  value: number;
  currency: string;
  plant: string;
  storageLocation: string;
  stockType: string;
  batch: string;
  postingDate: string;
  documentDate: string;
  headerText: string;
  status: string;
  purchaseOrderNumber: string;
  purchaseOrderItem: number | null;
  itemText: string;
  createdBy: string;
  journalDocument: string;
  drillDown: string;
}

export interface MaterialDocListResult {
  capability: string;
  selection: MaterialDocListSelection;
  rows: MaterialDocListRow[];
  rowCount: number;
  truncated: boolean;
  maxHits: number;
  warnings: string[];
  calculatedAt: string;
}

export class MaterialDocListError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'MaterialDocListError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new MaterialDocListError(message, remedy);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkDate(value: string, label: string): string {
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

const MASTERS: Array<{ key: keyof MaterialDocListSelection; table: string; column: string; label: string }> = [
  { key: 'materialFrom', table: 'material', column: 'material_number', label: 'material' },
  { key: 'materialTo', table: 'material', column: 'material_number', label: 'material' },
  { key: 'plantFrom', table: 'plant', column: 'plant', label: 'plant' },
  { key: 'plantTo', table: 'plant', column: 'plant', label: 'plant' },
  { key: 'storageLocationFrom', table: 'storage_location', column: 'storage_location', label: 'storage location' },
  { key: 'storageLocationTo', table: 'storage_location', column: 'storage_location', label: 'storage location' },
  { key: 'movementTypeFrom', table: 'movement_type', column: 'movement_type', label: 'movement type' },
  { key: 'movementTypeTo', table: 'movement_type', column: 'movement_type', label: 'movement type' },
];

export async function listMaterialDocuments(input: {
  client: string;
  selection: MaterialDocListSelection;
}): Promise<MaterialDocListResult> {
  const { client } = input;
  const raw = input.selection;
  const s: MaterialDocListSelection = {
    materialFrom: bound(raw.materialFrom),
    materialTo: bound(raw.materialTo),
    plantFrom: bound(raw.plantFrom),
    plantTo: bound(raw.plantTo),
    storageLocationFrom: bound(raw.storageLocationFrom),
    storageLocationTo: bound(raw.storageLocationTo),
    movementTypeFrom: bound(raw.movementTypeFrom),
    movementTypeTo: bound(raw.movementTypeTo),
    postingDateFrom: bound(raw.postingDateFrom),
    postingDateTo: bound(raw.postingDateTo),
    documentDateFrom: bound(raw.documentDateFrom),
    documentDateTo: bound(raw.documentDateTo),
    stockType: bound(raw.stockType),
    batch: bound(raw.batch)?.toUpperCase(),
    purchaseOrderFrom: bound(raw.purchaseOrderFrom),
    salesOrder: bound(raw.salesOrder),
    delivery: bound(raw.delivery),
    billingDocument: bound(raw.billingDocument),
    schedulingAgreement: bound(raw.schedulingAgreement),
    serialNumber: bound(raw.serialNumber),
    purchaseOrderTo: bound(raw.purchaseOrderTo),
    userName: bound(raw.userName),
    maxHits: raw.maxHits,
  };

  if (s.salesOrder) {
    fail('A sales order is not on the material document. No list was read.', 'Select a material or a batch. This list does not read a sales order.');
  }
  if (s.delivery) {
    fail('A delivery is not on the material document. No list was read.', 'Select a material or a batch. This list does not read a delivery.');
  }
  if (s.billingDocument) {
    fail('A billing document is not on the material document. No list was read.', 'Select a material or a batch. This list does not read a billing document.');
  }
  if (s.schedulingAgreement) {
    fail('A scheduling agreement is not on the material document. No list was read.', 'Select a material or a batch. This list does not read a scheduling agreement.');
  }
  if (s.serialNumber) {
    fail('A serial number is not on the material document. No list was read.', 'Select a material or a batch. This list does not read a serial number.');
  }

  // The posting-date range is required: without it the query has no index path
  // and the list becomes a scan of the whole ledger.
  if (!s.postingDateFrom || !s.postingDateTo) {
    fail(
      'A posting date range is required.',
      'Enter the posting date from and to — the ledger list is always bounded by posting dates.',
    );
  }
  checkDate(s.postingDateFrom, 'Posting date from');
  checkDate(s.postingDateTo, 'Posting date to');
  if (s.postingDateFrom > s.postingDateTo) {
    fail('The posting date range is inverted.', 'The lower bound must not exceed the upper bound.');
  }

  const pairs: Array<[string, string | undefined, string | undefined]> = [
    ['material', s.materialFrom, s.materialTo],
    ['plant', s.plantFrom, s.plantTo],
    ['storage location', s.storageLocationFrom, s.storageLocationTo],
    ['movement type', s.movementTypeFrom, s.movementTypeTo],
    ['document date', s.documentDateFrom, s.documentDateTo],
    ['purchase order', s.purchaseOrderFrom, s.purchaseOrderTo],
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
    // A document-number range is a scan; a single number must stand.
    if (s.purchaseOrderFrom && s.purchaseOrderFrom === s.purchaseOrderTo) {
      const rows = await tx.execute(sql`
        select 1 as hit from purchase_order where client = ${client} and order_number = ${s.purchaseOrderFrom}
      `) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) {
        fail(`The purchase order ${s.purchaseOrderFrom} does not stand.`, 'Maintain the order or widen the range.');
      }
    }
    if (s.stockType) {
      // Stock type has no master: it is judged against the types that stand in
      // the tenant's stock and ledger, so a typo refuses instead of answering an
      // empty list.
      const rows = await tx.execute(sql`
        select 1 as hit from stock_quantity where client = ${client} and stock_type = ${s.stockType}
        union all
        select 1 as hit from material_document_line where client = ${client} and stock_type = ${s.stockType}
        limit 1
      `) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) {
        fail(
          `The stock type ${s.stockType} does not stand.`,
          'Project and sales-order special stocks are not carried; select a stock type the ledger records.',
        );
      }
    }
    if (s.userName) {
      const rows = await tx.execute(sql`
        select 1 as hit from app_user where client = ${client} and username = ${s.userName}
        union all
        select 1 as hit from material_document where client = ${client} and created_by = ${s.userName}
        limit 1
      `) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) {
        fail(`User ${s.userName} is not known.`, 'Select a user that stands, or one who has posted a material document.');
      }
    }
    if (s.batch) {
      const standing = await tx.execute(sql`
        select 1 as hit from batch where client = ${client} and batch_number = ${s.batch} limit 1
      `) as unknown as Array<{ hit: number }>;
      if (standing.length === 0) {
        fail(
          `Batch ${s.batch} does not stand. No list was read.`,
          'Create the batch in MSC1N first. This list does not create a batch.',
        );
      }
    }

    const filters = [sql`l.client = ${client}`];
    const range = (column: string, from?: string, to?: string) => {
      if (!from && !to) return;
      filters.push(sql`${sql.raw(column)} between ${from ?? ''} and ${to ?? '￿'}`);
    };
    range('l.material_number', s.materialFrom, s.materialTo);
    range('l.plant', s.plantFrom, s.plantTo);
    range('l.storage_location', s.storageLocationFrom, s.storageLocationTo);
    range('l.movement_type', s.movementTypeFrom, s.movementTypeTo);
    range('l.purchase_order_number', s.purchaseOrderFrom, s.purchaseOrderTo);
    filters.push(sql`d.posting_date >= ${s.postingDateFrom}`);
    filters.push(sql`d.posting_date <= ${s.postingDateTo}`);
    if (s.documentDateFrom) filters.push(sql`d.document_date >= ${s.documentDateFrom}`);
    if (s.documentDateTo) filters.push(sql`d.document_date <= ${s.documentDateTo}`);
    if (s.stockType) filters.push(sql`l.stock_type = ${s.stockType}`);
    if (s.batch) filters.push(sql`l.batch_number = ${s.batch}`);
    if (s.userName) filters.push(sql`d.created_by = ${s.userName}`);
    const where = sql.join(filters, sql` and `);

    const rows = await tx.execute(sql`
      select d.material_document_number, d.document_year, l.line_number, l.movement_type, m.direction,
             l.material_number, coalesce(mat.description, '') as material_description,
             l.entry_quantity, l.entry_unit, l.base_quantity, l.base_unit,
             l.unit_price, l.price_unit, l.value, l.currency,
             l.plant, coalesce(l.storage_location, '') as storage_location, l.stock_type,
             coalesce(l.batch_number, '') as batch_number,
             d.posting_date::text as posting_date, d.document_date::text as document_date,
             coalesce(d.header_text, '') as header_text, d.status, d.created_by,
             coalesce(d.journal_document_number, '') as journal_document,
             coalesce(l.purchase_order_number, '') as purchase_order_number, l.purchase_order_item,
             coalesce(l.item_text, '') as item_text
      from material_document_line l
      join material_document d
        on d.client = l.client and d.material_document_number = l.material_document_number
      join movement_type m on m.client = l.client and m.movement_type = l.movement_type
      left join material mat on mat.client = l.client and mat.material_number = l.material_number
      where ${where}
      order by d.posting_date desc, d.material_document_number, l.line_number
      limit ${maxHits + 1}
    `) as unknown as Array<Record<string, unknown>>;

    const truncated = rows.length > maxHits;
    const window = rows.slice(0, maxHits);
    const num = (value: unknown, scale = 3) => Number(fromScaled(toScaled(String(value), scale), scale));
    const out: MaterialDocListRow[] = window.map((r) => ({
      materialDocumentNumber: String(r.material_document_number),
      documentYear: Number(r.document_year),
      lineNumber: Number(r.line_number),
      movementType: String(r.movement_type),
      movementDirection: String(r.direction ?? ''),
      materialNumber: String(r.material_number),
      materialDescription: String(r.material_description ?? ''),
      entryQuantity: num(r.entry_quantity),
      entryUnit: String(r.entry_unit ?? ''),
      baseQuantity: num(r.base_quantity),
      baseUnit: String(r.base_unit ?? ''),
      unitPrice: num(r.unit_price, 2),
      priceUnit: Number(r.price_unit ?? 1),
      value: num(r.value, 2),
      currency: String(r.currency ?? ''),
      plant: String(r.plant ?? ''),
      storageLocation: String(r.storage_location ?? ''),
      stockType: String(r.stock_type ?? ''),
      batch: String(r.batch_number ?? ''),
      postingDate: String(r.posting_date),
      documentDate: String(r.document_date),
      headerText: String(r.header_text ?? ''),
      status: String(r.status),
      purchaseOrderNumber: String(r.purchase_order_number ?? ''),
      purchaseOrderItem: r.purchase_order_item === null ? null : Number(r.purchase_order_item),
      itemText: String(r.item_text ?? ''),
      createdBy: String(r.created_by ?? ''),
      journalDocument: String(r.journal_document ?? ''),
      drillDown: `/inventory/material-documents?document=${encodeURIComponent(String(r.material_document_number))}`,
    }));

    if (truncated) warnings.push(`The list is truncated at ${maxHits} hits; narrow the selection for the complete list.`);
    if (out.some((r) => r.status !== 'POSTED')) {
      warnings.push('Documents that stand reversed are listed with that status; their reversals stand as document lines of their own.');
    }

    return {
      capability: MATERIAL_DOC_LIST_CAPABILITY,
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
