/** CSV / PDF export for the cost centre report (see finance/report-exports.ts for the contract). */
import { ReportExportError, type ReportAdapter, type ReportColumn, fmt } from '../output/report-export';
import { csvToReport } from '../output/csv-report';
import {
  DEFAULT_MAX_HITS, LEADING_LEDGER, PROFIT_CENTER_REPORT_CAPABILITY, listProfitCenterLines, profitCenterLinesCsv,
} from './profit-center-report';
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

export const profitCenterReportExport: ReportAdapter = {
  code: 'profit-center-report', route: '/controlling/profit-center-report', capability: `${PROFIT_CENTER_REPORT_CAPABILITY}.read`,
  async build(client, q) {
    const controllingArea = get(q, 'controllingArea').toUpperCase();
    if (!controllingArea) throw new ReportExportError('Controlling area is required.', 'Run the report on screen first; the export uses the same selection.');
    const fiscalYear = Number(get(q, 'fiscalYear')) || new Date().getFullYear();
    const result = await listProfitCenterLines({
      client,
      selection: {
        controllingArea,
        profitCenterGroup: get(q, 'profitCenterGroup').toUpperCase(),
        profitCenterFrom: get(q, 'profitCenterFrom').toUpperCase(), profitCenterTo: get(q, 'profitCenterTo').toUpperCase(),
        glAccountFrom: get(q, 'glAccountFrom'), glAccountTo: get(q, 'glAccountTo'),
        documentFrom: get(q, 'documentFrom'), documentTo: get(q, 'documentTo'),
        fiscalYear,
        periodFrom: Number(get(q, 'periodFrom')) || 1, periodTo: Number(get(q, 'periodTo')) || 12,
        ledger: (get(q, 'ledger') || LEADING_LEDGER).toUpperCase(),
        maxHits: Number(get(q, 'maxHits')) || DEFAULT_MAX_HITS,
      },
    });
    return csvToReport(profitCenterLinesCsv(result), {
      title: 'Profit centre line items',
      subtitle: [`Controlling area ${controllingArea} · fiscal year ${fiscalYear}`],
      fileStem: `profit-center-lines-${controllingArea}-${fiscalYear}`,
    });
  },
};

export const FOUNDATION_REPORT_EXPORTS: ReportAdapter[] = [costCenterReportExport, profitCenterReportExport];
