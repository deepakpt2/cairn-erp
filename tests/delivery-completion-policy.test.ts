import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { sql } from 'drizzle-orm';
import {
  listDeliveryCompletionPolicy,
  setDeliveryCompletionPlantPolicy,
  setDeliveryCompletionPolicy,
} from '../src/modules/purchasing/delivery-completion';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'PODC_POLICY_SCREEN_TEST';
const COMPANY = '1000';
const PLANT = '1000';

/**
 * The screen that maintains the rule: a company-code default, a plant override that beats
 * it, and a plant set back to inheriting whose row is deleted rather than left standing.
 */
describe('delivery completion policy maintenance', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('delivery-completion-policy');
      client = tenant.client;
      // Nothing of an earlier run may stand: the plant row beats the company row.
      await withTenant(client, async (tx) => {
        await tx.execute(sql`delete from purchase_delivery_completion_plant where client = ${client}`);
        await tx.execute(sql`delete from purchase_delivery_completion_policy where client = ${client}`);
      });
    }
    return client;
  }

  it('shows every company code with the rule it holds, and every plant with the rule it keeps', async () => {
    const c = await standingClient();
    const view = await listDeliveryCompletionPolicy(c);
    expect(view.companies.some((row) => row.companyCode === COMPANY)).toBe(true);
    expect(view.plants.some((row) => row.plant === PLANT)).toBe(true);
    // Untouched: no rule anywhere.
    expect(view.companies.find((row) => row.companyCode === COMPANY)?.autoClose).toBe(false);
    expect(view.plants.find((row) => row.plant === PLANT)?.autoClose).toBeNull();
  });

  it('sets the company default, and says so when the same rule is saved twice', async () => {
    const c = await standingClient();
    const first = await setDeliveryCompletionPolicy({
      client: c, changedBy: ACTOR, companyCode: COMPANY, autoClose: true,
    });
    expect(first.changed).toBe(true);
    expect((await listDeliveryCompletionPolicy(c)).companies
      .find((row) => row.companyCode === COMPANY)?.autoClose).toBe(true);

    const second = await setDeliveryCompletionPolicy({
      client: c, changedBy: ACTOR, companyCode: COMPANY, autoClose: true,
    });
    expect(second.changed).toBe(false);
  });

  it('lets a plant overrule its company, and returns it to inheriting when its row is removed', async () => {
    const c = await standingClient();
    await setDeliveryCompletionPolicy({
      client: c, changedBy: ACTOR, companyCode: COMPANY, autoClose: true,
    });
    // The plant answers no while its company answers yes.
    await setDeliveryCompletionPlantPolicy({
      client: c, changedBy: ACTOR, plant: PLANT, autoClose: false,
    });
    expect((await listDeliveryCompletionPolicy(c)).plants
      .find((row) => row.plant === PLANT)?.autoClose).toBe(false);

    // A blank choice is not "no": it is the plant keeping no row of its own.
    await setDeliveryCompletionPlantPolicy({
      client: c, changedBy: ACTOR, plant: PLANT, autoClose: null,
    });
    expect((await listDeliveryCompletionPolicy(c)).plants
      .find((row) => row.plant === PLANT)?.autoClose).toBeNull();
    const left = await withTenant(c, (tx) => tx.execute(sql`
      select count(*)::int as n from purchase_delivery_completion_plant
      where client = ${c} and plant = ${PLANT}
    `));
    expect((left as unknown as Array<{ n: number }>)[0].n).toBe(0);
  });
});
