/**
 * The reports that can be exported, by code. A module contributes its adapters here and nowhere else;
 * `/reports/export/[report]` looks the code up, checks the screen's capability and renders.
 */
import { FINANCE_REPORT_EXPORTS } from '../finance/report-exports';
import { FOUNDATION_REPORT_EXPORTS } from '../foundation/report-exports';
import { INVENTORY_REPORT_EXPORTS } from '../inventory/report-exports';
import { PRODUCTION_REPORT_EXPORTS } from '../production/report-exports';
import { PURCHASING_REPORT_EXPORTS } from '../purchasing/report-exports';
import { SALES_REPORT_EXPORTS } from '../sales/report-exports';
import {
  type ReportAdapter, type ReportDoc, REPORT_MAX_ROWS, ReportExportError, reportToCsv, reportToPdf, safeStem,
} from './report-export';

const ADAPTERS: ReportAdapter[] = [
  ...FINANCE_REPORT_EXPORTS, ...INVENTORY_REPORT_EXPORTS, ...SALES_REPORT_EXPORTS,
  ...PURCHASING_REPORT_EXPORTS, ...PRODUCTION_REPORT_EXPORTS, ...FOUNDATION_REPORT_EXPORTS,
];

export function reportAdapter(code: string): ReportAdapter | null {
  return ADAPTERS.find((a) => a.code === code) ?? null;
}

export function reportCodes(): string[] {
  return ADAPTERS.map((a) => a.code);
}

export interface RenderedReport {
  body: Uint8Array | string;
  contentType: string;
  fileName: string;
}

export async function renderReport(doc: ReportDoc, format: 'csv' | 'pdf', generatedOn: string): Promise<RenderedReport> {
  const rows = doc.sections.reduce((n, s) => n + s.rows.length, 0);
  if (rows > REPORT_MAX_ROWS) {
    throw new ReportExportError(`This report has ${rows} rows; an export is limited to ${REPORT_MAX_ROWS}.`, 'Narrow the selection and export again.');
  }
  const stem = safeStem(doc.fileStem);
  if (format === 'csv') {
    return { body: reportToCsv(doc), contentType: 'text/csv; charset=utf-8', fileName: `${stem}.csv` };
  }
  const pdf = await reportToPdf(doc, generatedOn);
  return { body: pdf.bytes, contentType: 'application/pdf', fileName: `${stem}.pdf` };
}
