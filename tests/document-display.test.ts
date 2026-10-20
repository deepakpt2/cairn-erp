import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { postJournalEntry, reverseJournalEntry } from '../src/platform/posting';
import { getJournalDocument, resolveDocumentNumber } from '../src/modules/finance/document-display';
import { parkJournal } from '../src/modules/finance/parked-journal';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';
import { defineRange } from '../src/platform/numbering';

const ACTOR = 'DISPLAY-TEST';
let client = '';
const company = '1000';
let firstDoc = '';
let secondDoc = '';
let reversalDoc = '';
let parkedDoc = '';

async function post(amount: string, date: string, reference?: string) {
  return withTenant(client, (tx) => postJournalEntry(tx, {
    client, companyCode: company, documentType: 'SA',
    documentDate: date, postingDate: date, fiscalYear: 2026,
    postingPeriod: Number(date.slice(5, 7)), currency: 'USD', localCurrency: 'USD',
    reference,
    lines: [
      { glAccount: '400000', debitCredit: 'S', amount },
      { glAccount: '101000', debitCredit: 'H', amount },
    ],
    postedBy: ACTOR, transactionCode: 'FIN.JOURNAL.POST',
  }));
}

beforeAll(async () => {
  const fx = await createTenant('document-display');
  client = fx.client;
  await defineTestRanges(fx, { fiscalYear: 2026 });
  firstDoc = (await post('500.00', '2026-03-15', 'DISPLAY-REF-1')).documentNumber;
  secondDoc = (await post('250.00', '2026-03-16')).documentNumber;
  reversalDoc = await withTenant(client, (tx) => reverseJournalEntry(tx, {
    client, documentNumber: firstDoc, fiscalYear: 2026,
    reversalDate: '2026-03-20', reason: 'Entered twice',
    reversedBy: ACTOR, transactionCode: 'FIN.DOCUMENT.REVERSE',
  }).then((r) => r.documentNumber));
  await withTenant(client, (tx) => defineRange(tx, {
    client, objectCode: 'PARKDOC', subObject: '*', prefix: 'PK', numberLength: 7, createdBy: ACTOR,
  }));
  parkedDoc = (await parkJournal({
    client, changedBy: ACTOR, requestKey: 'display-park-1',
    companyCode: company, documentDate: '2026-09-30', postingDate: '2026-09-30',
    documentType: 'SA', currency: 'USD',
    lines: [
      { glAccount: '400000', debitCredit: 'S', amount: 10 },
      { glAccount: '101000', debitCredit: 'H', amount: 10 },
    ],
  })).parkedNumber;
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

describe('SCR-090 document display and flow (R-138)', () => {
  it('retrieves by the complete key with totals per currency, and refuses scope mismatches silently', async () => {
    const found = await getJournalDocument(client, { documentNumber: secondDoc, companyCode: company, fiscalYear: 2026 });
    expect(found.kind).toBe('FOUND');
    if (found.kind !== 'FOUND') return;
    expect(found.document.lines).toHaveLength(2);
    expect(found.document.debitDocument).toBe(250);
    expect(found.document.creditLocal).toBe(250);
    expect(found.document.reference).toBeNull();

    // SCR-137 reworked this: a company code that disagrees is now named rather than
    // folded into "not found", which is SAP's own wording for the case.
    const mismatch = await getJournalDocument(client, { documentNumber: secondDoc, companyCode: '9999', fiscalYear: 2026 });
    expect(mismatch.kind).toBe('COMPANY_MISMATCH');
    const wrongYear = await getJournalDocument(client, { documentNumber: secondDoc, companyCode: company, fiscalYear: 2025 });
    expect(wrongYear.kind).toBe('NOT_FOUND');
  });

  it('walks the reversal chain both ways and shows the retained history', async () => {
    const original = await getJournalDocument(client, { documentNumber: firstDoc, companyCode: company, fiscalYear: 2026 });
    expect(original.kind).toBe('FOUND');
    if (original.kind !== 'FOUND') return;
    expect(original.document.status).toBe('REVERSED');
    const reversedBy = original.document.flow.find((f) => f.kind === 'REVERSED_BY');
    expect(reversedBy?.documentNumber).toBe(reversalDoc);
    expect(reversedBy?.href).toContain(encodeURIComponent(reversalDoc));
    expect(original.document.history.some((h) => h.changeType === 'REVERSE')).toBe(true);

    const reversal = await getJournalDocument(client, { documentNumber: reversalDoc, companyCode: company, fiscalYear: 2026 });
    expect(reversal.kind).toBe('FOUND');
    if (reversal.kind !== 'FOUND') return;
    expect(reversal.document.flow.find((f) => f.kind === 'REVERSAL_OF')?.documentNumber).toBe(firstDoc);
  });

  it('answers parked numbers as their own lifecycle, and navigates previous and next', async () => {
    const parked = await getJournalDocument(client, { documentNumber: parkedDoc, companyCode: company, fiscalYear: 2026 });
    expect(parked.kind).toBe('PARKED');

    const first = await getJournalDocument(client, { documentNumber: firstDoc, companyCode: company, fiscalYear: 2026 });
    expect(first.kind).toBe('FOUND');
    if (first.kind !== 'FOUND') return;
    expect(first.document.flow.some((f) => f.kind === 'NEXT')).toBe(true);
    expect(first.document.flow.some((f) => f.kind === 'PREVIOUS')).toBe(false);

    const resolved = await resolveDocumentNumber(client, secondDoc);
    expect(resolved).toEqual({ companyCode: company, fiscalYear: 2026 });
  });
});
