import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  executeAccrualReversal, listDueAccruals, postAccrualDocument,
} from '../src/modules/finance/accrual';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'ACCRUAL-TEST';
let client = '';
let company = '';
let documentNumber = '';
let fiscalYear = 0;

async function journalCount(): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    client, changedBy: ACTOR, requestKey: `acc-${Math.random().toString(36).slice(2)}`,
    companyCode: company, documentDate: '2026-04-01', postingDate: '2026-04-01',
    documentType: 'SA', currency: 'USD', headerText: 'Prepaid insurance',
    reversalDate: '2026-05-01', reversalReason: '01',
    lines: [
      { glAccount: '400000', debitCredit: 'S' as const, amount: '1200.00', assignment: 'ACC-01', lineText: 'Insurance accrual' },
      { glAccount: '101000', debitCredit: 'H' as const, amount: '1200.00' },
    ],
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeAll(async () => {
  const fx = await createTenant('accrual');
  client = fx.client;
  company = fx.companyCode;
  await defineTestRanges(fx, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into reversal_reason (client, reason_code, reason_description, is_active, created_by)
      values (${client}, '01', 'Accrual reversal', true, ${ACTOR}) on conflict do nothing
    `);
  });
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

describe('SCR-100 accrual/deferral documents FBS1/F.81 (R-148)', () => {
  it('posts with its reversal metadata in the same transaction, and replays by request key', async () => {
    const requestKey = 'acc-main-1';
    const posted = await postAccrualDocument(base({ requestKey }));
    documentNumber = posted.documentNumber;
    fiscalYear = posted.fiscalYear;
    expect(posted.reversalStatus).toBe('PENDING');
    expect(posted.reversalDate).toBe('2026-05-01');
    expect(posted.totalAmount).toBe(1200);
    expect(posted.journalStatus).toBe('POSTED');

    const journals = await journalCount();
    const replay = await postAccrualDocument(base({ requestKey }));
    expect(replay.documentNumber).toBe(documentNumber);
    expect(await journalCount()).toBe(journals);
  });

  it('rolls the document back when the reversal reason does not stand', async () => {
    const journals = await journalCount();
    await expect(postAccrualDocument(base({ reversalReason: '99' })))
      .rejects.toThrow('does not stand active');
    expect(await journalCount()).toBe(journals); // no partial posting, no orphan metadata
    await expect(postAccrualDocument(base({ reversalDate: '2026-03-01' })))
      .rejects.toThrow('precedes the posting date');
  });

  it('lists the document when due and reverses it exactly once', async () => {
    expect(await listDueAccruals(client, '2026-04-15')).toEqual([]);
    const due = await listDueAccruals(client, '2026-05-01');
    expect(due.map((d) => d.documentNumber)).toContain(documentNumber);

    const journals = await journalCount();
    const reversed = await executeAccrualReversal({
      client, changedBy: ACTOR, companyCode: company, documentNumber, fiscalYear,
    });
    expect(reversed.reversalStatus).toBe('REVERSED');
    expect(reversed.reversalDocumentNumber).toBeTruthy();
    expect(reversed.reversedBy).toBe(ACTOR);
    expect(await journalCount()).toBe(journals + 1);

    const rows = await withTenant(client, async (tx) => tx.execute(sql`
      select status from journal_entry where client = ${client} and document_number = ${documentNumber}
    `));
    expect((rows as unknown as Array<{ status: string }>)[0]?.status).toBe('REVERSED');
    expect(await listDueAccruals(client, '2026-05-02')).toEqual([]);

    const again = await executeAccrualReversal({
      client, changedBy: ACTOR, companyCode: company, documentNumber, fiscalYear,
    });
    expect(again.reversalStatus).toBe('REVERSED');
    expect(again.reversalDocumentNumber).toBe(reversed.reversalDocumentNumber);
    expect(await journalCount()).toBe(journals + 1); // exactly one reversal ever
  });
});
