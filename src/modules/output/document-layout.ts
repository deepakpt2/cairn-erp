/**
 * Document layout (MAIL-03) — the letterhead a company code's output documents carry.
 *
 * The layout holds the graphic, the header and footer text and *overrides*. The company's name and
 * address are the company code's own; an empty override falls back to them, so they are never copied.
 *
 * Rules this file keeps:
 * - The logo is validated server-side, after decoding, by magic bytes — never by the browser's
 *   content type or the file name. SVG is refused (it can carry script).
 * - The logo bytes never enter a change document or an error: the change records `logoSet` and the
 *   file name only.
 */
import { and, eq } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/pattern';
import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { documentLayout } from '../foundation/output-schema';
import { companyCode as companyCodeTable } from '../foundation/schema';

export const DOCUMENT_LAYOUT_ROUTE = '/config/document-layout';
export const DOCUMENT_LAYOUT_CAPABILITY = 'CFG.FND.DOCUMENT.LAYOUT.DEFINE';
export const DOCUMENT_LAYOUT_OBJECT_CLASS = 'document_layout';

export const LOGO_MAX_BYTES = 256 * 1024;
export const LOGO_MAX_DIMENSION = 2000;

export class DocumentLayoutError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'DocumentLayoutError';
  }
}

export interface DocumentLayoutView {
  companyCode: string;
  /** company_code.name — the fallback, always shown. */
  companyName: string;
  /** The override, or ''. */
  displayName: string;
  addressOverride: string;
  headerText: string;
  footerText: string;
  hasLogo: boolean;
  /** data:image/png;base64,… or null. */
  logoDataUri: string | null;
  logoFileName: string | null;
  showPageNumbers: boolean;
}

export interface SaveLayoutInput {
  client: string;
  companyCode: string;
  changedBy: string;
  displayName: string;
  addressOverride: string;
  headerText: string;
  footerText: string;
  /** The uploaded file, when one was chosen. Absent leaves the stored logo as it is. */
  logo?: { bytes: Uint8Array; fileName: string } | null;
  removeLogo?: boolean;
  showPageNumbers: boolean;
}

/** The letterhead as the renderers need it: the overrides already resolved against the company code. */
export interface ResolvedLetterhead {
  name: string;
  addressLines: string[];
  taxRegistrationNumber: string | null;
  headerText: string;
  footerLines: string[];
  showPageNumbers: boolean;
  logo: { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' } | null;
  /** The same logo as a data: URI, for the HTML letterhead and the print stylesheet. */
  logoDataUri: string | null;
}

/** What a screen needs to draw the letterhead: serialisable, no bytes. */
export type LetterheadView = Omit<ResolvedLetterhead, 'logo'>;

function requireDefine(capabilities: string[]): void {
  if (!hasCapability(capabilities, DOCUMENT_LAYOUT_CAPABILITY)) {
    throw new DocumentLayoutError(
      `Maintaining the document layout needs ${DOCUMENT_LAYOUT_CAPABILITY}, which this session does not hold.`,
      `Ask an administrator to grant ${DOCUMENT_LAYOUT_CAPABILITY} to one of your roles.`,
    );
  }
}

/* ─── Image validation ───────────────────────────────────────────────────────────────────────── */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return bytes.length >= magic.length && magic.every((value, index) => bytes[index] === value);
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  // 8 signature + 4 length + 4 'IHDR' + 4 width + 4 height.
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== 'IHDR') return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) { offset += 1; continue; }
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = view.getUint16(offset + 2);
    // SOF0..SOF15, except DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

export function validateLogo(bytes: Uint8Array): { mime: 'image/png' | 'image/jpeg' } {
  if (bytes.length === 0) {
    throw new DocumentLayoutError('The logo file is empty.', 'Choose a PNG or JPEG image.');
  }
  if (bytes.length > LOGO_MAX_BYTES) {
    throw new DocumentLayoutError(
      `The logo is ${Math.ceil(bytes.length / 1024)} KB; the limit is ${LOGO_MAX_BYTES / 1024} KB.`,
      'Reduce the image size and upload it again.',
    );
  }
  const isPng = startsWith(bytes, PNG_MAGIC);
  const isJpeg = startsWith(bytes, JPEG_MAGIC);
  if (!isPng && !isJpeg) {
    throw new DocumentLayoutError(
      'The logo must be a PNG or JPEG image.',
      'SVG and every other format are refused; the file is judged by its content, not its name.',
    );
  }
  const size = isPng ? pngSize(bytes) : jpegSize(bytes);
  if (!size || size.width < 1 || size.height < 1) {
    throw new DocumentLayoutError('The logo image header could not be read.', 'Export the image again and upload it.');
  }
  if (size.width > LOGO_MAX_DIMENSION || size.height > LOGO_MAX_DIMENSION) {
    throw new DocumentLayoutError(
      `The logo is ${size.width} × ${size.height}; the limit is ${LOGO_MAX_DIMENSION} × ${LOGO_MAX_DIMENSION}.`,
      'Scale the image down and upload it again.',
    );
  }
  return { mime: isPng ? 'image/png' : 'image/jpeg' };
}

/* ─── Reads ──────────────────────────────────────────────────────────────────────────────────── */

type LayoutRow = typeof documentLayout.$inferSelect;
type CompanyRow = Pick<typeof companyCodeTable.$inferSelect, 'companyCode' | 'name'>;

function viewOf(company: CompanyRow, row: LayoutRow | undefined): DocumentLayoutView {
  const hasLogo = Boolean(row?.logoData && row.logoMime);
  return {
    companyCode: company.companyCode,
    companyName: company.name,
    displayName: row?.displayName ?? '',
    addressOverride: row?.addressOverride ?? '',
    headerText: row?.headerText ?? '',
    footerText: row?.footerText ?? '',
    hasLogo,
    logoDataUri: hasLogo ? `data:${row!.logoMime};base64,${row!.logoData}` : null,
    logoFileName: hasLogo ? row!.logoFileName ?? null : null,
    showPageNumbers: row?.showPageNumbers ?? true,
  };
}

async function loadView(tx: Tx, client: string, companyCode: string): Promise<DocumentLayoutView> {
  const [company] = await tx.select({ companyCode: companyCodeTable.companyCode, name: companyCodeTable.name })
    .from(companyCodeTable)
    .where(and(eq(companyCodeTable.client, client), eq(companyCodeTable.companyCode, companyCode)));
  if (!company) {
    throw new DocumentLayoutError(`Company code ${companyCode || '(none)'} does not exist.`, 'Choose one of the tenant\'s company codes.');
  }
  const [row] = await tx.select().from(documentLayout)
    .where(and(eq(documentLayout.client, client), eq(documentLayout.companyCode, companyCode)));
  // A missing layout row is not an error: it is the company code with no logo and no footer.
  return viewOf(company, row);
}

export async function listDocumentLayouts(client: string, capabilities: string[]): Promise<DocumentLayoutView[]> {
  requireDefine(capabilities);
  return withTenant(client, async (tx) => {
    const companies = await tx.select({ companyCode: companyCodeTable.companyCode, name: companyCodeTable.name })
      .from(companyCodeTable).where(eq(companyCodeTable.client, client)).orderBy(companyCodeTable.companyCode);
    const rows = await tx.select().from(documentLayout).where(eq(documentLayout.client, client));
    const byCode = new Map(rows.map((row) => [row.companyCode, row]));
    return companies.map((company) => viewOf(company, byCode.get(company.companyCode)));
  });
}

export async function getDocumentLayout(client: string, companyCode: string, capabilities: string[]): Promise<DocumentLayoutView> {
  requireDefine(capabilities);
  return withTenant(client, (tx) => loadView(tx, client, companyCode));
}

/**
 * The letterhead the renderers draw, inside a transaction the caller holds. No capability check: this
 * is how a dispatched document gets its letterhead, not a maintenance screen.
 */
export async function resolveLetterhead(tx: Tx, client: string, companyCode: string): Promise<ResolvedLetterhead> {
  const [company] = await tx.select().from(companyCodeTable)
    .where(and(eq(companyCodeTable.client, client), eq(companyCodeTable.companyCode, companyCode)));
  if (!company) {
    throw new DocumentLayoutError(`Company code ${companyCode} does not exist.`);
  }
  const [row] = await tx.select().from(documentLayout)
    .where(and(eq(documentLayout.client, client), eq(documentLayout.companyCode, companyCode)));
  const override = (row?.addressOverride ?? '').trim();
  const addressLines = override
    ? override.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [company.address ?? '', [company.city, company.country].filter(Boolean).join(', ')]
        .flatMap((part) => part.split(/\r?\n/)).map((line) => line.trim()).filter(Boolean);
  return {
    name: (row?.displayName ?? '').trim() || company.name,
    addressLines,
    taxRegistrationNumber: company.taxRegistrationNumber ?? null,
    headerText: (row?.headerText ?? '').trim(),
    footerLines: (row?.footerText ?? '').split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim() !== ''),
    showPageNumbers: row?.showPageNumbers ?? true,
    logo: row?.logoData && row.logoMime
      ? { bytes: new Uint8Array(Buffer.from(row.logoData, 'base64')), mime: row.logoMime as 'image/png' | 'image/jpeg' }
      : null,
    logoDataUri: row?.logoData && row.logoMime ? `data:${row.logoMime};base64,${row.logoData}` : null,
  };
}

/**
 * The letterheads for a set of company codes, as the output screens draw them. A reader of the output
 * queue is not a maintainer of the layout, so there is deliberately no capability check; an unknown
 * code is simply absent.
 */
export async function letterheadViews(client: string, companyCodes: string[]): Promise<Record<string, LetterheadView>> {
  const codes = [...new Set(companyCodes.filter((code) => code !== ''))];
  if (codes.length === 0) return {};
  return withTenant(client, async (tx) => {
    const out: Record<string, LetterheadView> = {};
    for (const code of codes) {
      try {
        const { logo: _bytes, ...view } = await resolveLetterhead(tx, client, code);
        out[code] = view;
      } catch (error) {
        if (!(error instanceof DocumentLayoutError)) throw error;
      }
    }
    return out;
  });
}

/* ─── Writes ─────────────────────────────────────────────────────────────────────────────────── */

function snapshot(view: DocumentLayoutView) {
  // The logo bytes are never here: a boolean and the file name only.
  return {
    displayName: view.displayName,
    addressOverride: view.addressOverride,
    headerText: view.headerText,
    footerText: view.footerText,
    logoSet: view.hasLogo,
    logoFileName: view.logoFileName ?? '',
    showPageNumbers: view.showPageNumbers,
  };
}

export async function saveDocumentLayout(input: SaveLayoutInput, capabilities: string[]): Promise<DocumentLayoutView> {
  requireDefine(capabilities);
  const displayName = input.displayName.trim();
  const headerText = input.headerText.trim();
  if (displayName.length > 160) throw new DocumentLayoutError('The display name is limited to 160 characters.');
  if (headerText.length > 200) throw new DocumentLayoutError('The header text is limited to 200 characters.');

  const upload = input.logo && input.logo.bytes.length > 0 ? input.logo : null;
  const validated = upload ? validateLogo(upload.bytes) : null;

  return withTenant(input.client, async (tx) => {
    const before = await loadView(tx, input.client, input.companyCode);
    const logo = upload && validated
      ? {
          logoData: Buffer.from(upload.bytes).toString('base64'),
          logoMime: validated.mime,
          logoFileName: upload.fileName.replace(/[\\/]/g, '_').slice(0, 120) || 'logo',
        }
      : input.removeLogo
        ? { logoData: null, logoMime: null, logoFileName: null }
        : {};
    const values = {
      displayName: displayName || null,
      addressOverride: input.addressOverride.trim() || null,
      headerText: headerText || null,
      footerText: input.footerText.trim() || null,
      showPageNumbers: input.showPageNumbers,
      ...logo,
      changedBy: input.changedBy,
      changedAt: new Date(),
    };
    await tx.insert(documentLayout)
      .values({ client: input.client, companyCode: input.companyCode, ...values, createdBy: input.changedBy })
      .onConflictDoUpdate({ target: [documentLayout.client, documentLayout.companyCode], set: values });
    const after = await loadView(tx, input.client, input.companyCode);
    await recordChange(tx, {
      client: input.client,
      objectClass: DOCUMENT_LAYOUT_OBJECT_CLASS,
      objectKey: input.companyCode,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: DOCUMENT_LAYOUT_CAPABILITY,
      before: snapshot(before),
      after: snapshot(after),
    });
    return after;
  });
}

export async function removeLogo(
  input: { client: string; companyCode: string; changedBy: string },
  capabilities: string[],
): Promise<DocumentLayoutView> {
  requireDefine(capabilities);
  return withTenant(input.client, async (tx) => {
    const before = await loadView(tx, input.client, input.companyCode);
    await tx.update(documentLayout).set({
      logoData: null, logoMime: null, logoFileName: null,
      changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(eq(documentLayout.client, input.client), eq(documentLayout.companyCode, input.companyCode)));
    const after = await loadView(tx, input.client, input.companyCode);
    await recordChange(tx, {
      client: input.client,
      objectClass: DOCUMENT_LAYOUT_OBJECT_CLASS,
      objectKey: input.companyCode,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: DOCUMENT_LAYOUT_CAPABILITY,
      before: snapshot(before),
      after: snapshot(after),
    });
    return after;
  });
}
