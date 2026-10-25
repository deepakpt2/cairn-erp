import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  AvailabilityCheckError,
  assignCheckingGroup,
  availabilityCheckRefusal,
  listAvailabilityCheck,
  saveCheckingGroup,
  saveCheckingRule,
  saveScopeOfCheck,
} from '../src/modules/production/availability-check';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'AVCHECK_TEST';
const PLANT = 'QAV1';

describe('availability-check configuration', () => {
  let tenant: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant('avcheck');
    other = await createTenant('avcheck-other');
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${tenant.client}, 'AV-FG', 'Finished', t.material_type, 'PC', ${ACTOR}
        from (select material_type from material_type where client = ${tenant.client} order by material_type limit 1) t
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        select ${tenant.client}, ${PLANT}, 'Check plant', c.company_code, 'KW', ${ACTOR}
        from (select company_code from company_code where client = ${tenant.client} order by company_code limit 1) c
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, planned_delivery_days, in_house_production_days, created_by)
        values (${tenant.client}, 'AV-FG', ${PLANT}, 7, 3, ${ACTOR})
      `);
    });
  });

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await destroyTenant(other.client);
  });

  const scopeFlags = {
    includeSafetyStock: 'X',
    includeQualityStock: ' ',
    includeBlockedStock: ' ',
    includeRestrictedUse: ' ',
    purchaseOrders: 'X',
    purchaseRequisitions: ' ',
    plannedOrders: 'A',
    productionOrders: 'F',
    dependentRequirements: ' ',
    reservations: 'X',
    receiptsInPast: 'B',
  };

  it('stores a group, a distinct rule, and a scope without calculating ATP', async () => {
    const group = await saveCheckingGroup({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', checkingGroup: '01',
      description: 'Daily check', noCheck: ' ', version: 0, reason: 'Define the group',
    });
    const rule = await saveCheckingRule({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', checkingRule: '01',
      description: 'Production context', version: 0, reason: 'Define the rule',
    });
    expect(group?.checkingGroup).toBe('01');
    expect(rule?.checkingRule).toBe('01');
    const scope = await saveScopeOfCheck({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', checkingGroup: '01', checkingRule: '01',
      ...scopeFlags, version: 0, reason: 'Define the scope',
    });
    expect(scope).toMatchObject({
      checkingGroup: '01',
      checkingRule: '01',
      includeSafetyStock: 'X',
      plannedOrders: 'A',
      productionOrders: 'F',
      receiptsInPast: 'B',
      version: 1,
    });
    expect(scope).not.toHaveProperty('availableQuantity');
    const listed = await listAvailabilityCheck(tenant.client);
    expect(listed.groups).toHaveLength(1);
    expect(listed.rules).toHaveLength(1);
    expect(listed.scopes).toHaveLength(1);
    expect(listed.gaps.join(' ')).toMatch(/does not calculate an ATP quantity/);
    expect(listed.gaps.join(' ')).toMatch(/Checking control is not stored/);
    expect(listed.gaps.join(' ')).not.toMatch(/created and released/);
  });

  it('keeps a missing assignment null and does not rewrite MRP data', async () => {
    const [before] = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select checking_group, planned_delivery_days, in_house_production_days, mrp_type, version
        from material_plant
       where client = ${tenant.client} and material_number = 'AV-FG' and plant = ${PLANT}
    `)) as unknown as Array<{ checking_group: string | null; planned_delivery_days: number; in_house_production_days: number; mrp_type: string | null; version: number }>;
    expect(before.checking_group).toBeNull();
    const assigned = await assignCheckingGroup({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'AV-FG', plant: PLANT,
      checkingGroup: '01', expectedVersion: before.version, reason: 'Assign the group',
    });
    expect(assigned.checkingGroup).toBe('01');
    const [after] = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select checking_group, planned_delivery_days, in_house_production_days, mrp_type, version
        from material_plant
       where client = ${tenant.client} and material_number = 'AV-FG' and plant = ${PLANT}
    `)) as unknown as Array<{ checking_group: string | null; planned_delivery_days: number; in_house_production_days: number; mrp_type: string | null; version: number }>;
    expect(after.checking_group).toBe('01');
    expect(after.planned_delivery_days).toBe(before.planned_delivery_days);
    expect(after.in_house_production_days).toBe(before.in_house_production_days);
    expect(after.mrp_type).toBe(before.mrp_type);
    expect(after.version).toBe(before.version + 1);
    const cleared = await assignCheckingGroup({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'AV-FG', plant: PLANT,
      checkingGroup: '', expectedVersion: after.version, reason: 'Clear the group',
    });
    expect(cleared.checkingGroup).toBeNull();
  });

  it('refuses a plant view that does not stand and a rule used as a group', async () => {
    const [view] = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select version from material_plant
       where client = ${tenant.client} and material_number = 'AV-FG' and plant = ${PLANT}
    `)) as unknown as Array<{ version: number }>;
    await expect(assignCheckingGroup({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'AV-FG', plant: 'NONE',
      checkingGroup: '01', expectedVersion: view.version, reason: 'Missing plant',
    })).rejects.toThrow(/no plant view/);
    await expect(assignCheckingGroup({
      client: tenant.client, changedBy: ACTOR, materialNumber: 'AV-FG', plant: PLANT,
      checkingGroup: 'ZZ', expectedVersion: view.version, reason: 'Unknown group',
    })).rejects.toThrow(/does not stand/);
    await expect(saveScopeOfCheck({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', checkingGroup: '01', checkingRule: 'ZZ',
      ...scopeFlags, version: 0, reason: 'Missing rule',
    })).rejects.toThrow(/Checking rule ZZ does not stand/);
  });

  it('refuses unsupported scope values and does not infer a lead time', async () => {
    await expect(saveScopeOfCheck({
      client: tenant.client, changedBy: ACTOR, mode: 'CHANGE', checkingGroup: '01', checkingRule: '01',
      ...scopeFlags, purchaseOrders: 'A', version: 1, reason: 'Stock transport',
    })).rejects.toThrow(/stock-transport confirmed quantity/);
    await expect(saveScopeOfCheck({
      client: tenant.client, changedBy: ACTOR, mode: 'CHANGE', checkingGroup: '01', checkingRule: '01',
      ...scopeFlags, plannedOrders: 'B', version: 1, reason: 'Confirmed planned order',
    })).rejects.toThrow(/no confirmed quantity/);
    await expect(saveScopeOfCheck({
      client: tenant.client, changedBy: ACTOR, mode: 'CHANGE', checkingGroup: '01', checkingRule: '01',
      ...scopeFlags, receiptsInPast: 'A', version: 1, reason: 'Message',
    })).rejects.toThrow(/check message/);
    await expect(saveCheckingGroup({
      client: tenant.client, changedBy: ACTOR, mode: 'CHANGE', checkingGroup: '01',
      description: 'Daily check', noCheck: ' ', version: 1, reason: 'Lead time',
      extensions: { replenishmentLeadTime: '5' },
    })).rejects.toThrow(/replenishment lead time is not stored/i);
    expect(availabilityCheckRefusal({ salesRequirements: 'X' })).toMatch(/Sales orders are not implemented/);
    expect(availabilityCheckRefusal({ storageLocationInspection: 'X' })).toMatch(/Storage-location inspection/);
    expect(availabilityCheckRefusal({ dependentReservations: 'X' })).toMatch(/not a reservation/);
    expect(availabilityCheckRefusal({ atpQuantity: '1' })).toMatch(/does not calculate/);
  });

  it('does not let another tenant read or write the group', async () => {
    expect((await listAvailabilityCheck(other.client)).groups).toEqual([]);
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into availability_checking_group (client, checking_group, description, no_check, created_by)
      values (${other.client}, '99', 'Other', ' ', ${ACTOR})
    `))).rejects.toThrow();
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`
      update availability_check_scope
         set include_safety_stock = 'Y'
       where client = ${tenant.client} and checking_group = '01' and checking_rule = '01'
    `))).rejects.toThrow();
  });

  it('refuses deletion of a group that a scope still uses', async () => {
    await expect(saveCheckingGroup({
      client: tenant.client, changedBy: ACTOR, mode: 'DELETE', checkingGroup: '01',
      description: '', noCheck: ' ', version: 1, reason: 'Remove the group',
    })).rejects.toThrow(/used in a scope/);
    await expect(saveCheckingRule({
      client: tenant.client, changedBy: ACTOR, mode: 'DELETE', checkingRule: '01',
      description: '', version: 1, reason: 'Remove the rule',
    })).rejects.toThrow(/used in a scope/);
  });

  it('does not read stock, MRP, or order creation', () => {
    const service = readFileSync('src/modules/production/availability-check.ts', 'utf8');
    expect(service).not.toMatch(/stock-requirements|production-orders|mrp-run|goods-issue|order-bom-snapshot/);
    expect(service).not.toMatch(/availableQuantity|cumulatedAtp/);
    const page = readFileSync('src/app/config/availability-check/page.tsx', 'utf8');
    expect(page).toContain('does not calculate ATP');
    expect(service).toContain("ACTIVITY = 'CFG.PROD.AVCHECK.DEFINE'");
    expect(readFileSync('scripts/seed.ts', 'utf8')).toContain("aliases: ['OVZ2', 'OPJL', 'OVZ9', 'OPJJ']");
  });
});
