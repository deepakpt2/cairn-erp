import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  completeParkedJournal, deleteParkedJournal, editParkedJournal, parkJournal, postParkedJournal,
  ParkedJournalError,
} from '../src/modules/finance/parked-journal';
import { cancelParkedJournalReleaseForProvisioning as cancelParkedJournalRelease, getParkedJournalRelease, releaseParkedJournalForProvisioning as releaseParkedJournal } from '../src/modules/finance/parked-journal-release';
import { saveReleaseGroup } from '../src/modules/foundation/release-strategy-definition';
import { ReleaseError } from '../src/modules/purchasing/release';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';
import { defineReleaseStrategy } from './helpers/release-config';

const PREPARER = 'JE-PREPARER';
const APPROVER = 'JE-APPROVER';
let client = '';
let company = '';

const lines = (amount: number) => [
  { glAccount: '400000', debitCredit: 'S' as const, amount },
  { glAccount: '101000', debitCredit: 'H' as const, amount },
];
const base = (requestKey: string, amount: number) => ({
  client, changedBy: PREPARER, requestKey, companyCode: company,
  documentDate: '2026-09-30', postingDate: '2026-09-30', documentType: 'SA', currency: 'USD', lines: lines(amount),
});

beforeAll(async () => {
  const fx = await createTenant('finance-release', { companyCode: 'R101', currency: 'USD' });
  client = fx.client;
  company = fx.companyCode;
  await defineTestRanges(fx, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'PARKDOC', subObject: '*', prefix: 'PK', numberLength: 7, createdBy: PREPARER });
  });
  await defineReleaseStrategy({
    client, actor: PREPARER, category: 'JOURNAL_ENTRY', group: 'JE', codes: ['CTL', 'CFO'],
    strategy: 'JE_STD', from: '1000', steps: ['CTL', 'CFO'],
  });
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

describe('release strategies for parked journal entries', () => {
  it('lets a group be defined for contracts, scheduling agreements, journals and payment runs', async () => {
    for (const [group, category] of [
      ['CT', 'PURCHASE_CONTRACT'], ['SA', 'SCHED_AGREEMENT'], ['RN', 'PAYMENT_RUN'],
    ] as const) {
      await saveReleaseGroup({
        client, changedBy: PREPARER, mode: 'CREATE', groupCode: group, documentCategory: category,
        description: `${group} releases`, codes: [{ code: 'MGR', description: 'Manager' }], reason: 'acceptance',
      });
    }
    await expect(saveReleaseGroup({
      client, changedBy: PREPARER, mode: 'CREATE', groupCode: 'XX', documentCategory: 'SALES_ORDER',
      description: 'No such category', codes: [{ code: 'MGR', description: 'Manager' }], reason: 'acceptance',
    })).rejects.toThrow('document category is one of');
  });

  it('does not claim a journal under the threshold, which posts as before', async () => {
    const parked = await parkJournal(base('small', 500));
    expect(await getParkedJournalRelease(client, parked.parkedNumber)).toMatchObject({ status: 'NOT_REQUIRED' });
    const posted = await postParkedJournal({ client, changedBy: PREPARER, parkedNumber: parked.parkedNumber });
    expect(posted.status).toBe('POSTED');
  });

  it('holds a claimed journal until released, by someone other than the person who parked it', async () => {
    const parked = await parkJournal(base('claimed', 5000));
    const number = parked.parkedNumber;
    expect(await getParkedJournalRelease(client, number)).toMatchObject({
      status: 'PENDING', strategyCode: 'JE_STD', steps: ['CTL', 'CFO'], currentStep: 0,
    });
    await completeParkedJournal({ client, changedBy: PREPARER, parkedNumber: number });
    await expect(postParkedJournal({ client, changedBy: PREPARER, parkedNumber: number }))
      .rejects.toThrow(ParkedJournalError);
    await expect(postParkedJournal({ client, changedBy: PREPARER, parkedNumber: number }))
      .rejects.toThrow('waiting for release');

    // Four eyes: the preparer cannot release.
    await expect(releaseParkedJournal({ client, changedBy: PREPARER, parkedNumber: number, releaseCode: 'CTL' }))
      .rejects.toThrow('you cannot release it');
    // Steps run in sequence under the standing code.
    await expect(releaseParkedJournal({ client, changedBy: APPROVER, parkedNumber: number, releaseCode: 'CFO' }))
      .rejects.toThrow('acts under release code CTL');
    await releaseParkedJournal({ client, changedBy: APPROVER, parkedNumber: number, releaseCode: 'CTL' });
    await expect(postParkedJournal({ client, changedBy: PREPARER, parkedNumber: number }))
      .rejects.toThrow('waiting for release');
    await releaseParkedJournal({ client, changedBy: APPROVER, parkedNumber: number, releaseCode: 'CFO' });
    expect(await getParkedJournalRelease(client, number)).toMatchObject({ status: 'RELEASED' });

    const posted = await postParkedJournal({ client, changedBy: PREPARER, parkedNumber: number });
    expect(posted.status).toBe('POSTED');
    expect(posted.postedDocumentNumber).toBeTruthy();
  });

  it('starts the release again when the journal is edited after acts were given', async () => {
    const parked = await parkJournal(base('edited', 5000));
    const number = parked.parkedNumber;
    await releaseParkedJournal({ client, changedBy: APPROVER, parkedNumber: number, releaseCode: 'CTL' });
    expect((await getParkedJournalRelease(client, number)).currentStep).toBe(1);
    await editParkedJournal({ ...base('edited', 6000), parkedNumber: number, expectedVersion: parked.version });
    expect(await getParkedJournalRelease(client, number)).toMatchObject({ status: 'PENDING', currentStep: 0 });
  });

  it('cancels a release, and drops a deleted journal from the release queue', async () => {
    const parked = await parkJournal(base('cancelled', 5000));
    const number = parked.parkedNumber;
    await releaseParkedJournal({ client, changedBy: APPROVER, parkedNumber: number, releaseCode: 'CTL' });
    await cancelParkedJournalRelease({ client, changedBy: APPROVER, parkedNumber: number });
    expect((await getParkedJournalRelease(client, number)).currentStep).toBe(0);
    await deleteParkedJournal({ client, changedBy: PREPARER, parkedNumber: number, reason: 'Not needed' });
    expect(await getParkedJournalRelease(client, number)).toMatchObject({ status: 'NOT_REQUIRED' });
    await expect(releaseParkedJournal({ client, changedBy: APPROVER, parkedNumber: number, releaseCode: 'CTL' }))
      .rejects.toThrow(ReleaseError);
  });
});
