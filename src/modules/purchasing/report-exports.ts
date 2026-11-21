/** CSV / PDF export for the purchase order list (see finance/report-exports.ts for the contract). */
import { type ReportAdapter, type ReportColumn, fmt } from '../output/report-export';
import { listPurchaseRequisitions, PR_LIST_CAPABILITY, type RequisitionListSelection } from './requisition-list';
import { listInvoiceOverview, INVOICE_OVERVIEW_CAPABILITY, type InvoiceOverviewSelection } from './invoice-overview';
import { listPurchaseOrders, PO_LIST_CAPABILITY, DEFAULT_MAX_HITS, type PoListSelection } from './purchase-order-list';

const C = (label: string): ReportColumn => ({ label });
const R = (label: string): ReportColumn => ({ label, align: 'right' });
const get = (q: URLSearchParams, name: string) => (q.get(name) ?? '').trim();
const up = (q: URLSearchParams, name: string) => get(q, name).toUpperCase();

export const purchaseOrderListExport: ReportAdapter = {
  code: 'purchase-order-list', route: '/purchasing/purchase-order-list', capability: PO_LIST_CAPABILITY,
  async build(client, q, authorization) {
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
    const r = await listPurchaseOrders({ client, selection, authorization });
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

export const requisitionListExport: ReportAdapter = {
  code: 'requisition-list', route: '/purchasing/requisition-list', capability: PR_LIST_CAPABILITY,
  async build(client, q, authorization) {
    const selection: RequisitionListSelection = {
      purchasingGroupFrom: up(q, 'purchasingGroupFrom'), purchasingGroupTo: up(q, 'purchasingGroupTo'),
      plantFrom: up(q, 'plantFrom'), plantTo: up(q, 'plantTo'),
      materialFrom: up(q, 'materialFrom'), materialTo: up(q, 'materialTo'),
      purchasingOrgFrom: up(q, 'purchasingOrgFrom'), purchasingOrgTo: up(q, 'purchasingOrgTo'),
      requisitioner: get(q, 'requisitioner'),
      requisitionDateFrom: get(q, 'requisitionDateFrom'), requisitionDateTo: get(q, 'requisitionDateTo'),
      accountAssignmentCategory: up(q, 'accountAssignmentCategory'),
      displayClosed: get(q, 'displayClosed') === 'on' || get(q, 'displayClosed') === '1',
      maxHits: Number(get(q, 'maxHits')) || DEFAULT_MAX_HITS,
    };
    const r = await listPurchaseRequisitions({ client, selection, authorization });
    return {
      title: 'Purchase requisition list',
      subtitle: [`${r.rowCount} item(s)${r.truncated ? ` (truncated at ${r.maxHits})` : ''}`, ...r.warnings],
      sections: [{
        columns: [C('Requisition'), R('Item'), C('Material'), C('Text'), R('Quantity'), C('Unit'), R('Ordered'), R('Open'), C('Requested'), C('Delivery'), C('Plant'), C('Group'), C('Purch. org'), C('Acct assign'), C('Requisitioner'), R('Est. price'), C('Cur'), C('Status')],
        rows: r.rows.map((x) => [x.requisitionNumber, String(x.itemNumber), x.materialNumber, x.shortText, fmt(x.quantity, 3), x.unit, fmt(x.orderedQuantity, 3), fmt(x.openQuantity, 3), x.requisitionDate, x.deliveryDate, x.plant, x.purchasingGroup, x.purchasingOrgs.join(' '), x.accountAssignmentCategory, x.requisitioner, x.estimatedPrice === null ? '' : fmt(x.estimatedPrice), x.currency, x.status]),
      }],
      fileStem: `purchase-requisitions-${new Date().toISOString().slice(0, 10)}`,
    };
  },
};

export const invoiceOverviewExport: ReportAdapter = {
  code: 'invoice-overview', route: '/purchasing/invoice-overview', capability: INVOICE_OVERVIEW_CAPABILITY,
  async build(client, q, authorization) {
    const selection: InvoiceOverviewSelection = {
      companyFrom: up(q, 'companyFrom'), companyTo: up(q, 'companyTo'), fiscalYear: get(q, 'fiscalYear'),
      vendorFrom: up(q, 'vendorFrom'), vendorTo: up(q, 'vendorTo'), orderFrom: up(q, 'orderFrom'), orderTo: up(q, 'orderTo'),
      postingDateFrom: get(q, 'postingDateFrom'), postingDateTo: get(q, 'postingDateTo'),
      documentFrom: up(q, 'documentFrom'), documentTo: up(q, 'documentTo'), reference: get(q, 'reference'),
      lifecycle: up(q, 'lifecycle'), category: up(q, 'category'), purchasingOrg: up(q, 'purchasingOrg'),
      sort: get(q, 'sort'), direction: get(q, 'direction'), maxHits: Number(get(q, 'maxHits')) || undefined,
      draft: get(q, 'draft'), paymentBlock: get(q, 'paymentBlock'), reversed: get(q, 'reversed'), layout: get(q, 'layout'),
      export: '', withoutOrder: get(q, 'withoutOrder'),
      companyAuthorization: get(q, 'companyAuthorization'), purchasingAuthorization: get(q, 'purchasingAuthorization'),
      exchangeRate: get(q, 'exchangeRate'), post: '', release: '', clear: '',
    };
    const r = await listInvoiceOverview({ client, selection, authorization });
    return {
      title: 'Invoice overview',
      subtitle: [`Parked ${r.counts.parked} · posted ${r.counts.posted} · cancelled ${r.counts.cancelled}${r.truncated ? ` (truncated at ${r.maxHits})` : ''}`, ...r.warnings],
      sections: [
        {
          columns: [C('Document'), C('Year'), C('Status'), C('Category'), C('Company'), C('Supplier'), C('Name'), C('Reference'), C('Order'), C('Doc date'), C('Posted'), R('Gross'), C('Cur'), C('Journal'), C('Payment'), C('Clearing'), C('Created by')],
          rows: r.rows.map((x) => [x.documentNumber, String(x.fiscalYear), x.lifecycle, x.category ?? '', x.companyCode, x.supplierNumber, x.supplierName, x.reference, x.purchaseOrderNumber, x.documentDate, x.postingDate ?? '', fmt(x.grossAmount), x.currency, x.journalDocumentNumber ?? '', x.paymentState, x.clearingDocument ?? '', x.createdBy]),
        },
        {
          heading: 'Totals',
          columns: [C('Currency'), C('Status'), R('Count'), R('Gross')],
          rows: r.totals.map((t) => [t.currency, t.lifecycle, String(t.count), fmt(t.grossAmount)]),
        },
      ],
      fileStem: `invoice-overview-${new Date().toISOString().slice(0, 10)}`,
    };
  },
};

export const PURCHASING_REPORT_EXPORTS: ReportAdapter[] = [purchaseOrderListExport, requisitionListExport, invoiceOverviewExport];
