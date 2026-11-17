/**
 * Turns the CSV a module already produces for a report into a ReportDoc, so the PDF is the same
 * rows as the existing CSV download and never a second derivation.
 */
import type { ReportColumn, ReportDoc } from './report-export';

/** RFC 4180 parse: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

export function csvToReport(
  csv: string,
  head: { title: string; subtitle?: string[]; fileStem: string; rightAlign?: RegExp },
): ReportDoc {
  const all = parseCsv(csv);
  const notes: string[] = [];
  while (all.length > 0 && all[0][0]?.startsWith('#')) notes.push(all.shift()![0].replace(/^#\s*/, ''));
  const [header = [], ...body] = all.filter((r) => !(r.length === 1 && r[0] === ''));
  const columns: ReportColumn[] = header.map((label, c) => {
    const values = body.map((r) => r[c] ?? '').filter((v) => v !== '');
    const numeric = values.length > 0 && values.every((v) => NUMERIC.test(v));
    return { label, align: numeric || head.rightAlign?.test(label) ? 'right' : undefined } as ReportColumn;
  });
  return {
    title: head.title,
    subtitle: [...(head.subtitle ?? []), ...notes],
    sections: [{ columns, rows: body.map((r) => header.map((_, c) => r[c] ?? '')) }],
    fileStem: head.fileStem,
  };
}
