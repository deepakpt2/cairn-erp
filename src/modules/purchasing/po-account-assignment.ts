/**
 * Purchase orders by account assignment — SCR-129 / PROC.PO.ACCOUNTASSIGN (ME2K).
 *
 * The controlling perspective over the order book: every assignment line with
 * the object it commits to (a cost centre in this canon), the G/L account it
 * posts to, and the share of the item net value it carries.
 *
 * Commitment arithmetic: an item net value is distributed across its assignment
 * lines by percentage, and each line takes its share rounded to the cent. Group
 * totals are sums of those lines, so the cost-centre view always adds back to
 * what the items were worth.
 *
 * Deferred or refused by name (contract §26.858): asset (A), WBS (P) and internal
 * order (F) assignment categories — the canon item constraint admits only
 * COST_CENTER. Read-only: no insert, update or delete.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { receiptQuantityInOrderUnit, receiptUnitJoins } from './receipt-unit-basis';

export const PO_ACCOUNT_ASSIGN_CAPABILITY = 'PROC.PO.ACCOUNTASSIGN';
export const PO_ACCOUNT_ASSIGN_ALIAS = 'ME2K';

export const SCOPES = [
  { code: 'ALL', label: 'All items' },
  { code: 'STILL_TO_BE_DELIVERED', label: 'Still to be delivered' },
  { code: 'STILL_TO_BE_INVOICED', label: 'Still to be invoiced' },
  { code: 'COMPLETED', label: 'Completed' },
] as const;
export type PoScope = (typeof SCOPES)[number]['code'];

export const SCOPE_OF_LIST = ['ALV', 'STANDARD'] as const;
export type ScopeOfList = (typeof SCOPE_OF_LIST)[number];

/** The one assignment category this canon can carry, and the SAP code for it. */
export const COST_CENTER_CATEGORIES = ['COST_CENTER', 'K'] as const;

export const DEFAULT_MAX_HITS = 500;
export const MAX_HITS_CAP = 5000;

export interface PoAccountAssignSelection {
  scopeOfList?: string;
  scope?: string;
  accountAssignmentCategory?: string;
  costCenterFrom?: string;
  costCenterTo?: string;
  purchasingOrgFrom?: string;
  purchasingOrgTo?: string;
  purchasingGroupFrom?: string;
  purchasingGroupTo?: string;
  plantFrom?: string;
  plantTo?: string;
  supplierFrom?: string;
  supplierTo?: string;
  documentDateFrom?: string;
  documentDateTo?: string;
  maxHits?: number;
}

export interface PoAccountAssignRow {
  orderNumber: string;
  itemNumber: number;
  assignmentLine: number;
  accountAssignmentCategory: string;
  costCenter: string;
  glAccount: string;
  materialNumber: string;
  materialDescription: string;
  plant: string;
  quantity: number;
  unit: string;
  netValue: number;
  distributionPercentage: number;
  assignedValue: number;
  deliveryDate: string;
  releaseStatus: string;
  supplierNumber: string;
  currency: string;
  orderDrillDown: string;
  costCenterDrillDown: string;
}

export interface PoAccountAssignGroup {
  costCenter: string;
  assignedValue: number;
  lineCount: number;
}

export interface PoAccountAssignResult {
  capability: string;
  selection: PoAccountAssignSelection;
  scopeOfList: ScopeOfList;
  scope: PoScope;
  rows: PoAccountAssignRow[];
  groups: PoAccountAssignGroup[];
  groupCount: number;
  rowCount: number;
  totalAssignedValue: number;
  truncated: boolean;
  maxHits: number;
  warnings: string[];
  calculatedAt: string;
}

export class PoAccountAssignError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'PoAccountAssignError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new PoAccountAssignError(message, remedy);
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

export async function purchaseOrdersByAccountAssignment(input: {
  client: string;
  selection: PoAccountAssignSelection;
}): Promise<PoAccountAssignResult> {
  const { client } = input;
  const raw = input.selection;
  const s: PoAccountAssignSelection = {
    scopeOfList: bound(raw.scopeOfList) ?? 'ALV',
    scope: bound(raw.scope)?.toUpperCase() ?? 'ALL',
    accountAssignmentCategory: bound(raw.accountAssignmentCategory)?.toUpperCase(),
    costCenterFrom: bound(raw.costCenterFrom)?.toUpperCase(),
    costCenterTo: bound(raw.costCenterTo)?.toUpperCase(),
    purchasingOrgFrom: bound(raw.purchasingOrgFrom),
    purchasingOrgTo: bound(raw.purchasingOrgTo),
    purchasingGroupFrom: bound(raw.purchasingGroupFrom),
    purchasingGroupTo: bound(raw.purchasingGroupTo),
    plantFrom: bound(raw.plantFrom),
    plantTo: bound(raw.plantTo),
    supplierFrom: bound(raw.supplierFrom),
    supplierTo: bound(raw.supplierTo),
    documentDateFrom: bound(raw.documentDateFrom),
    documentDateTo: bound(raw.documentDateTo),
    maxHits: raw.maxHits,
  };

  const scopeOfList = String(s.scopeOfList).toUpperCase();
  if (!SCOPE_OF_LIST.includes(scopeOfList as ScopeOfList)) {
    fail(`The scope of list ${s.scopeOfList} does not stand.`, `Choose ${SCOPE_OF_LIST.join(' or ')}.`);
  }
  const scope = String(s.scope).toUpperCase();
  if (!SCOPES.some((sc) => sc.code === scope)) {
    fail(`The scope of selection ${s.scope} does not stand.`, `Use one of ${SCOPES.map((sc) => sc.code).join(', ')}.`);
  }
  if (s.accountAssignmentCategory) {
    const category = s.accountAssignmentCategory;
    if (category === 'A' || category === 'P' || category === 'F') {
      const name = category === 'A' ? 'asset' : category === 'P' ? 'WBS element' : 'internal order';
      fail(
        `The account assignment category ${category} (${name}) is not carried.`,
        'This canon assigns purchase order items to cost centres only; K and COST_CENTER are accepted.',
      );
    }
    if (!(COST_CENTER_CATEGORIES as readonly string[]).includes(category)) {
      fail(
        `The account assignment category ${category} does not stand.`,
        `Use ${COST_CENTER_CATEGORIES.join(' or ')}.`,
      );
    }
  }
  for (const [from, to, label] of [
    [s.costCenterFrom, s.costCenterTo, 'cost centre'],
    [s.purchasingOrgFrom, s.purchasingOrgTo, 'purchasing organisation'],
    [s.purchasingGroupFrom, s.purchasingGroupTo, 'purchasing group'],
    [s.plantFrom, s.plantTo, 'plant'],
    [s.supplierFrom, s.supplierTo, 'supplier'],
  ] as const) {
    if (from && to && to < from) fail(`The ${label} range is inverted.`, 'The lower bound must not exceed the upper bound.');
  }
  if (s.documentDateFrom) checkDate(s.documentDateFrom, 'Document date from');
  if (s.documentDateTo) checkDate(s.documentDateTo, 'Document date to');
  if (s.documentDateFrom && s.documentDateTo && s.documentDateTo < s.documentDateFrom) {
    fail('The document date range is inverted.', 'The start date must not exceed the end date.');
  }

  const warnings: string[] = [];
  const requested = s.maxHits ?? DEFAULT_MAX_HITS;
  if (!Number.isInteger(requested) || requested < 1) fail('Maximum hits must be a positive number.');
  const maxHits = Math.min(requested, MAX_HITS_CAP);
  if (requested > MAX_HITS_CAP) warnings.push(`Maximum hits capped at ${MAX_HITS_CAP}.`);
  if (scopeOfList === 'STANDARD') warnings.push('The scope of list STANDARD is presented as a flat list; the group totals stand below it.');
  if (s.accountAssignmentCategory === 'K') {
    warnings.push('Account assignment category K was read as COST_CENTER, the only category this canon carries.');
  }
  const calculatedAt = new Date().toISOString();

  return withTenant(client, async (tx) => {
    if (s.costCenterFrom) {
      const rows = await tx.execute(sql`
        select 1 as hit from cost_center where client = ${client} and cost_center = ${s.costCenterFrom!} limit 1
      `) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) fail(`The cost centre ${s.costCenterFrom} does not stand.`, 'Maintain the cost centre before selecting it.');
    }
    if (s.plantFrom) {
      const rows = await tx.execute(sql`select 1 as hit from plant where client = ${client} and plant = ${s.plantFrom!} limit 1`) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) fail(`The plant ${s.plantFrom} does not stand.`, 'Maintain the plant before selecting it.');
    }
    if (s.supplierFrom) {
      const rows = await tx.execute(sql`
        select 1 as hit from business_partner where client = ${client} and partner_number = ${s.supplierFrom!} limit 1
      `) as unknown as Array<{ hit: number }>;
      if (rows.length === 0) fail(`The supplier ${s.supplierFrom} does not stand.`, 'Maintain the business partner before selecting it.');
    }

    // A marked item is not outstanding work, so it never stands in a still-to-be
    // or completed scope — the SCR-124 ruling, unchanged.
    const scopeFilter = scope === 'STILL_TO_BE_DELIVERED'
      ? sql`and not i.marked_for_deletion and coalesce(gr.delivered, 0) < i.quantity`
      : scope === 'STILL_TO_BE_INVOICED'
        ? sql`and not i.marked_for_deletion and coalesce(gr.delivered, 0) > coalesce(ir.invoiced, 0)`
        : scope === 'COMPLETED'
          ? sql`and not i.marked_for_deletion and coalesce(gr.delivered, 0) >= i.quantity and coalesce(ir.invoiced, 0) >= i.quantity`
          : sql``;

    const where = sql.join([
      s.costCenterFrom ? sql`and a.cost_center >= ${s.costCenterFrom}` : sql``,
      s.costCenterTo ? sql`and a.cost_center <= ${s.costCenterTo}` : sql``,
      s.purchasingOrgFrom ? sql`and po.purchasing_org >= ${s.purchasingOrgFrom}` : sql``,
      s.purchasingOrgTo ? sql`and po.purchasing_org <= ${s.purchasingOrgTo}` : sql``,
      s.purchasingGroupFrom ? sql`and po.purchasing_group >= ${s.purchasingGroupFrom}` : sql``,
      s.purchasingGroupTo ? sql`and po.purchasing_group <= ${s.purchasingGroupTo}` : sql``,
      s.plantFrom ? sql`and i.plant >= ${s.plantFrom}` : sql``,
      s.plantTo ? sql`and i.plant <= ${s.plantTo}` : sql``,
      s.supplierFrom ? sql`and po.supplier_number >= ${s.supplierFrom}` : sql``,
      s.supplierTo ? sql`and po.supplier_number <= ${s.supplierTo}` : sql``,
      s.documentDateFrom ? sql`and po.document_date >= ${s.documentDateFrom}` : sql``,
      s.documentDateTo ? sql`and po.document_date <= ${s.documentDateTo}` : sql``,
    ], sql` `);

    // Driven from the header date — the one predicate the package makes meaningful,
    // and the plan every standing arm already chose (stage 2, B-847).
    const rows = await tx.execute(sql`
      with gr as (
        select l.purchase_order_number, l.purchase_order_item,
               -- The order line is counted in its own unit; the material's base unit is the stock
               -- figure, which this screen does not compare the ordered quantity with.
               sum(case when m.direction = 'REVERSAL' then -(${receiptQuantityInOrderUnit}) else (${receiptQuantityInOrderUnit}) end) as delivered
        from material_document_line l
        join material_document d
          on d.client = l.client and d.material_document_number = l.material_document_number and d.status = 'POSTED'
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
      )
      select po.order_number, i.item_number, a.line_number, i.account_assignment_category,
             a.cost_center, a.gl_account, coalesce(i.material_number, '') as material_number,
             coalesce(mat.description, i.short_text) as material_description, i.plant,
             i.quantity::text as quantity, i.unit, i.net_value::text as net_value,
             a.distribution_percentage::text as distribution_percentage,
             po.supplier_number, po.currency, po.release_status,
             coalesce(sc.delivery_date, '') as delivery_date
      from purchase_order po
      join purchase_order_item i on i.client = po.client and i.order_number = po.order_number
      join purchase_order_assignment a
        on a.client = i.client and a.order_number = i.order_number and a.item_number = i.item_number
      left join material mat on mat.client = i.client and mat.material_number = i.material_number
      left join gr on gr.purchase_order_number = i.order_number and gr.purchase_order_item = i.item_number
      left join ir on ir.purchase_order_number = i.order_number and ir.purchase_order_item = i.item_number
      left join schedule sc on sc.order_number = i.order_number and sc.item_number = i.item_number
      where po.client = ${client} ${where} ${scopeFilter}
      order by a.cost_center, po.order_number, i.item_number, a.line_number
      limit ${maxHits + 1}
    `) as unknown as Array<Record<string, unknown>>;

    const truncated = rows.length > maxHits;
    const window = rows.slice(0, maxHits);
    const num = (value: unknown, scale = 2) => (value === null || value === undefined
      ? 0
      : Number(fromScaled(toScaled(String(value), scale), scale)));

    const out: PoAccountAssignRow[] = window.map((r) => {
      const netValue = num(r.net_value);
      const percent = num(r.distribution_percentage);
      const costCenter = String(r.cost_center ?? '');
      const orderNumber = String(r.order_number);
      return {
        orderNumber,
        itemNumber: Number(r.item_number),
        assignmentLine: Number(r.line_number),
        accountAssignmentCategory: String(r.account_assignment_category ?? ''),
        costCenter,
        glAccount: String(r.gl_account ?? ''),
        materialNumber: String(r.material_number ?? ''),
        materialDescription: String(r.material_description ?? ''),
        plant: String(r.plant ?? ''),
        quantity: num(r.quantity, 3),
        unit: String(r.unit ?? ''),
        netValue,
        distributionPercentage: percent,
        // The line takes its share of the item, rounded at the line.
        assignedValue: Number(((netValue * percent) / 100).toFixed(2)),
        deliveryDate: String(r.delivery_date ?? ''),
        releaseStatus: String(r.release_status ?? ''),
        supplierNumber: String(r.supplier_number ?? ''),
        currency: String(r.currency ?? ''),
        orderDrillDown: `/purchasing/orders?order=${encodeURIComponent(orderNumber)}`,
        costCenterDrillDown: `/controlling/cost-center-report?costCenter=${encodeURIComponent(costCenter)}`,
      };
    });

    // Grouped by assigned object: the controlling view the package asks for.
    const groupMap = new Map<string, { assignedValue: number; lineCount: number }>();
    for (const row of out) {
      const entry = groupMap.get(row.costCenter) ?? { assignedValue: 0, lineCount: 0 };
      entry.assignedValue += row.assignedValue;
      entry.lineCount += 1;
      groupMap.set(row.costCenter, entry);
    }
    const groups: PoAccountAssignGroup[] = [...groupMap.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([costCenter, entry]) => ({
        costCenter,
        assignedValue: Number(entry.assignedValue.toFixed(2)),
        lineCount: entry.lineCount,
      }));
    const totalAssignedValue = Number(groups.reduce((sum, g) => sum + g.assignedValue, 0).toFixed(2));

    if (truncated) warnings.push(`The list is truncated at ${maxHits} hits; the group totals cover the rows shown. Narrow the selection for the complete list.`);
    if (out.length === 0) warnings.push('No assignment line matches the selection.');

    return {
      capability: PO_ACCOUNT_ASSIGN_CAPABILITY,
      selection: s,
      scopeOfList: scopeOfList as ScopeOfList,
      scope: scope as PoScope,
      rows: out,
      groups,
      groupCount: groups.length,
      rowCount: out.length,
      totalAssignedValue,
      truncated,
      maxHits,
      warnings,
      calculatedAt,
    };
  });
}
