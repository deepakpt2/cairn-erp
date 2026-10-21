import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  changeQuotaArrangement, createQuotaArrangement, getQuotaArrangement, previewQuotaArrangement,
  previewQuotaChange, previewQuotaSelection, rateQuota, writeQuotaArrangement, writeQuotaChange,
} from '../src/modules/purchasing/quota-arrangement';
import { changeSourceListEntry, createSourceListEntry } from '../src/modules/purchasing/source-list';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR154_QUOTA';

describe('SCR-154 purchasing quota arrangement', () => {
  let client = '';
  let other = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
    if (other) await destroyTenant(other);
  });

  async function standing(): Promise<string> {
    if (client) return client;
    const tenant = await createTenant('scr154-quota');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'QUOTAARR', subObject: '*', prefix: 'QA', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'SOURCELIST', subObject: '*', prefix: 'SL', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into purchasing_group (client, purchasing_group, name, created_by)
        values (${client}, '001', 'Buyer', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, general_status, created_by)
        values
          (${client}, 'V-QA', 'ORGANIZATION', 'Quota supplier', 'CREATED', ${ACTOR}),
          (${client}, 'V-QA2', 'ORGANIZATION', 'Other supplier', 'CREATED', ${ACTOR}),
          (${client}, 'V-BLOCK', 'ORGANIZATION', 'Blocked supplier', 'CREATED', ${ACTOR}),
          (${client}, 'V-BARE', 'ORGANIZATION', 'Unassigned supplier', 'CREATED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values
          (${client}, 'V-QA', 'SUPPLIER', ${ACTOR}),
          (${client}, 'V-QA2', 'SUPPLIER', ${ACTOR}),
          (${client}, 'V-BLOCK', 'SUPPLIER', ${ACTOR}),
          (${client}, 'V-BARE', 'SUPPLIER', ${ACTOR})
      `);
      await tx.execute(sql`
        update business_partner set is_blocked = true
         where client = ${client} and partner_number = 'V-BLOCK'
      `);
      await tx.execute(sql`
        insert into supplier_purchasing_org
          (client, partner_number, role_code, purchasing_org, order_currency, purchasing_group, purchasing_status, created_by)
        values
          (${client}, 'V-QA', 'SUPPLIER', '1000', 'USD', '001', 'CREATED', ${ACTOR}),
          (${client}, 'V-QA2', 'SUPPLIER', '1000', 'USD', '001', 'CREATED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, m.material_number, m.description, t.material_type, 'EA', ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
        cross join (values
          ('MAT-QA', 'Quota material'), ('MAT-MAKE', 'Produced'), ('MAT-BARE', 'No plant')
        ) as m(material_number, description)
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, procurement_type, created_by)
        values
          (${client}, 'MAT-QA', '1000', 'BUY', ${ACTOR}),
          (${client}, 'MAT-MAKE', '1000', 'MAKE', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${client}, '2000', 'Unassigned plant', '1000', 'KW', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_requisition_item
          (client, requisition_number, item_number, short_text, quantity, unit, requisition_date, delivery_date, plant, purchasing_group, created_by)
        values (${client}, 'PR-QA', 10, 'Stay', 1, 'EA', '2026-10-22', '2026-11-01', '1000', '001', ${ACTOR})
      `);
    });
    return client;
  }

  const header = { materialNumber: 'MAT-QA', plant: '1000', validFrom: '2020-01-01', validTo: '2099-12-31' };
  const items = [
    { partnerNumber: 'V-QA', purchasingOrg: '1000', quota: 60 },
    { partnerNumber: 'V-QA2', purchasingOrg: '1000', quota: 40 },
  ];

  async function counts(c: string) {
    const [row] = await withTenant(c, (tx) => tx.execute(sql`
      select
        (select count(*) from purchasing_quota_arrangement where client = ${c}) as arrangements,
        (select count(*) from purchase_order where client = ${c}) as orders,
        (select count(*) from journal_entry where client = ${c}) as journals,
        (select count(*) from material_document where client = ${c}) as movements,
        (select quantity from purchase_requisition_item where client = ${c} and requisition_number = 'PR-QA') as requisition
    `)) as unknown as Array<{ arrangements: string; orders: string; journals: string; movements: string; requisition: string }>;
    return row;
  }

  it('rates the package example exactly, and an equal rating prefers the lower item', () => {
    expect(rateQuota({ quota: 60, baseQuantity: '0', allocatedQuantity: '120' })).toBe('2.000000');
    expect(rateQuota({ quota: 40, baseQuantity: '0', allocatedQuantity: '40' })).toBe('1.000000');
    expect(rateQuota({ quota: 10, baseQuantity: '0', allocatedQuantity: '0' })).toBe('0.000000');
    expect(() => rateQuota({ quota: 0, baseQuantity: '0', allocatedQuantity: '0' })).toThrow('positive integer');
    expect(() => rateQuota({ quota: -1, baseQuantity: '0', allocatedQuantity: '0' })).toThrow('positive integer');
  });

  it('creates an arrangement, a check writes nothing, and the named cuts write nothing', async () => {
    const c = await standing();
    const before = await counts(c);
    const preview = await previewQuotaArrangement({ client: c, changedBy: ACTOR, ...header, items });
    expect(preview.quotaNumber).toBeNull();
    expect(preview.nothingAllocated).toBe(true);
    expect(preview.items.map((item) => item.itemNumber)).toEqual(['001', '002']);
    expect(preview.ratings[0].rating).toBe('0.000000');
    const untouched = await withTenant(c, (tx) => tx.execute(sql`
      select current_number from number_range where client = ${c} and object_code = 'QUOTAARR'
    `)) as unknown as Array<{ current_number: string }>;
    expect(Number(untouched[0].current_number)).toBe(0);

    const created = await createQuotaArrangement({ client: c, changedBy: ACTOR, ...header, items });
    expect(created.quotaNumber).toMatch(/^QA-\d{7}$/);
    const opened = await getQuotaArrangement(c, created.quotaNumber);
    expect(opened?.items).toMatchObject([
      { itemNumber: '001', partnerNumber: 'V-QA', quota: 60, quotaBaseQuantity: '0.000', markedForDeletion: false },
      { itemNumber: '002', partnerNumber: 'V-QA2', quota: 40, quotaBaseQuantity: '0.000' },
    ]);
    expect(opened?.version).toBe(1);

    await expect(createQuotaArrangement({ client: c, changedBy: ACTOR, ...header, quotaNumber: 'QA-9', items }))
      .rejects.toThrow('does not assign the quota number');
    await expect(createQuotaArrangement({
      client: c, changedBy: ACTOR, ...header, items: [{ ...items[0], itemNumber: '001' }],
    })).rejects.toThrow('does not assign the item number');
    await expect(createQuotaArrangement({ client: c, changedBy: ACTOR, ...header, items: [], }))
      .rejects.toThrow('no item');
    await expect(createQuotaArrangement({
      client: c, changedBy: ACTOR, ...header, items: [{ ...items[0], supplyingPlant: '2000' }],
    })).rejects.toThrow('supplying plant');
    await expect(createQuotaArrangement({
      client: c, changedBy: ACTOR, ...header, items: [{ ...items[0], procurementType: 'E' }],
    })).rejects.toThrow('F or E');
    await expect(createQuotaArrangement({
      client: c, changedBy: ACTOR, ...header, items: [{ ...items[0], allocatedQuantity: '1' }],
    })).rejects.toThrow('Allocated quantity is not a field');
    await expect(createQuotaArrangement({
      client: c, changedBy: ACTOR, ...header, items: [{ ...items[0], minSplitQuantity: '1' }],
    })).rejects.toThrow('minimum split');
    await expect(createQuotaArrangement({
      client: c, changedBy: ACTOR, ...header, items: [{ ...items[0], maxLotSize: '1' }],
    })).rejects.toThrow('maximum lot');
    await expect(createQuotaArrangement({ client: c, changedBy: ACTOR, ...header, items, companyCode: '1000' }))
      .rejects.toThrow('company code');
    await expect(createQuotaArrangement({ client: c, changedBy: ACTOR, ...header, items, requestKey: 'again' }))
      .rejects.toThrow('request key');
    await expect(createQuotaArrangement({ client: c, changedBy: ACTOR, ...header, items, deleteArrangement: true }))
      .rejects.toThrow('not physically deleted');
    await expect(createQuotaArrangement({
      client: c, changedBy: ACTOR, ...header, items: [{ ...items[0], quota: 0 }],
    })).rejects.toThrow('positive integer');
    await expect(createQuotaArrangement({
      client: c, changedBy: ACTOR, ...header, items: [{ ...items[0], quota: -2 }],
    })).rejects.toThrow('positive integer');
    await expect(createQuotaArrangement({
      client: c, changedBy: ACTOR, ...header, validFrom: '2026-12-31', validTo: '2026-01-01', items,
    })).rejects.toThrow('before the start');
    await expect(createQuotaArrangement({ client: c, changedBy: ACTOR, ...header, materialNumber: 'NO-MAT', items }))
      .rejects.toThrow('does not exist');
    await expect(createQuotaArrangement({ client: c, changedBy: ACTOR, ...header, plant: '9999', items }))
      .rejects.toThrow('Plant 9999 does not exist');
    await expect(createQuotaArrangement({ client: c, changedBy: ACTOR, ...header, materialNumber: 'MAT-BARE', items }))
      .rejects.toThrow('not extended');
    await expect(createQuotaArrangement({ client: c, changedBy: ACTOR, ...header, materialNumber: 'MAT-MAKE', items }))
      .rejects.toThrow('procured only by production');
    await expect(createQuotaArrangement({
      client: c, changedBy: ACTOR, ...header, items: [{ partnerNumber: 'V-BARE', purchasingOrg: '1000', quota: 10 }],
    })).rejects.toThrow('no purchasing assignment');
    await expect(createQuotaArrangement({
      client: c, changedBy: ACTOR, ...header, items: [{ partnerNumber: 'V-BLOCK', purchasingOrg: '1000', quota: 10 }],
    })).rejects.toThrow('blocked');
    await expect(createQuotaArrangement({
      client: c, changedBy: ACTOR, ...header, items: [{ partnerNumber: 'NOBODY', purchasingOrg: '1000', quota: 10 }],
    })).rejects.toThrow('does not exist');
    await withTenant(c, (tx) => tx.execute(sql`
      insert into material_plant (client, material_number, plant, procurement_type, created_by)
      values (${c}, 'MAT-QA', '2000', 'BUY', ${ACTOR})
    `));
    await expect(createQuotaArrangement({ client: c, changedBy: ACTOR, ...header, plant: '2000', items }))
      .rejects.toThrow('not assigned');
    await expect(createQuotaArrangement({
      client: c, changedBy: ACTOR, ...header,
      items: [items[0], { partnerNumber: 'V-QA', purchasingOrg: '1000', quota: 10 }],
    })).rejects.toThrow('already stands as item 001');

    const after = await counts(c);
    expect(after.journals).toBe(before.journals);
    expect(after.movements).toBe(before.movements);
    expect(after.orders).toBe(before.orders);
    expect(after.requisition).toBe(before.requisition);
    expect(Number(after.arrangements)).toBe(Number(before.arrangements) + 1);
  });

  it('rolls a failed create back, including the number, and two overlapping creates leave one', async () => {
    const c = await standing();
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${c}, 'MAT-RB', 'Rollback', material_type, 'EA', ${ACTOR}
        from material_type where client = ${c} order by material_type limit 1
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, procurement_type, created_by)
        values (${c}, 'MAT-RB', '1000', 'BUY', ${ACTOR})
      `);
    });
    const before = await withTenant(c, (tx) => tx.execute(sql`
      select current_number from number_range where client = ${c} and object_code = 'QUOTAARR'
    `)) as unknown as Array<{ current_number: string }>;
    await expect(withTenant(c, async (tx) => {
      await writeQuotaArrangement(tx, { client: c, changedBy: ACTOR, ...header, materialNumber: 'MAT-RB', items });
      throw new Error('fail the create');
    })).rejects.toThrow('fail the create');
    const after = await withTenant(c, (tx) => tx.execute(sql`
      select
        (select count(*) from purchasing_quota_arrangement where client = ${c} and material_number = 'MAT-RB') as arrangements,
        (select current_number from number_range where client = ${c} and object_code = 'QUOTAARR') as current_number
    `)) as unknown as Array<{ arrangements: string; current_number: string }>;
    expect(Number(after[0].arrangements)).toBe(0);
    expect(after[0].current_number).toBe(before[0].current_number);

    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${c}, 'MAT-CC', 'Concurrent', material_type, 'EA', ${ACTOR}
        from material_type where client = ${c} order by material_type limit 1
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, procurement_type, created_by)
        values (${c}, 'MAT-CC', '1000', 'BUY', ${ACTOR})
      `);
    });
    const raced = await Promise.allSettled([
      createQuotaArrangement({ client: c, changedBy: ACTOR, ...header, materialNumber: 'MAT-CC', items }),
      createQuotaArrangement({ client: c, changedBy: ACTOR, ...header, materialNumber: 'MAT-CC', items }),
    ]);
    expect(raced.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((row) => row.status === 'rejected')).toHaveLength(1);
    const rows = await withTenant(c, (tx) => tx.execute(sql`
      select count(*) as n from purchasing_quota_arrangement where client = ${c} and material_number = 'MAT-CC'
    `)) as unknown as Array<{ n: string }>;
    expect(Number(rows[0].n)).toBe(1);
  });

  it('refuses an overlap without closing the other, and a deactivated arrangement does not hold the interval', async () => {
    const c = await standing();
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${c}, 'MAT-OV', 'Overlap', material_type, 'EA', ${ACTOR}
        from material_type where client = ${c} order by material_type limit 1
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, procurement_type, created_by)
        values (${c}, 'MAT-OV', '1000', 'BUY', ${ACTOR})
      `);
    });
    const first = await createQuotaArrangement({
      client: c, changedBy: ACTOR, ...header, materialNumber: 'MAT-OV', validFrom: '2026-01-01', validTo: '2026-06-30', items,
    });
    const second = await createQuotaArrangement({
      client: c, changedBy: ACTOR, ...header, materialNumber: 'MAT-OV', validFrom: '2026-07-01', validTo: '2026-12-31', items,
    });
    await expect(changeQuotaArrangement({
      client: c, changedBy: ACTOR, reason: 'Crosses the next', quotaNumber: first.quotaNumber,
      expectedVersion: first.version, validTo: '2026-08-01',
    })).rejects.toThrow(second.quotaNumber);
    expect((await getQuotaArrangement(c, second.quotaNumber))?.validTo).toBe('2026-12-31');

    await expect(changeQuotaArrangement({
      client: c, changedBy: ACTOR, reason: 'stale', quotaNumber: first.quotaNumber,
      expectedVersion: first.version + 9, validTo: '2026-05-01',
    })).rejects.toThrow(`stands at version ${first.version}`);
    await expect(changeQuotaArrangement({
      client: c, changedBy: ACTOR, reason: 'Nothing moved', quotaNumber: first.quotaNumber,
      expectedVersion: first.version, validFrom: '2026-01-01', validTo: '2026-06-30',
    })).rejects.toThrow('Nothing on the quota arrangement is changed');
    expect((await getQuotaArrangement(c, first.quotaNumber))?.version).toBe(first.version);
    await expect(changeQuotaArrangement({
      client: c, changedBy: ACTOR, reason: 'Retarget', quotaNumber: first.quotaNumber,
      expectedVersion: first.version, materialNumber: 'MAT-QA',
    })).rejects.toThrow('not retargeted');

    const closed = await changeQuotaArrangement({
      client: c, changedBy: ACTOR, reason: 'Deactivate the first', quotaNumber: first.quotaNumber,
      expectedVersion: first.version, markDeleted: true,
    });
    expect(closed.version).toBe(first.version + 1);
    const replacement = await createQuotaArrangement({
      client: c, changedBy: ACTOR, ...header, materialNumber: 'MAT-OV', validFrom: '2026-01-01', validTo: '2026-03-31', items,
    });
    expect(replacement.quotaNumber).toMatch(/^QA-/);
    expect((await getQuotaArrangement(c, first.quotaNumber))?.markedForDeletion).toBe(true);
  });

  it('ranks the lower rating, excludes a deactivated item, and does not select a future or expired arrangement', async () => {
    const c = await standing();
    const created = await getQuotaArrangement(c, (await withTenant(c, (tx) => tx.execute(sql`
      select quota_number from purchasing_quota_arrangement
       where client = ${c} and material_number = 'MAT-QA' order by quota_number limit 1
    `)) as unknown as Array<{ quota_number: string }>)[0].quota_number);
    expect(created).not.toBeNull();
    const ranked = await previewQuotaSelection({
      client: c, materialNumber: 'MAT-QA', plant: '1000', documentDate: '2026-10-22',
      allocatedByItem: { '001': '120', '002': '40' },
    });
    expect(ranked.quotaNumber).toBe(created?.quotaNumber);
    expect(ranked.ratings.find((row) => row.itemNumber === '001')?.rating).toBe('2.000000');
    expect(ranked.ratings.find((row) => row.itemNumber === '002')?.rating).toBe('1.000000');
    expect(ranked.preferredItemNumber).toBe('002');
    expect(ranked.nothingAllocated).toBe(false);

    const tied = await previewQuotaSelection({
      client: c, materialNumber: 'MAT-QA', plant: '1000', documentDate: '2026-10-22',
    });
    expect(tied.preferredItemNumber).toBe('001');
    expect(tied.nothingAllocated).toBe(true);
    expect(tied.message).toContain('Nothing has been allocated');
    const before = await counts(c);
    expect(before.orders).toBe('0');

    await changeQuotaArrangement({
      client: c, changedBy: ACTOR, reason: 'Deactivate the first item', quotaNumber: created!.quotaNumber,
      expectedVersion: created!.version, items: [{ itemNumber: '001', markDeleted: true }],
    });
    const afterItem = await previewQuotaSelection({
      client: c, materialNumber: 'MAT-QA', plant: '1000', documentDate: '2026-10-22',
    });
    expect(afterItem.ratings.find((row) => row.itemNumber === '001')?.eligible).toBe(false);
    expect(afterItem.preferredItemNumber).toBe('002');

    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${c}, 'MAT-FUT', 'Future', material_type, 'EA', ${ACTOR}
        from material_type where client = ${c} order by material_type limit 1
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, procurement_type, created_by)
        values (${c}, 'MAT-FUT', '1000', 'BUY', ${ACTOR})
      `);
    });
    const future = await createQuotaArrangement({
      client: c, changedBy: ACTOR, ...header, materialNumber: 'MAT-FUT', validFrom: '2099-01-01', validTo: '2099-12-31', items,
    });
    const notYet = await previewQuotaSelection({
      client: c, materialNumber: 'MAT-FUT', plant: '1000', documentDate: '2026-10-22',
    });
    expect(notYet.quotaNumber).toBeNull();
    expect(future.quotaNumber).toMatch(/^QA-/);
    await changeQuotaArrangement({
      client: c, changedBy: ACTOR, reason: 'Expire the wide one', quotaNumber: created!.quotaNumber,
      expectedVersion: (await getQuotaArrangement(c, created!.quotaNumber))!.version, validTo: '2020-01-02',
    });
    const expired = await previewQuotaSelection({
      client: c, materialNumber: 'MAT-QA', plant: '1000', documentDate: '2026-10-22',
    });
    expect(expired.quotaNumber).toBeNull();
  });

  it('names a fixed source, excludes a blocked entry, and does not drop a supplier the list does not require', async () => {
    const c = await standing();
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${c}, 'MAT-SLQ', 'Listed', material_type, 'EA', ${ACTOR}
        from material_type where client = ${c} order by material_type limit 1
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, procurement_type, created_by)
        values (${c}, 'MAT-SLQ', '1000', 'BUY', ${ACTOR})
      `);
    });
    const quota = await createQuotaArrangement({
      client: c, changedBy: ACTOR, ...header, materialNumber: 'MAT-SLQ', items: [items[0]],
    });
    const fixed = await createSourceListEntry({
      client: c, changedBy: ACTOR, materialNumber: 'MAT-SLQ', plant: '1000', partnerNumber: 'V-QA2',
      purchasingOrg: '1000', validFrom: '2020-01-01', validTo: '2099-12-31', fixedSource: true,
    });
    await changeSourceListEntry({
      client: c, changedBy: ACTOR, reason: 'Require a source', sourceNumber: fixed.sourceNumber,
      expectedVersion: fixed.version, expectedListVersion: 1, sourceListRequired: true,
    });
    const named = await previewQuotaSelection({
      client: c, materialNumber: 'MAT-SLQ', plant: '1000', documentDate: '2026-10-22',
    });
    expect(named.preferredItemNumber).toBeNull();
    expect(named.fixedSourceNumber).toBe(fixed.sourceNumber);
    expect(named.fixedSourcePartner).toBe('V-QA2');
    expect(named.message).toContain(fixed.sourceNumber);
    expect(named.ratings).toHaveLength(1);

    const open = await createQuotaArrangement({
      client: c, changedBy: ACTOR, ...header, materialNumber: 'MAT-MAKE', items,
    }).catch(() => null);
    expect(open).toBeNull();
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${c}, 'MAT-OPT', 'Optional', material_type, 'EA', ${ACTOR}
        from material_type where client = ${c} order by material_type limit 1
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, procurement_type, created_by)
        values (${c}, 'MAT-OPT', '1000', 'BUY', ${ACTOR})
      `);
    });
    await createQuotaArrangement({ client: c, changedBy: ACTOR, ...header, materialNumber: 'MAT-OPT', items });
    const blocked = await createSourceListEntry({
      client: c, changedBy: ACTOR, materialNumber: 'MAT-OPT', plant: '1000', partnerNumber: 'V-QA',
      purchasingOrg: '1000', validFrom: '2020-01-01', validTo: '2099-12-31', blockedSource: true,
    });
    const optional = await previewQuotaSelection({
      client: c, materialNumber: 'MAT-OPT', plant: '1000', documentDate: '2026-10-22',
    });
    expect(optional.ratings.find((row) => row.partnerNumber === 'V-QA')?.eligible).toBe(false);
    expect(optional.ratings.find((row) => row.partnerNumber === 'V-QA')?.reason).toContain(blocked.sourceNumber);
    expect(optional.preferredItemNumber).toBe('002');
    expect(quota.quotaNumber).toMatch(/^QA-/);
  });

  it('records the change, a check writes nothing, and another tenant cannot read the arrangement', async () => {
    const c = await standing();
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${c}, 'MAT-AUD', 'Audit', material_type, 'EA', ${ACTOR}
        from material_type where client = ${c} order by material_type limit 1
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, procurement_type, created_by)
        values (${c}, 'MAT-AUD', '1000', 'BUY', ${ACTOR})
      `);
    });
    const created = await createQuotaArrangement({
      client: c, changedBy: ACTOR, ...header, materialNumber: 'MAT-AUD', validFrom: '2028-01-01', validTo: '2028-12-31',
      items: [items[1]],
    });
    const before = await withTenant(c, (tx) => tx.execute(sql`
      select count(*) as audits from change_document
       where client = ${c} and object_key = ${created.quotaNumber}
    `)) as unknown as Array<{ audits: string }>;
    const preview = await previewQuotaChange({
      client: c, changedBy: ACTOR, reason: 'Move the end', quotaNumber: created.quotaNumber,
      expectedVersion: created.version, validTo: '2028-06-30',
    });
    expect(preview.changes).toEqual([{ field: 'validTo', before: '2028-12-31', after: '2028-06-30' }]);
    const afterPreview = await withTenant(c, (tx) => tx.execute(sql`
      select count(*) as audits from change_document
       where client = ${c} and object_key = ${created.quotaNumber}
    `)) as unknown as Array<{ audits: string }>;
    expect(afterPreview[0].audits).toBe(before[0].audits);

    const changed = await changeQuotaArrangement({
      client: c, changedBy: ACTOR, reason: 'Move the end', quotaNumber: created.quotaNumber,
      expectedVersion: created.version, validTo: '2028-06-30',
    });
    expect(changed.version).toBe(created.version + 1);
    const delta = await withTenant(c, (tx) => tx.execute(sql`
      select i.field_name, i.old_value, i.new_value
        from change_document d
        join change_document_item i on i.client = d.client and i.change_document_id = d.id
       where d.client = ${c} and d.object_key = ${created.quotaNumber} and d.change_type = 'CHANGE'
    `)) as unknown as Array<{ field_name: string; old_value: string; new_value: string }>;
    expect(delta).toEqual(expect.arrayContaining([
      { field_name: 'validTo', old_value: '2028-12-31', new_value: '2028-06-30' },
    ]));

    await expect(withTenant(c, async (tx) => {
      await writeQuotaChange(tx, {
        client: c, changedBy: ACTOR, reason: 'Will roll back', quotaNumber: created.quotaNumber,
        expectedVersion: changed.version, markDeleted: true,
      });
      throw new Error('fail the change');
    })).rejects.toThrow('fail the change');
    expect((await getQuotaArrangement(c, created.quotaNumber))?.markedForDeletion).toBe(false);
    const audits = await withTenant(c, (tx) => tx.execute(sql`
      select count(*) as audits from change_document
       where client = ${c} and object_key = ${created.quotaNumber} and reason = 'Will roll back'
    `)) as unknown as Array<{ audits: string }>;
    expect(Number(audits[0].audits)).toBe(0);

    other = (await createTenant('scr154-quota-other')).client;
    expect(await getQuotaArrangement(other, created.quotaNumber)).toBeNull();
  });
});
