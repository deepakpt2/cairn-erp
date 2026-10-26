/**
 * The two production masters beside the version and routing screens enforce the lock they take —
 * CAIRN.md §24.
 *
 * Steps 4 to 6 repaired the production version and routing screens. The same grep over every screen
 * that opens a change lock left exactly two that write a standing document with no `enqueue` check at
 * all: the material BOM screen and the work-center screen. Both take a lock in the page and then let
 * `saveBomAction` / `saveWorkCenterAction` write whoever asks, so the lock only ever discouraged a
 * second editor instead of preventing one. These cases run the real screens and the real writes, and
 * read the tables back: the row the screen locked is the row the action must recognise, and a refused
 * write must leave nothing behind.
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
    // `can` stays the platform's own, so the capability sets below are judged by real
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
import {
  BOM_CHANGE_CAPABILITY,
  BOM_CREATE_CAPABILITY,
  BOM_LOCK,
  createMaterialBom,
  saveBomItemCategory,
  saveBomUsage,
} from '@/modules/production/material-bom';
import {
  WORK_CENTER_CHANGE_CAPABILITY,
  WORK_CENTER_CREATE_CAPABILITY,
  WORK_CENTER_LOCK,
  createWorkCenter,
  saveWorkCenterCategory,
} from '@/modules/production/work-center';
import { saveBomAction, saveUsageAction, type BomActionState } from '@/app/production/boms/actions';
import {
  saveCategoryAction,
  saveWorkCenterAction,
  type WorkCenterActionState,
} from '@/app/production/work-centers/actions';
import MaterialBomsPage from '@/app/production/boms/page';
import BomForm from '@/app/production/boms/BomForm';
import WorkCentersPage from '@/app/production/work-centers/page';
import WorkCenterForm from '@/app/production/work-centers/WorkCenterForm';

const ACTOR = 'MASTER_TEST';
const PLANT = '1000';
const MATERIAL = 'FG-MASTER';
const COMPONENT = 'CMP-MASTER';
const USAGE = 'P';
const ALTERNATIVE = '01';
const BOM_ARGUMENT = `${PLANT}/${MATERIAL}/${USAGE}/${ALTERNATIVE}`;
const CENTER = 'WC01';
const CENTER_ARGUMENT = `${PLANT}/${CENTER}`;

let tenant: TestTenant;

/** Two editors who may both change these masters, and a builder who may only create. */
const PEOPLE = {
  holder: {
    username: 'master.holder', sessionId: 'master-holder-session',
    capabilities: [BOM_CREATE_CAPABILITY, BOM_CHANGE_CAPABILITY, WORK_CENTER_CREATE_CAPABILITY, WORK_CENTER_CHANGE_CAPABILITY],
  },
  bidder: {
    username: 'master.bidder', sessionId: 'master-bidder-session',
    capabilities: [BOM_CREATE_CAPABILITY, BOM_CHANGE_CAPABILITY, WORK_CENTER_CREATE_CAPABILITY, WORK_CENTER_CHANGE_CAPABILITY],
  },
  creator: {
    username: 'master.creator', sessionId: 'master-creator-session',
    capabilities: [BOM_CREATE_CAPABILITY, WORK_CENTER_CREATE_CAPABILITY],
  },
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

function actingAs(person: Person): void {
  const { username, sessionId, capabilities } = PEOPLE[person];
  request.session = {
    sessionId,
    user: {
      client: tenant.client, userId: `user-${username}`, username, fullName: username,
      email: null, mustChangePassword: false, capabilities: [...capabilities],
    },
    expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
    renewed: false,
  } as unknown as SessionContext;
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

/** The lock row the platform holds for one document, read straight from `enqueue_entry`. */
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

async function lockCount(): Promise<number> {
  const rows = (await withTenant(tenant.client, (tx) => tx.execute(sql`
    select count(*)::int as count from enqueue_entry where client = ${tenant.client}
  `))) as unknown as Array<{ count: number }>;
  return rows[0]?.count ?? -1;
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

function bomParams(extra: Record<string, string> = {}): Promise<Record<string, string | string[] | undefined>> {
  return Promise.resolve({ material: MATERIAL, plant: PLANT, usage: USAGE, alternative: ALTERNATIVE, ...extra });
}

function centerParams(extra: Record<string, string> = {}): Promise<Record<string, string | string[] | undefined>> {
  return Promise.resolve({ plant: PLANT, workCenter: CENTER, ...extra });
}

/** Everything the standing BOM header and its lines carry, so a refusal can be checked against it. */
async function bomState() {
  const header = (await withTenant(tenant.client, (tx) => tx.execute(sql`
    select coalesce(header_text, '') as header_text, version, base_quantity::text as base_quantity,
           valid_from::text as valid_from, deletion_flag
      from material_bom
     where client = ${tenant.client} and material_number = ${MATERIAL} and plant = ${PLANT}
       and usage = ${USAGE} and alternative = ${ALTERNATIVE}
  `))) as unknown as Array<{ header_text: string; version: number; base_quantity: string; valid_from: string; deletion_flag: string }>;
  const lines = (await withTenant(tenant.client, (tx) => tx.execute(sql`
    select count(*)::int as count from material_bom_item
     where client = ${tenant.client} and material_number = ${MATERIAL} and plant = ${PLANT}
       and usage = ${USAGE} and alternative = ${ALTERNATIVE}
  `))) as unknown as Array<{ count: number }>;
  return { header: header[0] ?? null, lines: lines[0]?.count ?? -1 };
}

async function centerState() {
  const rows = (await withTenant(tenant.client, (tx) => tx.execute(sql`
    select description, version, coalesce(location, '') as location, deletion_flag
      from work_center
     where client = ${tenant.client} and plant = ${PLANT} and work_center = ${CENTER}
  `))) as unknown as Array<{ description: string; version: number; location: string; deletion_flag: string }>;
  return rows[0] ?? null;
}

function bomChangeForm(version: number, headerText: string): FormData {
  return form({
    mode: 'CHANGE',
    materialNumber: MATERIAL, plant: PLANT, usage: USAGE, alternative: ALTERNATIVE,
    status: '', baseQuantity: '1', baseUnit: 'KG', validFrom: '2026-01-01', validTo: '',
    headerText, changeNumber: '', requestKey: '', version: String(version),
    items: JSON.stringify([{ itemNumber: '0010', itemCategory: 'S', componentMaterial: COMPONENT, quantity: '2', unit: 'KG' }]),
  });
}

function centerChangeForm(version: number, description: string): FormData {
  return form({
    mode: 'CHANGE',
    plant: PLANT, workCenter: CENTER, category: 'MACH', description,
    personResponsible: '', location: 'BAY 2', usage: '', standardValueKey: '', controlKey: '',
    schedulingCapacityCategory: '', schedulingSetupFormula: '', schedulingProcessingFormula: '',
    schedulingTeardownFormula: '', capacities: '[]', costing: '[]', version: String(version),
  });
}

beforeAll(async () => {
  tenant = await createTenant('production-master-lock-0');
  await seed();

  for (const materialNumber of [MATERIAL, COMPONENT]) {
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
      view: 'BASIC', description: `Master ${materialNumber}`,
      materialType: 'RAW', materialGroup: 'RAW', baseUnit: 'KG', industrySector: 'M', barcode: '',
      grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false, reason: 'Master lock test',
    });
    await saveMaterialView({
      client: tenant.client, materialNumber, changedBy: ACTOR, expectedVersion: 0,
      view: 'PURCHASING', plant: PLANT, reason: 'Master lock test',
      purchasingGroup: '', orderUnit: 'KG', overdeliveryTolerance: '0',
      underdeliveryTolerance: '0', manufacturerPartNumber: '',
    });
  }
  await saveMaterialView({
    client: tenant.client, materialNumber: MATERIAL, changedBy: ACTOR, expectedVersion: 1,
    view: 'MRP', plant: PLANT, reason: 'Master lock test',
    mrpType: 'NONE', mrpController: '', procurementType: 'MAKE', lotSizing: 'EXACT',
    fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0', safetyStock: '0', reorderPoint: '0',
    plannedDeliveryDays: 0, inHouseProductionDays: 0,
  });
  await saveBomUsage({ client: tenant.client, changedBy: ACTOR, usage: USAGE, description: 'Production', productionRelevance: '.', engineeringRelevance: '.', costingRelevance: '.', salesRelevance: '.' });
  await saveBomItemCategory({ client: tenant.client, changedBy: ACTOR, category: 'S', description: 'Stock', materialEntry: '+', quantityEntry: '+' });
  await saveWorkCenterCategory({ client: tenant.client, changedBy: ACTOR, category: 'MACH', description: 'Machine' });
  await createWorkCenter({ client: tenant.client, changedBy: ACTOR, plant: PLANT, workCenter: CENTER, category: 'MACH', description: 'Assembly' });
  await createMaterialBom({
    client: tenant.client, changedBy: ACTOR, materialNumber: MATERIAL, plant: PLANT, usage: USAGE,
    alternative: ALTERNATIVE, baseQuantity: '1', baseUnit: 'KG', validFrom: '2026-01-01',
    items: [{ itemNumber: '0010', itemCategory: 'S', componentMaterial: COMPONENT, quantity: '2', unit: 'KG' }],
  });
});

afterAll(async () => {
  await withTenant(tenant.client, (tx) => tx.execute(sql`delete from enqueue_entry where client = ${tenant.client}`));
  await destroyTenant(tenant.client);
  await closeDb();
});

describe('the material BOM screen gets the lock it already takes enforced where the BOM is written', () => {
  it('grants change to the session the screen opened, and lets that save through', async () => {
    actingAs('holder');
    const page = await MaterialBomsPage({ searchParams: bomParams() });

    // The screen's own identity: plant, material, usage, alternative, under the transaction it names.
    expect(await enqueueRow(BOM_LOCK, BOM_ARGUMENT)).toMatchObject({
      owner_session_id: PEOPLE.holder.sessionId,
      owner_user: PEOPLE.holder.username,
      mode: 'EXCLUSIVE',
    });
    expect(propsOf(page, BomForm)).toMatchObject({ locked: false, document: { materialNumber: MATERIAL } });

    const before = await bomState();
    const result = await saveBomAction({ ok: false }, bomChangeForm(before.header?.version ?? 0, 'Text under the lock'));

    expect(result).toMatchObject({ ok: true });
    const after = await bomState();
    expect(after.header?.header_text).toBe('Text under the lock');
    expect(after.header?.version).toBe((before.header?.version ?? 0) + 1);
    expect(after.lines).toBe(before.lines);

    await release('holder', BOM_LOCK, BOM_ARGUMENT);
    expect(await lockCount()).toBe(0);
  });

  it('refuses a change from a session that was never granted the row, and writes nothing', async () => {
    actingAs('bidder');
    const before = await bomState();

    const result = await saveBomAction({ ok: false }, bomChangeForm(before.header?.version ?? 0, 'Written with no lock'));

    expect(result.ok).toBe(false);
    expect(result.message).toContain(`${BOM_LOCK} ${BOM_ARGUMENT} is not open for change in this session`);
    expect(await bomState()).toEqual(before);
    expect(await lockCount()).toBe(0);
  });

  it('shows a BOM another session holds as display only, and refuses that session as well', async () => {
    actingAs('holder');
    await MaterialBomsPage({ searchParams: bomParams() });
    try {
      actingAs('bidder');
      const contested = await MaterialBomsPage({ searchParams: bomParams() });

      // The row stays the holder's, and the screen offers the bidder no form to write with.
      expect(await enqueueRow(BOM_LOCK, BOM_ARGUMENT)).toMatchObject({ owner_user: PEOPLE.holder.username });
      expect(propsOf(contested, BomForm)).toBeNull();

      const before = await bomState();
      const result = await saveBomAction({ ok: false }, bomChangeForm(before.header?.version ?? 0, 'Written over another session'));

      expect(result.ok).toBe(false);
      expect(result.message).toContain(`is being changed by ${PEOPLE.holder.username}`);
      expect(await bomState()).toEqual(before);
    } finally {
      await release('holder', BOM_LOCK, BOM_ARGUMENT);
    }
    expect(await lockCount()).toBe(0);
  });

  it('keeps creating a second alternative free of any lock, for the session that may only create', async () => {
    actingAs('creator');
    const page = await MaterialBomsPage({ searchParams: bomParams({ create: '1', alternative: '02' }) });

    expect(propsOf(page, BomForm)).toMatchObject({ locked: false, document: null });

    const result = await saveBomAction({ ok: false }, form({
      mode: 'CREATE',
      materialNumber: MATERIAL, plant: PLANT, usage: USAGE, alternative: '02',
      status: '', baseQuantity: '1', baseUnit: 'KG', validFrom: '2026-02-01', validTo: '',
      headerText: 'Created with no lock', changeNumber: '', requestKey: 'master-create-1', version: '',
      items: JSON.stringify([{ itemNumber: '0010', itemCategory: 'S', componentMaterial: COMPONENT, quantity: '1', unit: 'KG' }]),
    }));

    expect(result).toMatchObject({ ok: true });
    expect(result.bom?.alternative).toBe('02');
    expect(await enqueueRow(BOM_LOCK, `${PLANT}/${MATERIAL}/${USAGE}/02`)).toBeNull();
    // Opening the standing alternative afterwards still takes nothing for this session.
    await MaterialBomsPage({ searchParams: bomParams() });
    expect(await lockCount()).toBe(0);
  });

  it('leaves the usage master on the same screen a plain configuration write', async () => {
    actingAs('creator');

    const result: BomActionState = await saveUsageAction({ ok: false }, form({
      usage: 'X', description: 'Another usage', productionRelevance: '.', engineeringRelevance: '.',
      costingRelevance: '.', salesRelevance: '.',
    }));

    expect(result).toMatchObject({ ok: true });
    expect(await lockCount()).toBe(0);
  });
});

describe('the work-center screen gets the lock it already takes enforced where the center is written', () => {
  it('grants change to the session the screen opened, and lets that save through', async () => {
    actingAs('holder');
    const page = await WorkCentersPage({ searchParams: centerParams() });

    expect(await enqueueRow(WORK_CENTER_LOCK, CENTER_ARGUMENT)).toMatchObject({
      owner_session_id: PEOPLE.holder.sessionId,
      owner_user: PEOPLE.holder.username,
      mode: 'EXCLUSIVE',
    });
    expect(propsOf(page, WorkCenterForm)).toMatchObject({ locked: false, document: { workCenter: CENTER } });

    const before = await centerState();
    const result = await saveWorkCenterAction({ ok: false }, centerChangeForm(before?.version ?? 0, 'Changed under the lock'));

    expect(result).toMatchObject({ ok: true });
    expect((await centerState())?.description).toBe('Changed under the lock');
    expect((await centerState())?.version).toBe((before?.version ?? 0) + 1);

    await release('holder', WORK_CENTER_LOCK, CENTER_ARGUMENT);
    expect(await lockCount()).toBe(0);
  });

  it('refuses a change from a session that was never granted the center, and writes nothing', async () => {
    actingAs('bidder');
    const before = await centerState();

    const result = await saveWorkCenterAction({ ok: false }, centerChangeForm(before?.version ?? 0, 'Written with no lock'));

    expect(result.ok).toBe(false);
    expect(result.message).toContain(`${WORK_CENTER_LOCK} ${CENTER_ARGUMENT} is not open for change in this session`);
    expect(await centerState()).toEqual(before);
    expect(await lockCount()).toBe(0);
  });

  it('holds the center against another session, which sees no form and is refused', async () => {
    actingAs('holder');
    await WorkCentersPage({ searchParams: centerParams() });
    try {
      actingAs('bidder');
      const contested = await WorkCentersPage({ searchParams: centerParams() });
      expect(await enqueueRow(WORK_CENTER_LOCK, CENTER_ARGUMENT)).toMatchObject({ owner_user: PEOPLE.holder.username });
      expect(propsOf(contested, WorkCenterForm)).toBeNull();

      const before = await centerState();
      const result = await saveWorkCenterAction({ ok: false }, centerChangeForm(before?.version ?? 0, 'Written over another session'));
      expect(result.ok).toBe(false);
      expect(result.message).toContain(`is being changed by ${PEOPLE.holder.username}`);
      expect(await centerState()).toEqual(before);
    } finally {
      await release('holder', WORK_CENTER_LOCK, CENTER_ARGUMENT);
    }
  });

  it('leaves creating a center and saving its category free of any lock', async () => {
    actingAs('creator');
    const page = await WorkCentersPage({ searchParams: Promise.resolve({ create: '1' }) });
    expect(propsOf(page, WorkCenterForm)).toMatchObject({ locked: false, document: null });

    const created: WorkCenterActionState = await saveWorkCenterAction({ ok: false }, form({
      mode: 'CREATE', plant: PLANT, workCenter: 'WC02', category: 'MACH',
      description: 'Created with no lock', personResponsible: '', location: '', usage: '',
      standardValueKey: '', controlKey: '', schedulingCapacityCategory: '', schedulingSetupFormula: '',
      schedulingProcessingFormula: '', schedulingTeardownFormula: '', capacities: '[]', costing: '[]',
      version: '', requestKey: '',
    }));
    expect(created).toMatchObject({ ok: true });
    expect(created.workCenter?.workCenter).toBe('WC02');

    const category = await saveCategoryAction({ ok: false }, form({
      category: 'INSP', description: 'Inspection station',
    }));
    expect(category).toMatchObject({ ok: true });

    expect(await enqueueRow(WORK_CENTER_LOCK, `${PLANT}/WC02`)).toBeNull();
    expect(await lockCount()).toBe(0);
  });
});
