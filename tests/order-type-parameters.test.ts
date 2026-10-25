import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { saveProductionOrderType } from '../src/modules/production/production-order-type';
import {
  OrderTypeParameterError,
  holdsOrderTypeParameterAuthority,
  listOrderTypeParameters,
  orderTypeParameterRefusal,
  productionVersionSelectionOf,
  saveOrderTypeParameter,
} from '../src/modules/production/order-type-parameters';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'OPL8_TEST';
const PLANT = 'QK08';
const OTHER_PLANT = 'QK09';

describe('order type-dependent parameters', () => {
  let tenant: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant('opl8');
    other = await createTenant('opl8-other');
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      select ${tenant.client}, ${PLANT}, 'Parameter plant', c.company_code, 'KW', ${ACTOR}
      from (select company_code from company_code where client = ${tenant.client} order by company_code limit 1) c
    `));
    await withTenant(other.client, (tx) => tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      select ${other.client}, ${OTHER_PLANT}, 'Other plant', c.company_code, 'KW', ${ACTOR}
      from (select company_code from company_code where client = ${other.client} order by company_code limit 1) c
    `));
    await saveProductionOrderType({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', orderType: 'PP01',
      description: 'Standard production', version: 0, reason: 'Type for parameters',
    });
    await saveProductionOrderType({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', orderType: 'PP02',
      description: 'Second type', version: 0, reason: 'Type for a constraint',
    });
    await saveProductionOrderType({
      client: other.client, changedBy: ACTOR, mode: 'CREATE', orderType: 'PP01',
      description: 'Other type', version: 0, reason: 'Other tenant type',
    });
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into routing_task_list_type (client, task_list_type, description, created_by)
      values (${tenant.client}, 'N', 'Standard routing', ${ACTOR})
    `));
  });

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await destroyTenant(other.client);
  });

  it('creates and edits a plant and order type combination without creating an order', async () => {
    const created = await saveOrderTypeParameter({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP01',
      taskListType: 'N', productionVersionSelection: '0', version: 0, reason: 'Define the combination',
    });
    expect(created).toMatchObject({
      plant: PLANT, orderType: 'PP01', orderCategory: '10', taskListType: 'N', productionVersionSelection: '0', version: 1,
    });
    const changed = await saveOrderTypeParameter({
      client: tenant.client, changedBy: ACTOR, mode: 'CHANGE', plant: PLANT, orderType: 'PP01',
      taskListType: '', productionVersionSelection: '1', version: 1, reason: 'Manual selection, not applied',
    });
    expect(changed).toMatchObject({ taskListType: null, productionVersionSelection: '1', version: 2 });
    const listed = await listOrderTypeParameters(tenant.client);
    expect(listed.parameters).toEqual([expect.objectContaining({ plant: PLANT, orderType: 'PP01', orderCategory: '10' })]);
    expect(listed.gaps.join(' ')).toMatch(/does not create an order/);
    expect(listed.gaps.join(' ')).toMatch(/not a documented selection method/);
    expect(listed.gaps.join(' ')).not.toMatch(/Blank is not automatic/);
    const form = readFileSync('src/app/config/order-type-parameters/OrderTypeParameterForm.tsx', 'utf8');
    expect(form).toContain('Automatic selection of production version');
    expect(form).toContain('Manual selection of production version');
    expect(form).not.toMatch(/not automatic|no automatic/i);
    const [orders] = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as n from production_order where client = ${tenant.client}
    `)) as unknown as Array<{ n: number }>;
    expect(orders.n).toBe(0);
  });

  it('refuses a duplicate key, a missing reference, and an invalid value', async () => {
    await expect(saveOrderTypeParameter({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP01',
      taskListType: '', productionVersionSelection: ' ', version: 0, reason: 'Duplicate',
    })).rejects.toThrow(/already stand/);
    await expect(saveOrderTypeParameter({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: 'NOPE', orderType: 'PP01',
      taskListType: '', productionVersionSelection: ' ', version: 0, reason: 'Missing plant',
    })).rejects.toThrow(/does not stand/);
    await expect(saveOrderTypeParameter({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP99',
      taskListType: '', productionVersionSelection: ' ', version: 0, reason: 'Missing type',
    })).rejects.toThrow(/does not stand/);
    await expect(saveOrderTypeParameter({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP1',
      taskListType: '', productionVersionSelection: ' ', version: 0, reason: 'Short type',
    })).rejects.toThrow(/not four characters/);
    await expect(saveOrderTypeParameter({
      client: tenant.client, changedBy: ACTOR, mode: 'CHANGE', plant: PLANT, orderType: 'PP01',
      taskListType: 'Z', productionVersionSelection: '1', version: 2, reason: 'Missing task list',
    })).rejects.toThrow(/does not stand/);
    await expect(saveOrderTypeParameter({
      client: tenant.client, changedBy: ACTOR, mode: 'CHANGE', plant: PLANT, orderType: 'PP01',
      taskListType: '', productionVersionSelection: '2', version: 2, reason: 'Bad selection',
    })).rejects.toThrow(/not blank, 0, or 1/);
    expect(orderTypeParameterRefusal({ checkingControl: 'X' })).toMatch(/Checking control is not stored/);
    expect(orderTypeParameterRefusal({ costingVariant: 'PPP1' })).toMatch(/costing variant is not stored/i);
    expect(orderTypeParameterRefusal({ routingSelection: '3' })).toMatch(/Routing selection is not stored/);
    expect(orderTypeParameterRefusal({ bomApplication: 'PP01' })).toMatch(/BOM application is not stored/);
    expect(orderTypeParameterRefusal({ orderCategory: '40' })).toMatch(/not a production order/);
  });

  it('does not let another tenant read or write the combination', async () => {
    expect((await listOrderTypeParameters(other.client)).parameters).toEqual([]);
    await expect(saveOrderTypeParameter({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: OTHER_PLANT, orderType: 'PP01',
      taskListType: '', productionVersionSelection: ' ', version: 0, reason: 'Other plant',
    })).rejects.toThrow(/does not stand in this tenant/);
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into production_order_type_parameter (client, plant, order_type, order_category, created_by)
      values (${other.client}, ${OTHER_PLANT}, 'PP01', '10', ${ACTOR})
    `))).rejects.toThrow();
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into production_order_type_parameter (client, plant, order_type, order_category, production_version_selection, created_by)
      values (${tenant.client}, ${PLANT}, 'PP02', '40', '2', ${ACTOR})
    `))).rejects.toThrow();
  });

  it('authorizes the configuration and does not itself create an order', () => {
    expect(holdsOrderTypeParameterAuthority(['CFG.PROD.ORDERPARAM.DEFINE'])).toBe(true);
    expect(holdsOrderTypeParameterAuthority(['PROD.ORDER.CREATE'])).toBe(false);
    expect(holdsOrderTypeParameterAuthority(['CFG.PROD.ORDERTYPE.DEFINE'])).toBe(false);
    const actions = readFileSync('src/app/config/order-type-parameters/actions.ts', 'utf8');
    expect(actions.indexOf('await requireCapability(ACTIVITY, session)')).toBeLessThan(actions.indexOf('await saveOrderTypeParameter'));
    const service = readFileSync('src/modules/production/order-type-parameters.ts', 'utf8');
    expect(service).not.toMatch(/production-orders|planned-order-conversion|stock-requirements|availability-check/);
    expect(service).toContain('readProductionVersionSelection');
    expect(service).toContain('Blank is not a selection method');
    const snapshot = readFileSync('src/modules/production/order-bom-snapshot.ts', 'utf8');
    const conversion = readFileSync('src/modules/production/planned-order-conversion.ts', 'utf8');
    expect(snapshot).toContain('readProductionVersionSelection');
    expect(conversion).toContain('readProductionVersionSelection');
    expect(readFileSync('src/modules/inventory/production-orders.ts', 'utf8')).toContain('An order-type parameter is not proof that the type stands.');
    expect(readFileSync('src/app/production/orders/actions.ts', 'utf8')).not.toContain('order-type-parameters');
    expect(readFileSync('src/app/production/planned-order-conversion/actions.ts', 'utf8')).toContain('productionVersion: text(form, \'productionVersion\')');
    expect(readFileSync('src/app/production/planned-order-conversion/actions.ts', 'utf8')).not.toContain('productionVersion: text(form, \'productionVersion\'),\n');
    expect(readFileSync('src/app/production/planned-order-conversion-collective/actions.ts', 'utf8')).toContain('productionVersion: text(form, \'productionVersion\')');
    const page = readFileSync('src/app/config/order-type-parameters/page.tsx', 'utf8');
    expect(page).toContain('can(session, ACTIVITY)');
    expect(page).toContain('does not create an order');
    expect(readFileSync('scripts/seed.ts', 'utf8')).toContain("aliases: ['OPL8']");
  });
});

describe('production version selection values', () => {
  it('accepts only 0 and 1 and does not guess blank or an unsupported value', () => {
    expect(productionVersionSelectionOf('0', '1000', 'PP01')).toBe('0');
    expect(productionVersionSelectionOf('1', '1000', 'PP01')).toBe('1');
    expect(() => productionVersionSelectionOf(' ', '1000', 'PP01')).toThrow(OrderTypeParameterError);
    expect(() => productionVersionSelectionOf(' ', '1000', 'PP01')).toThrow(/not a selection method/);
    expect(() => productionVersionSelectionOf('', '1000', 'PP01')).toThrow(/not a selection method/);
    expect(() => productionVersionSelectionOf(null, '1000', 'PP01')).toThrow(/not a selection method/);
    expect(() => productionVersionSelectionOf('2', '1000', 'PP01')).toThrow(/not 0 or 1/);
    let thrown = false;
    try {
      productionVersionSelectionOf('2', '1000', 'PP01');
    } catch (caught) {
      thrown = true;
      expect(caught).toBeInstanceOf(OrderTypeParameterError);
      expect((caught as OrderTypeParameterError).remedy).toMatch(/not guessed/);
    }
    expect(thrown).toBe(true);
  });
});
