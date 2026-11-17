/** CSV / PDF export for sales analysis (see finance/report-exports.ts for the contract). */
import { type ReportAdapter, type ReportColumn, fmt } from '../output/report-export';
import {
  type AnalysisFilter, type AnalysisKind, type GroupBy, type Period,
  ANALYSIS_KINDS, GROUP_BY, PERIODS, listAnalysis,
} from './analysis';

const C = (label: string): ReportColumn => ({ label });
const R = (label: string): ReportColumn => ({ label, align: 'right' });
const one = (q: URLSearchParams, k: string) => q.get(k) ?? '';
const pick = <T extends string>(list: readonly string[], value: string, fallback: T): T => (list.includes(value) ? (value as T) : fallback);

export const salesAnalysisExport: ReportAdapter = {
  code: 'sales-analysis', route: '/sales/analysis', capability: 'SALES.ANALYSIS.LIST',
  async build(client, q) {
    const kind = pick<AnalysisKind>(ANALYSIS_KINDS, one(q, 'kind'), 'SALES');
    const groupBy = pick<GroupBy>(GROUP_BY, one(q, 'groupBy'), 'CUSTOMER');
    const period = pick<Period>(PERIODS, one(q, 'period'), 'TOTAL');
    const filter: AnalysisFilter = {
      customerNumber: one(q, 'customerNumber'), materialNumber: one(q, 'materialNumber'), salesOrg: one(q, 'salesOrg'),
      plant: one(q, 'plant'), documentType: one(q, 'documentType'), currency: one(q, 'currency'),
      dateFrom: one(q, 'dateFrom'), dateTo: one(q, 'dateTo'),
    };
    const a = await listAnalysis(client, { kind, filter, groupBy, period });
    const margin = a.kind === 'MARGIN';
    const columns = [C('Group'), C('Name'), C('Period'), C('Cur'), R('Documents'), R('Lines'), R('Quantity'), R('Net value'), ...(margin ? [R('Cost'), R('Margin'), R('Margin %')] : [])];
    const rows = a.rows.map((r) => [r.key, r.keyName ?? '', r.period, r.currency, String(r.documents), String(r.lines), fmt(r.quantity, 3), fmt(r.netValue),
      ...(margin ? [r.costValue === null ? '' : fmt(r.costValue), r.marginValue === null ? '' : fmt(r.marginValue), r.marginPercent === null ? '' : fmt(r.marginPercent)] : [])]);
    return {
      title: `Sales analysis — ${a.kind.toLowerCase()}`,
      subtitle: [a.meaning, `Grouped by ${a.groupBy.toLowerCase().replace('_', ' ')}, ${a.period.toLowerCase()}`,
        ...(a.truncated ? [`Showing ${a.rows.length} of ${a.count} groups`] : [])],
      sections: [
        { columns, rows },
        {
          heading: 'Totals per currency',
          columns: [C('Cur'), R('Quantity'), R('Net value'), ...(margin ? [R('Cost'), R('Margin'), R('Margin %')] : [])],
          rows: a.totals.map((t) => [t.currency, fmt(t.quantity, 3), fmt(t.netValue), ...(margin ? [t.costValue === null ? '' : fmt(t.costValue), t.marginValue === null ? '' : fmt(t.marginValue), t.marginPercent === null ? '' : fmt(t.marginPercent)] : [])]),
        },
      ],
      fileStem: `sales-analysis-${a.kind.toLowerCase()}-${a.groupBy.toLowerCase()}`,
    };
  },
};

export const SALES_REPORT_EXPORTS: ReportAdapter[] = [salesAnalysisExport];
