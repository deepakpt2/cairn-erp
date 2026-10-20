import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  MATERIAL_DOC_DISPLAY_CAPABILITY,
  MaterialDocumentDisplayError,
  displayMaterialDocument,
} from '../src/modules/inventory/material-document-display';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-134 / INV.DISPLAY (MB03) — the display reads one document exactly as the
 * ledger recorded it: header with its poster and entry time, lines with their
 * movement, material description, quantities and references, and the company code
 * derived from the plants. It writes nothing and refuses to invent a company code
 * the document does not imply.
 */
const ACTOR = 'SCR134_MB03_TEST';
const DOC = '4900000001';

describe('SCR-134 material document display (MB03)', () => {
  let client = '';

  beforeAll(async () => {
    const tenant = await createTenant('scr134-mb03');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into company_code (client, company_code, name, country, currency, chart_of_accounts, created_by)
        select ${client}, '2000', 'Second company', 'KW', ${tenant.currency}, c.chart_of_accounts, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by) values
          (${client}, '1000', 'Main plant', '1000', 'KW', ${ACTOR}),
          (${client}, '2000', 'Second plant', '2000', 'KW', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, v.n, v.d, t.material_type, 'PC', ${ACTOR}
        from (values ('MAT-A', 'First material'), ('MAT-B', 'Second material')) as v(n, d)
        cross join (select material_type from material_type where client = ${client} order by material_type limit 1) t
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
          (${client}, 'RECEIPT_OTHER', 'Goods receipt without reference', 'RECEIPT', 'MATERIAL_DOCUMENT', ${ACTOR}),
          (${client}, 'ISSUE_OTHER', 'Goods issue without reference', 'ISSUE', 'MATERIAL_DOCUMENT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date,
                                       posting_date, header_text, status, journal_document_number,
                                       reversed_by, created_by, created_at) values
          (${client}, ${DOC}, 2026, '2026-04-01', '2026-04-01', 'GR for PO 4500000001', 'POSTED',
           '5100000001', null, 'JSMITH', '2026-04-01 09:15:00+00')
        on conflict do nothing
      `);
      // A second document that has since been reversed, to prove the display still shows it.
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date,
                                       posting_date, header_text, status, reversed_by, created_by) values
          (${client}, '4900000002', 2025, '2025-12-31', '2025-12-31', 'Closed-year receipt', 'REVERSED',
           '4900000003', 'JSMITH')
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (client, material_document_number, line_number, movement_type,
                                            material_number, plant, storage_location, stock_type, line_direction,
                                            entry_quantity, entry_unit, base_quantity, base_unit,
                                            value, currency, purchase_order_number, purchase_order_item, created_by) values
          (${client}, ${DOC}, 1, 'RECEIPT_OTHER', 'MAT-A', '1000', '0001', 'UNRESTRICTED', 'RECEIPT',
           10, 'PC', 10, 'PC', 100.000, 'KWD', '4500000001', 10, ${ACTOR}),
          (${client}, ${DOC}, 2, 'ISSUE_OTHER', 'MAT-B', '2000', '0002', 'UNRESTRICTED', 'ISSUE',
           4, 'PC', 4, 'PC', 0, 'KWD', null, null, ${ACTOR}),
          (${client}, '4900000002', 1, 'RECEIPT_OTHER', 'MAT-A', '1000', '0001', 'UNRESTRICTED', 'RECEIPT',
           7, 'PC', 7, 'PC', 70.000, 'KWD', null, null, ${ACTOR})
        on conflict do nothing
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  it('reads the header with its poster and entry time, and every line', async () => {
    const document = await displayMaterialDocument({ client, documentNumber: DOC });
    expect(document.capability).toBe(MATERIAL_DOC_DISPLAY_CAPABILITY);
    expect(document.materialDocumentNumber).toBe(DOC);
    expect(document.documentYear).toBe(2026);
    expect(document.postingDate).toBe('2026-04-01');
    expect(document.documentDate).toBe('2026-04-01');
    expect(document.headerText).toBe('GR for PO 4500000001');
    expect(document.postedBy).toBe('JSMITH');
    expect(document.enteredAt).toContain('2026-04-01T09:15:00');
    expect(document.journalDocumentNumber).toBe('5100000001');
    expect(document.lines).toHaveLength(2);
    expect(document.lines[0].lineNumber).toBe(1);
    expect(document.lines[1].lineNumber).toBe(2);
    expect(document.lineCount).toBe(2);
  });

  it('resolves the material and the movement description onto each line', async () => {
    const document = await displayMaterialDocument({ client, documentNumber: DOC });
    expect(document.lines[0].materialDescription).toBe('First material');
    expect(document.lines[0].movementDescription).toBe('Goods receipt without reference');
    expect(document.lines[0].quantity).toBe('10.000');
    expect(document.lines[0].unit).toBe('PC');
    expect(document.lines[0].value).toBe('100.0000');
    expect(document.lines[0].currency).toBe('KWD');
    expect(document.lines[0].purchaseOrderNumber).toBe('4500000001');
    expect(document.lines[0].purchaseOrderItem).toBe(10);
    expect(document.lines[1].lineDirection).toBe('ISSUE');
  });

  it('derives the company code from the plants and never asks for it', async () => {
    const document = await displayMaterialDocument({ client, documentNumber: DOC });
    expect(document.companyCodes).toEqual(['1000', '2000']);
  });

  it('refuses a document that does not stand, in the SAP shape', async () => {
    const error = await displayMaterialDocument({ client, documentNumber: '4999999999' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MaterialDocumentDisplayError);
    expect((error as Error).message).toBe('Material document 4999999999 does not exist.');
    expect((error as MaterialDocumentDisplayError).remedy).toMatch(/unique per tenant/);
  });

  it('cross-checks the fiscal year: the right year passes, a wrong year refuses by name', async () => {
    const document = await displayMaterialDocument({ client, documentNumber: DOC, fiscalYear: '2026' });
    expect(document.documentYear).toBe(2026);

    const error = await displayMaterialDocument({ client, documentNumber: DOC, fiscalYear: '2025' })
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      'Material document 4900000001 does not exist in fiscal year 2025.',
    );
    expect((error as MaterialDocumentDisplayError).remedy).toContain('stands in fiscal year 2026');
  });

  it('refuses a malformed year and an empty number', async () => {
    await expect(displayMaterialDocument({ client, documentNumber: DOC, fiscalYear: '26' }))
      .rejects.toThrow(/Fiscal year 26 is not a four-digit year/);
    await expect(displayMaterialDocument({ client, documentNumber: '  ' }))
      .rejects.toThrow(/A material document number is required/);
  });

  it('narrows to one item when one is named, and refuses an item the document does not carry', async () => {
    const document = await displayMaterialDocument({ client, documentNumber: DOC, itemNumber: '2' });
    expect(document.selectedItem).toBe(2);
    expect(document.lines).toHaveLength(1);
    expect(document.lines[0].materialNumber).toBe('MAT-B');

    const error = await displayMaterialDocument({ client, documentNumber: DOC, itemNumber: '7' })
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe('Material document 4900000001 carries no item 7.');
    expect((error as MaterialDocumentDisplayError).remedy).toContain('Its items are 1, 2');

    await expect(displayMaterialDocument({ client, documentNumber: DOC, itemNumber: 'x' }))
      .rejects.toThrow(/is not an item number/);
  });

  it('shows a reversed document exactly as posted — a display applies no period check', async () => {
    const document = await displayMaterialDocument({ client, documentNumber: '4900000002' });
    expect(document.status).toBe('REVERSED');
    expect(document.reversedBy).toBe('4900000003');
    expect(document.documentYear).toBe(2025);
    expect(document.lines).toHaveLength(1);
  });

  it('offers the list on the same posting date as a drill', async () => {
    const document = await displayMaterialDocument({ client, documentNumber: DOC });
    expect(document.listDrillDown).toBe(
      '/inventory/material-document-list?postingDateFrom=2026-04-01&postingDateTo=2026-04-01',
    );
  });

  it('never reaches another tenant’s document', async () => {
    const other = await createTenant('scr134-other');
    try {
      const error = await displayMaterialDocument({ client: other.client, documentNumber: DOC })
        .catch((e: unknown) => e);
      expect((error as Error).message).toBe('Material document 4900000001 does not exist.');
    } finally {
      await destroyTenant(other.client);
    }
  });
});
