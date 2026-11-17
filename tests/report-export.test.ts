/**
 * Report export: the CSV/PDF engine (pure), the registry, and adapters against an empty tenant — what the
 * export does with a selection that returns nothing, and with one the service refuses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { reportToCsv, reportToPdf, safeStem, type ReportDoc } from '../src/modules/output/report-export';
import { reportAdapter, reportCodes, renderReport } from '../src/modules/output/report-registry';
import { createTenant, destroyTenant } from './helpers';

const doc = (over: Partial<ReportDoc> = {}): ReportDoc => ({
  title: 'Test report', subtitle: ['Company 1000'], fileStem: 'test',
  sections: [{
    heading: 'Main',
    columns: [{ label: 'Name' }, { label: 'Amount', align: 'right' }],
    rows: [['Plain', '10.00'], ['Has, comma', '-5.50'], ['Quote "q"', '1'], ['=SUM(A1)', '2'], ['-cmd', '3'], ['+1+1', '4'], ['@x', '5'], ['multi\nline', '6']],
    totals: ['Total', '12.50'],
  }],
  ...over,
});

describe('CSV', () => {
  const csv = reportToCsv(doc());
  it('starts with a BOM, uses CRLF and carries title, selection, heading, header, rows and totals', () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('\r\n');
    expect(csv).toContain('Test report\r\nCompany 1000\r\n\r\nMain\r\nName,Amount\r\n');
    expect(csv.trimEnd().endsWith('Total,12.50')).toBe(true);
  });
  it('quotes commas, quotes and newlines', () => {
    expect(csv).toContain('"Has, comma",-5.50');
    expect(csv).toContain('"Quote ""q""",1');
    expect(csv).toContain('"multi\nline",6');
  });
  it('defuses spreadsheet formulas but keeps negative numbers', () => {
    expect(csv).toContain("'=SUM(A1),2");
    expect(csv).toContain("'-cmd,3");
    expect(csv).toContain("'+1+1,4");
    expect(csv).toContain("'@x,5");
    expect(csv).toContain(',-5.50');
  });
});

describe('PDF', () => {
  it('renders a small report as one landscape page', async () => {
    const pdf = await reportToPdf(doc(), '2026-11-17 10:00');
    expect(Buffer.from(pdf.bytes).subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.pageCount).toBe(1);
    expect(pdf.replacedCharacters).toBe(0);
  });
  it('paginates a long report and counts characters it cannot encode', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => [`Row ${i}`, String(i)]);
    rows.push(['Arabic مرحبا', '1']);
    const pdf = await reportToPdf(doc({ sections: [{ columns: [{ label: 'Name' }, { label: 'Amount', align: 'right' }], rows }] }), 'now');
    expect(pdf.pageCount).toBeGreaterThan(2);
    expect(pdf.replacedCharacters).toBe(5);
  });
  it('fits a very wide table without throwing', async () => {
    const columns = Array.from({ length: 30 }, (_, i) => ({ label: `Column ${i}` }));
    const rows = [Array.from({ length: 30 }, (_, i) => `A fairly long value number ${i}`)];
    const pdf = await reportToPdf(doc({ sections: [{ columns, rows }] }), 'now');
    expect(pdf.pageCount).toBe(1);
  });
  it('renderReport names the file and sets the type', async () => {
    const csv = await renderReport(doc({ fileStem: 'a b/c' }), 'csv', 'now');
    expect(csv).toMatchObject({ fileName: 'a-b-c.csv', contentType: 'text/csv; charset=utf-8' });
    const pdf = await renderReport(doc(), 'pdf', 'now');
    expect(pdf).toMatchObject({ fileName: 'test.pdf', contentType: 'application/pdf' });
    expect(safeStem('///')).toBe('report');
  });
});

describe('registry', () => {
  it('has unique codes, each with a route and a capability', () => {
    const codes = reportCodes();
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBeGreaterThanOrEqual(15);
    for (const code of codes) {
      const a = reportAdapter(code)!;
      expect(a.route.startsWith('/')).toBe(true);
      expect(a.capability).toMatch(/^[A-Z0-9]+(\.[A-Z0-9]+)+$/);
    }
    expect(reportAdapter('nope')).toBeNull();
  });
});

describe('adapters on an empty tenant', () => {
  let client = '';
  beforeAll(async () => { client = (await createTenant('rpt-export')).client; });
  afterAll(async () => { await destroyTenant(client); });

  it('list reports with no hits still produce a document and both formats', async () => {
    const selections: Record<string, URLSearchParams> = {
      'material-document-list': new URLSearchParams({ postingDateFrom: '2026-01-01', postingDateTo: '2026-12-31' }),
      'purchase-order-list': new URLSearchParams(),
    };
    for (const code of Object.keys(selections)) {
      const d = await reportAdapter(code)!.build(client, selections[code]);
      expect(d.sections[0].rows).toHaveLength(0);
      expect(reportToCsv(d)).toContain(d.title);
      expect((await reportToPdf(d, 'now')).pageCount).toBe(1);
    }
  });
  it('sales analysis produces headers and per-currency totals', async () => {
    const d = await reportAdapter('sales-analysis')!.build(client, new URLSearchParams({ kind: 'SALES', groupBy: 'MATERIAL' }));
    expect(d.title).toContain('Sales analysis');
    expect(d.sections).toHaveLength(2);
  });
  it('a report that needs a selection refuses with the same words as the screen', async () => {
    await expect(reportAdapter('vendor-balances')!.build(client, new URLSearchParams())).rejects.toMatchObject({ remedy: expect.any(String) });
    await expect(reportAdapter('trial-balance')!.build(client, new URLSearchParams())).rejects.toMatchObject({ remedy: expect.any(String) });
  });
});
