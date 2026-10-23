import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hasCapability } from '../src/platform/auth/session';
import { changeDocument } from '../src/platform/tables/audit-trail';
import { withTenant } from '../src/platform/db/client';
import { activityType, costCenter, factoryCalendar } from '../src/modules/foundation/schema';
import {
  WORK_CENTER_CHANGE_CAPABILITY,
  WORK_CENTER_CREATE_CAPABILITY,
  WORK_CENTER_DISPLAY_CAPABILITY,
  WorkCenterError,
  changeWorkCenter,
  createWorkCenter,
  getWorkCenter,
  holdsWorkCenterAuthority,
  saveWorkCenterCategory,
} from '../src/modules/production/work-center';
import { displayWorkCenter } from '../src/modules/production/work-center-display';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'CR01_TEST';
const clients: string[] = [];
let tenant: TestTenant;
let other: TestTenant;

beforeAll(async () => {
  tenant = await createTenant('cr01-work-center');
  other = await createTenant('cr01-work-center-other');
  clients.push(tenant.client, other.client);
  await withTenant(tenant.client, async (tx) => {
    await tx.execute(sql`insert into unit_of_measure (code, name, dimension) values ('H', 'Hour', 'TIME') on conflict (code) do nothing`);
    await tx.insert(factoryCalendar).values({
      client: tenant.client,
      calendarId: 'IN',
      name: 'India',
      isActive: true,
      createdBy: ACTOR,
    }).onConflictDoNothing();
    await tx.insert(costCenter).values({
      client: tenant.client,
      controllingArea: 'A000',
      costCenter: 'CC1000',
      validFrom: '2020-01-01',
      validTo: '9999-12-31',
      name: 'Assembly',
      category: 'PRODUCTION',
      companyCode: '1000',
      createdBy: ACTOR,
    }).onConflictDoNothing();
    await tx.insert(activityType).values({
      client: tenant.client,
      controllingArea: 'A000',
      activityType: 'MACH',
      validFrom: '2020-01-01',
      validTo: '9999-12-31',
      name: 'Machine',
      activityUnit: 'H',
      category: '1',
      priceIndicator: '1',
      createdBy: ACTOR,
    }).onConflictDoNothing();
  });
});

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

function base(workCenter: string, extra: Record<string, unknown> = {}) {
  return {
    client: tenant.client,
    changedBy: ACTOR,
    plant: '1000',
    workCenter,
    category: 'MACH',
    description: 'Assembly',
    ...extra,
  };
}

describe('work center master', () => {
  it('defines a category and creates a work center without a routing', async () => {
    await saveWorkCenterCategory({
      client: tenant.client,
      changedBy: ACTOR,
      category: 'MACH',
      description: 'Machine',
    });
    const saved = await createWorkCenter(base('WC01', {
      personResponsible: 'A1',
      location: 'HALL-1',
      usage: '009',
      standardValueKey: 'SAP1',
      controlKey: 'PP01',
    }));
    expect(saved.workCenter).toBe('WC01');
    expect(saved.routingReferences).toBe(0);
    expect(saved.productionOrderReferences).toBe(0);
    const again = await getWorkCenter(tenant.client, '1000', 'WC01');
    expect(again?.description).toBe('Assembly');
    expect(again?.version).toBe(1);
  });

  it('refuses a duplicate work center in the same plant', async () => {
    await expect(createWorkCenter(base('WC01'))).rejects.toBeInstanceOf(WorkCenterError);
  });

  it('refuses an unknown plant and an unknown category', async () => {
    await expect(createWorkCenter(base('WC02', { plant: '9999' }))).rejects.toThrow(/Plant 9999/);
    await expect(createWorkCenter(base('WC02', { category: 'ZZZZ' }))).rejects.toThrow(/not defined/);
  });

  it('requires a capacity when the category says so, and accepts it when supplied', async () => {
    await saveWorkCenterCategory({
      client: tenant.client,
      changedBy: ACTOR,
      category: 'REQC',
      description: 'Capacity required',
      requireCapacity: true,
    });
    await expect(createWorkCenter(base('WC03', { category: 'REQC' }))).rejects.toThrow(/requires a capacity/);
    const saved = await createWorkCenter(base('WC03', {
      category: 'REQC',
      capacities: [{
        capacityCategory: '001',
        factoryCalendar: 'IN',
        baseUnit: 'H',
        startTime: '08:00',
        endTime: '16:00',
        breakMinutes: 30,
        utilization: '100',
        individualCapacities: 2,
        finiteScheduling: 'X',
      }],
    }));
    expect(saved.capacities).toHaveLength(1);
    expect(saved.capacities[0].finiteScheduling).toBe('X');
  });

  it('refuses a missing calendar, a bad formula interval, and an unknown cost center', async () => {
    await expect(createWorkCenter(base('WC04', {
      capacities: [{ capacityCategory: '001', factoryCalendar: 'ZZ' }],
    }))).rejects.toThrow(/Factory calendar ZZ/);
    await expect(createWorkCenter(base('WC04', {
      schedulingCapacityCategory: '009',
    }))).rejects.toThrow(/not a capacity/);
    await expect(createWorkCenter(base('WC04', {
      costing: [{ validFrom: '2026-01-01', validTo: '2026-12-31', costCenter: 'NOPE' }],
    }))).rejects.toThrow(/Cost center NOPE/);
  });

  it('stores a costing assignment and a formula without calculating it', async () => {
    const saved = await createWorkCenter(base('WC05', {
      schedulingCapacityCategory: '001',
      schedulingProcessingFormula: 'SAP002',
      capacities: [{ capacityCategory: '001' }],
      costing: [{
        validFrom: '2026-01-01',
        validTo: '2026-12-31',
        costCenter: 'CC1000',
        activityType: 'MACH',
        formula: 'SAP005',
      }],
    }));
    expect(saved.schedulingProcessingFormula).toBe('SAP002');
    expect(saved.costing[0].formula).toBe('SAP005');
    expect(saved.costing[0].controllingArea).toBe('A000');
  });

  it('changes an editable field and refuses a category change', async () => {
    const changed = await changeWorkCenter(base('WC01', { description: 'Assembly line', version: 1 }));
    expect(changed.description).toBe('Assembly line');
    expect(changed.version).toBe(2);
    await expect(changeWorkCenter(base('WC01', { category: 'REQC', version: changed.version }))).rejects.toThrow(/cannot be changed/);
  });

  it('refuses a stale version and leaves the saved description', async () => {
    await expect(changeWorkCenter(base('WC01', { description: 'Lost update', version: 1 }))).rejects.toThrow(/someone else/);
    const standing = await getWorkCenter(tenant.client, '1000', 'WC01');
    expect(standing?.description).toBe('Assembly line');
  });

  it('does not add a work center column to a production order', async () => {
    const columns = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select column_name from information_schema.columns
      where table_name = 'production_order' and column_name = 'work_center'
    `));
    expect(columns).toHaveLength(0);
  });

  it('display reads the center and does not change its version', async () => {
    const before = await getWorkCenter(tenant.client, '1000', 'WC01');
    const shown = await displayWorkCenter(tenant.client, '1000', 'WC01');
    const after = await getWorkCenter(tenant.client, '1000', 'WC01');
    expect(shown?.description).toBe(before?.description);
    expect(after?.version).toBe(before?.version);
    const displaySource = readFileSync('src/modules/production/work-center-display.ts', 'utf8');
    const displayPage = readFileSync('src/app/production/work-center-display/page.tsx', 'utf8');
    expect(displaySource).not.toMatch(/\.(insert|update|delete)\(/);
    expect(displayPage).not.toMatch(/saveWorkCenterAction|openChangeForSession/);
  });

  it('keeps another tenant from reading this work center', async () => {
    expect(await getWorkCenter(other.client, '1000', 'WC01')).toBeNull();
  });

  it('records a change document and grants display only to a matching authority', async () => {
    const rows = await withTenant(tenant.client, (tx) => tx.select().from(changeDocument).where(and(
      eq(changeDocument.client, tenant.client),
      eq(changeDocument.objectClass, 'work_center'),
      eq(changeDocument.objectKey, '1000/WC01'),
    )));
    expect(rows.some((row) => row.changeType === 'CREATE' && row.transactionCode === 'CR01')).toBe(true);
    expect(rows.some((row) => row.changeType === 'CHANGE' && row.transactionCode === 'CR02')).toBe(true);
    expect(holdsWorkCenterAuthority(['PROD.*'], 'CREATE')).toBe(true);
    expect(holdsWorkCenterAuthority(['PROD.CONFIRM.*'], 'CHANGE')).toBe(false);
    expect(hasCapability(['PROD.WORKCENTER.DISPLAY'], WORK_CENTER_DISPLAY_CAPABILITY)).toBe(true);
    expect(hasCapability(['PROD.WORKCENTER.CREATE'], WORK_CENTER_CHANGE_CAPABILITY)).toBe(false);
    expect(WORK_CENTER_CREATE_CAPABILITY).toBe('PROD.WORKCENTER.CREATE');
  });

  it('copies a reference work center into a new key', async () => {
    const copied = await createWorkCenter(base('WC06', {
      description: 'Copied',
      copyFrom: { plant: '1000', workCenter: 'WC05' },
    }));
    expect(copied.workCenter).toBe('WC06');
    expect(copied.capacities).toHaveLength(1);
    expect(copied.deletionFlag).toBe(' ');
  });
});
