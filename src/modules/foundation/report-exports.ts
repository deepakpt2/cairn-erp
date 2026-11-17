/** CSV / PDF export for the cost centre report (see finance/report-exports.ts for the contract). */
import { type ReportAdapter, type ReportColumn, fmt } from '../output/report-export';
import { calculateCostCenterReport, COST_CENTER_REPORT_CAPABILITY, type CostCenterReportSelection } from './cost-center-report';

const C = (label: string): ReportColumn => ({ label });
const R = (label: string): ReportColumn => ({ label, align: 'right' });
const get = (q: URLSearchParams, name: string) => (q.get(name) ?? '').trim();

export const costCenterReportExport: ReportAdapter = {
  code: 'cost-center-report', route: '/controlling/cost-center-report', capability: COST_CENTER_REPORT_CAPABILITY,
  async build(client, q) {
    const year = new Date().getFullYear();
    const selection: CostCenterReportSelection = {
      controllingArea: get(q, 'controllingArea').toUpperCase(),
      costCenterGroup: get(q, 'costCenterGroup').toUpperCase(),
      costCenterFrom: get(q, 'costCenterFrom').toUpperCase(), costCenterTo: get(q, 'costCenterTo').toUpperCase(),
      costElementFrom: get(q, 'costElementFrom'), costElementTo: get(q, 'costElementTo'),
      fiscalYear: Number(get(q, 'fiscalYear')) || year,
      periodFrom: Number(get(q, 'periodFrom')) || 1, periodTo: Number(get(q, 'periodTo')) || 12,
      planVersion: (get(q, 'planVersion') || '000').toUpperCase(),
    };
    const r = await calculateCostCenterReport({ client, selection });
    return {
      title: 'Cost centre actual / plan',
      subtitle: [`Controlling area ${r.controllingArea} · currency ${r.currency} · plan version ${r.planVersion}`,
        `Fiscal year ${r.fiscalYear}, periods ${r.periodFrom}-${r.periodTo}`, ...r.warnings],
      sections: [
        {
          columns: [C('Key'), C('Description'), R('Actual'), R('Plan'), R('Variance'), R('Var %'), C('Status'), R('Actual YTD'), R('Plan YTD')],
          rows: r.rows.map((x) => [`${'   '.repeat(x.depth)}${x.key}`, x.label, fmt(x.actual), fmt(x.plan), fmt(x.variance), fmt(x.variancePercent), x.status ?? '', fmt(x.actualYtd), fmt(x.planYtd)]),
        },
        ...(r.activities.length > 0 ? [{
          heading: 'Planned activities',
          columns: [C('Cost centre'), C('Activity type'), R('Planned quantity'), R('Fixed price'), R('Variable price'), R('Price unit')],
          rows: r.activities.map((a) => [a.costCenter, a.activityType, fmt(a.plannedQuantity, 3), fmt(a.fixedPrice), fmt(a.variablePrice), String(a.priceUnit)]),
        }] : []),
      ],
      fileStem: `cost-center-report-${r.controllingArea}-${r.fiscalYear}`,
    };
  },
};

export const FOUNDATION_REPORT_EXPORTS: ReportAdapter[] = [costCenterReportExport];
