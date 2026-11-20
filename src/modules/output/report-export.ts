/**
 * Report export — one table model, two formats (CSV and PDF).
 *
 * A report adapter (see `report-registry.ts`) turns a screen's own result into a `ReportDoc`; nothing
 * here knows what a trial balance or an ageing list is. The figures are the ones the screen shows:
 * adapters read through the same service functions and format nothing but layout.
 *
 * CSV: UTF-8 with a byte-order mark (so Excel reads non-Latin text), CRLF rows, a cell that starts with
 * `= + @` or a tab/CR (or a `-` that is not a number) gets a leading apostrophe so a spreadsheet never
 * treats text as a formula.
 *
 * PDF: A4 landscape, Helvetica (WinAnsi, as `render-pdf.ts`; characters it cannot encode become `?`
 * and are counted), column widths fitted to the content, long cells truncated with an ellipsis, the
 * header repeated on every page, and "Page n of m" in the footer.
 */
import type { ServiceAuthorityContext } from '@/platform/auth/service-authority';
import { PDFDocument, PDFFont, StandardFonts, rgb } from 'pdf-lib';

export interface ReportColumn {
  label: string;
  /** Numbers and amounts read better right-aligned. */
  align?: 'left' | 'right';
}

export interface ReportSection {
  heading?: string;
  columns: ReportColumn[];
  rows: string[][];
  /** A closing row (totals), drawn bold under a rule. Same width as `columns`. */
  totals?: string[];
}

export interface ReportDoc {
  title: string;
  /** Selection lines: "Company 1000", "Key date 2026-11-30". */
  subtitle: string[];
  sections: ReportSection[];
  /** Used for the file name, e.g. `trial-balance-1000-2026-11-30`. */
  fileStem: string;
}

export const REPORT_MAX_ROWS = 50_000;

/** What a screen contributes to the export route: who may run it and how its query string becomes a table. */
export interface ReportAdapter {
  /** The `[report]` segment of `/reports/export/<code>`. */
  code: string;
  /** The screen this export belongs to, for the sign-in redirect and the codemap. */
  route: string;
  capability: string;
  /** Same query-string keys as the screen reads; throws a service error (with `remedy`) for a bad selection. */
  build(client: string, query: URLSearchParams, authorization: ServiceAuthorityContext | undefined): Promise<ReportDoc>;
}

export class ReportExportError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'ReportExportError';
  }
}

/** Number as it appears in an export: two decimals by default, empty for null. */
export function fmt(value: number | string | null | undefined, digits = 2): string {
  if (value === null || value === undefined || value === '') return '';
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : String(value);
}

export const num = (q: URLSearchParams, key: string): number | undefined => {
  const v = q.get(key);
  return v ? Number(v) : undefined;
};

export function need(q: URLSearchParams, key: string): string {
  const v = (q.get(key) ?? '').trim();
  if (!v) throw new ReportExportError(`${key} is required for this export.`, 'Run the report on screen first; the export uses the same selection.');
  return v;
}

// ── CSV ────────────────────────────────────────────────────────────────────

const NUMBER = /^-?\d[\d,]*(\.\d+)?$/;

function csvCell(value: string): string {
  let v = value ?? '';
  if (/^[=+@\t\r]/.test(v) || (v.startsWith('-') && !NUMBER.test(v))) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function reportToCsv(doc: ReportDoc): string {
  const lines: string[] = [];
  lines.push(csvCell(doc.title));
  for (const s of doc.subtitle) lines.push(csvCell(s));
  for (const section of doc.sections) {
    lines.push('');
    if (section.heading) lines.push(csvCell(section.heading));
    lines.push(section.columns.map((c) => csvCell(c.label)).join(','));
    for (const row of section.rows) lines.push(row.map(csvCell).join(','));
    if (section.totals) lines.push(section.totals.map(csvCell).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ── PDF ────────────────────────────────────────────────────────────────────

const PAGE_W = 841.89;
const PAGE_H = 595.28;
const MARGIN = 32;
const FONT_SIZE = 7.5;
const LEADING = 10;
const PAD = 4;
const TITLE_SIZE = 13;

export interface ReportPdf {
  bytes: Uint8Array;
  pageCount: number;
  replacedCharacters: number;
}

function sanitiser(font: PDFFont) {
  const supported = new Set(font.getCharacterSet());
  let replaced = 0;
  const run = (text: string, count: boolean): string => {
    let out = '';
    for (const char of (text ?? '').replace(/[\t\r\n]+/g, ' ')) {
      if (supported.has(char.codePointAt(0)!)) out += char;
      else { out += '?'; if (count) replaced += 1; }
    }
    return out;
  };
  return {
    /** Sanitise for drawing: counts what it replaces. */
    clean: (text: string): string => run(text, true),
    /** Sanitise for measuring: the same text, not counted. */
    peek: (text: string): string => run(text, false),
    get replaced() { return replaced; },
  };
}

function fit(font: PDFFont, size: number, text: string, width: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let cut = text;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}..`, size) > width) cut = cut.slice(0, -1);
  return `${cut}..`;
}

/** Column widths: the widest cell of each column, shrunk proportionally (never below a floor) to the page. */
function columnWidths(font: PDFFont, bold: PDFFont, section: ReportSection, clean: (t: string) => string, usable: number): number[] {
  const n = section.columns.length;
  const natural = section.columns.map((c, i) => {
    let w = bold.widthOfTextAtSize(clean(c.label), FONT_SIZE);
    for (const row of section.rows) w = Math.max(w, font.widthOfTextAtSize(clean(row[i] ?? ''), FONT_SIZE));
    if (section.totals) w = Math.max(w, bold.widthOfTextAtSize(clean(section.totals[i] ?? ''), FONT_SIZE));
    return w + PAD * 2;
  });
  const total = natural.reduce((a, b) => a + b, 0);
  if (total <= usable) return natural;
  const floor = Math.min(40, usable / n);
  const scale = usable / total;
  let widths = natural.map((w) => Math.max(floor, w * scale));
  const over = widths.reduce((a, b) => a + b, 0) - usable;
  if (over > 0) {
    const flex = widths.filter((w) => w > floor).length || 1;
    widths = widths.map((w) => (w > floor ? Math.max(floor, w - over / flex) : w));
  }
  return widths;
}

export async function reportToPdf(doc: ReportDoc, generatedOn: string): Promise<ReportPdf> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const san = sanitiser(font);
  const usable = PAGE_W - MARGIN * 2;
  const pages: ReturnType<PDFDocument['addPage']>[] = [];

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  pages.push(page);
  let y = PAGE_H - MARGIN;

  const newPage = () => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    y = PAGE_H - MARGIN;
  };
  const room = (lines: number) => y - lines * LEADING >= MARGIN + 14;

  page.drawText(san.clean(doc.title), { x: MARGIN, y: y - TITLE_SIZE, size: TITLE_SIZE, font: bold });
  y -= TITLE_SIZE + 6;
  for (const line of [...doc.subtitle, `Generated ${generatedOn}`]) {
    page.drawText(san.clean(line), { x: MARGIN, y: y - FONT_SIZE, size: FONT_SIZE, font, color: rgb(0.3, 0.3, 0.3) });
    y -= LEADING;
  }
  y -= 6;

  for (const section of doc.sections) {
    const widths = columnWidths(font, bold, section, san.peek, usable);
    const drawRow = (cells: string[], f: PDFFont, shade = false) => {
      if (shade) page.drawRectangle({ x: MARGIN, y: y - LEADING + 2.5, width: usable, height: LEADING, color: rgb(0.93, 0.93, 0.93) });
      let x = MARGIN;
      cells.forEach((cell, i) => {
        const text = fit(f, FONT_SIZE, san.clean(cell ?? ''), widths[i] - PAD * 2);
        const w = f.widthOfTextAtSize(text, FONT_SIZE);
        const dx = section.columns[i].align === 'right' ? widths[i] - PAD - w : PAD;
        page.drawText(text, { x: x + dx, y: y - FONT_SIZE, size: FONT_SIZE, font: f });
        x += widths[i];
      });
      y -= LEADING;
    };
    const drawHeader = () => {
      drawRow(section.columns.map((c) => c.label), bold, true);
    };

    if (section.heading) {
      if (!room(4)) newPage();
      page.drawText(san.clean(section.heading), { x: MARGIN, y: y - 9, size: 9, font: bold });
      y -= 14;
    }
    if (!room(3)) newPage();
    drawHeader();
    for (const row of section.rows) {
      if (!room(1)) { newPage(); drawHeader(); }
      drawRow(row, font);
    }
    if (section.totals) {
      if (!room(2)) { newPage(); drawHeader(); }
      page.drawLine({ start: { x: MARGIN, y: y + 1 }, end: { x: MARGIN + usable, y: y + 1 }, thickness: 0.5, color: rgb(0.2, 0.2, 0.2) });
      drawRow(section.totals, bold);
    }
    y -= 8;
  }

  const total = pages.length;
  pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${total}`;
    p.drawText(label, { x: PAGE_W - MARGIN - font.widthOfTextAtSize(label, 7), y: MARGIN - 12, size: 7, font, color: rgb(0.4, 0.4, 0.4) });
    p.drawText(san.clean(doc.title), { x: MARGIN, y: MARGIN - 12, size: 7, font, color: rgb(0.4, 0.4, 0.4) });
  });

  return { bytes: await pdf.save(), pageCount: total, replacedCharacters: san.replaced };
}

/** File-name safe stem. */
export function safeStem(stem: string): string {
  return stem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'report';
}
