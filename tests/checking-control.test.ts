import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { saveCheckingRule } from '../src/modules/production/availability-check';
import {
  checkingControlRefusal,
  holdsCheckingControlAuthority,
  listCheckingControls,
  saveCheckingControl,
} from '../src/modules/production/checking-control';
import { saveProductionOrderType } from '../src/modules/production/production-order-type';
import { createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'OPJK_TEST';
const PLANT = 'QK10';
const LONG_PLANT = 'QK10PLANTX';
const OTHER_PLANT = 'QK11';

describe('checking control', () => {
  let tenant: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant('opjk');
    other = await createTenant('opjk-other');
    await withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      select ${tenant.client}, v.plant, v.name, c.company_code, 'KW', ${ACTOR}
      from (select company_code from company_code where client = ${tenant.client} order by company_code limit 1) c
      cross join (values (${PLANT}, 'Checking plant'), (${LONG_PLANT}, 'Long plant key')) as v(plant, name)
    `));
    await withTenant(other.client, (tx) => tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      select ${other.client}, ${OTHER_PLANT}, 'Other plant', c.company_code, 'KW', ${ACTOR}
      from (select company_code from company_code where client = ${other.client} order by company_code limit 1) c
    `));
    await saveProductionOrderType({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', orderType: 'PP01',
      description: 'Standard production', version: 0, reason: 'Type for checking control',
    });
    await saveProductionOrderType({
      client: other.client, changedBy: ACTOR, mode: 'CREATE', orderType: 'PP01',
      description: 'Other type', version: 0, reason: 'Other tenant type',
    });
    await saveCheckingRule({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', checkingRule: 'PP',
      description: 'Production rule', version: 0, reason: 'Rule for checking control',
    });
    await saveCheckingRule({
      client: other.client, changedBy: ACTOR, mode: 'CREATE', checkingRule: 'PP',
      description: 'Other rule', version: 0, reason: 'Other tenant rule',
    });
  });

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await destroyTenant(other.client);
  });

  it('stores an explicit combination and does not invent a missing one', async () => {
    expect((await listCheckingControls(tenant.client)).controls).toEqual([]);
    const created = await saveCheckingControl({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP01',
      businessFunction: '1', noCheck: 'X', checkingRule: 'PP', checkOnSave: ' ', version: 0,
      reason: 'No automatic check during creation',
    });
    expect(created).toMatchObject({
      plant: PLANT, orderType: 'PP01', orderCategory: '10', businessFunction: '1',
      noCheck: 'X', checkingRule: 'PP', checkOnSave: ' ', version: 1,
    });
    const release = await saveCheckingControl({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: LONG_PLANT, orderType: 'PP01',
      businessFunction: '2', noCheck: ' ', checkingRule: '', checkOnSave: 'X', version: 0,
      reason: 'Release function, no rule named',
    });
    expect(release).toMatchObject({
      plant: LONG_PLANT, businessFunction: '2', noCheck: ' ', checkingRule: null, checkOnSave: 'X',
    });
    expect(LONG_PLANT).toHaveLength(10);
    const listed = await listCheckingControls(tenant.client);
    expect(listed.controls.map((row) => `${row.plant}/${row.businessFunction}`)).toEqual([
      `${PLANT}/1`,
      `${LONG_PLANT}/2`,
    ]);
    expect(listed.controls.some((row) => row.plant === PLANT && row.businessFunction === '2')).toBe(false);
    expect(listed.gaps.join(' ')).toMatch(/not a check and it is not a no-check/);
    expect(listed.gaps.join(' ')).toMatch(/CO09 remains blocked/);
    expect(listed.gaps.join(' ')).toMatch(/does not run a check/);
    const [orders] = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select count(*)::int as n from production_order where client = ${tenant.client}
    `)) as unknown as Array<{ n: number }>;
    expect(orders.n).toBe(0);
  });

  it('refuses a duplicate, a bad function, a missing choice, and a missing reference', async () => {
    await expect(saveCheckingControl({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP01',
      businessFunction: '1', noCheck: 'X', checkingRule: 'PP', checkOnSave: ' ', version: 0,
      reason: 'Duplicate',
    })).rejects.toThrow(/already stand/);
    await expect(saveCheckingControl({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP01',
      businessFunction: '3', noCheck: 'X', checkingRule: '', checkOnSave: ' ', version: 0,
      reason: 'Bad function',
    })).rejects.toThrow(/not 1 or 2/);
    await expect(saveCheckingControl({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP01',
      businessFunction: '', noCheck: 'X', checkingRule: '', checkOnSave: ' ', version: 0,
      reason: 'Blank function',
    })).rejects.toThrow(/not 1 or 2/);
    await expect(saveCheckingControl({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP01',
      businessFunction: '2', noCheck: '', checkingRule: '', checkOnSave: 'X', version: 0,
      reason: 'Indicator not chosen',
    })).rejects.toThrow(/was not chosen/);
    await expect(saveCheckingControl({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP01',
      businessFunction: '2', noCheck: 'Y', checkingRule: '', checkOnSave: 'X', version: 0,
      reason: 'Bad indicator',
    })).rejects.toThrow(/not X or blank/);
    await expect(saveCheckingControl({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP01',
      businessFunction: '2', noCheck: ' ', checkingRule: '', checkOnSave: '', version: 0,
      reason: 'Save indicator not chosen',
    })).rejects.toThrow(/check-on-save indicator was not chosen/);
    await expect(saveCheckingControl({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: 'NOPE', orderType: 'PP01',
      businessFunction: '2', noCheck: ' ', checkingRule: '', checkOnSave: ' ', version: 0,
      reason: 'Missing plant',
    })).rejects.toThrow(/does not stand/);
    await expect(saveCheckingControl({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP99',
      businessFunction: '2', noCheck: ' ', checkingRule: '', checkOnSave: ' ', version: 0,
      reason: 'Missing type',
    })).rejects.toThrow(/does not stand/);
    await expect(saveCheckingControl({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP01',
      businessFunction: '2', noCheck: ' ', checkingRule: 'ZZ', checkOnSave: ' ', version: 0,
      reason: 'Missing rule',
    })).rejects.toThrow(/does not stand in this tenant/);
    await expect(saveCheckingControl({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP01',
      businessFunction: '2', noCheck: ' ', checkingRule: 'P', checkOnSave: ' ', version: 0,
      reason: 'Short rule',
    })).rejects.toThrow(/not two characters/);
    expect(checkingControlRefusal({ releaseControl: '1' })).toMatch(/Release control is not stored/);
    expect(checkingControlRefusal({ componentCheckType: '1' })).toMatch(/component-check type is not stored/i);
    expect(checkingControlRefusal({ orderCategory: '40' })).toMatch(/not a production order/);
    expect(checkingControlRefusal({ co09: 'X' })).toMatch(/CO09 remains blocked/);
  });

  it('does not let another tenant read or write the record', async () => {
    expect((await listCheckingControls(other.client)).controls).toEqual([]);
    await expect(saveCheckingControl({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: OTHER_PLANT, orderType: 'PP01',
      businessFunction: '1', noCheck: 'X', checkingRule: '', checkOnSave: ' ', version: 0,
      reason: 'Other plant',
    })).rejects.toThrow(/does not stand in this tenant/);
    const ownRule = await saveCheckingControl({
      client: tenant.client, changedBy: ACTOR, mode: 'CREATE', plant: PLANT, orderType: 'PP01',
      businessFunction: '2', noCheck: ' ', checkingRule: 'PP', checkOnSave: ' ', version: 0,
      reason: 'Own rule is allowed',
    });
    expect(ownRule).toMatchObject({ checkingRule: 'PP', businessFunction: '2' });
    await saveCheckingControl({
      client: tenant.client, changedBy: ACTOR, mode: 'DELETE', plant: PLANT, orderType: 'PP01',
      businessFunction: '2', noCheck: ' ', checkingRule: '', checkOnSave: ' ', version: 1,
      reason: 'Return the key to unconfigured',
    });
    expect((await listCheckingControls(tenant.client)).controls.some((row) => row.plant === PLANT && row.businessFunction === '2')).toBe(false);
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into production_checking_control (
        client, plant, order_type, business_function, no_check, check_on_save, created_by
      ) values (${other.client}, ${OTHER_PLANT}, 'PP01', '1', 'X', ' ', ${ACTOR})
    `))).rejects.toThrow();
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into production_checking_control (
        client, plant, order_type, business_function, no_check, check_on_save, created_by
      ) values (${tenant.client}, ${PLANT}, 'PP01', '3', 'X', ' ', ${ACTOR})
    `))).rejects.toThrow();
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into production_checking_control (
        client, plant, order_type, business_function, check_on_save, created_by
      ) values (${tenant.client}, ${PLANT}, 'PP01', '1', ' ', ${ACTOR})
    `))).rejects.toThrow();
    await expect(withTenant(tenant.client, (tx) => tx.execute(sql`
      insert into production_checking_control (
        client, plant, order_type, business_function, no_check, check_on_save, created_by
      ) values (${tenant.client}, ${PLANT}, 'PP01', '1', '', ' ', ${ACTOR})
    `))).rejects.toThrow();
  });

  it('authorizes the configuration and does not read an operational check', () => {
    expect(holdsCheckingControlAuthority(['CFG.PROD.CHECKCTRL.DEFINE'])).toBe(true);
    expect(holdsCheckingControlAuthority(['PROD.ORDER.CREATE'])).toBe(false);
    expect(holdsCheckingControlAuthority(['CFG.PROD.ORDERTYPE.DEFINE'])).toBe(false);
    const actions = readFileSync('src/app/config/checking-control/actions.ts', 'utf8');
    expect(actions.indexOf('await requireCapability(ACTIVITY, session)')).toBeLessThan(actions.indexOf('await saveCheckingControl'));
    const service = readFileSync('src/modules/production/checking-control.ts', 'utf8');
    expect(service).not.toMatch(/from ['"].*production-orders|from ['"].*planned-order-conversion|from ['"].*stock-requirements|from ['"].*mrp-run/);
    const untouched = [
      'src/modules/inventory/production-orders.ts',
      'src/modules/production/planned-order-conversion.ts',
      'src/modules/production/mrp-run.ts',
      'src/modules/production/stock-requirements.ts',
      'src/modules/production/production-order-status.ts',
      'src/app/production/orders/actions.ts',
      'src/app/production/planned-order-conversion/actions.ts',
      'src/app/production/planned-order-conversion-collective/actions.ts',
      'src/app/production/mrp-run/actions.ts',
      'src/app/production/single-item-planning/actions.ts',
    ];
    for (const path of untouched) {
      expect(readFileSync(path, 'utf8')).not.toContain('checking-control');
    }
    const page = readFileSync('src/app/config/checking-control/page.tsx', 'utf8');
    expect(page).toContain('can(session, ACTIVITY)');
    expect(page).toContain('CO09 remains blocked');
    const form = readFileSync('src/app/config/checking-control/CheckingControlForm.tsx', 'utf8');
    expect(form).toContain('value="BLANK"');
    expect(form).toContain('Choose');
    expect(form).not.toContain('type="checkbox"');
    expect(readFileSync('scripts/seed.ts', 'utf8')).toContain("aliases: ['OPJK']");
  });
});
