import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  checkSalesDocumentCredit, listCreditDeterminations, listReleaseEvents,
  reblockDocument, recheckDocument, rejectReleaseRequest, releaseDocument,
  releaseDocumentsBulk, saveCustomerCredit,
} from '../src/modules/finance/credit';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'RELEASE-TEST';
const AREA = '1000';
let client = '';
let company = '';

const checkDoc = (salesDocument: string, orderValue: string) => checkSalesDocumentCredit({
  client, changedBy: ACTOR, salesDocument, documentDate: '2026-04-12',
  customer: 'C100', creditControlArea: AREA, orderValue, orderCurrency: 'USD',
});

beforeAll(async () => {
  const fx = await createTenant('creditrelease');
  client = fx.client;
  company = fx.companyCode;
  await defineTestRanges(fx, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into credit_control_area (client, credit_control_area, name, currency, warning_threshold_percent, created_by)
      values (${client}, ${AREA}, 'Main credit area', 'USD', 90, ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`update company_code set credit_control_area = ${AREA} where client = ${client} and company_code = ${company}`);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, name) values (${client}, 'C100', 'Release Customer')
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
    await tx.execute(sql`
      insert into journal_entry
        (client, document_number, fiscal_year, document_type, company_code, document_date,
         posting_date, posting_period, document_currency, local_currency, status, created_by)
      values (${client}, 'REL-SEED-1', 2026, 'SA', ${company}, '2026-04-10', '2026-04-10', 4, 'USD', 'USD', 'POSTED', ${ACTOR})
    `);
    await tx.execute(sql`
      insert into journal_entry_line
        (client, document_number, fiscal_year, line_number, gl_account, company_code,
         debit_credit, amount_local, amount_document, currency, business_partner)
      values
        (${client}, 'REL-SEED-1', 2026, 1, '101000', ${company}, 'S', 4000, 4000, 'USD', 'C100'),
        (${client}, 'REL-SEED-1', 2026, 2, '300000', ${company}, 'H', 4000, 4000, 'USD', null)
    `);
  });
  await saveCustomerCredit({
    client, changedBy: ACTOR, customer: 'C100', creditControlArea: AREA,
    creditLimit: '5000', riskCategory: 'A', isBlocked: false, changeReason: 'Initial assessment',
  });
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

describe('SCR-105 release credit-blocked documents VKM3 (R-153)', () => {
  it('records determinations from the credit check and queues the blocked ones', async () => {
    const passed = await checkDoc('SO-1', '500');
    expect(passed.status).toBe('PASSED');
    const blocked = await checkDoc('SO-2', '2000');
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.reason).toBe('LIMIT_EXCEEDED');

    const queue = await listCreditDeterminations(client, {});
    expect(queue.map((d) => d.salesDocument)).toEqual(['SO-2']);
    const everything = await listCreditDeterminations(client, { blockedOnly: false, includeReleased: true });
    expect(everything.map((d) => d.salesDocument).sort()).toEqual(['SO-1', 'SO-2']);
  });

  it('releases only on a passing fresh check, or by justified override under its own privilege', async () => {
    const plain = await releaseDocument({ client, changedBy: ACTOR, salesDocument: 'SO-2', canOverride: false });
    expect(plain.ok).toBe(false);
    expect(plain.message).toContain('still blocks');

    const noPrivilege = await releaseDocument({
      client, changedBy: ACTOR, salesDocument: 'SO-2', canOverride: false,
      override: { justification: 'Customer paid down verbally', approvalRef: 'APR-1' },
    });
    expect(noPrivilege.ok).toBe(false);
    expect(noPrivilege.message).toContain('override privilege');

    const noJustification = await releaseDocument({
      client, changedBy: ACTOR, salesDocument: 'SO-2', canOverride: true,
      override: { justification: '  ' },
    });
    expect(noJustification.ok).toBe(false);

    const overridden = await releaseDocument({
      client, changedBy: ACTOR, salesDocument: 'SO-2', canOverride: true,
      override: { justification: 'Payment received outside the ledger scope', approvalRef: 'APR-9' },
    });
    expect(overridden.ok).toBe(true);
    expect(overridden.status).toBe('RELEASED');
    const events = await listReleaseEvents(client, 'SO-2');
    expect(events.map((e) => e.eventType)).toContain('OVERRIDE_RELEASE');
    const queue = await listCreditDeterminations(client, { includeReleased: true });
    const released = queue.find((d) => d.salesDocument === 'SO-2');
    expect(released?.status).toBe('RELEASED');
    expect(released?.override).toBe(true);
    expect(released?.approvalRef).toBe('APR-9');

    const again = await releaseDocument({ client, changedBy: ACTOR, salesDocument: 'SO-2', canOverride: true });
    expect(again.ok).toBe(false); // already released: actual result, no overwrite
  });

  it('rejects with a mandatory reason, rechecks after a limit raise, and reblocks on a fresh determination', async () => {
    const blocked = await checkDoc('SO-3', '2000');
    expect(blocked.status).toBe('BLOCKED');
    await expect(rejectReleaseRequest({ client, changedBy: ACTOR, salesDocument: 'SO-3', reason: ' ' }))
      .rejects.toThrow('reason is mandatory');
    const rejected = await rejectReleaseRequest({
      client, changedBy: ACTOR, salesDocument: 'SO-3', reason: 'Insufficient payment history',
    });
    expect(rejected.ok).toBe(true);
    const afterReject = await listCreditDeterminations(client, {});
    expect(afterReject.find((d) => d.salesDocument === 'SO-3')?.status).toBe('BLOCKED');

    await saveCustomerCredit({
      client, changedBy: ACTOR, customer: 'C100', creditControlArea: AREA,
      creditLimit: '10000', riskCategory: 'A', isBlocked: false,
      changeReason: 'Limit raised after payment', expectedVersion: 1,
    });
    const rechecked = await recheckDocument({ client, changedBy: ACTOR, salesDocument: 'SO-3' });
    expect(rechecked.status).toBe('PASSED');

    const reblockedNoReason = await reblockDocument({ client, changedBy: ACTOR, salesDocument: 'SO-2', reason: '' });
    expect(reblockedNoReason.ok).toBe(false); // fresh check passes now: reason required
    const reblocked = await reblockDocument({
      client, changedBy: ACTOR, salesDocument: 'SO-2', reason: 'New information on payment behaviour',
    });
    expect(reblocked.ok).toBe(true);
    expect(reblocked.status).toBe('BLOCKED');
    const events = await listReleaseEvents(client, 'SO-2');
    expect(events.map((e) => e.eventType)).toEqual(expect.arrayContaining(['CHECK', 'OVERRIDE_RELEASE', 'REBLOCK']));
    const history = await withTenant(client, async (tx) => tx.execute(sql`
      select count(*)::int as n from credit_determination where client = ${client} and sales_document = 'SO-2'
    `));
    expect(Number((history as unknown as Array<{ n: number }>)[0]?.n)).toBeGreaterThanOrEqual(3); // never edited away
  });

  it('processes bulk releases per document with independent outcomes', async () => {
    await checkDoc('SO-4', '9000'); // 4000 + 9000 > 10000: blocked
    await checkDoc('SO-5', '100'); // passes
    const outcomes = await releaseDocumentsBulk({
      client, changedBy: ACTOR, salesDocuments: ['SO-4', 'SO-5', 'SO-404'], canOverride: false,
    });
    const byDoc = new Map(outcomes.map((o) => [o.salesDocument, o]));
    expect(byDoc.get('SO-4')?.ok).toBe(false);
    expect(byDoc.get('SO-5')?.ok).toBe(false); // stands PASSED, not blocked: actual result
    expect(byDoc.get('SO-5')?.message).toContain('stands PASSED');
    expect(byDoc.get('SO-404')?.ok).toBe(false);
  });
});
