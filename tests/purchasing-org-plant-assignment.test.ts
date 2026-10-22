import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { changeHistory } from '../src/platform/change';
import { withTenant } from '../src/platform/db/client';
import { companyCode, plant, purchasingOrg } from '../src/modules/foundation/schema';
import { assertPurchasingOrgForPlant, PURCH_ORG_PLANT_NOT_AUTHORIZED } from '../src/modules/foundation/purchasing-org-plant';
import { createRequisition } from '../src/modules/purchasing/requisitions';
import { createOrder } from '../src/modules/purchasing/orders';
import { defineRange } from '../src/platform/numbering';
import {
  assignPurchasingOrgPlant,
  checkPurchasingOrgPlant,
  listPurchasingOrgPlantAssignments,
  removePurchasingOrgPlant,
} from '../src/modules/purchasing/purchasing-org-plant-assignment';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'OX17_PLANT_TEST';

describe('purchasing organisation plant assignment (OX17)', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('ox17-plant');
      client = tenant.client;
      await withTenant(client, async (tx) => {
        await tx.execute(sql`
          insert into config_activity_status (client, activity_code, status, created_by)
          values (${client}, 'CFG.PROC.PURORG.ASSIGN_PLANT', 'NOT_STARTED', ${ACTOR})
          on conflict (client, activity_code) do nothing
        `);
      });
    }
    return client;
  }

  async function counts(c: string) {
    const [row] = await withTenant(c, async (tx) => {
      const rows = await tx.execute(sql`
        select
          (select count(*) from stock_quantity where client = ${c}) as stock,
          (select count(*) from journal_entry where client = ${c}) as journals,
          (select count(*) from purchasing_org_plant where client = ${c}) as pairs
      `);
      return rows as unknown as { stock: string; journals: string; pairs: string }[];
    });
    return row;
  }

  it('replays the standing pair without a second row or a posting', async () => {
    const c = await standingClient();
    const before = await counts(c);
    const first = await assignPurchasingOrgPlant({
      client: c,
      changedBy: ACTOR,
      purchasingOrg: '1000',
      plant: '1000',
      reason: 'The standard pair already stands.',
      requestKey: 'ox17-replay-1000',
    });
    const second = await assignPurchasingOrgPlant({
      client: c,
      changedBy: ACTOR,
      purchasingOrg: '1000',
      plant: '1000',
      reason: 'The standard pair already stands.',
      requestKey: 'ox17-replay-1000',
    });
    const after = await counts(c);
    expect(first).toMatchObject({ purchasingOrg: '1000', plant: '1000', assigned: false, replayed: false });
    expect(second).toMatchObject({ assigned: false, replayed: false });
    expect(after.pairs).toBe(before.pairs);
    expect(after.stock).toBe(before.stock);
    expect(after.journals).toBe(before.journals);
  });

  it('refuses a missing organisation, a missing plant, a plant with no company code, and a company mismatch', async () => {
    const c = await standingClient();
    await expect(assignPurchasingOrgPlant({
      client: c, changedBy: ACTOR, purchasingOrg: 'NOORG', plant: '1000', reason: 'Missing organisation.',
    })).rejects.toThrow('does not stand');
    await expect(assignPurchasingOrgPlant({
      client: c, changedBy: ACTOR, purchasingOrg: '1000', plant: 'NOPLANT', reason: 'Missing plant.',
    })).rejects.toThrow('does not stand');

    await withTenant(c, async (tx) => {
      await tx.insert(plant).values({
        client: c, plant: '3000', name: 'Unassigned plant', country: 'KW', companyCode: null, createdBy: ACTOR,
      }).onConflictDoNothing();
      await tx.insert(companyCode).values({
        client: c, companyCode: '2000', name: 'Other company', currency: 'USD', country: 'KW', createdBy: ACTOR,
      }).onConflictDoNothing();
      await tx.insert(plant).values({
        client: c, plant: '4000', name: 'Other company plant', country: 'KW', companyCode: '2000', createdBy: ACTOR,
      }).onConflictDoNothing();
    });

    await expect(assignPurchasingOrgPlant({
      client: c, changedBy: ACTOR, purchasingOrg: '1000', plant: '3000', reason: 'Plant has no company.',
    })).rejects.toThrow('no company code');
    await expect(assignPurchasingOrgPlant({
      client: c, changedBy: ACTOR, purchasingOrg: '1000', plant: '4000', reason: 'Wrong company.',
    })).rejects.toThrow('belongs to company code');
  });

  it('assigns a second plant of the same company, then refuses a company code, a status and a period on the assignment', async () => {
    const c = await standingClient();
    await withTenant(c, async (tx) => {
      await tx.insert(plant).values({
        client: c, plant: '2000', name: 'Second plant', country: 'KW', companyCode: '1000', createdBy: ACTOR,
      }).onConflictDoNothing();
      await tx.insert(purchasingOrg).values({
        client: c, purchasingOrg: '2000', name: 'Second organisation', companyCode: '1000', createdBy: ACTOR,
      }).onConflictDoNothing();
    });
    const created = await assignPurchasingOrgPlant({
      client: c, changedBy: ACTOR, purchasingOrg: '2000', plant: '2000', reason: 'Same company, second plant.', requestKey: 'ox17-2000',
    });
    expect(created).toMatchObject({ assigned: true, replayed: false });
    const replayed = await assignPurchasingOrgPlant({
      client: c, changedBy: ACTOR, purchasingOrg: '2000', plant: '2000', reason: 'Same company, second plant.', requestKey: 'ox17-2000',
    });
    expect(replayed.replayed).toBe(true);
    await expect(assignPurchasingOrgPlant({
      client: c, changedBy: ACTOR, purchasingOrg: '2000', plant: '1000', reason: 'A used request key.', requestKey: 'ox17-2000',
    })).rejects.toThrow('already recorded');
    const again = await assignPurchasingOrgPlant({
      client: c, changedBy: ACTOR, purchasingOrg: '1000', plant: '2000', reason: 'A plant may have more than one organisation.',
    });
    expect(again.assigned).toBe(true);

    await expect(assignPurchasingOrgPlant({
      client: c, changedBy: ACTOR, purchasingOrg: '2000', plant: '1000', reason: 'Company is derived.', companyCode: '1000',
    })).rejects.toThrow('company code');
    await expect(assignPurchasingOrgPlant({
      client: c, changedBy: ACTOR, purchasingOrg: '2000', plant: '1000', reason: 'No status.', status: 'ACTIVE',
    })).rejects.toThrow('status');
    await expect(assignPurchasingOrgPlant({
      client: c, changedBy: ACTOR, purchasingOrg: '2000', plant: '1000', reason: 'No period.', postingPeriod: '01',
    })).rejects.toThrow('posting period');

    const listed = await listPurchasingOrgPlantAssignments(c);
    expect(listed.find((row) => row.purchasingOrg === '2000' && row.plant === '2000')?.plantCompanyCode).toBe('1000');
  });

  it('refuses removal while a purchase order cites the pair, and does not rewrite the order', async () => {
    const c = await standingClient();
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${c}, 'OX17SUP', 'ORGANIZATION', 'OX17 supplier', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_group (client, purchasing_group, name, created_by)
        values (${c}, 'P01', 'OX17 group', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_order (
          client, order_number, supplier_number, purchasing_org, purchasing_group,
          company_code, currency, document_date, created_by
        ) values (
          ${c}, 'OX17PO', 'OX17SUP', '1000', 'P01', '1000', 'USD', '2026-10-22', ${ACTOR}
        )
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_order_item (
          client, order_number, item_number, short_text, quantity, unit, net_price, net_value, plant, created_by
        ) values (
          ${c}, 'OX17PO', 10, 'Cited line', 1, 'EA', 1, 1, '1000', ${ACTOR}
        )
        on conflict do nothing
      `);
    });

    await expect(removePurchasingOrgPlant({
      client: c, changedBy: ACTOR, purchasingOrg: '1000', plant: '1000', reason: 'Cited pair must stay.',
    })).rejects.toThrow(/1 purchase-order line/);

    const [order] = await withTenant(c, async (tx) => {
      const rows = await tx.execute(sql`
        select o.purchasing_org, i.plant
        from purchase_order o
        join purchase_order_item i on i.client = o.client and i.order_number = o.order_number
        where o.client = ${c} and o.order_number = 'OX17PO'
      `);
      return rows as unknown as { purchasing_org: string; plant: string }[];
    });
    expect(order).toMatchObject({ purchasing_org: '1000', plant: '1000' });
    const still = await checkPurchasingOrgPlant(c, '1000', '1000');
    expect(still.citations.purchaseOrders).toBe(1);
  });

  it('removes an uncited pair and records the deletion without posting', async () => {
    const c = await standingClient();
    const before = await counts(c);
    const removed = await removePurchasingOrgPlant({
      client: c, changedBy: ACTOR, purchasingOrg: '2000', plant: '2000', reason: 'No document cites this pair.', requestKey: 'ox17-remove-2000',
    });
    expect(removed).toMatchObject({ removed: true, replayed: false });
    const after = await counts(c);
    expect(Number(after.pairs)).toBe(Number(before.pairs) - 1);
    expect(after.journals).toBe(before.journals);
    expect(after.stock).toBe(before.stock);
    const history = await withTenant(c, (tx) => changeHistory(tx, c, 'purchasing_org_plant', '2000/2000'));
    expect(history.some((entry) => entry.changeType === 'DELETE')).toBe(true);
    await expect(checkPurchasingOrgPlant(c, '2000', '2000')).rejects.toThrow('not assigned');
  });

  it('refuses an order and a named requisition organisation that the plant does not authorize', async () => {
    const c = await standingClient();
    await withTenant(c, async (tx) => {
      await assertPurchasingOrgForPlant(tx, {
        client: c, purchasingOrg: '1000', plant: '1000', documentType: 'PURCHASE_ORDER',
      });
    });
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into plant (client, plant, name, country, company_code, created_by)
        values (${c}, '5000', 'Unassigned company plant', 'KW', '1000', ${ACTOR})
        on conflict do nothing
      `);
    });
    await expect(withTenant(c, (tx) => assertPurchasingOrgForPlant(tx, {
      client: c, purchasingOrg: '1000', plant: '5000', documentType: 'PURCHASE_ORDER',
    }))).rejects.toMatchObject({ code: PURCH_ORG_PLANT_NOT_AUTHORIZED });

    await withTenant(c, async (tx) => {
      await defineRange(tx, { client: c, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: c, objectCode: 'PURCHREQ', subObject: 'NB', prefix: 'PR', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into purchasing_group (client, purchasing_group, name, created_by)
        values (${c}, '001', 'OX17 group', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${c}, 'OX17V', 'ORGANIZATION', 'OX17 vendor', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${c}, 'OX17V', 'SUPPLIER', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
        values (${c}, 'OX17V', 'SUPPLIER', '1000', 'USD', ${ACTOR})
        on conflict do nothing
      `);
    });
    const item = {
      materialNumber: '', shortText: 'Plate', quantity: 1, unit: 'PC', netPrice: 1, priceUnit: 1,
      taxCode: '', plant: '5000', storageLocation: '', markedForDeletion: false,
      scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 1 }], assignments: [] as never[],
    };
    await expect(createOrder({
      client: c, changedBy: ACTOR, supplierNumber: 'OX17V', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: 'USD', items: [item],
    })).rejects.toMatchObject({ code: PURCH_ORG_PLANT_NOT_AUTHORIZED });

    const unnamed = await createRequisition({
      client: c, changedBy: ACTOR,
      items: [{
        materialNumber: '', shortText: 'Plate', quantity: 1, unit: 'PC', deliveryDate: '2026-11-15',
        plant: '5000', storageLocation: '', purchasingGroup: '001', markedForDeletion: false, assignments: [],
      }],
    });
    expect(unnamed.requisitionNumber).toBeTruthy();
    await expect(createRequisition({
      client: c, changedBy: ACTOR,
      items: [{
        materialNumber: '', shortText: 'Plate', quantity: 1, unit: 'PC', deliveryDate: '2026-11-15',
        plant: '5000', storageLocation: '', purchasingGroup: '001', purchasingOrg: '1000',
        markedForDeletion: false, assignments: [],
      }],
    })).rejects.toMatchObject({ code: PURCH_ORG_PLANT_NOT_AUTHORIZED });
  });
});
