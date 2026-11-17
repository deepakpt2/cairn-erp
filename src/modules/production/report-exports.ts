/** CSV / PDF export for the production order cost report (see finance/report-exports.ts for the contract). */
import { type ReportAdapter, type ReportColumn, ReportExportError, fmt } from '../output/report-export';
import { getProductionOrderCostReport, PRODUCTION_ORDER_COST_REPORT_CAPABILITY } from './order-cost-report';

const C = (label: string): ReportColumn => ({ label });
const R = (label: string): ReportColumn => ({ label, align: 'right' });

export const productionOrderCostExport: ReportAdapter = {
  code: 'production-order-cost', route: '/production/order-cost-report', capability: PRODUCTION_ORDER_COST_REPORT_CAPABILITY,
  async build(client, q) {
    const orderNumber = (q.get('order') ?? '').trim();
    if (!orderNumber) throw new ReportExportError('An order number is required for this export.', 'Run the report on screen first; the export uses the same selection.');
    const r = await getProductionOrderCostReport({
      client, orderNumber, fiscalYear: q.get('fiscalYear') ?? '', periodFrom: q.get('periodFrom') ?? '', periodTo: q.get('periodTo') ?? '',
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

export const PRODUCTION_REPORT_EXPORTS: ReportAdapter[] = [productionOrderCostExport];
