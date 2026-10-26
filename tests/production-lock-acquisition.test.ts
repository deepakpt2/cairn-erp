/**
 * Who may take the change lock on a standing production version or routing — CAIRN.md §24.
 *
 * Stage 1 step 4 taught these two screens to ask for the lock correctly, and step 5 put the lock in
 * front of the writes. Both left one thing unsaid: a session holding only the create capability took
 * the lock anyway, and then sat on a row it could not change — shutting an editor out of it. These
 * cases render the two screens against a real tenant with real sessions and read `enqueue_entry`
 * back, because the only proof that matters is whether a lock row exists and whose session owns it.
 *
 * Every case here is executable: no source-text assertions. Where the UI hands a capability to a
 * client form, the prop it was given is asserted, and the affordance's behaviour is asserted through
 * the action that serves it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type { SessionContext } from '@/platform/auth/session';

// The pages are transformed to the classic runtime (`React.createElement`) because the project
// tsconfig keeps `jsx: "preserve"`; they are called directly, so that global is all they need.
vi.stubGlobal('React', React);

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
    // `can` stays the real one, so the capability set below is judged by the platform's own
    // whole-segment matching. Only the cookie lookup is replaced.
    requireSession: vi.fn(resolve),
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
import { releaseChangeLock } from '@/platform/lock/enqueue';
import { saveMaterialView } from '@/modules/inventory/materials';
import { createMaterialBom, saveBomItemCategory, saveBomUsage } from '@/modules/production/material-bom';
import { createWorkCenter, saveWorkCenterCategory } from '@/modules/production/work-center';
import { ROUTING_LOCK, createRouting, saveRoutingControlKey, saveRoutingTaskListType, saveRoutingUsage } from '@/modules/production/routing';
import { PRODUCTION_VERSION_LOCK, createProductionVersion } from '@/modules/production/production-version';
import { copyVersionAction, saveVersionAction } from '@/app/production/production-versions/actions';
import { saveRoutingAction } from '@/app/production/routings/actions';
import ProductionVersionsPage from '@/app/production/production-versions/page';
import VersionForm from '@/app/production/production-versions/VersionForm';
import RoutingsPage from '@/app/production/routings/page';
import RoutingForm from '@/app/production/routings/RoutingForm';

const ACTOR = 'ACQ_TEST';
const PLANT = '1000';
const MATERIAL = 'FG-ACQ';
const VERSION = '0001';
const VERSION_ARGUMENT = `${PLANT}/${MATERIAL}/${VERSION}`;
const GROUP = '50000001';
const ROUTING_ARGUMENT = `N/${GROUP}/01`;

const VERSION_CAPS = {
  create: 'PROD.VERSION.CREATE',
  change: 'PROD.VERSION.CHANGE',
  check: 'PROD.VERSION.CHECK',
} as const;
const ROUTING_CAPS = { create: 'PROD.ROUTING.CREATE', change: 'PROD.ROUTING.CHANGE' } as const;

let tenant: TestTenant;

/** Three real logins: a builder, an editor, and a second editor to contend with the first. */
const PEOPLE = {
  creator: { username: 'acq.creator', sessionId: 'acq-creator-session', capabilities: [VERSION_CAPS.create, ROUTING_CAPS.create] },
  editor: { username: 'acq.editor', sessionId: 'acq-editor-session', capabilities: [VERSION_CAPS.create, VERSION_CAPS.change, ROUTING_CAPS.create, ROUTING_CAPS.change] },
  second: { username: 'acq.second', sessionId: 'acq-second-session', capabilities: [VERSION_CAPS.change, ROUTING_CAPS.change] },
} as const;

type Person = keyof typeof PEOPLE;

async function seed(): Promise<void> {
  for (const person of Object.values(PEOPLE)) {
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into app_user
        (id, client, username, full_name, email, password_hash, is_active, is_locked, created_by)
      values (${`user-${person.username}`}, ${tenant.client}, ${person.username}, ${person.username},
              null, 'test-hash', true, false, 'TEST')
    `));
    // A live `user_session` row, because a lock is only honoured while its session is alive.
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into user_session (id, client, user_id, token_hash, issued_at, expires_at)
      values (${person.sessionId}, ${tenant.client}, ${`user-${person.username}`}, ${`token-${person.sessionId}`},
              now(), now() + interval '8 hours')
    `));
  }
}

function actingAs(person: Person, extra: string[] = []): void {
  const { username, sessionId, capabilities } = PEOPLE[person];
  request.session = {
    sessionId,
    user: {
      client: tenant.client, userId: `user-${username}`, username, fullName: username,
      email: null, mustChangePassword: false, capabilities: [...capabilities, ...extra],
    },
    expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
    renewed: false,
  } as unknown as SessionContext;
}

/** A create-only session on the version screen: create, and nothing that writes a standing row. */
function actingAsCreator(): void {
  actingAs('creator');
}

async function enqueueRow(lockObject: string, argument: string) {
  const rows = (await withTenant(tenant.client, (tx) => tx.execute(sql`
    select owner_session_id, owner_user, transaction_code, mode
      from enqueue_entry
     where client = ${tenant.client} and lock_object = ${lockObject} and argument = ${argument}
  `))) as unknown as Array<{
    owner_session_id: string;
    owner_user: string;
    transaction_code: string | null;
    mode: string;
  }>;
  return rows[0] ?? null;
}

async function release(person: Person, lockObject: string, argument: string): Promise<void> {
  await releaseChangeLock({ client: tenant.client, sessionId: PEOPLE[person].sessionId, lockObject, argument });
}

type AnyElement = ReactElement<{ children?: ReactNode }>;

/** The props of the first element of `type` in the tree the page function returned. */
function propsOf(node: unknown, type: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = propsOf(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as AnyElement;
  if (element.type === type) return element.props as Record<string, unknown>;
  return propsOf(element.props.children, type);
}

function versionParams(extra: Record<string, string> = {}): Promise<Record<string, string | string[] | undefined>> {
  return Promise.resolve({ plant: PLANT, material: MATERIAL, version: VERSION, ...extra });
}

function routingParams(extra: Record<string, string> = {}): Promise<Record<string, string | string[] | undefined>> {
  return Promise.resolve({ type: 'N', group: GROUP, counter: '01', ...extra });
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

async function versionDescription(): Promise<string | null> {
  const rows = (await withTenant(tenant.client, (tx) => tx.execute(sql`
    select description from production_version
     where client = ${tenant.client} and plant = ${PLANT} and material_number = ${MATERIAL}
       and production_version = ${VERSION}
  `))) as unknown as Array<{ description: string | null }>;
  return rows[0]?.description ?? null;
}

async function versionRevision(): Promise<number> {
  const rows = (await withTenant(tenant.client, (tx) => tx.execute(sql`
    select version from production_version
     where client = ${tenant.client} and plant = ${PLANT} and material_number = ${MATERIAL}
       and production_version = ${VERSION}
  `))) as unknown as Array<{ version: number }>;
  return rows[0]?.version ?? -1;
}

async function routingRevision(): Promise<number> {
  const rows = (await withTenant(tenant.client, (tx) => tx.execute(sql`
    select version from routing
     where client = ${tenant.client} and task_list_type = 'N' and routing_group = ${GROUP} and group_counter = '01'
  `))) as unknown as Array<{ version: number }>;
  return rows[0]?.version ?? -1;
}

function changeForm(description: string, revision: number): FormData {
  return form({
    mode: 'CHANGE',
    version: String(revision),
    materialNumber: MATERIAL, plant: PLANT, productionVersion: VERSION,
    description, validFrom: '2026-01-01', lotFrom: '0', lotTo: '100', lotUnit: 'KG',
    bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: GROUP, groupCounter: '01',
    receivingStorageLocation: '', changeNumber: '', requestKey: '',
  });
}

beforeAll(async () => {
  tenant = await createTenant('production-lock-acquisition-0');
  await seed();

  for (const materialNumber of [MATERIAL, 'COMP-ACQ']) {
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
      reason: 'Acquisition test', view: 'BASIC', description: `Acquisition ${materialNumber}`,
      materialType: 'RAW', materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'M', barcode: '',
      grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
    });
  }
  await saveMaterialView({
    client: tenant.client, materialNumber: 'COMP-ACQ', changedBy: ACTOR, expectedVersion: 0,
    reason: 'Acquisition test', view: 'PURCHASING', plant: PLANT,
    purchasingGroup: '', orderUnit: 'KG', overdeliveryTolerance: '0',
    underdeliveryTolerance: '0', manufacturerPartNumber: '',
  });
  await saveMaterialView({
    client: tenant.client, materialNumber: MATERIAL, changedBy: ACTOR, expectedVersion: 0,
    reason: 'Acquisition test', view: 'PURCHASING', plant: PLANT,
    purchasingGroup: '', orderUnit: 'KG', overdeliveryTolerance: '0',
    underdeliveryTolerance: '0', manufacturerPartNumber: '',
  });
  await saveMaterialView({
    client: tenant.client, materialNumber: MATERIAL, changedBy: ACTOR, expectedVersion: 1,
    reason: 'Acquisition test', view: 'MRP', plant: PLANT,
    mrpType: 'NONE', mrpController: '', procurementType: 'MAKE', lotSizing: 'EXACT',
    fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0', safetyStock: '0', reorderPoint: '0',
    plannedDeliveryDays: 0, inHouseProductionDays: 0,
  });
  await saveBomUsage({ client: tenant.client, changedBy: ACTOR, usage: 'P', description: 'Production', productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.' });
  await saveBomItemCategory({ client: tenant.client, changedBy: ACTOR, category: 'S', description: 'Stock', materialEntry: '+', quantityEntry: '+' });
  await createMaterialBom({
    client: tenant.client, changedBy: ACTOR, materialNumber: MATERIAL, plant: PLANT, usage: 'P',
    alternative: '01', baseQuantity: '1', baseUnit: 'KG', validFrom: '2026-01-01',
    items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: 'COMP-ACQ', quantity: '2', unit: 'KG' }],
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

describe('a create-only session takes no change lock on a standing row', () => {
  it('leaves the production version unlocked in the enqueue table', async () => {
    actingAsCreator();
    const page = await ProductionVersionsPage({ searchParams: versionParams() });

    expect(await enqueueRow(PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT)).toBeNull();
    // The screen still shows the row — display only, and no invented claim about a holder.
    expect(propsOf(page, VersionForm)).toMatchObject({ locked: true, canCopy: true, document: { materialNumber: MATERIAL } });
  });

  it('leaves the routing unlocked in the enqueue table', async () => {
    actingAsCreator();
    const page = await RoutingsPage({ searchParams: routingParams() });

    expect(await enqueueRow(ROUTING_LOCK, ROUTING_ARGUMENT)).toBeNull();
    expect(propsOf(page, RoutingForm)).toMatchObject({ locked: true });
  });

  it('does not keep the version from an editor who opens it next', async () => {
    actingAsCreator();
    await ProductionVersionsPage({ searchParams: versionParams() });

    actingAs('editor');
    const page = await ProductionVersionsPage({ searchParams: versionParams() });
    try {
      const standing = await enqueueRow(PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT);
      expect(standing).toMatchObject({
        owner_session_id: PEOPLE.editor.sessionId,
        owner_user: PEOPLE.editor.username,
        transaction_code: 'CFG.PROD.VERSION.DEFINE',
        mode: 'EXCLUSIVE',
      });
      expect(propsOf(page, VersionForm)).toMatchObject({ locked: false });

      // And that editor can write, which is the whole point of the row being free.
      const result = await saveVersionAction({ ok: false }, changeForm('Saved by the editor after a look', await versionRevision()));
      expect(result.ok).toBe(true);
      expect(await versionDescription()).toBe('Saved by the editor after a look');
    } finally {
      await release('editor', PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT);
    }
  });

  it('does not keep the routing from an editor who opens it next', async () => {
    actingAsCreator();
    await RoutingsPage({ searchParams: routingParams() });
    expect(await enqueueRow(ROUTING_LOCK, ROUTING_ARGUMENT)).toBeNull();

    actingAs('editor');
    await RoutingsPage({ searchParams: routingParams() });
    try {
      expect(await enqueueRow(ROUTING_LOCK, ROUTING_ARGUMENT)).toMatchObject({
        owner_session_id: PEOPLE.editor.sessionId,
        owner_user: PEOPLE.editor.username,
      });
      const result = await saveRoutingAction({ ok: false }, form({
        mode: 'CHANGE', taskListType: 'N', routingGroup: GROUP, groupCounter: '01', plant: PLANT,
        description: 'Changed by the editor after a look', usage: '1', status: '',
        baseQuantity: '1', baseUnit: 'KG', lotFrom: '', lotTo: '', validFrom: '2026-01-01', validTo: '',
        deletionFlag: '', changeNumber: '', assignments: MATERIAL, operations: '0010|Cut|WC01|PP01',
        requestKey: '', version: String(await routingRevision()),
      }));
      expect(result).toMatchObject({ ok: true });
      expect(result.routing?.description).toBe('Changed by the editor after a look');
    } finally {
      await release('editor', ROUTING_LOCK, ROUTING_ARGUMENT);
    }
  });
});

describe('an entitled session still gets the lock, and keeps what it means', () => {
  it('takes and owns the version lock, then saves under it', async () => {
    actingAs('editor');
    const page = await ProductionVersionsPage({ searchParams: versionParams() });
    expect(propsOf(page, VersionForm)).toMatchObject({ locked: false });
    const revision = await versionRevision();
    try {
      const result = await saveVersionAction({ ok: false }, changeForm('Saved under the lock', revision));
      expect(result.ok).toBe(true);
      expect(await versionDescription()).toBe('Saved under the lock');
      expect(await versionRevision()).toBe(revision + 1);
    } finally {
      await release('editor', PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT);
    }
  });

  it('holds the row against a second editor, who is refused and writes nothing', async () => {
    actingAs('editor');
    await ProductionVersionsPage({ searchParams: versionParams() });
    const revision = await versionRevision();
    try {
      actingAs('second');
      const contention = await ProductionVersionsPage({ searchParams: versionParams() });
      expect(await enqueueRow(PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT)).toMatchObject({
        owner_session_id: PEOPLE.editor.sessionId,
      });
      expect(propsOf(contention, VersionForm)).toMatchObject({ locked: true });

      const refused = await saveVersionAction({ ok: false }, changeForm('Written over another session', revision));
      expect(refused.ok).toBe(false);
      expect(refused.message).toContain(`is being changed by ${PEOPLE.editor.username}`);
      expect(await versionRevision()).toBe(revision);
      expect(await versionDescription()).not.toBe('Written over another session');
    } finally {
      await release('editor', PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT);
    }
  });

  it('is not the UI gate doing the work: a screen-less request is refused by the action itself', async () => {
    // The builder has no lock and no change capability. Even with a hand-built form the save is
    // refused by the authority check, so the disabled screen is a courtesy, not the boundary.
    actingAsCreator();
    const standing = await versionDescription();
    await expect(saveVersionAction({ ok: false }, changeForm('Forged change by a builder', await versionRevision())))
      .rejects.toThrow(/does not hold the authority PROD.VERSION.CHANGE/);
    expect(await enqueueRow(PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT)).toBeNull();
    // Nothing was written: not the row, and not a lock on it.
    expect(await versionDescription()).toBe(standing);
  });
});

describe('creating stays exactly as it was', () => {
  it('opens the create flow for a create-only session without a lock', async () => {
    actingAsCreator();
    const page = await ProductionVersionsPage({ searchParams: versionParams({ create: '1' }) });

    expect(propsOf(page, VersionForm)).toMatchObject({ locked: false });
    expect(await enqueueRow(PRODUCTION_VERSION_LOCK, '1000/FG-ACQ/0002')).toBeNull();

    const result = await saveVersionAction({ ok: false }, form({
      mode: 'CREATE', materialNumber: MATERIAL, plant: PLANT, productionVersion: '0002',
      description: 'Created with no lock', validFrom: '2026-02-01', lotFrom: '0', lotTo: '100', lotUnit: 'KG',
      bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: GROUP, groupCounter: '01',
      receivingStorageLocation: '', changeNumber: '', requestKey: 'acq-create-1', version: '',
    }));
    expect(result.ok).toBe(true);
    expect(result.version?.productionVersion).toBe('0002');
  });

  it('copies from a standing version for that same session, which holds no lock', async () => {
    actingAsCreator();
    await ProductionVersionsPage({ searchParams: versionParams() });
    expect(await enqueueRow(PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT)).toBeNull();
    const standing = await versionDescription();

    const result = await copyVersionAction({ ok: false }, form({
      materialNumber: MATERIAL, plant: PLANT, productionVersion: VERSION, newProductionVersion: '0003',
      description: 'Copied by a builder', validFrom: '2026-03-01', lotFrom: '0', lotTo: '100', lotUnit: 'KG',
      bomUsage: 'P', bomAlternative: '01', taskListType: 'N', routingGroup: GROUP, groupCounter: '01',
      receivingStorageLocation: '', changeNumber: '', requestKey: 'acq-copy-1', version: '',
    }));

    expect(result.ok).toBe(true);
    expect(result.version?.productionVersion).toBe('0003');
    // The source row is untouched and still unlocked.
    expect(await versionDescription()).toBe(standing);
    expect(await enqueueRow(PRODUCTION_VERSION_LOCK, VERSION_ARGUMENT)).toBeNull();
  });

  it('creates a routing without a lock, before and after a builder looked at another', async () => {
    actingAsCreator();
    await RoutingsPage({ searchParams: routingParams() });

    const result = await saveRoutingAction({ ok: false }, form({
      mode: 'CREATE', taskListType: 'N', routingGroup: '50000002', groupCounter: '01', plant: PLANT,
      description: 'Created with no lock', usage: '1', status: '', baseQuantity: '1', baseUnit: 'KG',
      lotFrom: '', lotTo: '', validFrom: '2026-01-01', validTo: '', deletionFlag: '', changeNumber: '',
      assignments: MATERIAL, operations: '0010|Cut|WC01|PP01', requestKey: 'acq-routing-create-1', version: '',
    }));

    expect(result.ok).toBe(true);
    expect(result.routing?.routingGroup).toBe('50000002');
    expect(await enqueueRow(ROUTING_LOCK, 'N/50000002/01')).toBeNull();
  });
});
