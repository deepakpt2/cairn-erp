/** CSV / PDF export for the purchase order list (see finance/report-exports.ts for the contract). */
import { type ReportAdapter, type ReportColumn, fmt } from '../output/report-export';
import { listPurchaseOrders, PO_LIST_CAPABILITY, DEFAULT_MAX_HITS, type PoListSelection } from './purchase-order-list';

const C = (label: string): ReportColumn => ({ label });
const R = (label: string): ReportColumn => ({ label, align: 'right' });
const get = (q: URLSearchParams, name: string) => (q.get(name) ?? '').trim();
const up = (q: URLSearchParams, name: string) => get(q, name).toUpperCase();

export const purchaseOrderListExport: ReportAdapter = {
  code: 'purchase-order-list', route: '/purchasing/purchase-order-list', capability: PO_LIST_CAPABILITY,
  async build(client, q) {
    const selection: PoListSelection = {
      perspective: up(q, 'perspective') || 'VENDOR', scope: up(q, 'scope') || 'ALL',
      vendorFrom: up(q, 'vendorFrom'), vendorTo: up(q, 'vendorTo'),
      purchasingOrgFrom: up(q, 'purchasingOrgFrom'), purchasingOrgTo: up(q, 'purchasingOrgTo'),
      purchasingGroupFrom: up(q, 'purchasingGroupFrom'), purchasingGroupTo: up(q, 'purchasingGroupTo'),
      plantFrom: up(q, 'plantFrom'), plantTo: up(q, 'plantTo'),
      materialFrom: up(q, 'materialFrom'), materialTo: up(q, 'materialTo'),
      materialGroupFrom: up(q, 'materialGroupFrom'), materialGroupTo: up(q, 'materialGroupTo'),
      orderFrom: get(q, 'orderFrom'), orderTo: get(q, 'orderTo'),
      documentDateFrom: get(q, 'documentDateFrom'), documentDateTo: get(q, 'documentDateTo'),
      maxHits: Number(get(q, 'maxHits')) || DEFAULT_MAX_HITS,
    };
    const r = await listPurchaseOrders({ client, selection });
    return {
      title: 'Purchase order list',
      subtitle: [`Perspective ${r.perspective} · scope ${r.scope}`, `${r.rowCount} item(s)${r.truncated ? ` (truncated at ${r.maxHits})` : ''}`, ...r.warnings],
      sections: [{
        columns: [C('Order'), R('Item'), C('Supplier'), C('Name'), C('Date'), C('Material'), C('Text'), C('Plant'), R('Quantity'), C('Unit'), R('Net price'), R('Net value'), C('Cur'), C('Delivery'), R('Delivered'), R('Invoiced'), C('Status')],
        rows: r.rows.map((x) => [x.orderNumber, String(x.itemNumber), x.supplierNumber, x.supplierName, x.documentDate, x.materialNumber, x.shortText, x.plant, fmt(x.quantity, 3), x.unit, fmt(x.netPrice), fmt(x.netValue), x.currency, x.deliveryDate, fmt(x.deliveredQuantity, 3), fmt(x.invoicedQuantity, 3), x.status]),
      }],
      fileStem: `purchase-orders-${new Date().toISOString().slice(0, 10)}`,
    };
  },
};

export const PURCHASING_REPORT_EXPORTS: ReportAdapter[] = [purchaseOrderListExport];
