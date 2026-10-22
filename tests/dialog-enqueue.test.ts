import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { changeHistory } from '@/platform/change';
import { revokeSession } from '@/platform/auth/session';
import { withTenant } from '@/platform/db/client';
import {
  EnqueueError,
  assertChangeLock,
  deleteEnqueueEntry,
  listEnqueue,
  openForChange,
  releaseChangeLock,
} from '@/platform/lock/enqueue';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const tenant: TestTenant = await createTenant('enqueue');
const other: TestTenant = await createTenant('enqueue-other');

async function person(client: string, userId: string, sessionId: string, username: string, token: string) {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into app_user (id, client, username, full_name, password_hash, is_active, is_locked, created_by)
      values (${userId}, ${client}, ${username}, ${username}, 'test-hash', true, false, 'TEST')
    `);
    await tx.execute(sql`
      insert into user_session (id, client, user_id, token_hash, issued_at, expires_at)
      values (${sessionId}, ${client}, ${userId}, ${createHash('sha256').update(token).digest('hex')}, now(), now() + interval '8 hours')
    `);
  });
}

await person(tenant.client, 'enq-user-1', 'enq-session-1', 'enq.one', 'token-one');
await person(tenant.client, 'enq-user-2', 'enq-session-2', 'enq.two', 'token-two');

afterAll(async () => {
  await destroyTenant(other.client);
  await destroyTenant(tenant.client);
});

describe('dialog enqueue — one session changes, the next displays', () => {
  it('gives change to the first session and display to the second', async () => {
    const opened = await openForChange({
      client: tenant.client,
      sessionId: 'enq-session-1',
      username: 'enq.one',
      lockObject: 'PURCHASE_ORDER',
      argument: '4500000099',
      transactionCode: 'ME22N',
    });
    expect(opened.mode).toBe('CHANGE');

    const again = await openForChange({
      client: tenant.client,
      sessionId: 'enq-session-1',
      username: 'enq.one',
      lockObject: 'purchase_order',
      argument: '4500000099',
      transactionCode: 'ME22N',
    });
    expect(again.mode).toBe('CHANGE');

    const blocked = await openForChange({
      client: tenant.client,
      sessionId: 'enq-session-2',
      username: 'enq.two',
      lockObject: 'PURCHASE_ORDER',
      argument: '4500000099',
      transactionCode: 'ME22N',
    });
    expect(blocked.mode).toBe('DISPLAY');
    expect(blocked.holder?.username).toBe('enq.one');

    await expect(assertChangeLock({
      client: tenant.client,
      sessionId: 'enq-session-2',
      lockObject: 'PURCHASE_ORDER',
      argument: '4500000099',
    })).rejects.toBeInstanceOf(EnqueueError);
    await assertChangeLock({
      client: tenant.client,
      sessionId: 'enq-session-1',
      lockObject: 'PURCHASE_ORDER',
      argument: '4500000099',
    });
  });

  it('does not show one tenant the locks of another', async () => {
    expect(await listEnqueue(other.client)).toEqual([]);
  });

  it('lets the next session take a lock the holder has stopped answering', async () => {
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update enqueue_entry
           set heartbeat_at = now() - interval '10 minutes'
         where client = ${tenant.client} and lock_object = 'PURCHASE_ORDER' and argument = '4500000099'
      `);
    });
    const taken = await openForChange({
      client: tenant.client,
      sessionId: 'enq-session-2',
      username: 'enq.two',
      lockObject: 'PURCHASE_ORDER',
      argument: '4500000099',
      transactionCode: 'ME22N',
    });
    expect(taken.mode).toBe('CHANGE');
    await releaseChangeLock({
      client: tenant.client,
      sessionId: 'enq-session-2',
      lockObject: 'PURCHASE_ORDER',
      argument: '4500000099',
    });
  });

  it('drops the lock when the session is revoked', async () => {
    await openForChange({
      client: tenant.client,
      sessionId: 'enq-session-1',
      username: 'enq.one',
      lockObject: 'PLANT',
      argument: '1000',
      transactionCode: 'OX10',
    });
    await withTenant(tenant.client, (tx) => revokeSession(tx, { client: tenant.client, token: 'token-one' }));
    const rows = await listEnqueue(tenant.client);
    expect(rows.find((row) => row.argument === '1000')).toBeUndefined();
  });

  it('records an administrator delete and does not change a document', async () => {
    await openForChange({
      client: tenant.client,
      sessionId: 'enq-session-2',
      username: 'enq.two',
      lockObject: 'PLANT',
      argument: '2000',
      transactionCode: 'OX10',
    });
    await deleteEnqueueEntry({
      client: tenant.client,
      changedBy: 'enq.admin',
      lockObject: 'PLANT',
      argument: '2000',
      reason: 'The holder left the screen open.',
    });
    const standing = await listEnqueue(tenant.client);
    expect(standing.find((row) => row.argument === '2000')).toBeUndefined();
    const history = await withTenant(tenant.client, (tx) => changeHistory(tx, tenant.client, 'enqueue_entry', 'PLANT/2000'));
    expect(history.some((row) => row.changeType === 'DELETE' && row.changedBy === 'enq.admin')).toBe(true);
  });

  it('refuses a lock that does not name a document', async () => {
    await expect(openForChange({
      client: tenant.client,
      sessionId: 'enq-session-2',
      username: 'enq.two',
      lockObject: 'PLANT',
      argument: '   ',
      transactionCode: 'OX10',
    })).rejects.toBeInstanceOf(EnqueueError);
  });
});
