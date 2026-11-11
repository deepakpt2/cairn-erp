/**
 * DOC.RELEASE.WAITING — the one notification with nobody to send it to.
 *
 * Every other kind names a person: the author of the document, the holder of
 * the expiring grant, the owner of the closed session. This one cannot. A
 * release code is an authority, not a person (R-108), so "who can release
 * this?" is answered by capability and organisational scope, and answering it
 * means loading every candidate's authority — work that must not happen on the
 * request path.
 *
 * So the business transaction enqueues a fan-out and the worker answers the
 * question afterwards. The properties under test are therefore properties of
 * the seam, not of either half alone:
 *
 *   - a document that becomes pending leaves a run behind it, and the run
 *     carries what the recipient resolution needs — capability, place, object;
 *   - running it writes one row per person who may actually act, and nobody
 *     else;
 *   - a document nobody claims leaves nothing behind, because there is nobody
 *     to write to;
 *   - a document saved ten times while it waits does not queue ten runs, and
 *     a document that moves to a different strategy queues another, because
 *     the people who could release the old one are not the people who can
 *     release this one.
 *
 * Asserted against the real database, and read back through the row policy,
 * because a row written for the wrong id-space is invisible rather than
 * absent — it is counted as delivered and read by nobody.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCharacteristic } from '../src/modules/foundation/characteristic-definition';
import { saveClass, setClassStatus } from '../src/modules/foundation/class-definition';
import {
  saveReleaseGroup, saveReleaseStrategy, setReleaseStrategyStatus,
} from '../src/modules/foundation/release-strategy-definition';
import { changeRequisition, createRequisition } from '../src/modules/purchasing/requisitions';
import { getDocumentRelease } from '../src/modules/purchasing/release';
import { listInbox } from '../src/platform/notification/notify';
import { handlerFor, registerJob } from '../src/platform/job/registry';
import { ensureDefinition } from '../src/platform/job/queue';
import { runClaimed } from '../src/platform/job/execute';
import { fanoutJob, FANOUT_JOB } from '../src/platform/notification/jobs/fanout';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'RELEASE_WAITING_TEST';
const WORKER = 'test-worker';
const CAPABILITY = 'PROC.PR.RELEASE';

let client = '';
let approver = ''; // holds the release capability for plant 1000
let outsider = ''; // holds the same capability for plant 2000
let grantA = '';
let grantB = '';

/**
 * The fan-out run(s) queued for one document, oldest first.
 *
 * Read through `job_run` rather than collected by intercepting `enqueue`, so
 * the assertion is about what the document change actually left behind.
 */
async function runsFor(documentNumber: string): Promise<{ id: string; key: string; triggeredBy: string }[]> {
  return (await withTenant(client, async (tx) =>
    tx.execute(sql`
      select id, idempotency_key as key, triggered_by as "triggeredBy"
        from job_run
       where client = ${client}
         and job_code = ${FANOUT_JOB}
         and parameters->>'objectKey' = ${documentNumber}
       order by queued_at, id
    `),
  )) as unknown as { id: string; key: string; triggeredBy: string }[];
}

/** Run every fan-out queued for one document, the way the worker would. */
async function drain(documentNumber: string): Promise<string[]> {
  const outcomes: string[] = [];
  for (const run of await runsFor(documentNumber)) {
    outcomes.push(await runClaimed(WORKER, { runId: run.id, client, jobCode: FANOUT_JOB }));
  }
  return outcomes;
}

beforeAll(async () => {
  const tenant = await createTenant('release-waiting-notification');
  client = tenant.client;

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: 'PURCHREQ', subObject: 'NB', prefix: 'PR', numberLength: 7, createdBy: ACTOR,
    });
    await tx.execute(sql`
      insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
      values (${client}, '1000', 'Test purchasing organization', '1000', ${ACTOR})
      on conflict do nothing
    `);
  });

  await saveCharacteristic({
    client, changedBy: ACTOR, mode: 'CREATE',
    characteristicName: 'TOTAL_VALUE', description: 'Total document value',
    dataFormat: 'NUM', valueLength: 13, decimalPlaces: 2, unit: '', currency: '',
    negativeValuesAllowed: false, caseSensitive: false, intervalsAllowed: true,
    additionalValuesAllowed: true, valueAssignment: 'SINGLE', requiredEntry: false,
    values: [], reason: 'Release waiting acceptance',
  });
  await saveClass({
    client, changedBy: ACTOR, mode: 'CREATE',
    classType: 'PURCHASE_REQUISITION', className: 'PR_RELEASE',
    description: 'Requisition release class',
    assignments: [{ characteristicName: 'TOTAL_VALUE', requiredForClassification: true }],
    reason: 'Release waiting acceptance',
  });
  await setClassStatus({
    client, changedBy: ACTOR, classType: 'PURCHASE_REQUISITION', className: 'PR_RELEASE',
    status: 'ACTIVE', reason: 'Release waiting acceptance',
  });
  await saveReleaseGroup({
    client, changedBy: ACTOR, mode: 'CREATE',
    groupCode: 'PR', documentCategory: 'PURCHASE_REQUISITION', description: 'Requisition releases',
    codes: [{ code: 'MGR', description: 'Purchasing manager' }],
    reason: 'Release waiting acceptance',
  });

  const activate = async (strategyCode: string, priority: number, from: string) => {
    await saveReleaseStrategy({
      client, changedBy: ACTOR, mode: 'CREATE',
      groupCode: 'PR', strategyCode, description: `${strategyCode} strategy`,
      className: 'PR_RELEASE', priority,
      criteria: [{ characteristicName: 'TOTAL_VALUE', operator: 'GE', valueFrom: from, valueTo: '' }],
      steps: ['MGR'], reason: 'Release waiting acceptance',
    });
    await setReleaseStrategyStatus({
      client, changedBy: ACTOR, groupCode: 'PR', strategyCode, status: 'ACTIVE',
      reason: 'Release waiting acceptance',
    });
  };
  await activate('STD', 100, '1000');
  await activate('BIG', 10, '10000');

  // Two people, one capability, two plants. The second is the test: a holder
  // whose authority does not reach the document must not be told about it.
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  approver = `u-appr-${suffix}`;
  outsider = `u-out-${suffix}`;
  grantA = `grant-appr-${suffix}`;
  grantB = `grant-out-${suffix}`;

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into app_user (id, client, username, full_name, password_hash, is_active)
      values
        (${approver}, ${client}, ${'appr' + suffix}, 'Approver', 'scrypt:x:x', true),
        (${outsider}, ${client}, ${'out' + suffix}, 'Outsider', 'scrypt:x:x', true)
      on conflict (id) do nothing
    `);
    await tx.execute(sql`
      insert into user_capability (id, client, user_id, capability_code, valid_from, reason, granter)
      values
        (${grantA}, ${client}, ${approver}, ${CAPABILITY}, current_date, 'DIRECT', 'TEST'),
        (${grantB}, ${client}, ${outsider}, ${CAPABILITY}, current_date, 'DIRECT', 'TEST')
      on conflict (id) do nothing
    `);
    await tx.execute(sql`
      insert into user_capability_scope (client, grant_id, scope_type, scope_value)
      values
        (${client}, ${grantA}, 'PLANT', '1000'),
        (${client}, ${grantB}, 'PLANT', '2000')
      on conflict do nothing
    `);
  });

  // The definition ships with the schema (drizzle/9271_job_scheduler.sql).
  // This restates the flags the test relies on rather than assuming them.
  await withTenant(client, async (tx) => {
    await ensureDefinition(tx, {
      code: FANOUT_JOB, name: 'Resolve who to notify', module: 'PEOPLE',
      chunkSize: 100, maxRetries: 2, timeoutSeconds: 300, isScheduled: false,
    });
  });

  registerJob(fanoutJob);
}, 120_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
});

const requisitionItem = (estimatedPrice: number) => ({
  materialNumber: '', shortText: 'Industrial steel plate', quantity: 10, unit: 'PC',
  deliveryDate: '2026-11-15', plant: '1000', storageLocation: '', purchasingGroup: '001',
  estimatedPrice, priceUnit: 1, currency: 'USD', markedForDeletion: false,
  assignments: [] as never[],
});

describe('DOC.RELEASE.WAITING', () => {
  it('registers its handler, so a claimed run has something to run', () => {
    // A handler that is imported but not registered is a run that fails the
    // moment a worker claims it: "no handler is registered for NOTIFY.FANOUT".
    // The worker's import list is not enough on its own.
    expect(handlerFor(FANOUT_JOB)).toBe(fanoutJob);
  });

  it('queues a fan-out when a document becomes pending, and nobody is named in it', async () => {
    const requisition = await createRequisition({
      client, changedBy: ACTOR, items: [requisitionItem(150)],
    });
    expect(await getDocumentRelease(client, 'PURCHASE_REQUISITION', requisition.requisitionNumber))
      .toMatchObject({ status: 'PENDING', strategyCode: 'STD', currentStep: 0 });

    const runs = await runsFor(requisition.requisitionNumber);
    expect(runs).toHaveLength(1);

    // Nobody asked for this run, so nobody is named in it. Naming a person
    // here would make the job runtime report the fan-out's own outcome back
    // to them — "NOTIFY.FANOUT finished" on top of the notification the
    // fan-out just wrote.
    expect(runs[0]!.triggeredBy).toBe('RELEASE');
  });

  it('tells whoever may release it, and nobody who may not', async () => {
    const requisition = await createRequisition({
      client, changedBy: ACTOR, items: [requisitionItem(150)],
    });
    const number = requisition.requisitionNumber;

    expect(await drain(number)).toEqual(['SUCCEEDED']);

    const inbox = await listInbox(client, approver);
    const found = inbox.find((r) => r.kind === 'DOC.RELEASE.WAITING' && r.objectKey === number);
    expect(found).toBeTruthy();
    expect(found!.objectClass).toBe('purchase_requisition');
    expect(found!.isUnseen).toBe(true);
    // The message is resolved at render, never stored as text (R-19, D-008).
    expect(found!.title).toContain(number);

    // The outsider holds the same capability for a plant this document is not
    // in. Telling them would put work in their inbox the screen then refuses.
    const theirs = await listInbox(client, outsider);
    expect(theirs.some((r) => r.objectKey === number)).toBe(false);
  });

  it('leaves nothing behind when no strategy claims the document', async () => {
    const requisition = await createRequisition({
      client, changedBy: ACTOR, items: [requisitionItem(10)], // 100 total: below both strategies
    });
    expect(await getDocumentRelease(client, 'PURCHASE_REQUISITION', requisition.requisitionNumber))
      .toMatchObject({ status: 'NOT_REQUIRED' });

    // There is nobody to write to, and a fan-out that resolves to zero people
    // is a wasted run rather than an empty promise.
    expect(await runsFor(requisition.requisitionNumber)).toEqual([]);
  });

  it('writes one run per pending episode, however often the document is saved', async () => {
    const requisition = await createRequisition({
      client, changedBy: ACTOR, items: [requisitionItem(150)],
    });
    const number = requisition.requisitionNumber;
    expect(await runsFor(number)).toHaveLength(1);

    // Same strategy, same step: saving the document again is not news.
    await changeRequisition({
      client, changedBy: ACTOR, requisitionNumber: number,
      items: [{ ...requisitionItem(200), itemNumber: 10 }],
    });
    expect(await getDocumentRelease(client, 'PURCHASE_REQUISITION', number))
      .toMatchObject({ status: 'PENDING', strategyCode: 'STD' });
    expect(await runsFor(number)).toHaveLength(1);
  });

  it('writes a fresh run when a change moves the document to another strategy', async () => {
    const requisition = await createRequisition({
      client, changedBy: ACTOR, items: [requisitionItem(150)],
    });
    const number = requisition.requisitionNumber;
    const [first] = await runsFor(number);

    await changeRequisition({
      client, changedBy: ACTOR, requisitionNumber: number,
      items: [{ ...requisitionItem(1500), itemNumber: 10 }],
    });
    expect(await getDocumentRelease(client, 'PURCHASE_REQUISITION', number))
      .toMatchObject({ status: 'PENDING', strategyCode: 'BIG', currentStep: 0 });

    const runs = await runsFor(number);
    expect(runs).toHaveLength(2);
    // A different key, so the second episode is a second run rather than the
    // first one quietly answering for it.
    expect(runs[1]!.key).not.toBe(first!.key);
    expect(runs[1]!.key).toContain('BIG');
  });
});
