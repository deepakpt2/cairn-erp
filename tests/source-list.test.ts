import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { changeOrder, createOrder, getOrder } from '../src/modules/purchasing/orders';
import {
  changeSourceListEntry, createSourceListEntry, getSourceListEntry, previewSourceListChange,
  previewSourceListEntry, resolveSourceList, writeSourceListChange, writeSourceListEntry,
} from '../src/modules/purchasing/source-list';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR153_SOURCE_LIST';

describe('SCR-153 purchasing source list', () => {
  let client = '';
  let other = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
    if (other) await destroyTenant(other);
  });

  async function standing(): Promise<string> {
    if (client) return client;
    const tenant = await createTenant('scr153-source-list');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'SOURCELIST', subObject: '*', prefix: 'SL', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into purchasing_group (client, purchasing_group, name, created_by)
        values (${client}, '001', 'Buyer', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, general_status, created_by)
        values
          (${client}, 'V-SL', 'ORGANIZATION', 'Source supplier', 'CREATED', ${ACTOR}),
          (${client}, 'V-SL2', 'ORGANIZATION', 'Other supplier', 'CREATED', ${ACTOR}),
          (${client}, 'V-BLOCK', 'ORGANIZATION', 'Blocked supplier', 'CREATED', ${ACTOR}),
          (${client}, 'V-BARE', 'ORGANIZATION', 'Unassigned supplier', 'CREATED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values
          (${client}, 'V-SL', 'SUPPLIER', ${ACTOR}),
          (${client}, 'V-SL2', 'SUPPLIER', ${ACTOR}),
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
          (${client}, 'V-SL', 'SUPPLIER', '1000', 'USD', '001', 'CREATED', ${ACTOR}),
          (${client}, 'V-SL2', 'SUPPLIER', '1000', 'USD', '001', 'CREATED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, m.material_number, m.description, t.material_type, 'EA', ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
        cross join (values ('MAT-SL', 'Source material'), ('MAT-MAKE', 'Produced'), ('MAT-BARE', 'No plant')) as m(material_number, description)
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, procurement_type, created_by)
        values
          (${client}, 'MAT-SL', '1000', 'BUY', ${ACTOR}),
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
        values (${client}, 'PR-SL', 10, 'Stay', 1, 'EA', '2026-10-21', '2026-11-01', '1000', '001', ${ACTOR})
      `);
    });
    return client;
  }

  const entry = {
    materialNumber: 'MAT-SL', plant: '1000', partnerNumber: 'V-SL', purchasingOrg: '1000',
    validFrom: '2020-01-01', validTo: '2099-12-31',
  };

  const orderItem = {
    materialNumber: 'MAT-SL', shortText: 'Source material', quantity: 1, unit: 'EA', netPrice: 1, priceUnit: 1,
    plant: '1000', storageLocation: '', markedForDeletion: false, taxCode: '',
    scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 1 }], assignments: [] as never[],
  };

  async function counts(c: string) {
    const [row] = await withTenant(c, (tx) => tx.execute(sql`
      select
        (select count(*) from purchasing_source_list_entry where client = ${c}) as entries,
        (select count(*) from journal_entry where client = ${c}) as journals,
        (select count(*) from material_document where client = ${c}) as movements,
        (select quantity from purchase_requisition_item where client = ${c} and requisition_number = 'PR-SL') as requisition
    `)) as unknown as Array<{ entries: string; journals: string; movements: string; requisition: string }>;
    return row;
  }

  it('creates a source, leaves the requirement off, and a check writes nothing', async () => {
    const c = await standing();
    const before = await counts(c);
    const preview = await previewSourceListEntry({ client: c, changedBy: ACTOR, ...entry, mrpRelevant: true });
    expect(preview.sourceNumber).toBeNull();
    expect(preview.sourceListRequired).toBe(false);
    const untouched = await withTenant(c, (tx) => tx.execute(sql`
      select current_number from number_range where client = ${c} and object_code = 'SOURCELIST'
    `)) as unknown as Array<{ current_number: string }>;
    expect(Number(untouched[0].current_number)).toBe(0);

    const created = await createSourceListEntry({ client: c, changedBy: ACTOR, ...entry, mrpRelevant: true });
    expect(created.sourceNumber).toMatch(/^SL-\d{7}$/);
    expect(created.sourceListRequired).toBe(false);
    const opened = await getSourceListEntry(c, created.sourceNumber);
    expect(opened).toMatchObject({
      partnerNumber: 'V-SL', materialNumber: 'MAT-SL', plant: '1000', mrpRelevant: true,
      fixedSource: false, blockedSource: false, sourceListRequired: false, version: 1,
    });

    await expect(createSourceListEntry({ client: c, changedBy: ACTOR, ...entry, sourceNumber: 'SL-9' }))
      .rejects.toThrow('does not assign');
    await expect(createSourceListEntry({ client: c, changedBy: ACTOR, ...entry, agreementNumber: '4600000001' }))
      .rejects.toThrow('agreement');
    await expect(createSourceListEntry({ client: c, changedBy: ACTOR, ...entry, price: 10 }))
      .rejects.toThrow('price');
    await expect(createSourceListEntry({ client: c, changedBy: ACTOR, ...entry, quota: 50 }))
      .rejects.toThrow('quota');
    await expect(createSourceListEntry({ client: c, changedBy: ACTOR, ...entry, ranking: 1 }))
      .rejects.toThrow('ranking');
    await expect(createSourceListEntry({ client: c, changedBy: ACTOR, ...entry, companyCode: '1000' }))
      .rejects.toThrow('company code');
    await expect(createSourceListEntry({ client: c, changedBy: ACTOR, ...entry, validFrom: '2026-12-31', validTo: '2026-01-01' }))
      .rejects.toThrow('before the start');
    await expect(createSourceListEntry({ client: c, changedBy: ACTOR, ...entry, materialNumber: 'NO-MAT' }))
      .rejects.toThrow('does not exist');
    await expect(createSourceListEntry({ client: c, changedBy: ACTOR, ...entry, plant: '9999' }))
      .rejects.toThrow('Plant 9999 does not exist');
    await expect(createSourceListEntry({ client: c, changedBy: ACTOR, ...entry, materialNumber: 'MAT-BARE' }))
      .rejects.toThrow('not extended');
    await expect(createSourceListEntry({ client: c, changedBy: ACTOR, ...entry, materialNumber: 'MAT-MAKE' }))
      .rejects.toThrow('procured only by production');
    await expect(createSourceListEntry({ client: c, changedBy: ACTOR, ...entry, partnerNumber: 'V-BARE' }))
      .rejects.toThrow('no purchasing assignment');
    await withTenant(c, (tx) => tx.execute(sql`
      insert into material_plant (client, material_number, plant, procurement_type, created_by)
      values (${c}, 'MAT-SL', '2000', 'BUY', ${ACTOR})
    `));
    await expect(createSourceListEntry({ client: c, changedBy: ACTOR, ...entry, plant: '2000' }))
      .rejects.toThrow('not assigned');
    await expect(createSourceListEntry({ client: c, changedBy: ACTOR, ...entry, partnerNumber: 'V-BLOCK' }))
      .rejects.toThrow('blocked');
    await expect(createSourceListEntry({ client: c, changedBy: ACTOR, ...entry, partnerNumber: 'NOBODY' }))
      .rejects.toThrow('does not exist');
    await expect(createSourceListEntry({
      client: c, changedBy: ACTOR, ...entry, partnerNumber: 'V-SL2', purchasingOrg: '2000',
    })).rejects.toThrow('does not exist or is inactive');

    const after = await counts(c);
    expect(after.journals).toBe(before.journals);
    expect(after.movements).toBe(before.movements);
    expect(after.requisition).toBe(before.requisition);
    expect(Number(after.entries)).toBe(Number(before.entries) + 1);
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
      select current_number from number_range where client = ${c} and object_code = 'SOURCELIST'
    `)) as unknown as Array<{ current_number: string }>;
    await expect(withTenant(c, async (tx) => {
      await writeSourceListEntry(tx, { client: c, changedBy: ACTOR, ...entry, materialNumber: 'MAT-RB' });
      throw new Error('fail the create');
    })).rejects.toThrow('fail the create');
    const after = await withTenant(c, (tx) => tx.execute(sql`
      select
        (select count(*) from purchasing_source_list_entry where client = ${c} and material_number = 'MAT-RB') as entries,
        (select current_number from number_range where client = ${c} and object_code = 'SOURCELIST') as current_number
    `)) as unknown as Array<{ entries: string; current_number: string }>;
    expect(Number(after[0].entries)).toBe(0);
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
      createSourceListEntry({ client: c, changedBy: ACTOR, ...entry, materialNumber: 'MAT-CC' }),
      createSourceListEntry({ client: c, changedBy: ACTOR, ...entry, materialNumber: 'MAT-CC' }),
    ]);
    expect(raced.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((row) => row.status === 'rejected')).toHaveLength(1);
    const rows = await withTenant(c, (tx) => tx.execute(sql`
      select count(*) as n from purchasing_source_list_entry where client = ${c} and material_number = 'MAT-CC'
    `)) as unknown as Array<{ n: string }>;
    expect(Number(rows[0].n)).toBe(1);
  });

  it('refuses an overlap without closing the other, and a stale version names the version that stands', async () => {
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
    const first = await createSourceListEntry({
      client: c, changedBy: ACTOR, ...entry, materialNumber: 'MAT-OV', validFrom: '2026-01-01', validTo: '2026-06-30',
    });
    const second = await createSourceListEntry({
      client: c, changedBy: ACTOR, ...entry, materialNumber: 'MAT-OV', validFrom: '2026-07-01', validTo: '2026-12-31',
    });
    await expect(changeSourceListEntry({
      client: c, changedBy: ACTOR, reason: 'stale', sourceNumber: first.sourceNumber,
      expectedVersion: first.version + 9, validTo: '2026-05-01',
    })).rejects.toThrow(`stands at version ${first.version}`);

    await expect(changeSourceListEntry({
      client: c, changedBy: ACTOR, reason: 'Nothing moved', sourceNumber: first.sourceNumber,
      expectedVersion: first.version, validFrom: '2026-01-01', validTo: '2026-06-30',
    })).rejects.toThrow('Nothing on the source list is changed');
    expect((await getSourceListEntry(c, first.sourceNumber))?.version).toBe(first.version);

    await expect(changeSourceListEntry({
      client: c, changedBy: ACTOR, reason: 'Crosses the next', sourceNumber: first.sourceNumber,
      expectedVersion: first.version, validTo: '2026-08-01',
    })).rejects.toThrow(second.sourceNumber);
    expect((await getSourceListEntry(c, second.sourceNumber))?.validTo).toBe('2026-12-31');

    const other = await createSourceListEntry({
      client: c, changedBy: ACTOR, ...entry, materialNumber: 'MAT-OV', partnerNumber: 'V-SL2', fixedSource: true,
      validFrom: '2025-01-01', validTo: '2025-06-30',
    });
    await expect(createSourceListEntry({
      client: c, changedBy: ACTOR, ...entry, materialNumber: 'MAT-OV', fixedSource: true,
      validFrom: '2025-03-01', validTo: '2025-03-31',
    })).rejects.toThrow(`Fixed source ${other.sourceNumber}`);
    const alongside = await createSourceListEntry({
      client: c, changedBy: ACTOR, ...entry, materialNumber: 'MAT-OV', partnerNumber: 'V-SL2', fixedSource: false,
      validFrom: '2026-04-01', validTo: '2026-04-30',
    });
    expect(alongside.sourceNumber).toMatch(/^SL-/);

    await expect(changeSourceListEntry({
      client: c, changedBy: ACTOR, reason: 'Retarget', sourceNumber: first.sourceNumber,
      expectedVersion: first.version, partnerNumber: 'V-SL2',
    })).rejects.toThrow('not retargeted');
  });

  it('stores the source the order used, and a later change leaves that order where it was', async () => {
    const c = await standing();
    const [standingSource] = await withTenant(c, (tx) => tx.execute(sql`
      select source_number, version from purchasing_source_list_entry
       where client = ${c} and material_number = 'MAT-SL' and partner_number = 'V-SL'
    `)) as unknown as Array<{ source_number: string; version: number }>;
    const source = { sourceNumber: standingSource.source_number, version: standingSource.version };
    const placed = await createOrder({
      client: c, changedBy: ACTOR, supplierNumber: 'V-SL', purchasingOrg: '1000',
      purchasingGroup: '001', companyCode: '1000', currency: '', items: [orderItem],
    });
    const doc = await getOrder(c, placed.orderNumber);
    expect(doc?.supplierNumber).toBe('V-SL');
    expect(doc?.items[0].sourceNumber).toBe(source.sourceNumber);

    const required = await changeSourceListEntry({
      client: c, changedBy: ACTOR, reason: 'Require a source', sourceNumber: source.sourceNumber,
      expectedVersion: source.version, expectedListVersion: 1, sourceListRequired: true,
    });
    expect(required.version).toBe(source.version);
    const fixed = await createSourceListEntry({
      client: c, changedBy: ACTOR, ...entry, partnerNumber: 'V-SL2', fixedSource: true,
      validFrom: '2026-01-01', validTo: '2026-12-31',
    });
    await expect(createOrder({
      client: c, changedBy: ACTOR, supplierNumber: 'V-SL', purchasingOrg: '1000',
      purchasingGroup: '001', companyCode: '1000', currency: '',
      items: [{ ...orderItem, quantity: 2, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 2 }] }],
    })).rejects.toThrow(fixed.sourceNumber);
    const ordersBefore = await withTenant(c, (tx) => tx.execute(sql`
      select count(*) as n from purchase_order where client = ${c}
    `)) as unknown as Array<{ n: string }>;

    await changeSourceListEntry({
      client: c, changedBy: ACTOR, reason: 'Block the fixed source', sourceNumber: fixed.sourceNumber,
      expectedVersion: fixed.version, blockedSource: true,
    });
    const allowed = await createOrder({
      client: c, changedBy: ACTOR, supplierNumber: 'V-SL', purchasingOrg: '1000',
      purchasingGroup: '001', companyCode: '1000', currency: '',
      items: [{ ...orderItem, quantity: 2, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 2 }] }],
    });
    expect((await getOrder(c, allowed.orderNumber))?.items[0].sourceNumber).toBe(source.sourceNumber);

    await changeSourceListEntry({
      client: c, changedBy: ACTOR, reason: 'Expire the used source', sourceNumber: source.sourceNumber,
      expectedVersion: required.version, validTo: '2020-01-02',
    });
    const standingOrder = await getOrder(c, placed.orderNumber);
    expect(standingOrder?.supplierNumber).toBe('V-SL');
    expect(standingOrder?.items[0].sourceNumber).toBe(source.sourceNumber);

    await changeOrder({
      client: c, changedBy: ACTOR, orderNumber: placed.orderNumber, supplierNumber: 'V-SL',
      purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
      items: [{ ...orderItem, itemNumber: 10, quantity: 3, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 3 }] }],
    });
    const changed = await getOrder(c, placed.orderNumber);
    expect(changed?.supplierNumber).toBe('V-SL');
    expect(changed?.items[0].sourceNumber).toBe(source.sourceNumber);
    expect(changed?.items[0].quantity).toBe('3.000');
    expect(Number(ordersBefore[0].n)).toBeGreaterThan(0);
  });

  it('does not select a future, expired or blocked entry, and a list that does not require a source does not block', async () => {
    const c = await standing();
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${c}, 'MAT-OPT', 'Optional', material_type, 'EA', ${ACTOR}
        from material_type where client = ${c} order by material_type limit 1
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, procurement_type, created_by)
        values (${c}, 'MAT-OPT', '1000', 'BOTH', ${ACTOR})
      `);
    });
    const future = await createSourceListEntry({
      client: c, changedBy: ACTOR, ...entry, materialNumber: 'MAT-OPT',
      validFrom: '2099-01-01', validTo: '2099-12-31', sourceListRequired: true,
    });
    await expect(withTenant(c, (tx) => resolveSourceList(tx, {
      client: c, materialNumber: 'MAT-OPT', plant: '1000', purchasingOrg: '1000',
      partnerNumber: 'V-SL', documentDate: '2026-10-21',
    }))).rejects.toThrow('no eligible entry');
    await expect(createOrder({
      client: c, changedBy: ACTOR, supplierNumber: 'V-SL', purchasingOrg: '1000',
      purchasingGroup: '001', companyCode: '1000', currency: '',
      items: [{ ...orderItem, materialNumber: 'MAT-OPT' }],
    })).rejects.toThrow('no eligible entry');

    await changeSourceListEntry({
      client: c, changedBy: ACTOR, reason: 'Stop requiring', sourceNumber: future.sourceNumber,
      expectedVersion: future.version, expectedListVersion: 1, sourceListRequired: false,
    });
    const optional = await createOrder({
      client: c, changedBy: ACTOR, supplierNumber: 'V-SL2', purchasingOrg: '1000',
      purchasingGroup: '001', companyCode: '1000', currency: '',
      items: [{ ...orderItem, materialNumber: 'MAT-OPT' }],
    });
    expect((await getOrder(c, optional.orderNumber))?.items[0].sourceNumber).toBeNull();

    const blocked = await createSourceListEntry({
      client: c, changedBy: ACTOR, ...entry, materialNumber: 'MAT-OPT', partnerNumber: 'V-SL2',
      blockedSource: true, validFrom: '2020-01-01', validTo: '2026-12-31',
    });
    const skipped = await withTenant(c, (tx) => resolveSourceList(tx, {
      client: c, materialNumber: 'MAT-OPT', plant: '1000', purchasingOrg: '1000',
      partnerNumber: 'V-SL2', documentDate: '2026-10-21',
    }));
    expect(skipped.sourceNumber).toBeNull();
    expect(blocked.sourceNumber).toMatch(/^SL-/);
  });

  it('records the change, a check writes nothing, and another tenant cannot read the entry', async () => {
    const c = await standing();
    const created = await createSourceListEntry({
      client: c, changedBy: ACTOR, ...entry, partnerNumber: 'V-SL2',
      validFrom: '2028-01-01', validTo: '2028-12-31',
    });
    const before = await withTenant(c, (tx) => tx.execute(sql`
      select count(*) as audits from change_document
       where client = ${c} and object_key = ${created.sourceNumber}
    `)) as unknown as Array<{ audits: string }>;
    const preview = await previewSourceListChange({
      client: c, changedBy: ACTOR, reason: 'Move the end', sourceNumber: created.sourceNumber,
      expectedVersion: created.version, validTo: '2028-06-30',
    });
    expect(preview.changes).toEqual([{ field: 'validTo', before: '2028-12-31', after: '2028-06-30' }]);
    const afterPreview = await withTenant(c, (tx) => tx.execute(sql`
      select count(*) as audits from change_document
       where client = ${c} and object_key = ${created.sourceNumber}
    `)) as unknown as Array<{ audits: string }>;
    expect(afterPreview[0].audits).toBe(before[0].audits);

    const changed = await changeSourceListEntry({
      client: c, changedBy: ACTOR, reason: 'Move the end', sourceNumber: created.sourceNumber,
      expectedVersion: created.version, validTo: '2028-06-30',
    });
    expect(changed.version).toBe(created.version + 1);
    const delta = await withTenant(c, (tx) => tx.execute(sql`
      select i.field_name, i.old_value, i.new_value
        from change_document d
        join change_document_item i on i.client = d.client and i.change_document_id = d.id
       where d.client = ${c} and d.object_key = ${created.sourceNumber} and d.change_type = 'CHANGE'
    `)) as unknown as Array<{ field_name: string; old_value: string; new_value: string }>;
    expect(delta).toEqual(expect.arrayContaining([
      { field_name: 'validTo', old_value: '2028-12-31', new_value: '2028-06-30' },
    ]));

    await expect(withTenant(c, async (tx) => {
      await writeSourceListChange(tx, {
        client: c, changedBy: ACTOR, reason: 'Will roll back', sourceNumber: created.sourceNumber,
        expectedVersion: changed.version, blockedSource: true,
      });
      throw new Error('fail the change');
    })).rejects.toThrow('fail the change');
    expect((await getSourceListEntry(c, created.sourceNumber))?.blockedSource).toBe(false);
    const audits = await withTenant(c, (tx) => tx.execute(sql`
      select count(*) as audits from change_document
       where client = ${c} and object_key = ${created.sourceNumber} and reason = 'Will roll back'
    `)) as unknown as Array<{ audits: string }>;
    expect(Number(audits[0].audits)).toBe(0);

    other = (await createTenant('scr153-source-other')).client;
    expect(await getSourceListEntry(other, created.sourceNumber)).toBeNull();
  });
});
