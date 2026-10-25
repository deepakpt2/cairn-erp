import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  holdsOrderTypeAuthority,
  listProductionOrderTypes,
  productionOrderTypeRefusal,
  saveProductionOrderType,
} from '../src/modules/production/production-order-type';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'OPJH_TEST';

describe('production order type', () => {
  let tenant: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant('opjh');
    other = await createTenant('opjh-other');
  });

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await destroyTenant(other.client);
  });

  it('creates and edits a type without creating an order', async () => {
    const created = await saveProductionOrderType({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', orderType: 'PP01',
      description: 'Standard production', version: 0, reason: 'Define the type',
    });
    expect(created).toMatchObject({ orderType: 'PP01', description: 'Standard production', orderCategory: '10', version: 1 });
    const changed = await saveProductionOrderType({
      client: tenant.client, changedBy: ACTOR, mode: 'CHANGE', orderType: 'PP01',
      description: 'Standard order', version: 1, reason: 'Rename the type',
    });
    expect(changed?.description).toBe('Standard order');
    expect(changed?.version).toBe(2);
    const listed = await listProductionOrderTypes(tenant.client);
    expect(listed.types).toEqual([expect.objectContaining({ orderType: 'PP01', orderCategory: '10' })]);
    expect(listed.gaps.join(' ')).toMatch(/does not create a production order/);
    const [orders] = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as n from production_order where client = ${tenant.client}
    `)) as unknown as Array<{ n: number }>;
    expect(orders.n).toBe(0);
  });

  it('refuses a duplicate key, an invalid key, and a plant key', async () => {
    await expect(saveProductionOrderType({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', orderType: 'PP01',
      description: 'Again', version: 0, reason: 'Duplicate',
    })).rejects.toThrow(/already stands/);
    await expect(saveProductionOrderType({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', orderType: 'PP1',
      description: 'Short', version: 0, reason: 'Short key',
    })).rejects.toThrow(/not four characters/);
    await expect(saveProductionOrderType({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', orderType: 'pp01',
      description: 'Lower', version: 0, reason: 'Lower case',
    })).rejects.toThrow(/not four characters/);
    await expect(saveProductionOrderType({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', orderType: 'PP02',
      description: 'Plant type', version: 0, reason: 'Plant',
      extensions: { plant: '1000' },
    })).rejects.toThrow(/not keyed by plant/);
    expect(productionOrderTypeRefusal({ checkingControl: 'X' })).toMatch(/Checking control is not stored/);
    expect(productionOrderTypeRefusal({ orderCategory: '40' })).toMatch(/not a production order/);
    expect(productionOrderTypeRefusal({ numberRange: '01' })).toMatch(/numbering is not changed/);
  });

  it('does not let another tenant read or write the type', async () => {
    expect((await listProductionOrderTypes(other.client)).types).toEqual([]);
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into production_order_type (client, order_type, description, order_category, created_by)
      values (${other.client}, 'PP99', 'Other', '10', ${ACTOR})
    `))).rejects.toThrow();
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into production_order_type (client, order_type, description, order_category, created_by)
      values (${tenant.client}, 'PP09', 'Bad category', '01', ${ACTOR})
    `))).rejects.toThrow();
  });

  it('authorizes the configuration and does not read order creation', () => {
    expect(holdsOrderTypeAuthority(['CFG.PROD.ORDERTYPE.DEFINE'])).toBe(true);
    expect(holdsOrderTypeAuthority(['PROD.ORDER.CREATE'])).toBe(false);
    expect(holdsOrderTypeAuthority([])).toBe(false);
    const actions = readFileSync('src/app/config/production-order-types/actions.ts', 'utf8');
    expect(actions.indexOf('await requireCapability(ACTIVITY, session)')).toBeLessThan(actions.indexOf('await saveProductionOrderType'));
    const service = readFileSync('src/modules/production/production-order-type.ts', 'utf8');
    expect(service).not.toMatch(/production-orders|planned-order-conversion|stock-requirements|availability-check/);
    expect(readFileSync('src/modules/inventory/production-orders.ts', 'utf8')).not.toContain('production-order-type');
    expect(readFileSync('src/modules/production/planned-order-conversion.ts', 'utf8')).not.toContain('production-order-type');
    const page = readFileSync('src/app/config/production-order-types/page.tsx', 'utf8');
    expect(page).toContain('can(session, ACTIVITY)');
    expect(page).toContain('does not create an order');
    expect(readFileSync('scripts/seed.ts', 'utf8')).toContain("aliases: ['OPJH']");
  });
});
