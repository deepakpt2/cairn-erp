/**
 * Purchase requisitions: list display — SCR-123 / PROC.REQ.LIST (ME5A).
 *
 * A read-only report over the standing requisition canon (SCR-055): it adds
 * no state, no table and — per the measured stage-2 decision (§26.841) — no
 * index. Purchasing organisation is never stored on the item; it is derived
 * through `purchasing_org_plant`, so an organisation filter matches when any
 * plant assignment falls in the range and a plant mapped to nothing still
 * shows, with an empty organisation. Conversion is derived from the live
 * purchase-order items citing the requisition item, so an order line that is
 * marked for deletion stops converting the moment it is marked.
 *
 * Deferred by name (contract §26.840): the tracking-number filter (BEDZN — no
 * field stands on the requisition item), display variants beyond this grid,
 * requisition release-status display, and exporting.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';

export const PR_LIST_CAPABILITY = 'PROC.REQ.LIST';
export const PR_LIST_ALIAS = 'ME5A';

export const DEFAULT_MAX_HITS = 500;
export const MAX_HITS_CAP = 5000;

/** Ordered quantity at or above the requisition quantity converts the item. */
export type RequisitionStatus = 'OPEN' | 'PARTIAL' | 'CONVERTED';

export interface RequisitionListSelection {
  purchasingGroupFrom?: string;
  purchasingGroupTo?: string;
  plantFrom?: string;
  plantTo?: string;
  materialFrom?: string;
  materialTo?: string;
  purchasingOrgFrom?: string;
  purchasingOrgTo?: string;
  /** Exact requisitioner (the creating user), blank for all. */
  requisitioner?: string;
  requisitionDateFrom?: string;
  requisitionDateTo?: string;
  /** 'COST_CENTER', or 'NONE' for items carrying no account assignment. */
  accountAssignmentCategory?: string;
  /** Default off: converted and marked items stay hidden until asked for. */
  displayClosed?: boolean;
  maxHits?: number;
}

export interface RequisitionListRow {
  requisitionNumber: string;
  itemNumber: number;
  materialNumber: string;
  shortText: string;
  quantity: number;
  unit: string;
  orderedQuantity: number;
  openQuantity: number;
  requisitionDate: string;
  deliveryDate: string;
  plant: string;
  purchasingGroup: string;
  /** Derived from the plant assignment; empty when the plant maps to none. */
  purchasingOrgs: string[];
  accountAssignmentCategory: string;
  requisitioner: string;
  estimatedPrice: number | null;
  priceUnit: number;
  currency: string;
  status: RequisitionStatus;
  markedForDeletion: boolean;
  /** Converted or marked for deletion — the "closed" the toggle governs. */
  closed: boolean;
  /** ME53N-equivalent drill-down. */
  drillDown: string;
}

export interface RequisitionListResult {
  capability: string;
  selection: RequisitionListSelection;
  rows: RequisitionListRow[];
  rowCount: number;
  truncated: boolean;
  maxHits: number;
  /** Closed rows hidden by the default toggle, for the screen's hint. */
  closedHidden: boolean;
  warnings: string[];
  calculatedAt: string;
}

export class RequisitionListError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'RequisitionListError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new RequisitionListError(message, remedy);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkDate(value: string, label: string): string {
  // Date.parse rolls an impossible day over (2026-02-30 becomes 2026-03-02), so
  // the calendar check is the round trip, not the parse.
  const parsed = ISO_DATE.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`${label} ${value} is not a valid date.`, 'Use the format YYYY-MM-DD.');
  }
  return value;
}

/** Blank strings mean "no restriction", never a filter on blank. */
function bound(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? undefined : trimmed;
}

export async function listPurchaseRequisitions(input: {
  client: string;
  selection: RequisitionListSelection;
}): Promise<RequisitionListResult> {
  const { client } = input;
  const raw = input.selection;
  const s: RequisitionListSelection = {
    purchasingGroupFrom: bound(raw.purchasingGroupFrom),
    purchasingGroupTo: bound(raw.purchasingGroupTo),
    plantFrom: bound(raw.plantFrom),
    plantTo: bound(raw.plantTo),
    materialFrom: bound(raw.materialFrom),
    materialTo: bound(raw.materialTo),
    purchasingOrgFrom: bound(raw.purchasingOrgFrom),
    purchasingOrgTo: bound(raw.purchasingOrgTo),
    requisitioner: bound(raw.requisitioner),
    requisitionDateFrom: bound(raw.requisitionDateFrom),
    requisitionDateTo: bound(raw.requisitionDateTo),
    accountAssignmentCategory: bound(raw.accountAssignmentCategory)?.toUpperCase(),
    displayClosed: raw.displayClosed === true,
    maxHits: raw.maxHits,
  };

  // Inverted ranges refuse by name before anything is read.
  const pairs: Array<[string, string | undefined, string | undefined]> = [
    ['purchasing group', s.purchasingGroupFrom, s.purchasingGroupTo],
    ['plant', s.plantFrom, s.plantTo],
    ['material', s.materialFrom, s.materialTo],
    ['purchasing organisation', s.purchasingOrgFrom, s.purchasingOrgTo],
    ['requisition date', s.requisitionDateFrom, s.requisitionDateTo],
  ];
  for (const [label, from, to] of pairs) {
    if (from && to && from > to) fail(`The ${label} range is inverted.`, 'The lower bound must not exceed the upper bound.');
  }
  if (s.requisitionDateFrom) checkDate(s.requisitionDateFrom, 'Requisition date from');
  if (s.requisitionDateTo) checkDate(s.requisitionDateTo, 'Requisition date to');
  if (
    s.accountAssignmentCategory
    && s.accountAssignmentCategory !== 'COST_CENTER'
    && s.accountAssignmentCategory !== 'NONE'
  ) {
    fail(
      `Account assignment category ${s.accountAssignmentCategory} does not stand.`,
      'This canon carries COST_CENTER, or NONE for items without assignment.',
    );
  }

  const warnings: string[] = [];
  const requested = s.maxHits ?? DEFAULT_MAX_HITS;
  if (!Number.isInteger(requested) || requested < 1) fail('Maximum hits must be a positive number.');
  const maxHits = Math.min(requested, MAX_HITS_CAP);
  if (requested > MAX_HITS_CAP) warnings.push(`Maximum hits capped at ${MAX_HITS_CAP}.`);
  const calculatedAt = new Date().toISOString();

  return withTenant(client, async (tx) => {
    // Every supplied range endpoint is judged against its master: a key that
    // does not stand refuses by name instead of answering an empty list that
    // would read as "no demand".
    const masters: Array<[string, string, string | undefined, string | undefined]> = [
      ['purchasing_group', 'purchasing group', s.purchasingGroupFrom, s.purchasingGroupTo],
      ['plant', 'plant', s.plantFrom, s.plantTo],
      ['purchasing_org', 'purchasing organisation', s.purchasingOrgFrom, s.purchasingOrgTo],
      ['material', 'material', s.materialFrom, s.materialTo],
    ];
    const masterKey: Record<string, string> = {
      purchasing_group: 'purchasing_group',
      plant: 'plant',
      purchasing_org: 'purchasing_org',
      material: 'material_number',
    };
    for (const [table, label, from, to] of masters) {
      if (!from && !to) continue;
      const key = masterKey[table]!;
      const rows = await tx.execute(sql`
        select ${sql.raw(key)} as key from ${sql.raw(table)}
        where client = ${client} and ${sql.raw(key)} in (${from ?? ''}, ${to ?? ''})
      `) as unknown as Array<{ key: string }>;
      const standing = new Set(rows.map((r) => r.key));
      for (const [boundValue, which] of [[from, 'from'], [to, 'to']] as const) {
        if (boundValue && !standing.has(boundValue)) {
          fail(
            `The ${label} ${boundValue} (${which} bound) does not stand.`,
            `Maintain the ${label} before selecting it.`,
          );
        }
      }
    }

    if (s.requisitioner) {
      const known = await tx.execute(sql`
        select 1 as hit from app_user where client = ${client} and username = ${s.requisitioner}
        union all
        select 1 as hit from purchase_requisition_item
        where client = ${client} and created_by = ${s.requisitioner} limit 1
      `) as unknown as Array<{ hit: number }>;
      if (known.length === 0) {
        fail(
          `Requisitioner ${s.requisitioner} is not known.`,
          'Select a user that stands, or one who has created a requisition.',
        );
      }
    }

    const filters = [sql`r.client = ${client}`];
    if (s.purchasingGroupFrom || s.purchasingGroupTo) {
      filters.push(sql`r.purchasing_group between ${s.purchasingGroupFrom ?? ''} and ${s.purchasingGroupTo ?? '￿'}`);
    }
    if (s.plantFrom || s.plantTo) {
      filters.push(sql`r.plant between ${s.plantFrom ?? ''} and ${s.plantTo ?? '￿'}`);
    }
    if (s.materialFrom || s.materialTo) {
      filters.push(sql`coalesce(r.material_number, '') between ${s.materialFrom ?? ''} and ${s.materialTo ?? '￿'}`);
    }
    if (s.requisitionDateFrom) filters.push(sql`r.requisition_date >= ${s.requisitionDateFrom}`);
    if (s.requisitionDateTo) filters.push(sql`r.requisition_date <= ${s.requisitionDateTo}`);
    if (s.requisitioner) filters.push(sql`r.created_by = ${s.requisitioner}`);
    if (s.accountAssignmentCategory === 'NONE') {
      filters.push(sql`coalesce(r.account_assignment_category, '') = ''`);
    } else if (s.accountAssignmentCategory === 'COST_CENTER') {
      filters.push(sql`r.account_assignment_category = 'COST_CENTER'`);
    }
    if (s.purchasingOrgFrom || s.purchasingOrgTo) {
      filters.push(sql`exists (
        select 1 from purchasing_org_plant op
        where op.client = r.client and op.plant = r.plant
          and op.purchasing_org between ${s.purchasingOrgFrom ?? ''} and ${s.purchasingOrgTo ?? '￿'}
      )`);
    }
    if (!s.displayClosed) {
      filters.push(sql`not (r.marked_for_deletion or coalesce(po.ordered, 0) >= r.quantity)`);
    }

    const where = sql.join(filters, sql` and `);
    const rows = await tx.execute(sql`
      select r.requisition_number, r.item_number, coalesce(r.material_number, '') as material_number,
        r.short_text, r.quantity::text as quantity, r.unit,
        coalesce(po.ordered, 0)::text as ordered,
        greatest(r.quantity - coalesce(po.ordered, 0), 0)::text as open_quantity,
        r.requisition_date::text as requisition_date, r.delivery_date::text as delivery_date,
        r.plant, r.purchasing_group, coalesce(r.account_assignment_category, '') as account_assignment,
        r.created_by, r.estimated_price::text as estimated_price, r.price_unit::text as price_unit,
        coalesce(r.currency, '') as currency, r.marked_for_deletion,
        coalesce(orgs.purchasing_orgs, '') as purchasing_orgs
      from purchase_requisition_item r
      left join (
        select requisition_number, requisition_item, sum(quantity) as ordered
        from purchase_order_item
        where client = ${client} and not marked_for_deletion
          and requisition_number is not null and requisition_number <> ''
        group by requisition_number, requisition_item
      ) po on po.requisition_number = r.requisition_number and po.requisition_item = r.item_number
      left join (
        select plant, string_agg(purchasing_org, ', ' order by purchasing_org) as purchasing_orgs
        from purchasing_org_plant where client = ${client} group by plant
      ) orgs on orgs.plant = r.plant
      where ${where}
      order by r.requisition_date desc, r.requisition_number, r.item_number
      limit ${maxHits + 1}
    `) as unknown as Array<Record<string, unknown>>;

    const truncated = rows.length > maxHits;
    const window = rows.slice(0, maxHits);
    const out: RequisitionListRow[] = window.map((r) => {
      const quantity = Number(fromScaled(toScaled(String(r.quantity), 3), 3));
      const orderedQuantity = Number(fromScaled(toScaled(String(r.ordered), 3), 3));
      const marked = r.marked_for_deletion === true;
      const status: RequisitionStatus = orderedQuantity <= 0
        ? 'OPEN'
        : orderedQuantity < quantity ? 'PARTIAL' : 'CONVERTED';
      return {
        requisitionNumber: String(r.requisition_number),
        itemNumber: Number(r.item_number),
        materialNumber: String(r.material_number ?? ''),
        shortText: String(r.short_text ?? ''),
        quantity,
        unit: String(r.unit ?? ''),
        orderedQuantity,
        openQuantity: Number(fromScaled(toScaled(String(r.open_quantity), 3), 3)),
        requisitionDate: String(r.requisition_date),
        deliveryDate: String(r.delivery_date),
        plant: String(r.plant ?? ''),
        purchasingGroup: String(r.purchasing_group ?? ''),
        purchasingOrgs: String(r.purchasing_orgs ?? '') === ''
          ? []
          : String(r.purchasing_orgs).split(', '),
        accountAssignmentCategory: String(r.account_assignment ?? ''),
        requisitioner: String(r.created_by ?? ''),
        estimatedPrice: r.estimated_price === null
          ? null
          : Number(fromScaled(toScaled(String(r.estimated_price)))),
        priceUnit: Number(r.price_unit ?? 1),
        currency: String(r.currency ?? ''),
        status,
        markedForDeletion: marked,
        closed: marked || status === 'CONVERTED',
        drillDown: `/purchasing/requisitions?req=${encodeURIComponent(String(r.requisition_number))}`,
      };
    });

    const closedHidden = !s.displayClosed;
    if (closedHidden) {
      warnings.push('Closed requisitions (converted or marked for deletion) are hidden; set Display closed to include them.');
    }
    if (truncated) {
      warnings.push(`The list is truncated at ${maxHits} hits; narrow the selection for the complete list.`);
    }

    return {
      capability: PR_LIST_CAPABILITY,
      selection: s,
      rows: out,
      rowCount: out.length,
      truncated,
      maxHits,
      closedHidden,
      warnings,
      calculatedAt,
    };
  });
}
