/**
 * Cost centers: actual / plan / variance (SCR-112 /
 * FIN.RPT.COSTCENTER.ACTUAL; S_ALR_87013611 primary alias,
 * S_ALR_87013614 and KSB1N as further search aliases).
 *
 * Actuals are the journal lines carrying a cost centre (cost
 * element = the posted G/L account; primary cost elements are
 * the only posting source in canon). Plan values read the
 * cost_center_plan table the same round builds; a missing plan
 * is null, never a dressed-up zero. Variance = actual − plan;
 * favorable/unfavorable judges by the element's account type
 * (EXPENSE over plan unfavorable, REVENUE over plan favorable).
 * Range totals and year-to-date totals stand as distinct
 * measures. Read-only; closed periods report normally.
 *
 * Stage 1 carries the vocabulary only; plan schema lands in
 * stage 2 and the report service in stage 3.
 */
export const COST_CENTER_REPORT_CAPABILITY = 'FIN.RPT.COSTCENTER.ACTUAL';
export const DEFAULT_PLAN_VERSION = '000';

export interface CostCenterReportSelection {
  controllingArea: string;
  fiscalYear: number;
  periodFrom: number;
  periodTo: number;
  planVersion: string;
  costCenterFrom?: string;
  costCenterTo?: string;
  costCenterGroup?: string;
  costElementFrom?: string;
  costElementTo?: string;
}

export type VarianceStatus = 'FAVORABLE' | 'UNFAVORABLE' | 'ON_PLAN';

export interface CostCenterReportRow {
  kind: 'GROUP' | 'CENTER' | 'ELEMENT';
  key: string;
  label: string;
  depth: number;
  costCenter?: string;
  costElement?: string;
  actual: number;
  /** Null when no plan row stands — missing is never a zero. */
  plan: number | null;
  variance: number | null;
  variancePercent: number | null;
  status: VarianceStatus | null;
  actualYtd: number;
  planYtd: number | null;
}

export interface CostCenterActivityPlan {
  costCenter: string;
  activityType: string;
  plannedQuantity: number;
  fixedPrice: number;
  variablePrice: number;
  priceUnit: number;
}

export interface CostCenterReportResult {
  controllingArea: string;
  currency: string;
  fiscalYear: number;
  periodFrom: number;
  periodTo: number;
  planVersion: string;
  rows: CostCenterReportRow[];
  activities: CostCenterActivityPlan[];
  /** Centres excluded because no validity covers a reported period. */
  excludedCenters: string[];
  warnings: string[];
  calculatedAt: string;
}

import { sql } from 'drizzle-orm';
import { withTenant } from '@/platform/db/client';
import { fromScaled, toScaled } from '@/platform/posting/decimal';

export class CostCenterReportError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CostCenterReportError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new CostCenterReportError(message, remedy);
}

const signedStatus = (variance: number): VarianceStatus =>
  variance === 0 ? 'ON_PLAN' : variance < 0 ? 'FAVORABLE' : 'UNFAVORABLE';

export async function calculateCostCenterReport(input: {
  client: string; selection: CostCenterReportSelection;
}): Promise<CostCenterReportResult> {
  const { client } = input;
  const s = { ...input.selection, planVersion: (input.selection.planVersion || DEFAULT_PLAN_VERSION).toUpperCase() };
  if (!/^[A-Z0-9]{1,3}$/.test(s.planVersion)) fail(`Plan version ${s.planVersion} is not a configured version key.`, 'Versions run 1–3 characters.');
  if (!Number.isInteger(s.fiscalYear) || s.fiscalYear < 1900 || s.fiscalYear > 2199) fail('A valid fiscal year is required.');
  if (s.periodFrom < 1 || s.periodTo > 16 || s.periodFrom > s.periodTo) {
    fail('The period range is invalid.', 'Period from must not exceed period to; periods run 1–16.');
  }
  if (s.costCenterFrom && s.costCenterTo && s.costCenterFrom > s.costCenterTo) fail('The cost center range is inverted.');
  if (s.costElementFrom && s.costElementTo && s.costElementFrom > s.costElementTo) fail('The cost element range is inverted.');
  const calculatedAt = new Date().toISOString();
  const yearStart = `${s.fiscalYear}-01-01`;
  const yearEnd = `${s.fiscalYear}-12-31`;

  return withTenant(client, async (tx) => {
    const areaRows = await tx.execute(sql`
      select controlling_area, currency from controlling_area
      where client = ${client} and controlling_area = ${s.controllingArea}
    `) as unknown as Array<{ controlling_area: string; currency: string }>;
    const area = areaRows[0];
    if (!area) fail(`Controlling area ${s.controllingArea} does not stand.`);
    const currency = area.currency;

    const companyRows = await tx.execute(sql`
      select company_code from controlling_area_company
      where client = ${client} and controlling_area = ${s.controllingArea} order by company_code
    `) as unknown as Array<{ company_code: string }>;
    const companies = companyRows.map((r) => r.company_code);
    if (companies.length === 0) fail(`Controlling area ${s.controllingArea} has no company codes assigned.`);

    // Centre master with fiscal-year validity (overlap judgement).
    const centerRows = await tx.execute(sql`
      select cost_center, name, valid_from::text as valid_from, valid_to::text as valid_to
      from cost_center where client = ${client} and controlling_area = ${s.controllingArea}
      order by cost_center, valid_from
    `) as unknown as Array<{ cost_center: string; name: string; valid_from: string; valid_to: string }>;
    const centerNames = new Map<string, string>();
    const validCenters = new Set<string>();
    for (const row of centerRows) {
      if (row.valid_from <= yearEnd && row.valid_to >= yearStart) {
        validCenters.add(row.cost_center);
        centerNames.set(row.cost_center, row.name);
      }
    }

    let selected = [...validCenters].filter((c) =>
      (!s.costCenterFrom || c >= s.costCenterFrom) && (!s.costCenterTo || c <= s.costCenterTo));
    const excludedCenters: string[] = [];
    for (const center of new Set(centerRows.map((r) => r.cost_center))) {
      if (!validCenters.has(center) && (!s.costCenterFrom || center >= s.costCenterFrom) && (!s.costCenterTo || center <= s.costCenterTo)) {
        excludedCenters.push(center);
      }
    }
    if (s.costCenterGroup) {
      const groupRows = await tx.execute(sql`
        select group_name from cost_center_group
        where client = ${client} and controlling_area = ${s.controllingArea} and group_name = ${s.costCenterGroup}
      `) as unknown as Array<{ group_name: string }>;
      if (groupRows.length === 0) fail(`Cost center group ${s.costCenterGroup} does not stand in controlling area ${s.controllingArea}.`);
      const leafRows = await tx.execute(sql`
        select val_from, val_to from cost_center_group_leaf
        where client = ${client} and controlling_area = ${s.controllingArea} and group_name = ${s.costCenterGroup}
      `) as unknown as Array<{ val_from: string; val_to: string }>;
      const inGroup = (c: string) => leafRows.some((l) => (l.val_to ? c >= l.val_from && c <= l.val_to : c === l.val_from));
      selected = selected.filter(inGroup);
    }
    if (selected.length === 0) fail('No cost centers match the selection in the reported fiscal year.', 'Widen the center selection.');
    const selectedSet = new Set(selected);

    // Actuals: one aggregation over the journal snapshot.
    const actualRows = await tx.execute(sql`
      select l.cost_center as center, l.gl_account as element,
        coalesce(sum(case when e.posting_period between ${s.periodFrom} and ${s.periodTo}
                          then case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end end), 0)::text as actual_range,
        coalesce(sum(case when e.posting_period <= ${s.periodTo}
                          then case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end end), 0)::text as actual_ytd
      from journal_entry_line l
      join journal_entry e
        on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
      where l.client = ${client} and l.cost_center is not null
        and e.company_code in (${sql.join(companies.map((c) => sql`${c}`), sql`, `)})
        and e.fiscal_year = ${s.fiscalYear} and e.status = 'POSTED'
        and e.local_currency = ${currency}
        ${s.costElementFrom ? sql`and l.gl_account between ${s.costElementFrom} and ${s.costElementTo || s.costElementFrom}` : sql``}
      group by l.cost_center, l.gl_account
    `) as unknown as Array<{ center: string; element: string; actual_range: string; actual_ytd: string }>;

    const foreignRows = await tx.execute(sql`
      select count(*)::int as n from journal_entry_line l
      join journal_entry e
        on e.client = l.client and e.document_number = l.document_number and e.fiscal_year = l.fiscal_year
      where l.client = ${client} and l.cost_center is not null
        and e.company_code in (${sql.join(companies.map((c) => sql`${c}`), sql`, `)})
        and e.fiscal_year = ${s.fiscalYear} and e.status = 'POSTED'
        and e.local_currency <> ${currency}
    `) as unknown as Array<{ n: number }>;

    const planRows = await tx.execute(sql`
      select cost_center as center, cost_element as element,
        coalesce(sum(case when period between ${s.periodFrom} and ${s.periodTo} then planned_amount end), 0)::text as plan_range,
        coalesce(sum(case when period <= ${s.periodTo} then planned_amount end), 0)::text as plan_ytd,
        count(*)::int as rows
      from cost_center_plan
      where client = ${client} and controlling_area = ${s.controllingArea}
        and plan_version = ${s.planVersion} and fiscal_year = ${s.fiscalYear}
      group by cost_center, cost_element
    `) as unknown as Array<{ center: string; element: string; plan_range: string; plan_ytd: string; rows: number }>;

    const warnings: string[] = [];
    if ((foreignRows[0]?.n ?? 0) > 0) {
      warnings.push(`${foreignRows[0]!.n} cost line(s) stand in a company currency other than the controlling-area currency ${currency} and are excluded; conversion is not applied.`);
    }
    if (planRows.length === 0) {
      warnings.push(`No plan data stands for version ${s.planVersion} in ${s.fiscalYear}; plan shows as missing, never as zero.`);
    }
    if (excludedCenters.length > 0) {
      warnings.push(`Cost centers without validity in ${s.fiscalYear} are excluded: ${excludedCenters.join(', ')}.`);
    }

    const elements = new Set<string>();
    for (const r of actualRows) if (selectedSet.has(r.center)) elements.add(r.element);
    for (const r of planRows) if (selectedSet.has(r.center)) elements.add(r.element);
    const typeRows = elements.size === 0 ? [] : await tx.execute(sql`
      select account_number, account_type from gl_account
      where client = ${client} and account_number in (${sql.join([...elements].map((e) => sql`${e}`), sql`, `)})
      order by chart_of_accounts
    `) as unknown as Array<{ account_number: string; account_type: string }>;
    const typeOf = new Map<string, string>();
    for (const r of typeRows) if (!typeOf.has(r.account_number)) typeOf.set(r.account_number, r.account_type);
    const signOf = (element: string) => (typeOf.get(element) === 'REVENUE' ? -1 : 1);

    interface ElementFigures { actual: bigint; actualYtd: bigint; plan: bigint | null; planYtd: bigint | null }
    const byCenter = new Map<string, Map<string, ElementFigures>>();
    const ensure = (center: string, element: string): ElementFigures => {
      const map = byCenter.get(center) ?? new Map<string, ElementFigures>();
      byCenter.set(center, map);
      const figures = map.get(element) ?? { actual: 0n, actualYtd: 0n, plan: null, planYtd: null };
      map.set(element, figures);
      return figures;
    };
    for (const r of actualRows) {
      if (!selectedSet.has(r.center)) continue;
      const f = ensure(r.center, r.element);
      f.actual = toScaled(r.actual_range);
      f.actualYtd = toScaled(r.actual_ytd);
    }
    for (const r of planRows) {
      if (!selectedSet.has(r.center)) continue;
      const f = ensure(r.center, r.element);
      const sign = signOf(r.element);
      f.plan = toScaled(r.plan_range) * BigInt(sign);
      f.planYtd = toScaled(r.plan_ytd) * BigInt(sign);
    }

    const judge = (actual: bigint, plan: bigint | null) => {
      if (plan === null) return { variance: null, variancePercent: null, status: null };
      const variance = actual - plan;
      return {
        variance: Number(fromScaled(variance)),
        variancePercent: plan === 0n ? null : Number(fromScaled(variance)) / Math.abs(Number(fromScaled(plan))) * 100,
        status: signedStatus(Number(fromScaled(variance))),
      };
    };
    const sumFigures = (figures: ElementFigures[]): ElementFigures => ({
      actual: figures.reduce((a, f) => a + f.actual, 0n),
      actualYtd: figures.reduce((a, f) => a + f.actualYtd, 0n),
      plan: figures.some((f) => f.plan !== null) ? figures.reduce((a, f) => a + (f.plan ?? 0n), 0n) : null,
      planYtd: figures.some((f) => f.planYtd !== null) ? figures.reduce((a, f) => a + (f.planYtd ?? 0n), 0n) : null,
    });
    const toRow = (kind: CostCenterReportRow['kind'], key: string, label: string, depth: number,
      figures: ElementFigures, extra?: Partial<CostCenterReportRow>): CostCenterReportRow => {
      const judged = judge(figures.actual, figures.plan);
      return {
        kind, key, label, depth,
        actual: Number(fromScaled(figures.actual)),
        plan: figures.plan === null ? null : Number(fromScaled(figures.plan)),
        variance: judged.variance, variancePercent: judged.variancePercent, status: judged.status,
        actualYtd: Number(fromScaled(figures.actualYtd)),
        planYtd: figures.planYtd === null ? null : Number(fromScaled(figures.planYtd)),
        ...extra,
      };
    };

    const centerRowsBuilt = new Map<string, { row: CostCenterReportRow; elements: CostCenterReportRow[] }>();
    for (const center of selected) {
      const elementMap = byCenter.get(center) ?? new Map<string, ElementFigures>();
      const elementRows = [...elementMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([element, figures]) => toRow('ELEMENT', `${center}|${element}`, element, 2, figures, { costCenter: center, costElement: element }));
      const totals = sumFigures([...elementMap.values()]);
      centerRowsBuilt.set(center, {
        row: toRow('CENTER', center, centerNames.get(center) ? `${center} — ${centerNames.get(center)}` : center, 1, totals, { costCenter: center }),
        elements: elementRows,
      });
    }

    // Hierarchy placement at fiscal-year end (latest valid_from wins).
    const nodeRows = await tx.execute(sql`
      select node, parent_node, title, display_order from cost_center_node
      where client = ${client} and controlling_area = ${s.controllingArea}
      order by display_order, node
    `) as unknown as Array<{ node: string; parent_node: string | null; title: string; display_order: number }>;
    const assignmentRows = await tx.execute(sql`
      select node, cost_center, valid_from::text as valid_from from cost_center_node_assignment
      where client = ${client} and controlling_area = ${s.controllingArea}
      order by cost_center, valid_from
    `) as unknown as Array<{ node: string; cost_center: string; valid_from: string }>;
    const placement = new Map<string, string>();
    for (const a of assignmentRows) {
      if (a.valid_from <= yearEnd) placement.set(a.cost_center, a.node);
    }
    const centersByNode = new Map<string, string[]>();
    const unplaced: string[] = [];
    for (const center of selected) {
      const node = placement.get(center);
      if (node) centersByNode.set(node, [...(centersByNode.get(node) ?? []), center]);
      else unplaced.push(center);
    }
    const childrenOf = new Map<string, typeof nodeRows>();
    for (const node of nodeRows) {
      if (node.parent_node) childrenOf.set(node.parent_node, [...(childrenOf.get(node.parent_node) ?? []), node]);
    }
    const rows: CostCenterReportRow[] = [];
    const visit = (node: (typeof nodeRows)[number], depth: number): ElementFigures => {
      const own = (centersByNode.get(node.node) ?? []).flatMap((c) => [...(byCenter.get(c)?.values() ?? [])]);
      const totals = sumFigures(own);
      const groupRow = toRow('GROUP', node.node, `${node.title} (${node.node})`, depth, totals);
      rows.push(groupRow);
      let aggregate = totals;
      for (const center of centersByNode.get(node.node) ?? []) {
        const built = centerRowsBuilt.get(center)!;
        rows.push({ ...built.row, depth: depth + 1 }, ...built.elements.map((e) => ({ ...e, depth: depth + 2 })));
      }
      for (const child of childrenOf.get(node.node) ?? []) {
        const childTotals = visit(child, depth + 1);
        aggregate = sumFigures([aggregate, childTotals]);
      }
      groupRow.actual = Number(fromScaled(aggregate.actual));
      groupRow.actualYtd = Number(fromScaled(aggregate.actualYtd));
      groupRow.plan = aggregate.plan === null ? null : Number(fromScaled(aggregate.plan));
      groupRow.planYtd = aggregate.planYtd === null ? null : Number(fromScaled(aggregate.planYtd));
      const judged = judge(aggregate.actual, aggregate.plan);
      groupRow.variance = judged.variance;
      groupRow.variancePercent = judged.variancePercent;
      groupRow.status = judged.status;
      return aggregate;
    };
    for (const root of nodeRows.filter((n) => !n.parent_node)) visit(root, 0);
    if (unplaced.length > 0) {
      const totals = sumFigures(unplaced.flatMap((c) => [...(byCenter.get(c)?.values() ?? [])]));
      rows.push(toRow('GROUP', 'UNPLACED', 'Centres outside the hierarchy', 0, totals));
      for (const center of unplaced) {
        const built = centerRowsBuilt.get(center)!;
        rows.push({ ...built.row, depth: 1 }, ...built.elements.map((e) => ({ ...e, depth: 2 })));
      }
    }

    const activityRows = await tx.execute(sql`
      select cost_center, activity_type, period, planned_quantity::text as qty,
             fixed_price::text as fixed_price, variable_price::text as variable_price, price_unit
      from activity_rate
      where client = ${client} and controlling_area = ${s.controllingArea}
        and plan_version = ${s.planVersion} and fiscal_year = ${s.fiscalYear}
        and period between ${s.periodFrom} and ${s.periodTo}
      order by cost_center, activity_type, period
    `) as unknown as Array<{ cost_center: string; activity_type: string; period: number; qty: string; fixed_price: string; variable_price: string; price_unit: number }>;
    const activityMap = new Map<string, CostCenterActivityPlan>();
    for (const r of activityRows) {
      if (!selectedSet.has(r.cost_center)) continue;
      const key = `${r.cost_center}|${r.activity_type}`;
      const existing = activityMap.get(key);
      if (existing) {
        existing.plannedQuantity += Number(r.qty);
        existing.fixedPrice = Number(r.fixed_price);
        existing.variablePrice = Number(r.variable_price);
        existing.priceUnit = r.price_unit;
      } else {
        activityMap.set(key, {
          costCenter: r.cost_center, activityType: r.activity_type,
          plannedQuantity: Number(r.qty), fixedPrice: Number(r.fixed_price),
          variablePrice: Number(r.variable_price), priceUnit: r.price_unit,
        });
      }
    }

    return {
      controllingArea: s.controllingArea, currency, fiscalYear: s.fiscalYear,
      periodFrom: s.periodFrom, periodTo: s.periodTo, planVersion: s.planVersion,
      rows, activities: [...activityMap.values()],
      excludedCenters, warnings, calculatedAt,
    };
  });
}
