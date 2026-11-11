/**
 * CREDIT.BLOCKED and CREDIT.RELEASED — a pair that deliberately does not go
 * to the same people.
 *
 * A credit block is work for whoever may clear it, and that is a capability
 * within a place, not a person: whoever holds FIN.CREDIT.RELEASE over the
 * document's credit control area. So the block fans out, exactly as a document
 * waiting for release does, and for the same reason — resolving it means
 * loading every candidate's authority, which is the worker's job and not the
 * request path's.
 *
 * The release is the other half. Once the block is off, the document can go
 * out, and the person waiting for that is the one who raised it. That one has
 * a name, so it is not fanned out: it is addressed to the author, found in the
 * change trail the way DOC.RELEASED is.
 *
 * The property that matters most is the episode boundary. A determination is
 * raised again on every change to the document and on every manual recheck,
 * and a document that was blocked and still is has told nobody anything they
 * do not already hold unread. Only a transition is news.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { withTenant } from '../src/platform/db/client';
import {
  checkSalesDocumentCredit, reblockDocument, recheckDocument, releaseDocument,
  saveCustomerCredit,
} from '../src/modules/finance/credit';
import { listInbox, markSeen } from '../src/platform/notification/notify';
import { registerJob } from '../src/platform/job/registry';
import { ensureDefinition } from '../src/platform/job/queue';
import { runClaimed } from '../src/platform/job/execute';
import { fanoutJob, FANOUT_JOB } from '../src/platform/notification/jobs/fanout';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'CREDIT-NOTIFY-TEST';
const WORKER = 'test-worker';
const AREA = '1000';
const OTHER_AREA = '2000';
const CAPABILITY = 'FIN.CREDIT.RELEASE';
const DOCUMENT = 'SO-1';

let client = '';
let company = '';
let controller = ''; // holds the release capability over area 1000
let elsewhere = ''; // holds the same capability over area 2000
let author = ''; // raised the sales document, named in its change trail
let authorUsername = ''; // what the change trail records — not the same string as `author`

async function runsFor(salesDocument: string): Promise<{ id: string; key: string; triggeredBy: string }[]> {
  return (await withTenant(client, async (tx) =>
    tx.execute(sql`
      select id, idempotency_key as key, triggered_by as "triggeredBy"
        from job_run
       where client = ${client}
         and job_code = ${FANOUT_JOB}
         and parameters->>'objectKey' = ${salesDocument}
       order by queued_at, id
    `),
  )) as unknown as { id: string; key: string; triggeredBy: string }[];
}

/** Run every fan-out queued for one document, the way the worker would. */
async function drain(salesDocument: string): Promise<string[]> {
  const outcomes: string[] = [];
  for (const run of await runsFor(salesDocument)) {
    outcomes.push(await runClaimed(WORKER, { runId: run.id, client, jobCode: FANOUT_JOB }));
  }
  return outcomes;
}

function inboxOf(userId: string, kind: string, objectKey: string) {
  return listInbox(client, userId).then((rows) =>
    rows.filter((r) => r.kind === kind && r.objectKey === objectKey));
}

const checkDoc = (salesDocument: string, orderValue: string) => checkSalesDocumentCredit({
  client, changedBy: ACTOR, salesDocument, documentDate: '2026-04-12',
  customer: 'C100', creditControlArea: AREA, orderValue, orderCurrency: 'USD',
});

beforeAll(async () => {
  const fx = await createTenant('creditnotification');
  client = fx.client;
  company = fx.companyCode;
  await defineTestRanges(fx, { fiscalYear: 2026 });

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into credit_control_area (client, credit_control_area, name, currency, warning_threshold_percent, created_by)
      values
        (${client}, ${AREA}, 'Main credit area', 'USD', 90, ${ACTOR}),
        (${client}, ${OTHER_AREA}, 'Other credit area', 'USD', 90, ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`update company_code set credit_control_area = ${AREA} where client = ${client} and company_code = ${company}`);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, name) values (${client}, 'C100', 'Credit customer')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into credit_risk_category (client, risk_category, name, created_by)
      values (${client}, 'A', 'Low risk', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into credit_block_reason (client, reason_code, name, created_by)
      values (${client}, '01', 'Manual credit hold', ${ACTOR}) on conflict do nothing
    `);
    // Four thousand of open receivables, so a two-thousand order breaks a
    // five-thousand limit without anyone having to edit the master afterwards.
    await tx.execute(sql`
      insert into journal_entry
        (client, document_number, fiscal_year, document_type, company_code, document_date,
         posting_date, posting_period, document_currency, local_currency, status, created_by)
      values (${client}, 'CN-SEED-1', 2026, 'SA', ${company}, '2026-04-10', '2026-04-10', 4, 'USD', 'USD', 'POSTED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into journal_entry_line
        (client, document_number, fiscal_year, line_number, gl_account, company_code,
         debit_credit, amount_local, amount_document, currency, business_partner)
      values
        (${client}, 'CN-SEED-1', 2026, 1, '101000', ${company}, 'S', 4000, 4000, 'USD', 'C100'),
        (${client}, 'CN-SEED-1', 2026, 2, '300000', ${company}, 'H', 4000, 4000, 'USD', null)
    `);
  });
  await saveCustomerCredit({
    client, changedBy: ACTOR, customer: 'C100', creditControlArea: AREA,
    creditLimit: '5000', riskCategory: 'A', isBlocked: false, changeReason: 'Initial assessment',
  });

  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  controller = `u-ctl-${suffix}`;
  elsewhere = `u-else-${suffix}`;
  author = `u-author-${suffix}`;
  authorUsername = `author${suffix}`;

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into app_user (id, client, username, full_name, password_hash, is_active)
      values
        (${controller}, ${client}, ${'ctl' + suffix}, 'Credit controller', 'scrypt:x:x', true),
        (${elsewhere}, ${client}, ${'else' + suffix}, 'Controller elsewhere', 'scrypt:x:x', true),
        (${author}, ${client}, ${authorUsername}, 'Sales clerk', 'scrypt:x:x', true)
      on conflict (id) do nothing
    `);
    await tx.execute(sql`
      insert into user_capability (id, client, user_id, capability_code, valid_from, reason, granter)
      values
        (${'grant-ctl-' + suffix}, ${client}, ${controller}, ${CAPABILITY}, current_date, 'DIRECT', 'TEST'),
        (${'grant-else-' + suffix}, ${client}, ${elsewhere}, ${CAPABILITY}, current_date, 'DIRECT', 'TEST')
      on conflict (id) do nothing
    `);
    await tx.execute(sql`
      insert into user_capability_scope (client, grant_id, scope_type, scope_value)
      values
        (${client}, ${'grant-ctl-' + suffix}, 'CREDIT_CONTROL_AREA', ${AREA}),
        (${client}, ${'grant-else-' + suffix}, 'CREDIT_CONTROL_AREA', ${OTHER_AREA})
      on conflict do nothing
    `);
    // The change trail is where the author of a document is found. The
    // username is deliberately not the user id: the two live in different id
    // spaces, and a notification addressed to the wrong one is stored,
    // counted as delivered, and read by nobody.
    await tx.execute(sql`
      insert into change_document (id, client, object_class, object_key, change_type, changed_by)
      values (${'cd-' + suffix}, ${client}, 'sales_order', ${DOCUMENT}, 'CREATE', ${authorUsername})
      on conflict (id) do nothing
    `);
  });

  await withTenant(client, async (tx) => {
    await ensureDefinition(tx, {
      code: FANOUT_JOB, name: 'Resolve who to notify', module: 'PEOPLE',
      chunkSize: 100, maxRetries: 2, timeoutSeconds: 300, isScheduled: false,
    });
  });

  registerJob(fanoutJob);
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

describe('CREDIT.BLOCKED and CREDIT.RELEASED', () => {
  it('tells whoever may clear the block, and not a controller of another area', async () => {
    const blocked = await checkDoc(DOCUMENT, '2000');
    expect(blocked.status).toBe('BLOCKED');

    const runs = await runsFor(DOCUMENT);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.triggeredBy).toBe('CREDIT');

    expect(await drain(DOCUMENT)).toEqual(['SUCCEEDED']);

    const told = await inboxOf(controller, 'CREDIT.BLOCKED', DOCUMENT);
    expect(told).toHaveLength(1);
    expect(told[0]!.objectClass).toBe('sales_order');
    expect(told[0]!.isUnseen).toBe(true);
    expect(told[0]!.title).toContain(DOCUMENT);

    // Same capability, another credit control area. Telling them would put
    // work in their inbox that the credit release screen then refuses.
    expect(await inboxOf(elsewhere, 'CREDIT.BLOCKED', DOCUMENT)).toHaveLength(0);
  });

  it('says nothing again while the document stays blocked', async () => {
    // A recheck raises a whole new determination, and the document is still
    // blocked. That is not an episode; the controllers already hold the
    // message, unread.
    const rechecked = await recheckDocument({ client, changedBy: ACTOR, salesDocument: DOCUMENT });
    expect(rechecked.status).toBe('BLOCKED');

    expect(await runsFor(DOCUMENT)).toHaveLength(1);
  });

  it('tells the author, and only the author, when the block is released', async () => {
    const released = await releaseDocument({
      client, changedBy: ACTOR, salesDocument: DOCUMENT, canOverride: true,
      override: { justification: 'Payment confirmed outside the ledger', approvalRef: 'APR-1' },
    });
    expect(released.ok).toBe(true);
    expect(released.status).toBe('RELEASED');

    const told = await inboxOf(author, 'CREDIT.RELEASED', DOCUMENT);
    expect(told).toHaveLength(1);
    expect(told[0]!.objectClass).toBe('sales_order');
    expect(told[0]!.title).toContain(DOCUMENT);

    // The release is not work for the credit controllers; their queue simply
    // gets shorter, which is a query and not a message.
    expect(await inboxOf(controller, 'CREDIT.RELEASED', DOCUMENT)).toHaveLength(0);
  });

  it('treats a reblock as a new episode once the last block has been read', async () => {
    // The first block is still unread, so mark it off: the deduplication is on
    // unseen rows, which is the whole mechanism and not an artefact of this
    // fixture.
    const [previous] = await inboxOf(controller, 'CREDIT.BLOCKED', DOCUMENT);
    expect(previous).toBeTruthy();
    expect(await markSeen(client, controller, previous!.notificationId)).toBe(true);

    const reblocked = await reblockDocument({
      client, changedBy: ACTOR, salesDocument: DOCUMENT,
      reason: 'New information on payment behaviour',
    });
    expect(reblocked.ok).toBe(true);
    expect(reblocked.status).toBe('BLOCKED');

    const runs = await runsFor(DOCUMENT);
    expect(runs).toHaveLength(2);

    expect(await drain(DOCUMENT)).toEqual(['SUCCEEDED', 'SUCCEEDED']);

    // The old row is seen and the new one is not: the inbox keeps both,
    // because "seen" is not "deleted". What proves the episode happened is
    // that there is an unread block message again.
    const now = await inboxOf(controller, 'CREDIT.BLOCKED', DOCUMENT);
    expect(now).toHaveLength(2);
    expect(now.filter((r) => r.isUnseen)).toHaveLength(1);
  });
});
