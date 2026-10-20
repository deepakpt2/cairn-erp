import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  MATERIAL_DOC_OUTPUT_CAPABILITY,
  MaterialDocumentOutputError,
  determineOutputs,
  dispatchMessage,
  dispatchPending,
  listOutputMessages,
  recordOutputsForPostedDocument,
  renderSlip,
  setRecipient,
} from '../src/modules/inventory/material-document-output';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-135 / MB90 — output determination and dispatch.
 *
 * A receipt document earns WE01 and the hook dispatches it there and then; an issue
 * document earns WA01; a transfer that both receipts and issues earns neither. A
 * run fills what stands missing and stays idempotent. An EMAIL with no recipient
 * fails for real, records why, and succeeds once a recipient is set. A processed
 * message refuses a second dispatch.
 */
const ACTOR = 'SCR135_MB90_TEST';

describe('SCR-135 material document output (MB90)', () => {
  let client = '';

  const receiptDoc = '4900001000';
  const issueDoc = '4900001001';
  const transferDoc = '4900001002';
  const historyDoc = '4900001003';
  const emailDoc = '4900001004';

  beforeAll(async () => {
    const tenant = await createTenant('scr135-mb90');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into plant (client, plant, name, country, created_by)
        values (${client}, '1000', 'Output plant', 'KW', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'OUT-MAT', 'Printed material', t.material_type, 'PC', ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
          (${client}, 'RECEIPT_OTHER', 'Goods receipt without reference', 'RECEIPT', 'MATERIAL_DOCUMENT', ${ACTOR}),
          (${client}, 'ISSUE_OTHER', 'Goods issue without reference', 'ISSUE', 'MATERIAL_DOCUMENT', ${ACTOR})
        on conflict do nothing
      `);
      for (const [number, year] of [
        [receiptDoc, 2026], [issueDoc, 2026], [transferDoc, 2026], [historyDoc, 2026], [emailDoc, 2026],
      ] as const) {
        await tx.execute(sql`
          insert into material_document (client, material_document_number, document_year, document_date, posting_date,
                                         header_text, status, created_by)
          values (${client}, ${number}, ${year}, '2026-05-01', '2026-05-01', 'Output test', 'POSTED', ${ACTOR})
          on conflict do nothing
        `);
      }
      await tx.execute(sql`
        insert into material_document_line (client, material_document_number, line_number, movement_type, material_number,
                                            plant, storage_location, stock_type, line_direction, entry_quantity, entry_unit,
                                            base_quantity, base_unit, value, currency, created_by) values
          (${client}, ${receiptDoc}, 1, 'RECEIPT_OTHER', 'OUT-MAT', '1000', '0001', 'UNRESTRICTED', 'RECEIPT', 10, 'PC', 10, 'PC', 100, 'KWD', ${ACTOR}),
          (${client}, ${issueDoc}, 1, 'ISSUE_OTHER', 'OUT-MAT', '1000', '0001', 'UNRESTRICTED', 'ISSUE', 4, 'PC', 4, 'PC', 0, 'KWD', ${ACTOR}),
          (${client}, ${transferDoc}, 1, 'ISSUE_OTHER', 'OUT-MAT', '1000', '0001', 'UNRESTRICTED', 'ISSUE', 2, 'PC', 2, 'PC', 0, 'KWD', ${ACTOR}),
          (${client}, ${transferDoc}, 2, 'RECEIPT_OTHER', 'OUT-MAT', '1000', '0002', 'UNRESTRICTED', 'RECEIPT', 2, 'PC', 2, 'PC', 0, 'KWD', ${ACTOR}),
          (${client}, ${historyDoc}, 1, 'RECEIPT_OTHER', 'OUT-MAT', '1000', '0001', 'UNRESTRICTED', 'RECEIPT', 5, 'PC', 5, 'PC', 50, 'KWD', ${ACTOR}),
          (${client}, ${emailDoc}, 1, 'RECEIPT_OTHER', 'OUT-MAT', '1000', '0001', 'UNRESTRICTED', 'RECEIPT', 1, 'PC', 1, 'PC', 10, 'KWD', ${ACTOR})
        on conflict do nothing
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  it('determines and dispatches a receipt document’s slip as it posts', async () => {
    await withTenant(client, async (tx) => {
      const created = await recordOutputsForPostedDocument(tx, client, receiptDoc, ACTOR);
      expect(created).toBe(1);
    });
    const list = await listOutputMessages({ client, selection: { documentFrom: receiptDoc, documentTo: receiptDoc } });
    expect(list.rows).toHaveLength(1);
    const row = list.rows[0];
    expect(row.outputType).toBe('WE01');
    expect(row.outputTypeDescription).toBe('Goods receipt slip');
    expect(row.status).toBe('PROCESSED');
    expect(row.statusCode).toBe('1');
    expect(row.sendCount).toBe(1);
    expect(row.lastProcessedAt).not.toBeNull();
    expect(row.plants).toEqual(['1000']);
    expect(row.companyCodes).toHaveLength(1);
  });

  it('gives an issue document the goods issue slip, pending because it is periodic', async () => {
    await withTenant(client, async (tx) => {
      await recordOutputsForPostedDocument(tx, client, issueDoc, ACTOR);
    });
    const list = await listOutputMessages({ client, selection: { documentFrom: issueDoc, documentTo: issueDoc } });
    expect(list.rows[0].outputType).toBe('WA01');
    expect(list.rows[0].status).toBe('PENDING');
    expect(list.rows[0].dispatchTime).toBe('PERIODIC');
    expect(list.rows[0].sendCount).toBe(0);
  });

  it('writes nothing for a transfer, which both receipts and issues', async () => {
    const result = await determineOutputs({ client, changedBy: ACTOR, selection: { documentFrom: transferDoc, documentTo: transferDoc } });
    expect(result.created).toBe(0);
    expect(result.transfers).toBe(1);
    const list = await listOutputMessages({ client, selection: { documentFrom: transferDoc, documentTo: transferDoc } });
    expect(list.rows).toHaveLength(0);
  });

  it('fills what stands missing for a document posted before the capability, and stays idempotent', async () => {
    const first = await determineOutputs({ client, changedBy: ACTOR, selection: { documentFrom: historyDoc, documentTo: historyDoc } });
    expect(first.created).toBe(1);
    const second = await determineOutputs({ client, changedBy: ACTOR, selection: { documentFrom: historyDoc, documentTo: historyDoc } });
    expect(second.created).toBe(0);
    const list = await listOutputMessages({ client, selection: { documentFrom: historyDoc, documentTo: historyDoc } });
    expect(list.rows).toHaveLength(1);
  });

  it('counts the queue by status and narrows it by output type', async () => {
    const all = await listOutputMessages({ client });
    expect(all.capability).toBe(MATERIAL_DOC_OUTPUT_CAPABILITY);
    expect(all.processed).toBeGreaterThanOrEqual(1);
    expect(all.pending).toBeGreaterThanOrEqual(2);

    const issues = await listOutputMessages({ client, selection: { outputType: 'WA01' } });
    expect(issues.rows.every((r) => r.outputType === 'WA01')).toBe(true);
  });

  it('renders the slip from the document as posted', async () => {
    const slip = await renderSlip({ client, documentNumber: receiptDoc });
    expect(slip).toContain(`MATERIAL DOCUMENT ${receiptDoc} / 2026`);
    expect(slip).toContain('OUT-MAT');
    expect(slip).toContain('Printed material');
    expect(slip).toContain('10.000 PC');
    expect(slip).toContain('Items 1');
  });

  it('fails an EMAIL output with no recipient, records why, and succeeds once a recipient stands', async () => {
    // An EMAIL message is created by setting the medium on the condition; here the
    // queue row is written directly, which is what a condition change produces.
    await withTenant(client, async (tx) => {
      await recordOutputsForPostedDocument(tx, client, emailDoc, ACTOR);
      await tx.execute(sql`
        insert into output_message (client, material_document_number, document_year, output_type,
                                    transmission_medium, dispatch_time, status, created_by)
        values (${client}, ${emailDoc}, 2026, 'WE01', 'EMAIL', 'PERIODIC', 'PENDING', ${ACTOR})
        on conflict do nothing
      `);
    });

    const failed = await dispatchMessage({
      client, changedBy: ACTOR, documentNumber: emailDoc, outputType: 'WE01', transmissionMedium: 'EMAIL',
    });
    expect(failed.status).toBe('ERROR');
    expect(failed.errorText).toMatch(/needs a recipient/);
    expect(failed.slip).toBeNull();

    await setRecipient({
      client, changedBy: ACTOR, documentNumber: emailDoc, outputType: 'WE01',
      transmissionMedium: 'EMAIL', recipient: 'warehouse@example.test',
    });
    const done = await dispatchMessage({
      client, changedBy: ACTOR, documentNumber: emailDoc, outputType: 'WE01', transmissionMedium: 'EMAIL',
    });
    expect(done.status).toBe('PROCESSED');
    expect(done.sendCount).toBe(1);
    expect(done.errorText).toBeNull();
    expect(done.slip).toContain(emailDoc);
  });

  it('refuses a second dispatch of a processed message', async () => {
    const error = await dispatchMessage({
      client, changedBy: ACTOR, documentNumber: receiptDoc, outputType: 'WE01', transmissionMedium: 'PRINT',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MaterialDocumentOutputError);
    expect((error as Error).message).toMatch(/is already processed/);
    expect((error as MaterialDocumentOutputError).remedy).toMatch(/deferred by name/);
  });

  it('dispatches the pending periodic queue in one run', async () => {
    const run = await dispatchPending({ client, changedBy: ACTOR, selection: { outputType: 'WA01' } });
    expect(run.dispatched).toBe(1);
    expect(run.failed).toBe(0);
    const list = await listOutputMessages({ client, selection: { outputType: 'WA01' } });
    expect(list.rows[0].status).toBe('PROCESSED');
    expect(list.rows[0].sendCount).toBe(1);
  });

  it('refuses FAX and EDI by name, and names the media that exist', async () => {
    for (const refused of ['FAX', 'EDI']) {
      const error = await listOutputMessages({ client, selection: { transmissionMedium: refused } })
        .catch((e: unknown) => e);
      expect((error as MaterialDocumentOutputError).message).toMatch(/is not a transmission medium/);
      expect((error as MaterialDocumentOutputError).remedy).toMatch(/refused by name/);
      expect((error as MaterialDocumentOutputError).remedy).toMatch(/PRINT \(1\) and EMAIL \(5\)/);
    }
    await expect(listOutputMessages({ client, selection: { status: 'SENT' } }))
      .rejects.toThrow(/is not a processing status/);
  });

  it('refuses a message that does not stand, and another tenant’s queue is invisible', async () => {
    await expect(dispatchMessage({
      client, changedBy: ACTOR, documentNumber: receiptDoc, outputType: 'WA01', transmissionMedium: 'PRINT',
    })).rejects.toThrow(/No WA01 output stands/);

    const other = await createTenant('scr135-other');
    try {
      const list = await listOutputMessages({ client: other.client });
      expect(list.rows).toHaveLength(0);
      expect(list.pending).toBe(0);
    } finally {
      await destroyTenant(other.client);
    }
  });
});
