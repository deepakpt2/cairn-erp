/**
 * Document PDF (MAIL-03) — the stored rendering, wrapped in the company code's letterhead.
 *
 * SERVER-SIDE ONLY. `pdf-lib` must never be imported from a client component: it would be bundled
 * into the browser. This file is called from exactly two places — the OUTPUT.DISPATCH job and the
 * explicit Download PDF action. Nothing else renders a PDF.
 *
 * The body is the fixed-width text the output engine already produced and stored in
 * `output_message.rendered_document`: one `drawText` per line, never wrapped or reflowed, never
 * re-read from the masters, so the PDF is provably the document the message records.
 *
 * The 14 standard PDF fonts are WinAnsi (Windows-1252) only, and pdf-lib throws on anything else.
 * Every string is therefore sanitised before it is drawn: a character WinAnsi cannot encode becomes
 * `?` and is counted, and the count is returned for the caller to surface. It is not an error.
 * Upgrade path (deliberately not built here): `embedFont` with a Unicode TTF such as Noto Sans Arabic.
 */
import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from 'pdf-lib';

import { type Tx, withTenant } from '../../platform/db/client';
import { type ResolvedLetterhead, resolveLetterhead } from './document-layout';

export interface PdfRenderResult {
  bytes: Uint8Array;
  /** Characters replaced because WinAnsi cannot encode them. Zero for Latin-1 text. */
  replacedCharacters: number;
  pageCount: number;
}

export interface RenderPdfInput {
  client: string;
  companyCode: string;
  /** 'Order confirmation', 'Invoice', 'Goods receipt' */
  title: string;
  documentNumber: string;
  /** output_message.rendered_document, 78 columns. */
  bodyText: string;
}

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 42.5;
const BODY_SIZE = 8.5;
const BODY_LEADING = 10.5;
const NAME_SIZE = 11;
const ADDRESS_SIZE = 8.5;
const ADDRESS_LEADING = 10.5;
const FOOTER_SIZE = 7.5;
const FOOTER_LEADING = 9;
const LOGO_MAX_HEIGHT = 40;
const LOGO_MAX_WIDTH = 160;
const BAND_GAP = 8;

/** The most output a single stored document can ask for: a guard against a runaway text, not a limit anyone meets. */
const MAX_LINES = 20000;

/** Replace what WinAnsi cannot encode with `?`, counting each replacement. */
function sanitiser(font: PDFFont) {
  const supported = new Set(font.getCharacterSet());
  let replaced = 0;
  return {
    clean(text: string): string {
      let out = '';
      for (const char of text.replace(/\t/g, '    ')) {
        const code = char.codePointAt(0)!;
        if (supported.has(code)) { out += char; continue; }
        out += '?';
        replaced += 1;
      }
      return out;
    },
    get replaced() { return replaced; },
  };
}

function textWidth(font: PDFFont, size: number, text: string): number {
  return font.widthOfTextAtSize(text, size);
}

/** Render from a letterhead the caller already resolved. Pure: no database access. */
export async function renderPdfWithLetterhead(
  letterhead: ResolvedLetterhead,
  input: Pick<RenderPdfInput, 'title' | 'documentNumber' | 'bodyText'>,
): Promise<PdfRenderResult> {
  const pdf = await PDFDocument.create();
  const body = await pdf.embedFont(StandardFonts.Courier);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const sanitise = sanitiser(regular);

  pdf.setTitle(sanitise.clean(`${input.title} ${input.documentNumber}`));
  pdf.setAuthor(sanitise.clean(letterhead.name));
  pdf.setCreator('Cairn');
  pdf.setProducer('pdf-lib');
  pdf.setCreationDate(new Date());

  let logo: PDFImage | null = null;
  if (letterhead.logo) {
    logo = letterhead.logo.mime === 'image/png'
      ? await pdf.embedPng(letterhead.logo.bytes)
      : await pdf.embedJpg(letterhead.logo.bytes);
  }
  let logoWidth = 0;
  let logoHeight = 0;
  if (logo) {
    // At most 40 pt high, aspect preserved, and never wider than the band can sensibly spare.
    const scale = Math.min(1, LOGO_MAX_HEIGHT / logo.height, LOGO_MAX_WIDTH / logo.width);
    logoHeight = logo.height * scale;
    logoWidth = logo.width * scale;
  }

  // ── Geometry, decided before anything is drawn so "Page n of m" is known. ──
  const nameText = sanitise.clean(letterhead.name);
  const addressLines = letterhead.addressLines.map((line) => sanitise.clean(line));
  const taxLine = letterhead.taxRegistrationNumber
    ? sanitise.clean(`Tax registration: ${letterhead.taxRegistrationNumber}`)
    : null;
  const headerText = sanitise.clean(letterhead.headerText);
  const textBlockHeight = NAME_SIZE + 3 + (addressLines.length + (taxLine ? 1 : 0)) * ADDRESS_LEADING;
  const bandHeight = Math.max(logoHeight, textBlockHeight) + BAND_GAP;

  const footerLines = letterhead.footerLines.map((line) => sanitise.clean(line));
  const footerHeight = (footerLines.length + (letterhead.showPageNumbers ? 1 : 0)) * FOOTER_LEADING
    + (footerLines.length > 0 || letterhead.showPageNumbers ? 6 : 0);

  const contentHeight = PAGE_HEIGHT - 2 * MARGIN - footerHeight;
  const firstPageLines = Math.max(1, Math.floor((contentHeight - bandHeight - 6) / BODY_LEADING));
  const otherPageLines = Math.max(1, Math.floor(contentHeight / BODY_LEADING));

  const lines = input.bodyText.replace(/\r\n/g, '\n').split('\n').slice(0, MAX_LINES).map((line) => sanitise.clean(line));
  const pages: string[][] = [];
  let index = 0;
  while (index < lines.length || pages.length === 0) {
    const take = pages.length === 0 ? firstPageLines : otherPageLines;
    pages.push(lines.slice(index, index + take));
    index += take;
    if (lines.length === 0) break;
  }

  // ── Drawing. ──
  const ink = rgb(0, 0, 0);
  pages.forEach((pageLines, pageIndex) => {
    const page: PDFPage = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let y = PAGE_HEIGHT - MARGIN;

    if (pageIndex === 0) {
      const top = y;
      if (logo) {
        page.drawImage(logo, { x: MARGIN, y: top - logoHeight, width: logoWidth, height: logoHeight });
      }
      const textX = MARGIN + (logo ? logoWidth + 10 : 0);
      let ty = top - NAME_SIZE;
      page.drawText(nameText, { x: textX, y: ty, size: NAME_SIZE, font: bold, color: ink });
      ty -= 3;
      for (const line of [...addressLines, ...(taxLine ? [taxLine] : [])]) {
        ty -= ADDRESS_LEADING;
        page.drawText(line, { x: textX, y: ty, size: ADDRESS_SIZE, font: regular, color: ink });
      }
      if (headerText) {
        const width = textWidth(regular, NAME_SIZE, headerText);
        page.drawText(headerText, {
          x: PAGE_WIDTH - MARGIN - width, y: top - NAME_SIZE, size: NAME_SIZE, font: regular, color: ink,
        });
      }
      y = top - bandHeight + BAND_GAP / 2;
      page.drawLine({
        start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.6, color: ink,
      });
      y -= 6;
    }

    // Body: left margin only; the text lays itself out because it is already a grid.
    for (const line of pageLines) {
      y -= BODY_LEADING;
      if (line !== '') page.drawText(line, { x: MARGIN, y: y + 2.5, size: BODY_SIZE, font: body, color: ink });
    }

    // Footer: centred above the bottom margin, page number last.
    const footer = [...footerLines];
    if (letterhead.showPageNumbers) footer.push(`Page ${pageIndex + 1} of ${pages.length}`);
    let fy = MARGIN + (footer.length - 1) * FOOTER_LEADING;
    for (const line of footer) {
      const width = textWidth(regular, FOOTER_SIZE, line);
      page.drawText(line, { x: (PAGE_WIDTH - width) / 2, y: fy, size: FOOTER_SIZE, font: regular, color: ink });
      fy -= FOOTER_LEADING;
    }
  });

  const bytes = await pdf.save();
  return { bytes, replacedCharacters: sanitise.replaced, pageCount: pages.length };
}

/** Render inside a transaction the caller already holds (the dispatch job). */
export async function renderDocumentPdfIn(tx: Tx, input: RenderPdfInput): Promise<PdfRenderResult> {
  const letterhead = await resolveLetterhead(tx, input.client, input.companyCode);
  return renderPdfWithLetterhead(letterhead, input);
}

/** Render on its own read: the Download PDF action. */
export async function renderDocumentPdf(input: RenderPdfInput): Promise<PdfRenderResult> {
  return withTenant(input.client, (tx) => renderDocumentPdfIn(tx, input));
}

/** The warning line for a render that replaced characters; null when nothing was replaced. */
export function replacedCharactersWarning(count: number): string | null {
  if (count <= 0) return null;
  return `${count} character${count === 1 ? '' : 's'} could not be represented and ${count === 1 ? 'was' : 'were'} replaced. Embedding a Unicode font is required for non-Latin text.`;
}
