/**
 * MAIL-03 — document layout, PDF, and dispatch as a job.
 *
 * The transport is mocked and nothing is sent: these tests prove what is stored, what the PDF
 * contains, and what the OUTPUT.DISPATCH job does with a PENDING message. Everything else runs against
 * the real erp_test database. Material-document outputs stand in for "an output message": the job's
 * contract is the same for every document category.
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { PDFArray, PDFDocument, decodePDFRawStream, type PDFRawStream } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/platform/mail/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/platform/mail/transport')>();
  return { ...actual, deliverMail: vi.fn(), probeConnection: vi.fn() };
});

import { withTenant } from '../src/platform/db/client';
import {
  DocumentLayoutError,
  getDocumentLayout,
  removeLogo,
  saveDocumentLayout,
} from '../src/modules/output/document-layout';
import { renderPdfWithLetterhead, renderDocumentPdf } from '../src/modules/output/render-pdf';
import { renderStoredPdf, PdfDownloadError } from '../src/modules/output/download-pdf';
import { dispatchMessageForProvisioning as dispatchMessage, recordOutputsForPostedDocument } from '../src/modules/inventory/material-document-output';
import { saveMailConfig } from '../src/platform/mail/service';
import { createTenant, destroyTenant } from './helpers';
import { runOutputDispatch } from './helpers/output-dispatch';

const CAP = ['CFG.FND.DOCUMENT.LAYOUT.DEFINE'];
const MAIL_CAP = ['CFG.PLT.MAIL.DEFINE'];
const ACTOR = 'MAIL03_TEST';
const COMPANY = '1000';

/** A one-pixel PNG, and a minimal JPEG header with a SOF0 marker of 1 × 1. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
]);

let client = '';
let other = '';
const saved: Record<string, string | undefined> = {};

const layoutInput = (overrides: Record<string, unknown> = {}) => ({
  client, companyCode: COMPANY, changedBy: ACTOR, displayName: '', addressOverride: '', headerText: '',
  footerText: '', showPageNumbers: true, ...overrides,
});

/** The text drawn on each page, decoded from the content streams. */
async function pageTexts(bytes: Uint8Array): Promise<string[][]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray
      ? contents.asArray().map((ref) => doc.context.lookup(ref))
      : [contents];
    const out: string[] = [];
    for (const stream of streams) {
      const raw = Buffer.from(decodePDFRawStream(stream as PDFRawStream).decode()).toString('latin1');
      for (const match of raw.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
        out.push(Buffer.from(match[1]!, 'hex').toString('latin1'));
      }
    }
    return out;
  });
}

const messageRows = (document: string) => withTenant(client, (tx) => tx.execute(sql`
  select status, send_count, rendered_document, error_text, transmission_medium, recipient
    from output_message where client = ${client} and document_number = ${document}
   order by transmission_medium
`)) as unknown as Promise<Array<{
  status: string; send_count: number; rendered_document: string | null; error_text: string | null;
  transmission_medium: string; recipient: string | null;
}>>;

const mailRows = (document?: string) => withTenant(client, (tx) => tx.execute(sql`
  select id, to_address, subject, attachment_name, attachment_mime, length(attachment_data) as size, object_key
    from mail_message where client = ${client} ${document ? sql`and object_key like ${'%/' + document + '/%'}` : sql``}
`)) as unknown as Promise<Array<{ id: string; to_address: string; subject: string; attachment_name: string | null; attachment_mime: string | null; size: number | null; object_key: string }>>;

let counter = 0;
/** A posted receipt document of one line, and (optionally) an output message for it. */
async function document(options: { medium?: 'PRINT' | 'EMAIL'; recipient?: string | null; withLines?: boolean } = {}) {
  const number = `49${String(Date.now()).slice(-6)}${counter += 1}`.slice(0, 20);
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, header_text, status, created_by)
      values (${client}, ${number}, 2026, '2026-05-01', '2026-05-01', 'Layout test', 'POSTED', ${ACTOR})
    `);
    if (options.withLines !== false) {
      await tx.execute(sql`
        insert into material_document_line (client, material_document_number, line_number, movement_type, material_number,
                                            plant, storage_location, stock_type, line_direction, entry_quantity, entry_unit,
                                            base_quantity, base_unit, value, currency, created_by)
        values (${client}, ${number}, 1, 'RECEIPT_OTHER', 'OUT-MAT', '1000', '0001', 'UNRESTRICTED', 'RECEIPT', 3, 'PC', 3, 'PC', 30, 'KWD', ${ACTOR})
      `);
    }
    await tx.execute(sql`
      insert into output_message (client, document_category, document_number, document_year, output_type,
                                  transmission_medium, dispatch_time, issue_number, status, recipient, created_by)
      values (${client}, 'MATERIAL_DOCUMENT', ${number}, 2026, 'WE01', ${options.medium ?? 'EMAIL'}, 'PERIODIC', 1,
              'PENDING', ${options.recipient === undefined ? 'warehouse@example.test' : options.recipient}, ${ACTOR})
    `);
  });
  return number;
}

async function enableMail(enabled: boolean) {
  await saveMailConfig({
    client, changedBy: ACTOR, host: 'smtp.example', port: 587, encryption: 'STARTTLS', username: '', password: '',
    clearPassword: false, senderAddress: 'erp@example.com', senderName: 'ERP', isEnabled: enabled,
  }, MAIL_CAP);
}

beforeAll(async () => {
  saved.ring = process.env.CAIRN_BANK_DATA_KEYRING_JSON;
  process.env.CAIRN_BANK_DATA_KEYRING_JSON = JSON.stringify({ activeKeyId: 'k1', keys: { k1: randomBytes(32).toString('base64url') } });
  client = (await createTenant('mail03-a')).client;
  other = (await createTenant('mail03-b')).client;
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      update company_code set name = 'Acme Foods', address = 'Street 1' || chr(10) || 'Block 2', city = 'Kuwait City',
             tax_registration_number = 'TRN-77' where client = ${client} and company_code = ${COMPANY}
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, country, company_code, created_by)
      values (${client}, '1000', 'Layout plant', 'KW', ${COMPANY}, ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'OUT-MAT', 'Printed material', t.material_type, 'PC', ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
      values (${client}, 'RECEIPT_OTHER', 'Goods receipt without reference', 'RECEIPT', 'MATERIAL_DOCUMENT', ${ACTOR})
      on conflict do nothing
    `);
  });
  // The output types the messages name.
  await withTenant(client, async (tx) => {
    const doc = '4900000001';
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, status, created_by)
      values (${client}, ${doc}, 2026, '2026-05-01', '2026-05-01', 'POSTED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into material_document_line (client, material_document_number, line_number, movement_type, material_number,
                                          plant, storage_location, stock_type, line_direction, entry_quantity, entry_unit,
                                          base_quantity, base_unit, value, currency, created_by)
      values (${client}, ${doc}, 1, 'RECEIPT_OTHER', 'OUT-MAT', '1000', '0001', 'UNRESTRICTED', 'RECEIPT', 1, 'PC', 1, 'PC', 1, 'KWD', ${ACTOR})
    `);
    await recordOutputsForPostedDocument(tx, client, doc, ACTOR);
  });
  await runOutputDispatch(client);
});

afterAll(async () => {
  if (saved.ring === undefined) delete process.env.CAIRN_BANK_DATA_KEYRING_JSON;
  else process.env.CAIRN_BANK_DATA_KEYRING_JSON = saved.ring;
  await destroyTenant(client);
  await destroyTenant(other);
});

describe('document layout', () => {
  it('1. a layout with no overrides falls back to the company code name and address', async () => {
    const view = await getDocumentLayout(client, COMPANY, CAP);
    expect(view).toMatchObject({ companyName: 'Acme Foods', displayName: '', addressOverride: '', hasLogo: false, showPageNumbers: true });
    await saveDocumentLayout(layoutInput(), CAP);
    const saved = await getDocumentLayout(client, COMPANY, CAP);
    expect(saved.displayName).toBe('');
    // The renderers resolve the same fallback.
    const pdf = await renderDocumentPdf({ client, companyCode: COMPANY, title: 'Goods receipt', documentNumber: 'X1', bodyText: 'body' });
    const [page] = await pageTexts(pdf.bytes);
    expect(page).toContain('Acme Foods');
    expect(page).toContain('Street 1');
    expect(page).toContain('Kuwait City, KW');
    expect(page).toContain('Tax registration: TRN-77');
  });

  it('2. a PNG logo is accepted and round-trips to a data: URI; a JPEG likewise', async () => {
    let view = await saveDocumentLayout(layoutInput({ logo: { bytes: new Uint8Array(PNG), fileName: 'logo.png' } }), CAP);
    expect(view.hasLogo).toBe(true);
    expect(view.logoDataUri).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(view.logoFileName).toBe('logo.png');
    view = await saveDocumentLayout(layoutInput({ logo: { bytes: new Uint8Array(JPEG), fileName: 'logo.jpg' } }), CAP);
    expect(view.logoDataUri).toBe(`data:image/jpeg;base64,${JPEG.toString('base64')}`);
  });

  it('3. a file whose bytes are not PNG/JPEG is refused whatever its name or type says', async () => {
    const fake = new Uint8Array(Buffer.from('GIF89a not an image really'));
    await expect(saveDocumentLayout(layoutInput({ logo: { bytes: fake, fileName: 'logo.png' } }), CAP))
      .rejects.toBeInstanceOf(DocumentLayoutError);
  });

  it('4. an SVG is refused, and so is a file over 256 KB', async () => {
    const svg = new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
    await expect(saveDocumentLayout(layoutInput({ logo: { bytes: svg, fileName: 'logo.svg' } }), CAP)).rejects.toThrow(/PNG or JPEG/);
    const big = new Uint8Array(257 * 1024);
    big.set(PNG);
    await expect(saveDocumentLayout(layoutInput({ logo: { bytes: big, fileName: 'big.png' } }), CAP)).rejects.toThrow(/limit is 256 KB/);
  });

  it('5. removeLogo clears the logo columns and leaves the texts alone', async () => {
    await saveDocumentLayout(layoutInput({
      headerText: 'Tax invoice', footerText: 'Bank: 123\nLegal line', displayName: 'Acme',
      logo: { bytes: new Uint8Array(PNG), fileName: 'logo.png' },
    }), CAP);
    const view = await removeLogo({ client, companyCode: COMPANY, changedBy: ACTOR }, CAP);
    expect(view).toMatchObject({ hasLogo: false, logoDataUri: null, logoFileName: null, headerText: 'Tax invoice', displayName: 'Acme' });
    expect(view.footerText).toBe('Bank: 123\nLegal line');
    const row = (await withTenant(client, (tx) => tx.execute(sql`
      select logo_data, logo_mime, logo_file_name from document_layout where client = ${client} and company_code = ${COMPANY}
    `))) as unknown as Array<Record<string, unknown>>;
    expect(row[0]).toEqual({ logo_data: null, logo_mime: null, logo_file_name: null });
  });

  it('6. the change document records logoSet: true and never the base64', async () => {
    await saveDocumentLayout(layoutInput({ logo: { bytes: new Uint8Array(PNG), fileName: 'logo.png' } }), CAP);
    const items = (await withTenant(client, (tx) => tx.execute(sql`
      select i.field_name, i.new_value from change_document_item i
        join change_document d on d.id = i.change_document_id
       where d.client = ${client} and d.object_class = 'document_layout'
    `))) as unknown as Array<{ field_name: string; new_value: string | null }>;
    expect(items.some((item) => item.field_name === 'logoSet' && item.new_value === 'true')).toBe(true);
    expect(JSON.stringify(items)).not.toContain(PNG.toString('base64'));
  });

  it('refuses a session without the layout capability', async () => {
    await expect(saveDocumentLayout(layoutInput(), ['CFG.PLT.MAIL.DEFINE'])).rejects.toThrow(/needs CFG.FND.DOCUMENT.LAYOUT.DEFINE/);
  });
});

describe('document PDF', () => {
  const letterhead = {
    name: 'Acme Foods', addressLines: ['Street 1'], taxRegistrationNumber: null, headerText: 'Tax invoice',
    footerLines: ['Bank: 123'], showPageNumbers: true, logo: null, logoDataUri: null,
  };
  const body = (lines: number) => Array.from({ length: lines }, (_, i) => `LINE ${String(i + 1).padStart(4, '0')} ${'x'.repeat(60)}`).join('\n');

  it('7. a one-page document returns bytes starting %PDF- and one page', async () => {
    const pdf = await renderPdfWithLetterhead(letterhead, { title: 'Invoice', documentNumber: '90000001', bodyText: body(5) });
    expect(Buffer.from(pdf.bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(pdf.pageCount).toBe(1);
    expect((await PDFDocument.load(pdf.bytes)).getPageCount()).toBe(1);
  });

  it('8. a body long enough for three pages produces three pages, each footer saying Page n of 3', async () => {
    const pdf = await renderPdfWithLetterhead(letterhead, { title: 'Invoice', documentNumber: '90000002', bodyText: body(150) });
    expect(pdf.pageCount).toBe(3);
    const pages = await pageTexts(pdf.bytes);
    pages.forEach((page, index) => expect(page).toContain(`Page ${index + 1} of 3`));
    // The letterhead is on the first page only.
    expect(pages[0]).toContain('Acme Foods');
    expect(pages[1]).not.toContain('Acme Foods');
  });

  it('9. the PDF body equals rendered_document line for line, unwrapped', async () => {
    const text = ['INVOICE 90000003', '='.repeat(78), '', 'Net value'.padStart(58) + '      50.00', 'x'.repeat(78)].join('\n');
    const pdf = await renderPdfWithLetterhead(letterhead, { title: 'Invoice', documentNumber: '90000003', bodyText: text });
    const [page] = await pageTexts(pdf.bytes);
    const drawn = page.filter((line) => text.split('\n').includes(line));
    expect(drawn).toEqual(text.split('\n').filter((line) => line !== ''));
    expect(pdf.replacedCharacters).toBe(0);
  });

  it('10. Arabic text returns replacedCharacters > 0 and still produces a valid PDF', async () => {
    const pdf = await renderPdfWithLetterhead(letterhead, { title: 'Invoice', documentNumber: '90000004', bodyText: 'Customer: مرحبا بالعالم\nTotal 10' });
    expect(pdf.replacedCharacters).toBe(12);
    expect((await PDFDocument.load(pdf.bytes)).getPageCount()).toBe(1);
  });

  it('11. Latin-1 text returns replacedCharacters === 0', async () => {
    const pdf = await renderPdfWithLetterhead(letterhead, { title: 'Invoice', documentNumber: '90000005', bodyText: 'Café Müller — naïve façade £5 €5' });
    expect(pdf.replacedCharacters).toBe(0);
  });

  it('Download PDF refuses a message with no rendered document instead of rendering from masters', async () => {
    await expect(renderStoredPdf({
      client,
      load: async () => ({ renderedDocument: null, title: 'Invoice', documentNumber: '1', companyCode: COMPANY }),
    })).rejects.toBeInstanceOf(PdfDownloadError);
  });
});

describe('OUTPUT.DISPATCH', () => {
  it('12. dispatching an EMAIL message leaves it PENDING with no rendering and no mail row', async () => {
    await enableMail(true);
    const number = await document();
    const queued = await dispatchMessage({ client, changedBy: ACTOR, documentNumber: number, outputType: 'WE01', transmissionMedium: 'EMAIL' });
    expect(queued.status).toBe('PENDING');
    const [row] = await messageRows(number);
    expect(row).toMatchObject({ status: 'PENDING', rendered_document: null });
    expect(await mailRows(number)).toHaveLength(0);
  });

  it('13. one chunk renders the text, queues one mail with one PDF named for the document, and sets PROCESSED', async () => {
    await enableMail(true);
    const number = await document();
    await runOutputDispatch(client);
    const [row] = await messageRows(number);
    expect(row).toMatchObject({ status: 'PROCESSED', send_count: 1 });
    expect(row.rendered_document).toContain(number);
    const mails = await mailRows(number);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to_address: 'warehouse@example.test', attachment_mime: 'application/pdf' });
    expect(mails[0]!.attachment_name).toMatch(new RegExp(`${number}\\.pdf$`));
    expect(mails[0]!.size).toBeGreaterThan(500);
  });

  it('14. EMAIL with mail not configured is an ERROR naming the mail screen, and enqueues no mail', async () => {
    await enableMail(false);
    const number = await document();
    await runOutputDispatch(client);
    const [row] = await messageRows(number);
    expect(row.status).toBe('ERROR');
    expect(row.error_text).toContain('/platform/mail');
    expect(await mailRows(number)).toHaveLength(0);
  });

  it('15. a message with no recipient goes to ERROR with the recipient text', async () => {
    await enableMail(true);
    const number = await document({ recipient: null });
    await runOutputDispatch(client);
    const [row] = await messageRows(number);
    expect(row.status).toBe('ERROR');
    expect(row.error_text).toMatch(/needs a recipient/);
    expect(await mailRows(number)).toHaveLength(0);
  });

  it('16. a row that throws leaves the others in the chunk processed, with its own error_text', async () => {
    await enableMail(true);
    // The poisoned message names a document that does not exist, so rendering its slip throws.
    const ghost = `99${String(Date.now()).slice(-8)}`.slice(0, 20);
    await withTenant(client, (tx) => tx.execute(sql`
      insert into output_message (client, document_category, document_number, document_year, output_type,
                                  transmission_medium, dispatch_time, issue_number, status, created_by)
      values (${client}, 'MATERIAL_DOCUMENT', ${ghost}, 2026, 'WE01', 'PRINT', 'PERIODIC', 1, 'PENDING', ${ACTOR})
    `));
    const good = await document({ medium: 'PRINT' });
    await runOutputDispatch(client);
    const [bad] = await messageRows(ghost);
    expect(bad.status).toBe('ERROR');
    expect(bad.error_text).toMatch(/could not be processed/);
    expect((await messageRows(good))[0]!.status).toBe('PROCESSED');
  });

  it('17. two runs reaching one PENDING row: one processes it, and there is exactly one mail row', async () => {
    await enableMail(true);
    const number = await document();
    await Promise.all([runOutputDispatch(client), runOutputDispatch(client)]);
    const [row] = await messageRows(number);
    expect(row).toMatchObject({ status: 'PROCESSED', send_count: 1 });
    expect(await mailRows(number)).toHaveLength(1);
  });

  it('18. a PRINT message reaches PROCESSED with its text rendered and no PDF produced', async () => {
    await enableMail(true);
    const number = await document({ medium: 'PRINT', recipient: null });
    await runOutputDispatch(client);
    const [row] = await messageRows(number);
    expect(row).toMatchObject({ status: 'PROCESSED', send_count: 1 });
    expect(row.rendered_document).toContain(number);
    expect(await mailRows(number)).toHaveLength(0);
  });
});

describe('tenancy and grants', () => {
  it('19. a layout in one client is invisible to another', async () => {
    await saveDocumentLayout(layoutInput({ headerText: 'Only mine' }), CAP);
    const rows = (await withTenant(other, (tx) => tx.execute(sql`select company_code from document_layout`))) as unknown as unknown[];
    expect(rows).toHaveLength(0);
    const own = (await withTenant(client, (tx) => tx.execute(sql`select header_text from document_layout`))) as unknown as Array<{ header_text: string }>;
    expect(own.some((row) => row.header_text === 'Only mine')).toBe(true);
  });

  it('20. document_layout has SELECT, INSERT, UPDATE for cairn_app and no DELETE', async () => {
    const rows = (await withTenant(client, (tx) => tx.execute(sql`
      select privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'document_layout' and grantee = 'cairn_app'
       order by privilege_type
    `))) as unknown as Array<{ privilege_type: string }>;
    expect(rows.map((row) => row.privilege_type)).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });
});
