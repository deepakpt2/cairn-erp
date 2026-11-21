/** CSV / PDF exports for the inventory reports (see finance/report-exports.ts for the contract). */
import { type ReportAdapter, type ReportColumn, fmt } from '../output/report-export';
import { stockOverview, STOCK_OVERVIEW_CAPABILITY, DEFAULT_MAX_HITS, type StockOverviewSelection } from './stock-overview';
import { listMaterialDocuments, MATERIAL_DOC_LIST_CAPABILITY, type MaterialDocListSelection } from './material-document-list';
import { businessDate, listShelfLife, SLED_LIST_CAPABILITY, type ShelfLifeSelection } from './shelf-life-list';

const C = (label: string): ReportColumn => ({ label });
const R = (label: string): ReportColumn => ({ label, align: 'right' });
const get = (q: URLSearchParams, name: string) => (q.get(name) ?? '').trim();
const up = (q: URLSearchParams, name: string) => get(q, name).toUpperCase();

export const stockOverviewExport: ReportAdapter = {
  code: 'stock-overview', route: '/inventory/stock-overview', capability: STOCK_OVERVIEW_CAPABILITY,
  async build(client, q, authorization) {
    const selection: StockOverviewSelection = {
      material: up(q, 'material'), plantFrom: up(q, 'plantFrom'), plantTo: up(q, 'plantTo'),
      storageLocationFrom: up(q, 'storageLocationFrom'), storageLocationTo: up(q, 'storageLocationTo'),
      batch: get(q, 'batch'), specialStockIndicator: up(q, 'specialStockIndicator'),
      displayZero: get(q, 'displayZero') === 'on' || get(q, 'displayZero') === '1',
      expansionLevel: up(q, 'expansionLevel') || 'STORAGE_LOCATION',
      maxHits: Number(get(q, 'maxHits')) || DEFAULT_MAX_HITS,
    };
    const r = await stockOverview({ client, selection, authorization });
    const rows: string[][] = [];
    for (const p of r.plants) {
      if (p.storageLocations.length === 0) rows.push([p.plant, '', '', '', fmt(p.quantity, 3)]);
      for (const l of p.storageLocations) {
        if (l.stockTypes.length === 0) rows.push([p.plant, l.storageLocation, '', '', fmt(l.quantity, 3)]);
        for (const t of l.stockTypes) {
          if (t.batches.length === 0) rows.push([p.plant, l.storageLocation, t.stockType, '', fmt(t.quantity, 3)]);
          for (const b of t.batches) rows.push([p.plant, l.storageLocation, t.stockType, b.batch, fmt(b.quantity, 3)]);
        }
      }
    }
    return {
      title: 'Stock overview',
      subtitle: [`Material ${r.material} ${r.materialDescription} · base unit ${r.baseUnit}`,
        `Unrestricted ${fmt(r.unrestrictedQuantity, 3)} · quality inspection ${fmt(r.qualityInspectionQuantity, 3)} · blocked ${fmt(r.blockedQuantity, 3)} · special ${fmt(r.specialQuantity, 3)}`,
        ...(r.truncated ? [`Truncated at ${r.maxHits} hits`] : []), ...r.warnings],
      sections: [{
        columns: [C('Plant'), C('Storage location'), C('Stock type'), C('Batch'), R(`Quantity (${r.baseUnit})`)],
        rows, totals: ['Total', '', '', '', fmt(r.totalQuantity, 3)],
      }],
      fileStem: `stock-overview-${r.material}`,
    };
  },
};

export const materialDocumentListExport: ReportAdapter = {
  code: 'material-document-list', route: '/inventory/material-document-list', capability: MATERIAL_DOC_LIST_CAPABILITY,
  async build(client, q, authorization) {
    const s: MaterialDocListSelection = {
      materialFrom: up(q, 'materialFrom'), materialTo: up(q, 'materialTo'),
      plantFrom: up(q, 'plantFrom'), plantTo: up(q, 'plantTo'),
      storageLocationFrom: up(q, 'storageLocationFrom'), storageLocationTo: up(q, 'storageLocationTo'),
      movementTypeFrom: up(q, 'movementTypeFrom'), movementTypeTo: up(q, 'movementTypeTo'),
      postingDateFrom: get(q, 'postingDateFrom'), postingDateTo: get(q, 'postingDateTo'),
      documentDateFrom: get(q, 'documentDateFrom'), documentDateTo: get(q, 'documentDateTo'),
      stockType: up(q, 'stockType'), batch: up(q, 'batch'),
      purchaseOrderFrom: get(q, 'purchaseOrderFrom'), purchaseOrderTo: get(q, 'purchaseOrderTo'),
      salesOrder: get(q, 'salesOrder'), delivery: get(q, 'delivery'), billingDocument: get(q, 'billingDocument'),
      schedulingAgreement: get(q, 'schedulingAgreement'), serialNumber: get(q, 'serialNumber'),
      userName: get(q, 'userName'), maxHits: Number(get(q, 'maxHits')) || undefined,
    };
    const r = await listMaterialDocuments({ client, selection: s, authorization });
    return {
      title: 'Material document list',
      subtitle: [`${r.rowCount} line(s)${r.truncated ? ` (truncated at ${r.maxHits})` : ''}`, ...r.warnings],
      sections: [{
        columns: [C('Document'), C('Year'), R('Line'), C('Mvt'), C('Dir'), C('Material'), C('Description'), R('Quantity'), C('Unit'), R('Value'), C('Cur'), C('Plant'), C('Sloc'), C('Stock type'), C('Batch'), C('Posted'), C('PO'), C('User'), C('Status')],
        rows: r.rows.map((x) => [x.materialDocumentNumber, String(x.documentYear), String(x.lineNumber), x.movementType, x.movementDirection, x.materialNumber, x.materialDescription, fmt(x.entryQuantity, 3), x.entryUnit, fmt(x.value), x.currency, x.plant, x.storageLocation, x.stockType, x.batch, x.postingDate, x.purchaseOrderNumber, x.createdBy, x.status]),
      }],
      fileStem: `material-documents-${new Date().toISOString().slice(0, 10)}`,
    };
  },
};

export const shelfLifeExport: ReportAdapter = {
  code: 'shelf-life-list', route: '/inventory/shelf-life-list', capability: SLED_LIST_CAPABILITY,
  async build(client, q) {
    const remaining = get(q, 'remainingShelfLifeDays');
    const selection: ShelfLifeSelection = {
      materialFrom: up(q, 'materialFrom'), materialTo: up(q, 'materialTo'),
      plantFrom: up(q, 'plantFrom'), plantTo: up(q, 'plantTo'),
      storageLocationFrom: up(q, 'storageLocationFrom'), storageLocationTo: up(q, 'storageLocationTo'),
      batchFrom: up(q, 'batchFrom'), batchTo: up(q, 'batchTo'),
      remainingShelfLifeDays: remaining === '' ? null : Number(remaining),
      scope: up(q, 'scope') || 'TOTAL', includeZeroStock: get(q, 'includeZeroStock') === '1',
      display: up(q, 'display') || 'DAYS', layout: up(q, 'layout') || 'ALV', layoutVariant: get(q, 'layoutVariant'),
      keyDate: businessDate('Asia/Kuwait'),
    };
    const r = await listShelfLife({ client, selection, timeZone: 'Asia/Kuwait' });
    return {
      title: 'Shelf life list',
      subtitle: [`Key date ${r.keyDate}`, ...(r.truncated ? [`Truncated at ${r.maxHits} rows`] : []), ...r.warnings],
      sections: [
        {
          columns: [C('Material'), C('Description'), C('Plant'), C('Sloc'), C('Batch'), C('Manufactured'), C('Expires'), R('Remaining'), C('Status'), R('Unrestricted'), C('Unit')],
          rows: r.rows.map((x) => [x.materialNumber, x.materialDescription, x.plant, x.storageLocation, x.batch, x.manufactureDate ?? '', x.expirationDate ?? '', x.displayRemaining, x.classification, fmt(x.unrestrictedQuantity, 3), x.baseUnit]),
        },
        ...(r.undetermined.length > 0 ? [{
          heading: 'Shelf life could not be determined',
          columns: [C('Material'), C('Plant'), C('Sloc'), C('Batch'), R('Unrestricted'), C('Reason')],
          rows: r.undetermined.map((x) => [x.materialNumber, x.plant, x.storageLocation, x.batch, fmt(x.unrestrictedQuantity, 3), x.reason]),
        }] : []),
      ],
      fileStem: `shelf-life-${r.keyDate}`,
    };
  },
};

export const INVENTORY_REPORT_EXPORTS: ReportAdapter[] = [stockOverviewExport, materialDocumentListExport, shelfLifeExport];
