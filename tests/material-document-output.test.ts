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
import { listInbox } from '../src/platform/notification/notify';
import { registerJob } from '../src/platform/job/registry';
import { ensureDefinition } from '../src/platform/job/queue';
import { runClaimed } from '../src/platform/job/execute';
import { fanoutJob, FANOUT_JOB } from '../src/platform/notification/jobs/fanout';

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
const WORKER = 'test-worker';

// The fan-out is a real job, so it has to be registered for `runClaimed` to find it.
registerJob(fanoutJob);

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
        insert into output_message (client, document_category, document_number, document_year, output_type,
                                    transmission_medium, dispatch_time, issue_number, status, created_by)
        values (${client}, 'MATERIAL_DOCUMENT', ${emailDoc}, 2026, 'WE01', 'EMAIL', 'PERIODIC', 1,
                'PENDING', ${ACTOR})
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

  /** Every fan-out run queued for one document, in the order it was queued. */
  async function fanoutRuns(documentNumber: string) {
    return (await withTenant(client, (tx) => tx.execute(sql`
      select id, triggered_by as "triggeredBy"
        from job_run
       where client = ${client}
         and job_code = ${FANOUT_JOB}
         and parameters->>'objectKey' = ${documentNumber}
       order by queued_at, id
    `))) as unknown as { id: string; triggeredBy: string }[];
  }

  /** Run them, the way the worker would, and report how each ended. */
  async function drainFanout(documentNumber: string): Promise<string[]> {
    const outcomes: string[] = [];
    for (const run of await fanoutRuns(documentNumber)) {
      outcomes.push(await runClaimed(WORKER, { runId: run.id, client, jobCode: FANOUT_JOB }));
    }
    return outcomes;
  }

  function inboxOf(userId: string, kind: string, objectKey: string) {
    return listInbox(client, userId).then((rows) =>
      rows.filter((row) => row.kind === kind && row.objectKey === objectKey));
  }

  const notifyDoc = '4900001005';

  it('tells the plants that can put a failed slip right, one fan-out per plant', async () => {
    // A document whose lines stand in two plants. A holder scoped to one of
    // them is not responsible for the other, so the failure is queued once per
    // place somebody has to answer it in rather than once and then shouted to
    // everybody who holds the capability anywhere.
    const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
    const inFirst = `u-md-${suffix}-1`;
    const inSecond = `u-md-${suffix}-2`;
    const inThird = `u-md-${suffix}-3`;
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date,
                                       posting_date, header_text, status, created_by)
        values (${client}, ${notifyDoc}, 2026, '2026-05-01', '2026-05-01', 'Two plants', 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (client, material_document_number, line_number, movement_type, material_number,
                                            plant, storage_location, stock_type, line_direction, entry_quantity, entry_unit,
                                            base_quantity, base_unit, value, currency, created_by) values
          (${client}, ${notifyDoc}, 1, 'RECEIPT_OTHER', 'OUT-MAT', '1000', '0001', 'UNRESTRICTED', 'RECEIPT', 2, 'PC', 2, 'PC', 20, 'KWD', ${ACTOR}),
          (${client}, ${notifyDoc}, 2, 'RECEIPT_OTHER', 'OUT-MAT', '2000', '0001', 'UNRESTRICTED', 'RECEIPT', 3, 'PC', 3, 'PC', 30, 'KWD', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into output_message (client, document_category, document_number, document_year, output_type,
                                    transmission_medium, dispatch_time, issue_number, status, created_by)
        values (${client}, 'MATERIAL_DOCUMENT', ${notifyDoc}, 2026, 'WE01', 'EMAIL', 'PERIODIC', 1,
                'PENDING', ${ACTOR})
        on conflict do nothing
      `);
      // Three holders of the same capability. Two of them over a plant this
      // document stands in; the third over one it does not.
      await tx.execute(sql`
        insert into app_user (id, client, username, full_name, password_hash, is_active)
        values
          (${inFirst}, ${client}, ${'md1' + suffix}, 'Clerk in plant 1000', 'scrypt:x:x', true),
          (${inSecond}, ${client}, ${'md2' + suffix}, 'Clerk in plant 2000', 'scrypt:x:x', true),
          (${inThird}, ${client}, ${'md3' + suffix}, 'Clerk in plant 3000', 'scrypt:x:x', true)
        on conflict (id) do nothing
      `);
      await tx.execute(sql`
        insert into user_capability (id, client, user_id, capability_code, valid_from, reason, granter)
        values
          (${'mdg1-' + suffix}, ${client}, ${inFirst}, ${MATERIAL_DOC_OUTPUT_CAPABILITY}, current_date, 'DIRECT', 'TEST'),
          (${'mdg2-' + suffix}, ${client}, ${inSecond}, ${MATERIAL_DOC_OUTPUT_CAPABILITY}, current_date, 'DIRECT', 'TEST'),
          (${'mdg3-' + suffix}, ${client}, ${inThird}, ${MATERIAL_DOC_OUTPUT_CAPABILITY}, current_date, 'DIRECT', 'TEST')
        on conflict (id) do nothing
      `);
      await tx.execute(sql`
        insert into user_capability_scope (client, grant_id, scope_type, scope_value)
        values
          (${client}, ${'mdg1-' + suffix}, 'PLANT', '1000'),
          (${client}, ${'mdg2-' + suffix}, 'PLANT', '2000'),
          (${client}, ${'mdg3-' + suffix}, 'PLANT', '3000')
        on conflict do nothing
      `);
      await ensureDefinition(tx, {
        code: FANOUT_JOB, name: 'Resolve who to notify', module: 'PEOPLE',
        chunkSize: 100, maxRetries: 2, timeoutSeconds: 300, isScheduled: false,
      });
    });

    const failed = await dispatchMessage({
      client, changedBy: ACTOR, documentNumber: notifyDoc, outputType: 'WE01', transmissionMedium: 'EMAIL',
    });
    expect(failed.status).toBe('ERROR');

    // One run per plant, and both attributed to the output rather than to the
    // person who happened to press dispatch.
    const runs = await fanoutRuns(notifyDoc);
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.triggeredBy)).toEqual(['OUTPUT', 'OUTPUT']);

    expect(await drainFanout(notifyDoc)).toEqual(['SUCCEEDED', 'SUCCEEDED']);

    for (const [clerk, expected] of [[inFirst, 1], [inSecond, 1], [inThird, 0]] as const) {
      const told = await inboxOf(clerk, 'OUTPUT.FAILED', notifyDoc);
      expect(told).toHaveLength(expected);
      if (expected === 1) {
        expect(told[0]!.objectClass).toBe('material_document_output');
        expect(told[0]!.isUnseen).toBe(true);
        expect(told[0]!.title).toContain(notifyDoc);
      }
    }

    // Dispatching it again fails the same way, and that is the same episode:
    // both clerks already hold the message, unread.
    const again = await dispatchMessage({
      client, changedBy: ACTOR, documentNumber: notifyDoc, outputType: 'WE01', transmissionMedium: 'EMAIL',
    });
    expect(again.status).toBe('ERROR');
    expect(await fanoutRuns(notifyDoc)).toHaveLength(2);
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
