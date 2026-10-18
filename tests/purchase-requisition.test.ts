import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { changeHistory } from '../src/platform/change';
import { defineRange } from '../src/platform/numbering';
import {
  changeRequisition,
  createRequisition,
  getRequisition,
} from '../src/modules/purchasing/requisitions';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR055_ME51N_TEST';

/**
 * SCR-055 / ME51N acceptance: the requisition drawn from the PURCHREQ
 * range and judged against the standing masters, cost-centre assignment
 * at a hundred percent, the period gates never consulted, changes
 * keeping item numbers stable, and the deletion flag warning only.
 */
describe('SCR-055 purchase requisitions (ME51N)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr055-purchase-requisition');
      client = tenant.client;
      await withTenant(client, async (tx) => {
        // The PURCHREQ range the draw needs (real provisioning defines it
        // the same way), and a valid cost centre under the standing
        // controlling-area assignment for company 1000.
        await defineRange(tx, {
          client, objectCode: 'PURCHREQ', subObject: 'NB', prefix: 'PR', numberLength: 7, createdBy: ACTOR,
        });
        await tx.execute(sql`
          insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
          select ${client}, controlling_area, 'CC1000', '2020-01-01', '2099-12-31', 'Test cost centre', 'ADMINISTRATION', '1000', ${ACTOR}
          from controlling_area_company
          where client = ${client} and company_code = '1000'
          on conflict do nothing
        `);
        // A P&L consumption account in the company chart.
        await tx.execute(sql`
          insert into gl_account_group (client, chart_of_accounts, account_group, description, from_account_number, to_account_number, created_by)
          select ${client}, chart_of_accounts, 'OPEX', 'Operating expenses', '400000', '499999', ${ACTOR}
          from company_code where client = ${client} and company_code = '1000'
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into gl_account (client, chart_of_accounts, account_number, name, account_type, account_group, gl_account_type, is_balance_sheet, language_key, sort_key, created_by)
          select ${client}, chart_of_accounts, '400000', 'Consumption expense', 'EXPENSE', 'OPEX', 'PL_STATEMENT', false, 'EN', '001', ${ACTOR}
          from company_code where client = ${client} and company_code = '1000'
          on conflict do nothing
        `);
      });
    }
    return client;
  }

  const stockItem = {
    materialNumber: '',
    shortText: 'Industrial steel plate',
    quantity: 10,
    unit: 'PC',
    deliveryDate: '2026-11-15',
    plant: '1000',
    storageLocation: '',
    purchasingGroup: '001',
    priceUnit: 1,
    currency: '',
    markedForDeletion: false,
    assignments: [] as never[],
  };

  it('creates a requisition judged against the masters, its number drawn from the range', async () => {
    const c = await standingClient();
    await expect(createRequisition({
      client: c, changedBy: ACTOR,
      items: [{ ...stockItem, plant: '9999' }],
    })).rejects.toThrow('Plant 9999 does not exist');
    await expect(createRequisition({
      client: c, changedBy: ACTOR,
      items: [{ ...stockItem, materialNumber: 'NOPE-1' }],
    })).rejects.toThrow('Material NOPE-1 does not exist');

    const created = await createRequisition({
      client: c, changedBy: ACTOR,
      items: [{ ...stockItem, estimatedPrice: 150, currency: 'USD' }],
    });
    expect(created.requisitionNumber).toMatch(/^PR-\d{7}$/);
    const doc = await getRequisition(c, created.requisitionNumber);
    expect(doc?.items).toHaveLength(1);
    expect(doc?.items[0]).toMatchObject({
      itemNumber: 10,
      shortText: 'Industrial steel plate',
      quantity: '10.000',
      estimatedPrice: '150.00',
      priceUnit: '1',
      accountAssignmentCategory: null,
      markedForDeletion: false,
    });
    const history = await withTenant(c, (tx) => changeHistory(tx, c, 'purchase_requisition', created.requisitionNumber));
    expect(history.length).toBeGreaterThanOrEqual(1);
  });

  it('judges cost-centre assignment: validity, the chart, and a hundred percent', async () => {
    const c = await standingClient();
    const ccItem = {
      ...stockItem,
      accountAssignmentCategory: 'COST_CENTER' as const,
      assignments: [{ glAccount: '400000', costCenter: 'CC1000', distributionPercentage: 60 }],
    };
    await expect(createRequisition({ client: c, changedBy: ACTOR, items: [ccItem] }))
      .rejects.toThrow('total 60.00, not 100');
    await expect(createRequisition({
      client: c, changedBy: ACTOR,
      items: [{ ...ccItem, assignments: [{ glAccount: '400000', costCenter: 'NOPE', distributionPercentage: 100 }] }],
    })).rejects.toThrow('Cost centre NOPE does not stand valid');
    await expect(createRequisition({
      client: c, changedBy: ACTOR,
      items: [{ ...ccItem, assignments: [{ glAccount: '999999', costCenter: 'CC1000', distributionPercentage: 100 }] }],
    })).rejects.toThrow('G/L account 999999 does not exist');

    const created = await createRequisition({
      client: c, changedBy: ACTOR,
      items: [{
        ...ccItem,
        assignments: [
          { glAccount: '400000', costCenter: 'CC1000', distributionPercentage: 60 },
          { glAccount: '400000', costCenter: 'CC1000', distributionPercentage: 40 },
        ],
      }],
    });
    const doc = await getRequisition(c, created.requisitionNumber);
    expect(doc?.items[0].assignments).toHaveLength(2);
    expect(doc?.items[0].accountAssignmentCategory).toBe('COST_CENTER');
  });

  it('changes keep item numbers stable, add at the next step, and carry the deletion mark', async () => {
    const c = await standingClient();
    const created = await createRequisition({
      client: c, changedBy: ACTOR, items: [{ ...stockItem }],
    });
    const changed = await changeRequisition({
      client: c, changedBy: ACTOR, requisitionNumber: created.requisitionNumber,
      items: [
        { ...stockItem, itemNumber: 10, quantity: 25, markedForDeletion: true },
        { ...stockItem, shortText: 'Second item', quantity: 5 },
      ],
    });
    expect(changed.requisitionNumber).toBe(created.requisitionNumber);
    const doc = await getRequisition(c, created.requisitionNumber);
    expect(doc?.items.map((i) => i.itemNumber)).toEqual([10, 20]);
    expect(doc?.items[0]).toMatchObject({ quantity: '25.000', markedForDeletion: true });
    expect(doc?.items[1].shortText).toBe('Second item');
    const history = await withTenant(c, (tx) => changeHistory(tx, c, 'purchase_requisition', created.requisitionNumber));
    expect(history.length).toBeGreaterThanOrEqual(2);
  });
});
