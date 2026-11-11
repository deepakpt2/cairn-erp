/**
 * Notifications — Phase 7.
 *
 * The assertions that matter here are the ones that would catch the two ways
 * this design could quietly go wrong:
 *
 *   - the resolver and `can()` disagreeing, so the inbox offers work the
 *     screen then refuses;
 *   - the recipient term of the policy not biting, so one person reads
 *     another's inbox.
 *
 * Both are asserted against the real database rather than a mock, because both
 * are properties of the policy and the grant resolver together.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { canUser } from '@/platform/auth/authority';
import { db, withTenant, withTenantAs } from '@/platform/db/client';
import { sql } from 'drizzle-orm';

import {
  getNotification,
  listInbox,
  markAllSeen,
  markSeen,
  notifyAll,
  notifyOn,
  unreadCount,
} from '@/platform/notification/notify';
import { resolveRecipients } from '@/platform/notification/recipients';
import {
  NOTIFICATION_ROUTES,
  routeForNotification,
} from '@/platform/notification/routing';
import { notification } from '@/platform/tables/system';
import { SCREENS } from '@/ui/shell/screen-catalog';
import { and, eq } from 'drizzle-orm';

import { parseCron, nextDueAfter } from '@/platform/job/cron';

let client: string;
let managerA: string; // holds the release capability, scoped to plant 1000
let managerB: string; // holds it, scoped to plant 2000
let clerk: string; // holds nothing
let grantA: string;
let grantB: string;
let grantExp: string;

const CAPABILITY = 'PROC.PR.RELEASE';

// Everything seeded below carries the run's suffix and is removed again here.
// The grants are why: with a fixed id, `on conflict do nothing` skipped the
// insert on every run after the first, so the capability was never granted and
// `canUser` answered false. A fixture that passes once and fails forever after
// is worse than one that fails on the first run, because it looks like a
// product regression when it is only stale rows.
afterAll(async () => {
  if (!client) return;
  await withTenant(client, async (tx) => {
    await tx.execute(sql`delete from notification where client = ${client}`);
    await tx.execute(
      sql`delete from user_capability_scope where client = ${client} and grant_id in (${grantA}, ${grantB}, ${grantExp})`,
    );
    await tx.execute(
      sql`delete from user_capability where client = ${client} and id in (${grantA}, ${grantB}, ${grantExp})`,
    );
    await tx.execute(
      sql`delete from app_user where client = ${client} and id in (${managerA}, ${managerB}, ${clerk})`,
    );
    await tx.execute(sql`delete from plant where client = ${client} and plant in ('1000', '2000')`);
  }).catch(() => {});
});

async function seedTenant(): Promise<void> {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  client = `N${suffix}`.slice(0, 4).padEnd(4, 'X');

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into client (client, name) values (${client}, ${'Notify test ' + suffix})
      on conflict (client) do nothing
    `);
    // Plants, so a scope has something to point at.
    await tx.execute(sql`
      insert into plant (client, plant, name, country) values
        (${client}, '1000', 'Plant 1000', 'US'), (${client}, '2000', 'Plant 2000', 'US')
      on conflict do nothing
    `);
  });

  // `app_user.id` has no default: it is a supplied key, not a serial.
  managerA = `u-a-${suffix}`;
  managerB = `u-b-${suffix}`;
  clerk = `u-c-${suffix}`;
  grantA = `grant-a-${suffix}`;
  grantB = `grant-b-${suffix}`;
  grantExp = `grant-exp-${suffix}`;

  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into app_user (id, client, username, full_name, password_hash, is_active)
      values
        (${managerA}, ${client}, ${'mgrA' + suffix}, 'Manager A', 'scrypt:x:x', true),
        (${managerB}, ${client}, ${'mgrB' + suffix}, 'Manager B', 'scrypt:x:x', true),
        (${clerk}, ${client}, ${'clerk' + suffix}, 'Clerk', 'scrypt:x:x', true)
      on conflict (id) do nothing
    `);
  });
}

beforeAll(async () => {
  await seedTenant();
}, 60_000);

describe('notification delivery', () => {
  it('delivers one message to one person, inside the caller transaction', async () => {
    const id = await withTenant(client, async (tx) =>
      notifyOn(tx, {
        client,
        recipient: managerA,
        kind: 'DOC.RELEASED',
        objectClass: 'purchase_requisition',
        objectKey: '1000000001',
        messageKey: 'notification.kind.DOC.RELEASED',
        messageParams: { document: '1000000001' },
      }),
    );
    expect(id).toBeTruthy();

    const rows = await listInbox(client, managerA);
    expect(rows.some((r) => r.notificationId === id)).toBe(true);
  });

  it('resolves the message through the locale, not as stored text', async () => {
    const rows = await listInbox(client, managerA);
    const found = rows.find((r) => r.kind === 'DOC.RELEASED');
    expect(found).toBeTruthy();
    // A missing catalogue entry renders the key itself, which is exactly what
    // this asserts against: the key was resolved, and the placeholder filled.
    expect(found!.title).not.toBe(found!.messageKey);
    expect(found!.title).toContain('1000000001');
  });

  it('does not write a second unseen copy of the same event', async () => {
    const before = await unreadCount(client, managerA);
    await withTenant(client, async (tx) => {
      await notifyOn(tx, {
        client,
        recipient: managerA,
        kind: 'DOC.RELEASED',
        objectClass: 'purchase_requisition',
        objectKey: '1000000001',
        messageKey: 'notification.kind.DOC.RELEASED',
        messageParams: { document: '1000000001' },
      });
    });
    const after = await unreadCount(client, managerA);
    expect(after).toBe(before); // the first row is still unseen, so this is a no-op
  });

  it('marks one seen, once, and counts it as read', async () => {
    const before = await unreadCount(client, managerA);
    const rows = await listInbox(client, managerA);
    const target = rows.find((r) => r.isUnseen)!;
    expect(await markSeen(client, managerA, target.notificationId)).toBe(true);
    // Idempotent: the second call reports that nothing changed.
    expect(await markSeen(client, managerA, target.notificationId)).toBe(false);
    expect(await unreadCount(client, managerA)).toBe(before - 1);
  });

  it('marks everything seen at once', async () => {
    await withTenant(client, async (tx) =>
      notifyOn(tx, {
        client,
        recipient: clerk,
        kind: 'JOB.COMPLETED',
        objectClass: 'job_run',
        objectKey: 'run-1',
        messageKey: 'notification.kind.JOB.COMPLETED',
        messageParams: { job: 'TEST.JOB' },
      }),
    );
    expect(await unreadCount(client, clerk)).toBeGreaterThan(0);
    const marked = await markAllSeen(client, clerk);
    expect(marked).toBeGreaterThan(0);
    expect(await unreadCount(client, clerk)).toBe(0);
  });
});

describe('the recipient term of the policy', () => {
  it('does not let one person read another person inbox', async () => {
    // Read as managerA; the row belongs to clerk.
    const mine = await listInbox(client, managerA);
    expect(mine.some((r) => r.recipient === clerk)).toBe(false);
  });

  it('returns nothing at all when no person is named', async () => {
    // withTenant sets only cairn.client. An unset cairn.user must make the
    // comparison null and return no rows — fail closed, not open.
    const rows = await withTenant(client, async (tx) =>
      tx.select().from(notification).where(eq(notification.client, client)),
    );
    expect(rows).toEqual([]);
  });

  it('will not mark somebody else row seen', async () => {
    const theirRows = await listInbox(client, clerk);
    const target = theirRows[0];
    expect(target).toBeTruthy();
    expect(await markSeen(client, managerA, target!.notificationId)).toBe(false);
  });
});

describe('recipient resolution is the inverse of can()', () => {
  it('agrees with can() for a holder in scope', async () => {
    // Grant managerA the capability, scoped to plant 1000.
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into user_capability (id, client, user_id, capability_code, valid_from, reason, granter)
        values (${grantA}, ${client}, ${managerA}, ${CAPABILITY}, current_date, 'DIRECT', 'TEST')
        on conflict (id) do nothing
      `);
      await tx.execute(sql`
        insert into user_capability_scope (client, grant_id, scope_type, scope_value)
        values (${client}, ${grantA}, 'PLANT', '1000')
        on conflict do nothing
      `);
    });

    expect(await canUser({ client, userId: managerA }, CAPABILITY, { plant: '1000' })).toBe(true);
    expect(await canUser({ client, userId: managerA }, CAPABILITY, { plant: '2000' })).toBe(false);

    const forA = await withTenant(client, async (tx) =>
      resolveRecipients(tx, client, CAPABILITY, { plant: '1000' }),
    );
    expect(forA).toContain(managerA);

    const forB = await withTenant(client, async (tx) =>
      resolveRecipients(tx, client, CAPABILITY, { plant: '2000' }),
    );
    expect(forB).not.toContain(managerA);
  });

  it('narrows by scope rather than telling every holder', async () => {
    // managerB holds the same capability for plant 2000.
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into user_capability (id, client, user_id, capability_code, valid_from, reason, granter)
        values (${grantB}, ${client}, ${managerB}, ${CAPABILITY}, current_date, 'DIRECT', 'TEST')
        on conflict (id) do nothing
      `);
      await tx.execute(sql`
        insert into user_capability_scope (client, grant_id, scope_type, scope_value)
        values (${client}, ${grantB}, 'PLANT', '2000')
        on conflict do nothing
      `);
    });

    const thousand = await withTenant(client, async (tx) =>
      resolveRecipients(tx, client, CAPABILITY, { plant: '1000' }),
    );
    const twoThousand = await withTenant(client, async (tx) =>
      resolveRecipients(tx, client, CAPABILITY, { plant: '2000' }),
    );

    expect(thousand).toContain(managerA);
    expect(thousand).not.toContain(managerB);
    expect(twoThousand).toContain(managerB);
    expect(twoThousand).not.toContain(managerA);
  });

  it('never names somebody who does not hold the capability', async () => {
    const found = await withTenant(client, async (tx) =>
      resolveRecipients(tx, client, CAPABILITY, { plant: '1000' }),
    );
    expect(found).not.toContain(clerk);
  });

  it('writes one row per resolved person', async () => {
    const told = await withTenant(client, async (tx) => {
      const people = await resolveRecipients(tx, client, CAPABILITY, { plant: '1000' });
      return notifyAll(tx, client, people, {
        kind: 'DOC.RELEASE.WAITING',
        objectClass: 'purchase_requisition',
        objectKey: '1000000002',
        messageKey: 'notification.kind.DOC.RELEASE.WAITING',
        messageParams: { document: '1000000002' },
      });
    });
    expect(told).toBe(1);
    const rows = await listInbox(client, managerA);
    expect(rows.some((r) => r.objectKey === '1000000002')).toBe(true);
  });
});

describe('the scheduler grammar', () => {
  it('parses a star, a number, a range, a list and a step', () => {
    const spec = parseCron('*/15 8-17 1,15 * 1-5');
    expect(spec.minutes).toEqual([0, 15, 30, 45]);
    expect(spec.hours).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(spec.daysOfMonth).toEqual([1, 15]);
    expect(spec.months).toHaveLength(12);
    expect(spec.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it('finds the next instant after a given one', () => {
    const next = nextDueAfter('0 6 * * *', new Date('2026-03-01T07:00:00'));
    expect(next).not.toBeNull();
    expect(next!.getHours()).toBe(6);
    expect(next!.getMinutes()).toBe(0);
    expect(next!.getDate()).toBe(2); // 06:00 today has already passed
  });

  it('returns null for a schedule that can never fire again', () => {
    // The thirtieth of February.
    expect(nextDueAfter('0 0 30 2 *', new Date('2026-01-01T00:00:00'))).toBeNull();
  });

  it('rejects an expression that is not five fields', () => {
    expect(() => parseCron('0 6 * *')).toThrow();
  });
});

describe('the sweep does not repeat itself', () => {
  it('leaves one unseen row when run twice for the same grant', async () => {
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into user_capability (id, client, user_id, capability_code, valid_from, valid_to, reason, granter)
        values (${grantExp}, ${client}, ${clerk}, 'PROC.PR.RELEASE',
                current_date, current_date + 3, 'DIRECT', 'TEST')
        on conflict (id) do nothing
      `);
    });

    const key = { objectClass: 'user_capability', objectKey: grantExp };
    const before = (await listInbox(client, clerk)).filter((r) => r.objectKey === grantExp).length;

    await withTenant(client, async (tx) => {
      await notifyOn(tx, { client, recipient: clerk, kind: 'GRANT.EXPIRING', messageKey: 'notification.kind.GRANT.EXPIRING', messageParams: { capability: 'PROC.PR.RELEASE', date: '' }, ...key });
      await notifyOn(tx, { client, recipient: clerk, kind: 'GRANT.EXPIRING', messageKey: 'notification.kind.GRANT.EXPIRING', messageParams: { capability: 'PROC.PR.RELEASE', date: '' }, ...key });
    });

    const after = (await listInbox(client, clerk)).filter((r) => r.objectKey === grantExp).length;
    expect(after).toBe(before + 1);
  });
});

describe('opening a notification takes you to the thing it is about', () => {
  /**
   * The routing table is data that rots. A screen gets renamed, a parameter
   * gets dropped, and the table keeps pointing at a URL that now 404s or —
   * worse — quietly ignores the parameter and opens an unfiltered list that
   * looks like the right document. These two assertions are the ones that
   * catch that, and they are why the table can be a plain object: the
   * coupling to the catalogue is checked here rather than imported there.
   */
  it('points every route at a screen that exists', () => {
    const known = new Set(SCREENS.map((screen) => screen.path));
    for (const [objectClass, entry] of Object.entries(NOTIFICATION_ROUTES)) {
      expect(known.has(entry.path), `${objectClass} -> ${entry.path}`).toBe(true);
    }
  });

  it('only uses parameters the target screen declares it accepts', () => {
    const byPath = new Map(SCREENS.map((screen) => [screen.path, screen]));
    for (const [objectClass, entry] of Object.entries(NOTIFICATION_ROUTES)) {
      const screen = byPath.get(entry.path)!;
      if (!entry.param) continue;
      expect(
        screen.accepts.includes(entry.param),
        `${objectClass} -> ${entry.path}?${entry.param}`,
      ).toBe(true);
    }
  });

  it('routes a document class to the screen that shows that document', () => {
    expect(
      routeForNotification({
        objectClass: 'purchase_requisition',
        objectKey: '1000000007',
        recipient: 'someone',
      }),
    ).toBe('/purchasing/requisitions?req=1000000007');

    expect(
      routeForNotification({
        objectClass: 'purchase_order',
        objectKey: '4500000001',
        recipient: 'someone',
      }),
    ).toBe('/purchasing/purchase-order-display?order=4500000001');

    expect(
      routeForNotification({
        objectClass: 'sales_order',
        objectKey: '20000001',
        recipient: 'someone',
      }),
    ).toBe('/sales/orders?order=20000001');
  });

  it('falls back rather than guessing for a class with no obvious home', () => {
    // Both are deliberately absent from the table. An output message has no
    // screen keyed by message, and a closed session has nothing to show.
    expect(
      routeForNotification({
        objectClass: 'output_message',
        objectKey: 'x',
        recipient: 'someone',
      }),
    ).toBeNull();

    expect(
      routeForNotification({
        objectClass: 'user_session',
        objectKey: 'x',
        recipient: 'someone',
      }),
    ).toBeNull();

    expect(
      routeForNotification({
        objectClass: 'something_not_invented_yet',
        objectKey: 'x',
        recipient: 'someone',
      }),
    ).toBeNull();
  });

  it('sends an expiring grant to the person who holds it, not to the grant id', () => {
    // The authority screen filters by user. The object key is the grant, which
    // that screen has never heard of, so the row's recipient is what names the
    // person — no lookup needed to answer a question the row already answers.
    expect(
      routeForNotification({
        objectClass: 'user_capability',
        objectKey: 'grant-abc',
        recipient: 'u-holder',
      }),
    ).toBe('/people/authority?user=u-holder');
  });

  it('lands a job on the jobs page without pretending to open the run', () => {
    // The jobs screen accepts no filter, so a run id in the query would be
    // silently dropped and the page would look like it had opened the wrong run.
    expect(
      routeForNotification({ objectClass: 'job_run', objectKey: 'run-9', recipient: 'someone' }),
    ).toBe('/platform/jobs');
  });

  it('encodes a key that is not safe in a query string', () => {
    // What matters is that a key cannot inject a second parameter: &, = and
    // space are escaped, so the value stays one value. encodeURIComponent
    // leaves the apostrophe alone, which is correct rather than an oversight —
    // it is legal in a query value and needs no escaping there.
    expect(
      routeForNotification({
        objectClass: 'purchase_order',
        objectKey: "45'0000 001&x=1",
        recipient: 'someone',
      }),
    ).toBe("/purchasing/purchase-order-display?order=45'0000%20001%26x%3D1");
  });

  it('has nothing to route when there is no key', () => {
    expect(
      routeForNotification({ objectClass: 'purchase_order', objectKey: '', recipient: 'someone' }),
    ).toBeNull();
  });

  it('takes you to the document, having read the row back', async () => {
    const id = await withTenant(client, async (tx) =>
      notifyOn(tx, {
        client,
        recipient: managerA,
        kind: 'DOC.RELEASED',
        objectClass: 'purchase_requisition',
        objectKey: '1000000009',
        messageKey: 'notification.kind.DOC.RELEASED',
        messageParams: { document: '1000000009' },
      }),
    );

    const row = await getNotification(client, managerA, id!);
    expect(row).toBeTruthy();
    expect(routeForNotification(row!)).toBe('/purchasing/requisitions?req=1000000009');
  });

  it('gives you nothing to route when the row is not yours', async () => {
    const id = await withTenant(client, async (tx) =>
      notifyOn(tx, {
        client,
        recipient: clerk,
        kind: 'JOB.COMPLETED',
        objectClass: 'job_run',
        objectKey: 'run-private',
        messageKey: 'notification.kind.JOB.COMPLETED',
        messageParams: { job: 'X' },
      }),
    );

    // The recipient term of the policy makes this null rather than a row that
    // should not have been readable. The caller falls back to the inbox, which
    // is the same as being told nothing.
    expect(await getNotification(client, managerA, id!)).toBeNull();
  });
});
