import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  completeParkedJournal,
  deleteParkedJournal,
  editParkedJournal,
  parkJournal,
  postParkedJournal,
  ParkedJournalError,
} from '../src/modules/finance/parked-journal';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'PARKED-TEST';
let client = '';
let company = '';

async function journalCount(): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`);
    return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
  });
}

const balanced = [
  { glAccount: '400000', debitCredit: 'S' as const, amount: 500 },
  { glAccount: '101000', debitCredit: 'H' as const, amount: 500 },
];

function base(overrides: Record<string, unknown> = {}) {
  return {
    client, changedBy: ACTOR, requestKey: 'park-1',
    companyCode: company, documentDate: '2026-09-30', postingDate: '2026-09-30',
    documentType: 'SA', currency: 'USD', lines: balanced, ...overrides,
  };
}

beforeAll(async () => {
  const fx = await createTenant('parked-journal', { companyCode: 'P101', currency: 'USD' });
  client = fx.client;
  company = fx.companyCode;
  await defineTestRanges(fx, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'PARKDOC', subObject: '*', prefix: 'PK', numberLength: 7, createdBy: ACTOR });
  });
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

describe('SCR-087 parked journal (R-135)', () => {
  it('parks an unbalanced document with no journal behind it, and replays by request key', async () => {
    const parked = await parkJournal(base({
      lines: [{ glAccount: '400000', debitCredit: 'S', amount: 300 }],
    }));
    expect(parked.parkedNumber.startsWith('PK-')).toBe(true);
    expect(parked.status).toBe('PARKED');
    expect(parked.balance).toBe(300);
    expect(Number(parked.totalDebit)).toBe(300);
    expect(await journalCount()).toBe(0);

    const replayed = await parkJournal(base({
      lines: [{ glAccount: '400000', debitCredit: 'S', amount: 300 }],
    }));
    expect(replayed.parkedNumber).toBe(parked.parkedNumber);

    await expect(parkJournal(base({
      requestKey: 'park-bad', lines: [{ glAccount: '999999', debitCredit: 'S', amount: 1 }],
    }))).rejects.toThrowError(/does not stand/);
  });

  it('judges save-as-complete by the balance, and edits are version-checked and re-park', async () => {
    const parked = await parkJournal(base({
      requestKey: 'park-2', lines: [{ glAccount: '400000', debitCredit: 'S', amount: 300 }],
    }));
    await expect(completeParkedJournal({ client, changedBy: ACTOR, parkedNumber: parked.parkedNumber }))
      .rejects.toThrowError(/does not balance/);

    await expect(editParkedJournal({
      client, changedBy: ACTOR, parkedNumber: parked.parkedNumber, expectedVersion: 99,
      companyCode: company, documentDate: '2026-09-30', postingDate: '2026-09-30',
      documentType: 'SA', currency: 'USD', lines: balanced,
    })).rejects.toThrowError(/has changed since/);

    const edited = await editParkedJournal({
      client, changedBy: ACTOR, parkedNumber: parked.parkedNumber, expectedVersion: parked.version,
      companyCode: company, documentDate: '2026-09-30', postingDate: '2026-09-30',
      documentType: 'SA', currency: 'USD', lines: balanced,
    });
    expect(edited.status).toBe('PARKED');
    expect(edited.version).toBe(parked.version + 1);
    expect(edited.balance).toBe(0);

    const completed = await completeParkedJournal({ client, changedBy: ACTOR, parkedNumber: parked.parkedNumber });
    expect(completed.status).toBe('COMPLETED');

    const reParked = await editParkedJournal({
      client, changedBy: ACTOR, parkedNumber: parked.parkedNumber, expectedVersion: completed.version,
      companyCode: company, documentDate: '2026-09-30', postingDate: '2026-09-30',
      documentType: 'SA', currency: 'USD', lines: balanced,
    });
    expect(reParked.status).toBe('PARKED');
  });

  it('posts atomically through the engine, retains the posted reference, and never double-posts', async () => {
    const parked = await parkJournal(base({ requestKey: 'park-3' }));
    await completeParkedJournal({ client, changedBy: ACTOR, parkedNumber: parked.parkedNumber });
    const before = await journalCount();
    const posted = await postParkedJournal({ client, changedBy: ACTOR, parkedNumber: parked.parkedNumber });
    expect(posted.status).toBe('POSTED');
    expect(posted.postedDocumentNumber).toBeTruthy();
    expect(await journalCount()).toBe(before + 1);

    const again = await postParkedJournal({ client, changedBy: ACTOR, parkedNumber: parked.parkedNumber });
    expect(again.postedDocumentNumber).toBe(posted.postedDocumentNumber);
    expect(await journalCount()).toBe(before + 1);

    await expect(deleteParkedJournal({ client, changedBy: ACTOR, parkedNumber: parked.parkedNumber, reason: 'wrong' }))
      .rejects.toThrowError(/reverse the posted document/);

    const doomed = await parkJournal(base({ requestKey: 'park-4' }));
    await expect(deleteParkedJournal({ client, changedBy: ACTOR, parkedNumber: doomed.parkedNumber }))
      .rejects.toBeInstanceOf(ParkedJournalError);
    const deleted = await deleteParkedJournal({
      client, changedBy: ACTOR, parkedNumber: doomed.parkedNumber, reason: 'Entered in error',
    });
    expect(deleted.status).toBe('DELETED');
  });
});
