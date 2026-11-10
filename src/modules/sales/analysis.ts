/**
 * Sales analysis — §5.3, SAP's MCTA, MC+I and the sales information system.
 *
 * A register answers "show me the documents". An analysis answers "what do they add up to" — by
 * customer, by material, by sales organisation, by document type, by period — and it is the first
 * screen in this package that is read by somebody who is not about to do anything with what they
 * see. That changes what it owes them: a register may hand back rows, but an analysis has to be
 * able to say what its own numbers mean.
 *
 * Four things follow from that, and they are the whole design.
 *
 * **Every analysis reads documents that already stand.** There is no analysis table, no cube and no
 * nightly roll-up, for the same reason the register carries none (§5.2): a number that is copied is
 * a number that can disagree with the document it came from, and an analysis is read by people who
 * will not open the document to check.
 *
 * **The arithmetic has one author.** The backlog's delivered and billed quantities are read with the
 * same joins as `fulfillment-quantities.ts`, because that module is what the order, delivery and
 * billing services use to refuse things. An analysis that said a line was open when the delivery
 * service says it is drawn down would be worse than no analysis.
 *
 * **Money is never added across currencies.** Every analysis is grouped by currency as well as by the
 * dimension it was asked for, and the totals are reported once per currency. A single total over
 * USD and EUR is not a number, and an analysis that printed one would be read as truth.
 *
 * **Cost is reported only where a cost stands.** Margin is read from the statistical cost condition
 * (Phase 2), joined line by line. A line priced by a procedure that carries no cost condition has no
 * cost, and the row says so rather than showing a margin equal to its revenue — which is the single
 * most dangerous number a margin report can print.
 *
 * Nothing here posts, and nothing here decides. An analysis reads.
 */
import { sql } from 'drizzle-orm';

import { type Tx, withTenant } from '../../platform/db/client';
import { businessPartner } from '../foundation/business-partner-schema';
import { salesArea } from '../foundation/schema';
import { material } from '../inventory/schema';
import { STANDARD_RETURNS_DELIVERY_TYPE } from './document-type';
import {
  billingDocument, billingDocumentLine, delivery, deliveryLine, salesDocumentType,
  salesOrder, salesOrderLine,
} from './schema';

// ─────────────────────────────────────────────────────────────────────────────
// What can be analysed
// ─────────────────────────────────────────────────────────────────────────────

export const ANALYSIS_KINDS = ['SALES', 'BACKLOG', 'RETURNS', 'MARGIN'] as const;
export type AnalysisKind = (typeof ANALYSIS_KINDS)[number];

export const ANALYSIS_KIND_MEANING: Record<AnalysisKind, string> = {
  SALES: 'What was sold: billed quantities and revenue, by whatever the business asks about.',
  BACKLOG: 'What is still to come: the open quantity and value on orders that stand.',
  RETURNS: 'What came back: the goods received on returns deliveries, and what they were worth.',
  MARGIN: 'What it earned: revenue less the cost the pricing carried, and the margin as a share of it.',
};

/** The dimension a row is broken down by. */
export const GROUP_BY = ['CUSTOMER', 'MATERIAL', 'SALES_ORG', 'DOCUMENT_TYPE', 'PERIOD'] as const;
export type GroupBy = (typeof GROUP_BY)[number];

export const GROUP_BY_MEANING: Record<GroupBy, string> = {
  CUSTOMER: 'By customer',
  MATERIAL: 'By material',
  SALES_ORG: 'By sales organisation',
  DOCUMENT_TYPE: 'By document type',
  PERIOD: 'By period',
};

/** How the date axis is bucketed. `TOTAL` is one row per group over the whole window. */
export const PERIODS = ['TOTAL', 'MONTH', 'QUARTER', 'YEAR'] as const;
export type Period = (typeof PERIODS)[number];

export const ANALYSIS_LIMIT = 200;

export interface AnalysisFilter {
  documentNumber?: string;
  orderNumber?: string;
  deliveryNumber?: string;
  customerNumber?: string;
  materialNumber?: string;
  salesOrg?: string;
  plant?: string;
  documentType?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Money is never added across currencies, so a caller may name the one it wants. */
  currency?: string;
}

export interface AnalysisRow {
  /** The grouped value: a customer number, a material number, a sales organisation, a type, or '' . */
  key: string;
  /** What that value is called, where the master has a name for it. */
  keyName: string | null;
  /** The period bucket, '' when the analysis is not bucketed. */
  period: string;
  currency: string;
  /** How many documents contributed to this row. */
  documents: number;
  /** How many document lines contributed, and how many of them carried a cost. */
  lines: number;
  costedLines: number;
  /**
   * What the analysis counts. Billed quantity for sales and margin, open quantity for the backlog,
   * returned quantity for returns.
   */
  quantity: string;
  /** The value of that quantity, in the row's currency. */
  netValue: string;
  /** The cost the pricing carried. Null where this analysis carries no cost at all. */
  costValue: string | null;
  marginValue: string | null;
  /** The margin as a percentage of revenue. Null where there is no revenue to be a share of. */
  marginPercent: string | null;
  /** Whether every line in the row carried a cost. A row that did not has an understated margin. */
  costIsComplete: boolean;
}

/**
 * The totals of what was answered, once per currency.
 *
 * There is deliberately no document count here. A document carrying two materials stands in two rows
 * when the analysis is by material, and a total that counted it once would not add up to the rows
 * above it — which is the same promise the register makes about its totals (§5.2).
 */
export interface AnalysisTotals {
  currency: string;
  quantity: string;
  netValue: string;
  costValue: string | null;
  marginValue: string | null;
  marginPercent: string | null;
  costIsComplete: boolean;
}

export interface Analysis {
  kind: AnalysisKind;
  meaning: string;
  groupBy: GroupBy;
  period: Period;
  rows: AnalysisRow[];
  /** How many groups there were, whether or not they were all read. */
  count: number;
  truncated: boolean;
  /** One entry per currency, because money is never added across them. */
  totals: AnalysisTotals[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Building the read
// ─────────────────────────────────────────────────────────────────────────────

/** Trim a filter of its blanks, so an empty box on a screen narrows nothing. */
function clean(filter: AnalysisFilter): AnalysisFilter {
  const out: AnalysisFilter = {};
  for (const [key, value] of Object.entries(filter)) {
    if (typeof value === 'string' && value.trim() !== '') {
      (out as Record<string, string>)[key] = value.trim();
    }
  }
  return out;
}

/**
 * The date a row is bucketed by, per analysis.
 *
 * Sales and margin are bucketed by the billing date, because that is the day the revenue was
 * earned. The backlog is bucketed by the date the customer asked for the goods, because a backlog
 * is a promise about the future and bucketing it by the day the order was taken would put a
 * late-running order in a period nobody is worried about.
 */
const DATE_COLUMN: Record<AnalysisKind, string> = {
  SALES: 'bd.billing_date',
  MARGIN: 'bd.billing_date',
  BACKLOG: 'ol.requested_delivery_date',
  RETURNS: 'dv.delivery_date',
};

/** The bucket itself, as a sortable string. */
function periodExpression(period: Period, kind: AnalysisKind): ReturnType<typeof sql> {
  const column = sql.raw(DATE_COLUMN[kind]);
  if (period === 'MONTH') return sql`to_char(${column}, 'YYYY-MM')`;
  if (period === 'QUARTER') return sql`to_char(${column}, 'YYYY-"Q"Q')`;
  if (period === 'YEAR') return sql`to_char(${column}, 'YYYY')`;
  return sql`''::text`;
}

/**
 * The dimension, as a column of the analysis that is answering.
 *
 * A material stands on the billing line in one analysis and on the order line in another, which is
 * why each kind names its own columns rather than sharing an alias. This map is the whole of the
 * surface a caller can choose from — a free-text dimension would be a free-text `GROUP BY`.
 */
const DIMENSION_COLUMN: Record<AnalysisKind, Record<GroupBy, string>> = {
  SALES: {
    CUSTOMER: 'bd.customer_number', MATERIAL: 'bl.material_number',
    SALES_ORG: 'bd.sales_org', DOCUMENT_TYPE: 'bd.document_type', PERIOD: "''::text",
  },
  MARGIN: {
    CUSTOMER: 'bd.customer_number', MATERIAL: 'bl.material_number',
    SALES_ORG: 'bd.sales_org', DOCUMENT_TYPE: 'bd.document_type', PERIOD: "''::text",
  },
  BACKLOG: {
    CUSTOMER: 'o.customer_number', MATERIAL: 'ol.material_number',
    SALES_ORG: 'o.sales_org', DOCUMENT_TYPE: 'o.document_type', PERIOD: "''::text",
  },
  RETURNS: {
    CUSTOMER: 'so.customer_number', MATERIAL: 'dl.material_number',
    SALES_ORG: 'so.sales_org', DOCUMENT_TYPE: 'dv.document_type', PERIOD: "''::text",
  },
};

/**
 * How the read is cut before it is cut short. Biggest first, which is what an analysis is for —
 * except when the axis *is* the period, where a reader wants the buckets in order.
 */
function orderExpression(groupBy: GroupBy, value: ReturnType<typeof sql>): ReturnType<typeof sql> {
  return groupBy === 'PERIOD' ? sql`1 asc` : sql`${value} desc`;
}

interface RawRow {
  key_value: string | null;
  period_value: string | null;
  currency: string;
  documents: number | string;
  lines: number | string;
  costed_lines: number | string;
  quantity: string;
  net_value: string;
  cost_value: string | null;
  total_groups: number | string;
}

/** The window a filter imposes on a date column, as a SQL fragment. */
function dateWindow(filter: AnalysisFilter, kind: AnalysisKind): ReturnType<typeof sql> {
  const column = sql.raw(DATE_COLUMN[kind]);
  if (filter.dateFrom && filter.dateTo) {
    return sql`and ${column} between ${filter.dateFrom} and ${filter.dateTo}`;
  }
  if (filter.dateFrom) return sql`and ${column} >= ${filter.dateFrom}`;
  if (filter.dateTo) return sql`and ${column} <= ${filter.dateTo}`;
  return sql``;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sales and margin: the billing documents that stand, line by line
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What was sold, and what it cost.
 *
 * The cost is joined at the line, from the statistical cost conditions the pricing wrote. Only
 * `ITEM` and `DISTRIBUTED` rows are taken: an `ITEM` row is a condition priced on that line, and a
 * `DISTRIBUTED` row is the share of a header condition that fell to it. The `HEADER` row is the
 * whole of that header condition, kept at line zero, and taking it alongside its own shares would
 * count the same money twice.
 *
 * A billing document that was cancelled is left out, and so is the cancellation document it raised,
 * which carries no lines of its own — the pair nets to nothing by absence, which is exactly how
 * `fulfillment-quantities.ts` treats cancelled documents. A credit memo raised with lines stands in
 * its own right and reduces what was sold, which is what a credit memo is for.
 */
async function salesRows(
  tx: Tx, client: string, filter: AnalysisFilter, groupBy: GroupBy, period: Period, limit: number,
): Promise<RawRow[]> {
  const dimension = sql.raw(DIMENSION_COLUMN['SALES'][groupBy]);
  const bucket = periodExpression(period, 'SALES');
  const group = groupBy === 'PERIOD' ? sql`${bucket}` : sql`${dimension}`;
  const rows = await tx.execute(sql`
    select
      ${group}::text as key_value,
      ${groupBy === 'PERIOD' ? sql`''::text` : bucket}::text as period_value,
      bd.currency as currency,
      count(distinct bd.billing_number) as documents,
      count(distinct bd.billing_number || '/' || bl.line_number) as lines,
      count(distinct case when cl.line_number is not null
                          then bd.billing_number || '/' || bl.line_number end) as costed_lines,
      coalesce(sum(bl.billing_quantity), 0)::text as quantity,
      coalesce(sum(bl.net_amount), 0)::text as net_value,
      coalesce(sum(cl.cost_amount), 0)::text as cost_value,
      count(*) over () as total_groups
    from billing_document bd
    join billing_document_line bl
      on bl.client = bd.client and bl.billing_number = bd.billing_number
    left join (
      select dc.client, dc.document_number, dc.line_number, sum(dc.amount) as cost_amount
        from sales_document_condition dc
        join sales_condition_type ct
          on ct.client = dc.client and ct.condition_type = dc.condition_type
       where dc.client = ${client}
         and dc.document_category = 'BILLING'
         and dc.origin in ('ITEM', 'DISTRIBUTED')
         and ct.condition_class = 'COST'
       group by 1, 2, 3
    ) cl on cl.client = bd.client and cl.document_number = bd.billing_number
        and cl.line_number = bl.line_number
    where bd.client = ${client}
      and bd.status <> 'CANCELLED'
      ${filter.documentNumber ? sql`and bd.billing_number = ${filter.documentNumber}` : sql``}
      ${filter.orderNumber ? sql`and coalesce(bl.order_number, bd.order_number) = ${filter.orderNumber}` : sql``}
      ${filter.deliveryNumber ? sql`and coalesce(bl.delivery_number, bd.delivery_number) = ${filter.deliveryNumber}` : sql``}
      ${filter.customerNumber ? sql`and bd.customer_number = ${filter.customerNumber}` : sql``}
      ${filter.materialNumber ? sql`and bl.material_number = ${filter.materialNumber}` : sql``}
      ${filter.salesOrg ? sql`and bd.sales_org = ${filter.salesOrg}` : sql``}
      ${filter.documentType ? sql`and bd.document_type = ${filter.documentType}` : sql``}
      ${filter.status ? sql`and bd.status = ${filter.status}` : sql``}
      ${filter.currency ? sql`and bd.currency = ${filter.currency}` : sql``}
      ${filter.plant ? sql`and exists (
        select 1 from sales_order_line sol
         where sol.client = bd.client and sol.order_number = bl.order_number
           and sol.line_number = bl.order_line_number and sol.plant = ${filter.plant}
      )` : sql``}
      ${dateWindow(filter, 'SALES')}
    group by 1, 2, 3
    order by ${orderExpression(groupBy, sql`sum(bl.net_amount)`)}
    limit ${limit}
  `);
  return rows as unknown as RawRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// The backlog: what stands on orders that are still open
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What is still to come.
 *
 * The delivered quantity is read with the same join `fulfillment-quantities.ts` uses — over the
 * deliveries that stand, excluding returns deliveries, because goods that came back are not goods
 * that were never delivered. A rejected line is not in the backlog: it is finished. A returns order
 * is not in the backlog either: it is a request for goods to come back, and counting it as an open
 * commitment would put a return on the same footing as a sale.
 *
 * The value is the open quantity at the price the line was priced at, not the price that stands
 * today. A backlog valued at today's price is a forecast; this is a report about what was promised.
 */
async function backlogRows(
  tx: Tx, client: string, filter: AnalysisFilter, groupBy: GroupBy, period: Period, limit: number,
): Promise<RawRow[]> {
  const dimension = sql.raw(DIMENSION_COLUMN['BACKLOG'][groupBy]);
  const bucket = periodExpression(period, 'BACKLOG');
  const group = groupBy === 'PERIOD' ? sql`${bucket}` : sql`${dimension}`;
  const rows = await tx.execute(sql`
    select
      ${group}::text as key_value,
      ${groupBy === 'PERIOD' ? sql`''::text` : bucket}::text as period_value,
      o.currency as currency,
      count(distinct o.order_number) as documents,
      count(distinct o.order_number || '/' || ol.line_number) as lines,
      0 as costed_lines,
      coalesce(sum(greatest(ol.order_quantity - coalesce(d.delivered, 0), 0)), 0)::text as quantity,
      coalesce(sum(greatest(ol.order_quantity - coalesce(d.delivered, 0), 0)
        * ol.net_amount / nullif(ol.order_quantity, 0)), 0)::text as net_value,
      null::text as cost_value,
      count(*) over () as total_groups
    from sales_order o
    join sales_order_line ol on ol.client = o.client and ol.order_number = o.order_number
    left join (
      select dl.client, dl.order_number, dl.order_line_number, sum(dl.delivery_quantity) as delivered
        from delivery_line dl
        join delivery dv on dv.client = dl.client and dv.delivery_number = dl.delivery_number
       where dl.client = ${client}
         and dv.status <> 'CANCELLED'
         and dv.document_type <> ${STANDARD_RETURNS_DELIVERY_TYPE}
       group by 1, 2, 3
    ) d on d.client = ol.client and d.order_number = ol.order_number
       and d.order_line_number = ol.line_number
    where o.client = ${client}
      and o.status = 'OPEN'
      and ol.status <> 'REJECTED'
      -- A returns order asks for goods to come back. It is not an open commitment to ship.
      and o.document_type not in (
        select rc.returns_order_type from sales_returns_configuration rc where rc.client = ${client}
      )
      ${filter.documentNumber ? sql`and o.order_number = ${filter.documentNumber}` : sql``}
      ${filter.orderNumber ? sql`and o.order_number = ${filter.orderNumber}` : sql``}
      ${filter.customerNumber ? sql`and o.customer_number = ${filter.customerNumber}` : sql``}
      ${filter.materialNumber ? sql`and ol.material_number = ${filter.materialNumber}` : sql``}
      ${filter.salesOrg ? sql`and o.sales_org = ${filter.salesOrg}` : sql``}
      ${filter.documentType ? sql`and o.document_type = ${filter.documentType}` : sql``}
      ${filter.plant ? sql`and ol.plant = ${filter.plant}` : sql``}
      ${filter.currency ? sql`and o.currency = ${filter.currency}` : sql``}
      ${filter.deliveryNumber ? sql`and exists (
        select 1 from delivery_line dl2
         where dl2.client = o.client and dl2.order_number = o.order_number
           and dl2.delivery_number = ${filter.deliveryNumber}
      )` : sql``}
      ${dateWindow(filter, 'BACKLOG')}
    group by 1, 2, 3
    having sum(greatest(ol.order_quantity - coalesce(d.delivered, 0), 0)) > 0
    order by ${orderExpression(groupBy, sql`sum(greatest(ol.order_quantity - coalesce(d.delivered, 0), 0)
      * ol.net_amount / nullif(ol.order_quantity, 0))`)}
    limit ${limit}
  `);
  return rows as unknown as RawRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Returns: what came back
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What came back, on the returns deliveries that stand.
 *
 * Valued at the price on the returns order line, because a return is given its value by the goods
 * it is returning and not by a price somebody maintains for it.
 *
 * What has been asked back and not yet received is not here: that is the returns register (§5.2),
 * which is the right screen for it. This one is about what actually happened.
 *
 * A tenant that has configured no returns chain gets an empty analysis rather than a guess. There is
 * no way to infer a return from a quantity's sign, and an analysis that tried would be wrong in a
 * way that is very hard to notice.
 */
async function returnsRows(
  tx: Tx, client: string, filter: AnalysisFilter, groupBy: GroupBy, period: Period, limit: number,
): Promise<RawRow[]> {
  const dimension = sql.raw(DIMENSION_COLUMN['RETURNS'][groupBy]);
  const bucket = periodExpression(period, 'RETURNS');
  const group = groupBy === 'PERIOD' ? sql`${bucket}` : sql`${dimension}`;
  const rows = await tx.execute(sql`
    select
      ${group}::text as key_value,
      ${groupBy === 'PERIOD' ? sql`''::text` : bucket}::text as period_value,
      so.currency as currency,
      count(distinct dv.delivery_number) as documents,
      count(distinct dv.delivery_number || '/' || dl.line_number) as lines,
      0 as costed_lines,
      coalesce(sum(dl.delivery_quantity), 0)::text as quantity,
      coalesce(sum(dl.delivery_quantity * ol.net_amount / nullif(ol.order_quantity, 0)), 0)::text
        as net_value,
      null::text as cost_value,
      count(*) over () as total_groups
    from delivery dv
    join delivery_line dl on dl.client = dv.client and dl.delivery_number = dv.delivery_number
    join sales_order so on so.client = dv.client and so.order_number = dv.order_number
    join sales_order_line ol
      on ol.client = dl.client and ol.order_number = dl.order_number
     and ol.line_number = dl.order_line_number
    where dv.client = ${client}
      and dv.status <> 'CANCELLED'
      and dv.document_type in (
        select rc.returns_delivery_type from sales_returns_configuration rc where rc.client = ${client}
      )
      ${filter.documentNumber ? sql`and dv.delivery_number = ${filter.documentNumber}` : sql``}
      ${filter.deliveryNumber ? sql`and dv.delivery_number = ${filter.deliveryNumber}` : sql``}
      ${filter.orderNumber ? sql`and dv.order_number = ${filter.orderNumber}` : sql``}
      ${filter.customerNumber ? sql`and so.customer_number = ${filter.customerNumber}` : sql``}
      ${filter.materialNumber ? sql`and dl.material_number = ${filter.materialNumber}` : sql``}
      ${filter.salesOrg ? sql`and so.sales_org = ${filter.salesOrg}` : sql``}
      ${filter.documentType ? sql`and dv.document_type = ${filter.documentType}` : sql``}
      ${filter.status ? sql`and dv.status = ${filter.status}` : sql``}
      ${filter.plant ? sql`and dl.plant = ${filter.plant}` : sql``}
      ${filter.currency ? sql`and so.currency = ${filter.currency}` : sql``}
      ${dateWindow(filter, 'RETURNS')}
    group by 1, 2, 3
    order by ${orderExpression(groupBy, sql`sum(dl.delivery_quantity * ol.net_amount / nullif(ol.order_quantity, 0))`)}
    limit ${limit}
  `);
  return rows as unknown as RawRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Names for the keys
// ─────────────────────────────────────────────────────────────────────────────

/** What a key is called, read once for the whole answer rather than once a row. */
async function keyNames(
  tx: Tx, client: string, groupBy: GroupBy, keys: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (keys.length === 0) return out;
  if (groupBy === 'CUSTOMER') {
    const rows = await tx.select({ key: businessPartner.partnerNumber, name: businessPartner.name })
      .from(businessPartner).where(sql`${businessPartner.client} = ${client}`);
    for (const row of rows) out.set(row.key, row.name);
  } else if (groupBy === 'MATERIAL') {
    const rows = await tx.select({ key: material.materialNumber, name: material.description })
      .from(material).where(sql`${material.client} = ${client}`);
    for (const row of rows) out.set(row.key, row.name);
  } else if (groupBy === 'SALES_ORG') {
    const rows = await tx.select({ key: salesArea.salesOrg, name: salesArea.name })
      .from(salesArea).where(sql`${salesArea.client} = ${client}`);
    for (const row of rows) out.set(row.key, row.name);
  } else if (groupBy === 'DOCUMENT_TYPE') {
    const rows = await tx.select({ key: salesDocumentType.documentType, name: salesDocumentType.name })
      .from(salesDocumentType).where(sql`${salesDocumentType.client} = ${client}`);
    for (const row of rows) out.set(row.key, row.name);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The answer
// ─────────────────────────────────────────────────────────────────────────────

const money = (value: number) => value.toFixed(2);

/**
 * One analysis.
 *
 * The totals are read off the rows that were answered, exactly as the register's are (§5.2): an
 * analysis that totalled the whole table while showing a cut of it is two answers to one question.
 * They are reported once per currency, because a total over two currencies is not a number.
 */
export async function listAnalysis(
  client: string,
  input: { kind: AnalysisKind; filter?: AnalysisFilter; groupBy?: GroupBy; period?: Period; limit?: number },
): Promise<Analysis> {
  const filter = clean(input.filter ?? {});
  const groupBy: GroupBy = (GROUP_BY as readonly string[]).includes(input.groupBy ?? '')
    ? input.groupBy as GroupBy : 'CUSTOMER';
  const period: Period = (PERIODS as readonly string[]).includes(input.period ?? '')
    ? input.period as Period : 'TOTAL';
  const limit = Math.min(Math.max(input.limit ?? ANALYSIS_LIMIT, 1), 1000);

  return withTenant(client, async (tx) => {
    const raw = input.kind === 'BACKLOG'
      ? await backlogRows(tx, client, filter, groupBy, period, limit)
      : input.kind === 'RETURNS'
        ? await returnsRows(tx, client, filter, groupBy, period, limit)
        : await salesRows(tx, client, filter, groupBy, period, limit);

    const names = await keyNames(tx, client, groupBy, raw.map((row) => row.key_value ?? ''));

    // A margin is only carried where the analysis is about one. Sales is what was sold; it does not
    // pretend to a cost a tenant may never have priced.
    const carriesCost = input.kind === 'MARGIN';

    const rows: AnalysisRow[] = raw.map((row) => {
      const lines = Number(row.lines ?? 0);
      const costedLines = Number(row.costed_lines ?? 0);
      const net = Number(row.net_value ?? 0);
      const cost = carriesCost && costedLines > 0 ? Number(row.cost_value ?? 0) : null;
      const margin = cost === null ? null : net - cost;
      return {
        key: row.key_value ?? '',
        keyName: names.get(row.key_value ?? '') ?? null,
        period: row.period_value ?? '',
        currency: row.currency,
        documents: Number(row.documents ?? 0),
        lines,
        costedLines,
        quantity: row.quantity,
        netValue: row.net_value,
        costValue: cost === null ? null : money(cost),
        marginValue: margin === null ? null : money(margin),
        marginPercent: margin === null || net === 0 ? null : money((margin / net) * 100),
        costIsComplete: !carriesCost || costedLines === lines,
      };
    });

    // Biggest first, which is what an analysis is for — except when the axis is the period, where a
    // reader wants the months in order.
    rows.sort((a, b) => (groupBy === 'PERIOD'
      ? a.key.localeCompare(b.key)
      : Number(b.netValue) - Number(a.netValue)));

    const byCurrency = new Map<string, AnalysisRow[]>();
    for (const row of rows) {
      const bucket = byCurrency.get(row.currency) ?? [];
      bucket.push(row);
      byCurrency.set(row.currency, bucket);
    }
    const totals: AnalysisTotals[] = [...byCurrency.entries()].map(([currency, group]) => {
      let net = 0;
      let cost = 0;
      let quantity = 0;
      let lines = 0;
      let costed = 0;
      for (const row of group) {
        net += Number(row.netValue);
        quantity += Number(row.quantity);
        lines += row.lines;
        costed += row.costedLines;
        if (row.costValue !== null) cost += Number(row.costValue);
      }
      const costedAll = !carriesCost || (lines > 0 && costed === lines);
      return {
        currency,
        quantity: money(quantity),
        netValue: money(net),
        costValue: carriesCost && costed > 0 ? money(cost) : null,
        marginValue: carriesCost && costed > 0 ? money(net - cost) : null,
        marginPercent: carriesCost && costed > 0 && net !== 0 ? money(((net - cost) / net) * 100) : null,
        costIsComplete: costedAll,
      };
    }).sort((a, b) => a.currency.localeCompare(b.currency));

    return {
      kind: input.kind,
      meaning: ANALYSIS_KIND_MEANING[input.kind],
      groupBy,
      period,
      rows,
      count: Number(raw[0]?.total_groups ?? 0),
      truncated: Number(raw[0]?.total_groups ?? 0) > rows.length,
      totals,
    };
  });
}
