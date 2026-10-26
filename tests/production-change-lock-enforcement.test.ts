/**
 * The change lock is enforced where the write happens — CAIRN.md §24.
 *
 * `tests/production-screen-lock.test.ts` proves the two production screens ask for the lock
 * correctly. This file proves the other half: the write actions refuse a change that the session
 * does not own, against a real database, a real `enqueue` row and a real `user_session`. Nothing
 * here is a source-text assertion. Each case signs in a session row, takes or releases the lock
 * through the platform's own helpers, calls the action the screen calls, and then reads the row
 * back — because the whole point of the guard is that nothing was written.
 *
 * The bug this pins: both screens were capability-gated only, so a request that never opened the
 * row in change could still write it, and two sessions editing the same version or routing met
 * only at the optimistic `version` check — the loser got "changed by someone else" after doing the
 * work, instead of being refused before any of it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SessionContext } from '@/platform/auth/session';

const request = vi.hoisted(() => ({ session: null as SessionContext | null }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/platform/auth/current', async (original) => {
  const actual = await original<typeof import('@/platform/auth/current')>();
  const { hasCapability } = await import('@/platform/auth/session');
  const resolve = async () => {
    if (!request.session) throw new Error('AUTH_REDIRECT');
    return request.session;
  };
  return {
    ...actual,
    requireSession: vi.fn(resolve),
    // Only the request plumbing is replaced: the real `requireCapability` reads the cookie through
    // `requireSession` in its own module, which no test has. The authority test below is the
    // production one — the same `hasCapability` helper and the same `AuthzError` — so a refusal for
    // a missing authority still behaves as it does in the running app.
    requireCapability: vi.fn(async (capability: string) => {
      const resolved = await resolve();
      if (!hasCapability(resolved.user.capabilities, capability)) {
        throw new actual.AuthzError(capability, resolved.user.username);
      }
      return resolved;
    }),
  };
});

import { closeDb, createTenant, destroyTenant, withTenant, type TestTenant } from './helpers';
import { openForChange, releaseChangeLock } from '@/platform/lock/enqueue';
import { saveMaterialView } from '@/modules/inventory/materials';
import { saveBomItemCategory, saveBomUsage, createMaterialBom } from '@/modules/production/material-bom';
import { createWorkCenter, saveWorkCenterCategory } from '@/modules/production/work-center';
import { ROUTING_LOCK, createRouting, saveRoutingControlKey, saveRoutingTaskListType, saveRoutingUsage } from '@/modules/production/routing';
import { PRODUCTION_VERSION_LOCK, createProductionVersion } from '@/modules/production/production-version';
import { checkVersionAction, deleteVersionAction, lockVersionAction, saveVersionAction } from '@/app/production/production-versions/actions';
import { saveRoutingAction } from '@/app/production/routings/actions';

const ACTOR = 'LOCK_TEST';
const PLANT = '1000';
const MATERIAL = 'FG-LOCK';
const VERSION = '0001';
/** The row identity, which is also the lock argument the screen and the action both build. */
const VERSION_ARGUMENT = `${PLANT}/${MATERIAL}/${VERSION}`;
const GROUP = '50000001';
const ROUTING_KEY = `N/${GROUP}/01`;
const ROUTING_ARGUMENT = `N/${GROUP}/01`;

let tenant: TestTenant;

/** One real login each: the session that holds the lock, and a second one that must not borrow it. */
const PEOPLE = {
  holder: { username: 'lock.holder', sessionId: 'pcl-holder-session' },
  bidder: { username: 'lock.bidder', sessionId: 'pcl-bidder-session' },
} as const;

async function addPerson(username: string): Promise<void> {
  await withTenant(tenant.client, (tx) => tx.execute(sql`
    insert into app_user
      (id, client, username, full_name, email, password_hash, is_active, is_locked, created_by)
    values (${`user-${username}`}, ${tenant.client}, ${username}, ${username},
            null, 'test-hash', true, false, 'TEST')
  `));
}

/** A session row, because `purgeStale` judges a lock by the liveness of the session that owns it. */
async function addSession(username: string, sessionId: string): Promise<void> {
  await withTenant(tenant.client, (tx) => tx.execute(sql`
    insert into user_session (id, client, user_id, token_hash, issued_at, expires_at)
    values (${sessionId}, ${tenant.client}, ${`user-${username}`}, ${`token-${sessionId}`},
            now(), now() + interval '8 hours')
  `));
}

function actingAs(person: keyof typeof PEOPLE, capabilities: string[] = ['*']): void {
  const { username, sessionId } = PEOPLE[person];
  request.session = {
    sessionId,
    user: {
      client: tenant.client, userId: `user-${username}`, username, fullName: username,
      email: null, mustChangePassword: false, capabilities,
    },
    expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
    renewed: false,
  } as unknown as SessionContext;
}

function sessionIdOf(person: keyof typeof PEOPLE): string {
  return PEOPLE[person].sessionId;
}

/** The opening the screen performs, taken from the platform rather than written by hand. */
async function hold(lockObject: string, argument: string, person: keyof typeof PEOPLE): Promise<void> {
  await openForChange({
    client: tenant.client,
    sessionId: sessionIdOf(person),
    username: PEOPLE[person].username,
    lockObject,
    argument,
    transactionCode: lockObject === ROUTING_LOCK ? 'CFG.PROD.ROUTING.DEFINE' : 'CFG.PROD.VERSION.DEFINE',
  });
}

async function clear(lockObject: string, argument: string, person: keyof typeof PEOPLE): Promise<void> {
  await releaseChangeLock({ client: tenant.client, sessionId: sessionIdOf(person), lockObject, argument });
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

interface VersionSnapshot {
  description: string | null;
  version: number;
  check_status: string;
  checked_at: string | null;
  changed_at: string | null;
}

/** Everything the guard could have moved. A refusal must leave all of it standing. */
async function versionRow(): Promise<VersionSnapshot | null> {
  const rows = (await withTenant(tenant.client, (tx) => tx.execute(sql`
    select description, version, check_status, checked_at, changed_at
      from production_version
     where client = ${tenant.client} and plant = ${PLANT} and material_number = ${MATERIAL}
       and production_version = ${VERSION}
  `))) as unknown as VersionSnapshot[];
  return rows[0] ?? null;
}

interface RoutingSnapshot {
  description: string | null;
  version: number;
  changed_at: string | null;
}

async function routingRow(): Promise<RoutingSnapshot | null> {
  const rows = (await withTenant(tenant.client, (tx) => tx.execute(sql`
    select description, version, changed_at
      from routing
     where client = ${tenant.client} and task_list_type = 'N' and routing_group = ${GROUP} and group_counter = '01'
  `))) as unknown as RoutingSnapshot[];
  return rows[0] ?? null;
}

async function changeDocCount(objectClass: string, objectKey: string): Promise<number> {
  const rows = (await withTenant(tenant.client, (tx) => tx.execute(sql`
    select count(*)::int as count from change_document
     where client = ${tenant.client} and object_class = ${objectClass} and object_key = ${objectKey}
  `))) as unknown as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
}

/** The act forms carry the row identity only, exactly as the screen posts them. */
function versionIdentity(): Record<string, string> {
  return { materialNumber: MATERIAL, plant: PLANT, productionVersion: VERSION };
}

/** The notice a redirected act action left behind, decoded from the redirect it threw. */
async function noticeOf(action: Promise<unknown>): Promise<string> {
  try {
    await action;
    return '';
  } catch (error) {
    const digest = typeof (error as { digest?: unknown })?.digest === 'string' ? (error as { digest: string }).digest : String(error);
    const encoded = /notice=([^&]*)/.exec(digest)?.[1] ?? digest;
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
}

beforeAll(async () => {
  tenant = await createTenant('production-change-lock-0');
  await addPerson(PEOPLE.holder.username);
  await addPerson(PEOPLE.bidder.username);
  await addSession(PEOPLE.holder.username, PEOPLE.holder.sessionId);
  await addSession(PEOPLE.bidder.username, PEOPLE.bidder.sessionId);

  await saveMaterialView({
    client: tenant.client, materialNumber: MATERIAL, changedBy: ACTOR, expectedVersion: 0,
    reason: 'Lock test', view: 'BASIC', description: 'Locked FG', materialType: 'RAW',
    materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'M', barcode: '',
    grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
  });
  await saveMaterialView({
    client: tenant.client, materialNumber: MATERIAL, changedBy: ACTOR, expectedVersion: 0,
    reason: 'Lock test', view: 'PURCHASING', plant: PLANT,
    purchasingGroup: '', orderUnit: 'KG', overdeliveryTolerance: '0',
    underdeliveryTolerance: '0', manufacturerPartNumber: '',
  });
  await saveMaterialView({
    client: tenant.client, materialNumber: MATERIAL, changedBy: ACTOR, expectedVersion: 1,
    reason: 'Lock test', view: 'MRP', plant: PLANT,
    mrpType: 'NONE', mrpController: '', procurementType: 'MAKE', lotSizing: 'EXACT',
    fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0', safetyStock: '0', reorderPoint: '0',
    plannedDeliveryDays: 0, inHouseProductionDays: 0,
  });
  await saveMaterialView({
    client: tenant.client, materialNumber: 'COMP-LOCK', changedBy: ACTOR, expectedVersion: 0,
    reason: 'Lock test', view: 'BASIC', description: 'Locked component', materialType: 'RAW',
    materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'M', barcode: '',
    grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
  });
  await saveMaterialView({
    client: tenant.client, materialNumber: 'COMP-LOCK', changedBy: ACTOR, expectedVersion: 0,
    reason: 'Lock test', view: 'PURCHASING', plant: PLANT,
    purchasingGroup: '', orderUnit: 'KG', overdeliveryTolerance: '0',
    underdeliveryTolerance: '0', manufacturerPartNumber: '',
  });
  await saveBomUsage({ client: tenant.client, changedBy: ACTOR, usage: 'P', description: 'Production', productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.' });
  await saveBomItemCategory({ client: tenant.client, changedBy: ACTOR, category: 'S', description: 'Stock', materialEntry: '+', quantityEntry: '+' });
  await createMaterialBom({
    client: tenant.client, changedBy: ACTOR, materialNumber: MATERIAL, plant: PLANT, usage: 'P',
    alternative: '01', baseQuantity: '1', baseUnit: 'KG', validFrom: '2026-01-01',
    items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'COMP-LOCK', quantity: '2', unit: 'KG' }],
  });
  await saveRoutingTaskListType({ client: tenant.client, changedBy: ACTOR, taskListType: 'N', description: 'Routing' });
  await saveRoutingUsage({ client: tenant.client, changedBy: ACTOR, usage: '1', description: 'Production' });
  await saveRoutingControlKey({ client: tenant.client, changedBy: ACTOR, controlKey: 'PP01', description: 'Internal' });
  await saveWorkCenterCategory({ client: tenant.client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
  await createWorkCenter({ client: tenant.client, changedBy: ACTOR, plant: PLANT, workCenter: 'WC01', category: 'MACH', description: 'Assembly' });
  await createRouting({
    client: tenant.client, changedBy: ACTOR, taskListType: 'N', plant: PLANT, usage: '1',
    routingGroup: GROUP, groupCounter: '01', baseQuantity: '1', baseUnit: 'KG', validFrom: '2026-01-01',
    assignments: [{ materialNumber: MATERIAL }],
    operations: [{ operationNumber: '0010', shortText: 'Cut', workCenter: 'WC01', controlKey: 'PP01' }],
  });
  await createProductionVersion({
    client: tenant.client, changedBy: ACTOR, materialNumber: MATERIAL, plant: PLANT, productionVersion: VERSION,
    description: 'As created', validFrom: '2026-01-01', lotFrom: '0', lotTo: '100', lotUnit: 'KG',
    bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: GROUP, groupCounter: '01',
  });
});

afterAll(async () => {
  await withTenant(tenant.client, (tx) => tx.execute(sql`delete from enqueue_entry where client = ${tenant.client}`));
  await destroyTenant(tenant.client);
  await closeDb();
});

describe('the production version write actions hold to the change lock', () => {
  it('lets the session that was granted the lock change the version', async () => {
    actingAs('holder');
    await hold(PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT, 'holder');
    try {
      const standing = await versionRow();
      const result = await saveVersionAction({ ok: false }, form({
        mode: 'CHANGE',
        version: String(standing?.version ?? 0),
        ...versionIdentity(),
        description: 'Changed by the holder',
        validFrom: '2026-01-01',
        lotFrom: '0', lotTo: '100', lotUnit: 'KG',
        bomUsage: 'P', bomAlternative: '01',
        taskListType: 'N', routingGroup: GROUP, groupCounter: '01',
        receivingStorageLocation: '', changeNumber: '', requestKey: '',
      }));

      expect(result.ok).toBe(true);
      expect(result.version?.description).toBe('Changed by the holder');
      const after = await versionRow();
      expect(after?.description).toBe('Changed by the holder');
      expect(after?.version).toBe((standing?.version ?? 0) + 1);
    } finally {
      await clear(PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT, 'holder');
    }
  });

  it('refuses a change with no lock taken, and writes nothing', async () => {
    actingAs('holder');
    const before = await versionRow();
    const documents = await changeDocCount('production_version', VERSION_ARGUMENT);

    const result = await saveVersionAction({ ok: false }, form({
      mode: 'CHANGE',
      version: String(before?.version ?? 0),
      ...versionIdentity(),
      description: 'Changed without a lock',
      validFrom: '2026-01-01', lotFrom: '0', lotTo: '100', lotUnit: 'KG',
      bomUsage: 'P', bomAlternative: '01',
      taskListType: 'N', routingGroup: GROUP, groupCounter: '01',
      receivingStorageLocation: '', changeNumber: '', requestKey: '',
    }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain('is not open for change in this session');
    expect(result.remedy).toContain('Open the object in change');
    expect(await versionRow()).toEqual(before);
    expect(await changeDocCount('production_version', VERSION_ARGUMENT)).toBe(documents);
  });

  it('refuses a second session while the row is open elsewhere, and names who holds it', async () => {
    actingAs('holder');
    await hold(PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT, 'holder');
    try {
      actingAs('bidder');
      const before = await versionRow();
      const result = await saveVersionAction({ ok: false }, form({
        mode: 'CHANGE',
        version: String(before?.version ?? 0),
        ...versionIdentity(),
        description: 'Changed over another session',
        validFrom: '2026-01-01', lotFrom: '0', lotTo: '100', lotUnit: 'KG',
        bomUsage: 'P', bomAlternative: '01',
        taskListType: 'N', routingGroup: GROUP, groupCounter: '01',
        receivingStorageLocation: '', changeNumber: '', requestKey: '',
      }));

      expect(result.ok).toBe(false);
      expect(result.message).toContain(`is being changed by ${PEOPLE.holder.username}`);
      expect(result.message).toContain('This session cannot change it');
      expect(await versionRow()).toEqual(before);
    } finally {
      actingAs('holder');
      await clear(PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT, 'holder');
    }
  });

  it('refuses a change after the lock was released, on the lifecycle the screen itself uses', async () => {
    actingAs('holder');
    await hold(PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT, 'holder');
    await clear(PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT, 'holder');
    const before = await versionRow();

    const result = await saveVersionAction({ ok: false }, form({
      mode: 'CHANGE',
      version: String(before?.version ?? 0),
      ...versionIdentity(),
      description: 'Changed after releasing',
      validFrom: '2026-01-01', lotFrom: '0', lotTo: '100', lotUnit: 'KG',
      bomUsage: 'P', bomAlternative: '01',
      taskListType: 'N', routingGroup: GROUP, groupCounter: '01',
      receivingStorageLocation: '', changeNumber: '', requestKey: '',
    }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain('is not open for change in this session');
    expect(await versionRow()).toEqual(before);
  });

  it('refuses a change whose session has expired, even while its lock row still stands', async () => {
    actingAs('holder');
    await hold(PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT, 'holder');
    const before = await versionRow();
    await withTenant(tenant.client, (tx) => tx.execute(
      sql`update user_session set expires_at = now() - interval '1 minute' where id = ${sessionIdOf('holder')}`,
    ));
    try {
      const result = await saveVersionAction({ ok: false }, form({
        mode: 'CHANGE',
        version: String(before?.version ?? 0),
        ...versionIdentity(),
        description: 'Changed on an expired session',
        validFrom: '2026-01-01', lotFrom: '0', lotTo: '100', lotUnit: 'KG',
        bomUsage: 'P', bomAlternative: '01',
        taskListType: 'N', routingGroup: GROUP, groupCounter: '01',
        receivingStorageLocation: '', changeNumber: '', requestKey: '',
      }));

      expect(result.ok).toBe(false);
      expect(result.message).toContain('is not open for change in this session');
      expect(await versionRow()).toEqual(before);
    } finally {
      await withTenant(tenant.client, (tx) => tx.execute(
        sql`update user_session set expires_at = now() + interval '8 hours' where id = ${sessionIdOf('holder')}`,
      ));
      await clear(PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT, 'holder');
    }
  });

  it('refuses a change that presents a lock taken on another row', async () => {
    // The form is what names the row, so a held lock must be the lock on *that* row. Holding the
    // lock of version 0002 buys nothing for a write against 0001.
    actingAs('holder');
    await hold(PRODUCTION_VERSION_LOCK, `${PLANT}/${MATERIAL}/0002`, 'holder');
    const before = await versionRow();
    try {
      const result = await saveVersionAction({ ok: false }, form({
        mode: 'CHANGE',
        version: String(before?.version ?? 0),
        ...versionIdentity(),
        description: 'Changed with a lock meant for another row',
        validFrom: '2026-01-01', lotFrom: '0', lotTo: '100', lotUnit: 'KG',
        bomUsage: 'P', bomAlternative: '01',
        taskListType: 'N', routingGroup: GROUP, groupCounter: '01',
        receivingStorageLocation: '', changeNumber: '', requestKey: '',
      }));

      expect(result.ok).toBe(false);
      expect(result.message).toContain(`${PRODUCTION_VERSION_LOCK} ${VERSION_ARGUMENT} is not open for change in this session`);
      expect(await versionRow()).toEqual(before);
    } finally {
      await clear(PRODUCTION_VERSION_LOCK, `${PLANT}/${MATERIAL}/0002`, 'holder');
    }
  });

  it('creates a version without taking a lock, because nothing stands there yet', async () => {
    actingAs('holder');
    const result = await saveVersionAction({ ok: false }, form({
      mode: 'CREATE',
      materialNumber: MATERIAL, plant: PLANT, productionVersion: '0002',
      description: 'Created with no lock',
      validFrom: '2026-02-01', lotFrom: '0', lotTo: '100', lotUnit: 'KG',
      bomUsage: 'P', bomAlternative: '01',
      taskListType: 'N', routingGroup: GROUP, groupCounter: '01',
      receivingStorageLocation: '', changeNumber: '', requestKey: 'pcl-create-1', version: '',
    }));

    expect(result.ok).toBe(true);
    expect(result.version?.productionVersion).toBe('0002');
  });

  it('keeps the authority check in front of the lock', async () => {
    actingAs('holder');
    await hold(PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT, 'holder');
    try {
      actingAs('holder', []);
      await expect(saveVersionAction({ ok: false }, form({
        mode: 'CHANGE',
        version: String((await versionRow())?.version ?? 0),
        ...versionIdentity(),
        description: 'Refused before the lock was even read',
        validFrom: '2026-01-01', lotFrom: '0', lotTo: '100', lotUnit: 'KG',
        bomUsage: 'P', bomAlternative: '01',
        taskListType: 'N', routingGroup: GROUP, groupCounter: '01',
        receivingStorageLocation: '', changeNumber: '', requestKey: '',
      }))).rejects.toThrow(/does not hold the authority/);
    } finally {
      actingAs('holder');
      await clear(PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT, 'holder');
    }
  });
});

describe('the production version act forms hold to the change lock too', () => {
  it('refuses check, lock and delete with no lock, and the row keeps every value it had', async () => {
    actingAs('holder');
    const before = await versionRow();
    const documents = await changeDocCount('production_version', VERSION_ARGUMENT);

    const check = await noticeOf(checkVersionAction(form(versionIdentity())));
    const lock = await noticeOf(lockVersionAction(form({ ...versionIdentity(), version: '0', locked: '1' })));
    const deletion = await noticeOf(deleteVersionAction(form({ ...versionIdentity(), version: '0' })));

    expect(check).toContain('is not open for change in this session');
    expect(lock).toContain('is not open for change in this session');
    expect(deletion).toContain('is not open for change in this session');
    expect(await versionRow()).toEqual(before);
    expect(await changeDocCount('production_version', VERSION_ARGUMENT)).toBe(documents);
  });

  it('lets the holder run them, so the guard does not lock out legitimate work', async () => {
    actingAs('holder');
    await hold(PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT, 'holder');
    try {
      const before = await versionRow();
      const notice = await noticeOf(checkVersionAction(form(versionIdentity())));
      expect(notice).not.toContain('is not open for change in this session');

      // A check is a write, which is why it belongs under the lock: `checkProductionVersion`
      // stamps the check result and moves the header revision, while leaving the business fields
      // alone. So the holder gets through and the row still says what the last change said.
      const after = await versionRow();
      expect(after?.checked_at).not.toBe(before?.checked_at);
      expect(after?.version).toBe((before?.version ?? 0) + 1);
      expect(after?.description).toBe(before?.description);
    } finally {
      await clear(PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT, 'holder');
    }
  });
});

describe('the routing write action holds to the change lock', () => {
  function routingForm(mode: 'CREATE' | 'CHANGE', extra: Record<string, string> = {}): FormData {
    return form({
      mode,
      taskListType: 'N', routingGroup: mode === 'CHANGE' ? GROUP : '50000002', groupCounter: '01',
      plant: PLANT,
      description: mode === 'CHANGE' ? 'Routed by the holder' : 'Created with no lock',
      usage: '1', status: '', baseQuantity: '1', baseUnit: 'KG',
      lotFrom: '', lotTo: '', validFrom: '2026-01-01', validTo: '', deletionFlag: '', changeNumber: '',
      assignments: MATERIAL,
      operations: '0010|Cut|WC01|PP01',
      requestKey: mode === 'CHANGE' ? '' : 'pcl-routing-create-1',
      version: mode === 'CHANGE' ? '0' : '',
      ...extra,
    });
  }

  it('refuses a routing change with no lock taken, and writes nothing', async () => {
    actingAs('holder');
    const before = await routingRow();
    const documents = await changeDocCount('routing', ROUTING_KEY);

    const result = await saveRoutingAction({ ok: false }, routingForm('CHANGE', { version: String(before?.version ?? 0) }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain(`${ROUTING_LOCK} ${ROUTING_ARGUMENT} is not open for change in this session`);
    expect(await routingRow()).toEqual(before);
    expect(await changeDocCount('routing', ROUTING_KEY)).toBe(documents);
  });

  it('refuses a routing change another session holds, and refuses it again once that lock is released', async () => {
    actingAs('holder');
    await hold(ROUTING_LOCK, ROUTING_ARGUMENT, 'holder');
    actingAs('bidder');
    const before = await routingRow();
    const contested = await saveRoutingAction({ ok: false }, routingForm('CHANGE', { version: String(before?.version ?? 0) }));
    expect(contested.ok).toBe(false);
    expect(contested.message).toContain(`is being changed by ${PEOPLE.holder.username}`);

    // The bidder cannot release the holder's lock to get their way.
    await clear(ROUTING_LOCK, ROUTING_ARGUMENT, 'bidder');
    expect(await routingRow()).toEqual(before);
    const afterReleaseAttempt = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select owner_user from enqueue_entry
       where client = ${tenant.client} and lock_object = ${ROUTING_LOCK} and argument = ${ROUTING_ARGUMENT}
    `)) as unknown as Array<{ owner_user: string }>;
    expect(afterReleaseAttempt[0]?.owner_user).toBe(PEOPLE.holder.username);

    actingAs('holder');
    await clear(ROUTING_LOCK, ROUTING_ARGUMENT, 'holder');
    const released = await saveRoutingAction({ ok: false }, routingForm('CHANGE', { version: String(before?.version ?? 0) }));
    expect(released.ok).toBe(false);
    expect(released.message).toContain('is not open for change in this session');
  });

  it('refuses a routing whose lock has gone stale on its heartbeat, sweeping it the way the platform does', async () => {
    actingAs('holder');
    await hold(ROUTING_LOCK, ROUTING_ARGUMENT, 'holder');
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      update enqueue_entry set heartbeat_at = now() - interval '4 minutes'
       where client = ${tenant.client} and lock_object = ${ROUTING_LOCK} and argument = ${ROUTING_ARGUMENT}
    `));
    const before = await routingRow();

    const result = await saveRoutingAction({ ok: false }, routingForm('CHANGE', { version: String(before?.version ?? 0) }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('is not open for change in this session');
    expect(await routingRow()).toEqual(before);

    // A stale lock is swept, so the next session in line gets change rather than waiting it out.
    actingAs('bidder');
    const reopened = await saveRoutingAction({ ok: false }, routingForm('CHANGE', { version: String(before?.version ?? 0) }));
    expect(reopened.ok).toBe(false);
    expect(reopened.message).toContain('is not open for change in this session');
  });

  it('lets the session holding the routing save it', async () => {
    actingAs('holder');
    await hold(ROUTING_LOCK, ROUTING_ARGUMENT, 'holder');
    try {
      const before = await routingRow();
      const result = await saveRoutingAction({ ok: false }, routingForm('CHANGE', {
        version: String(before?.version ?? 0),
        description: 'Changed by the holder',
      }));

      expect(result.ok).toBe(true);
      expect(result.routing?.description).toBe('Changed by the holder');
      expect((await routingRow())?.version).toBe((before?.version ?? 0) + 1);
    } finally {
      await clear(ROUTING_LOCK, ROUTING_ARGUMENT, 'holder');
    }
  });

  it('refuses a routing change that presents the lock of another group', async () => {
    actingAs('holder');
    await hold(ROUTING_LOCK, 'N/50000002/01', 'holder');
    const before = await routingRow();
    try {
      const result = await saveRoutingAction({ ok: false }, routingForm('CHANGE', { version: String(before?.version ?? 0) }));
      expect(result.ok).toBe(false);
      expect(result.message).toContain(`${ROUTING_LOCK} ${ROUTING_ARGUMENT} is not open for change in this session`);
      expect(await routingRow()).toEqual(before);
    } finally {
      // Released whatever the assertions did, so the next case does not inherit this lock.
      await clear(ROUTING_LOCK, 'N/50000002/01', 'holder');
    }
  });

  it('creates a routing without a lock, and takes no lock for a new group', async () => {
    actingAs('holder');
    const result = await saveRoutingAction({ ok: false }, routingForm('CREATE'));

    expect(result.ok).toBe(true);
    expect(result.routing?.routingGroup).toBe('50000002');
    const standing = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select 1 from enqueue_entry
       where client = ${tenant.client} and lock_object = ${ROUTING_LOCK} and argument = ${`N/50000002/01`}
    `)) as unknown as unknown[];
    expect(standing).toHaveLength(0);
  });
});
