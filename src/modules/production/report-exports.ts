/** CSV / PDF export for the production order cost report (see finance/report-exports.ts for the contract). */
import { type ReportAdapter, type ReportColumn, ReportExportError, fmt } from '../output/report-export';
import { stockRequirementsList, STOCK_REQUIREMENTS_CAPABILITY, DEFAULT_MAX_HITS } from './stock-requirements';
import { getProductionOrderCostReport, PRODUCTION_ORDER_COST_REPORT_CAPABILITY } from './order-cost-report';

const C = (label: string): ReportColumn => ({ label });
const R = (label: string): ReportColumn => ({ label, align: 'right' });

export const productionOrderCostExport: ReportAdapter = {
  code: 'production-order-cost', route: '/production/order-cost-report', capability: PRODUCTION_ORDER_COST_REPORT_CAPABILITY,
  async build(client, q, authorization) {
    const orderNumber = (q.get('order') ?? '').trim();
    if (!orderNumber) throw new ReportExportError('An order number is required for this export.', 'Run the report on screen first; the export uses the same selection.');
    const r = await getProductionOrderCostReport({
      client, authorization, orderNumber, fiscalYear: q.get('fiscalYear') ?? '', periodFrom: q.get('periodFrom') ?? '', periodTo: q.get('periodTo') ?? '',
    });
    return {
      title: 'Production order cost report',
      subtitle: [`Order ${r.order.orderNumber} · material ${r.order.materialNumber} · plant ${r.order.plant} · status ${r.order.status}`,
        `Company ${r.order.companyCode ?? '-'} · controlling area ${r.order.controllingArea ?? '-'}`, ...r.gaps],
      sections: [
        {
          columns: [C('Company'), C('Document'), C('Year'), C('Type'), C('Posted'), R('Period'), R('Line'), C('Account'), C('D/C'), R('Amount'), C('Cur'), R('Local'), C('Local cur'), C('Status'), C('Material'), C('Plant'), C('Text')],
          rows: r.lines.map((l) => [l.companyCode, l.displayNumber, String(l.fiscalYear), l.documentType, l.postingDate, String(l.postingPeriod), String(l.lineNumber), l.glAccount, l.debitCredit, fmt(l.amountDocument), l.lineCurrency, fmt(l.amountLocal), l.localCurrency, l.status, l.material ?? '', l.plant ?? '', l.lineText ?? '']),
        },
        {
          heading: 'Totals',
          columns: [C('Company'), C('Cur'), R('Debit'), R('Credit'), R('Net'), C('Local cur'), R('Debit local'), R('Credit local'), R('Net local')],
          rows: r.totals.map((t) => [t.companyCode, t.documentCurrency, fmt(t.debitDocument), fmt(t.creditDocument), fmt(t.netDocument), t.localCurrency, fmt(t.debitLocal), fmt(t.creditLocal), fmt(t.netLocal)]),
        },
      ],
      fileStem: `order-cost-${r.order.orderNumber}`,
    };
  },
};

export const stockRequirementsExport: ReportAdapter = {
  code: 'stock-requirements', route: '/production/stock-requirements', capability: STOCK_REQUIREMENTS_CAPABILITY,
  async build(client, q, authorization) {
    const get = (name: string) => (q.get(name) ?? '').trim();
    const r = await stockRequirementsList({
      client, today: new Date().toISOString().slice(0, 10),
      selection: {
        material: get('material').toUpperCase(), plant: get('plant').toUpperCase(), mrpArea: get('mrpArea'),
        specialStockIndicator: get('specialStockIndicator').toUpperCase(),
        displayPastDue: get('pastDueOff') !== '1',
        periodSplit: (get('periodSplit') || 'DAILY').toUpperCase(),
        simulationVersion: get('simulationVersion'), horizonEnd: get('horizonEnd'),
        maxHits: Number(get('maxHits')) || DEFAULT_MAX_HITS,
      },
    }, authorization);
    return {
      title: 'Stock/requirements list',
      subtitle: [
        `Material ${r.material} ${r.materialDescription} · plant ${r.plant} · unit ${r.baseUnit} · ${r.periodSplit}`,
        `Opening stock ${fmt(r.openingStock, 3)} · receipts ${fmt(r.totalReceipts, 3)} · requirements ${fmt(r.totalRequirements, 3)} · closing ${fmt(r.closingBalance, 3)} · safety stock ${fmt(r.safetyStock, 3)}`,
        ...r.warnings,
      ],
      sections: [{
        columns: [C('Date'), C('Period end'), C('Element'), C('Direction'), C('Document'), C('Item'), R('Quantity'), R('Projected'), C('Exceptions')],
        rows: r.rows.map((x) => [x.date, x.periodEnd, x.elementLabel, x.direction, x.documentNumber, x.documentItem, fmt(x.quantity, 3), fmt(x.projectedBalance, 3), x.exceptions.join(' ')]),
      }],
      fileStem: `stock-requirements-${r.material}-${r.plant}`,
    };
  },
};

export const PRODUCTION_REPORT_EXPORTS: ReportAdapter[] = [productionOrderCostExport, stockRequirementsExport];
