import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  changePurchasingInfoRecord, createPurchasingInfoRecord, previewPurchasingInfoRecord,
  resolvePurchasingInfoRecord, writePurchasingInfoRecord,
} from '../src/modules/purchasing/info-record';
import { changeOrder, createOrder, getOrder } from '../src/modules/purchasing/orders';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR151_INFO_RECORD';

describe('SCR-151 purchasing info record', () => {
  let client = '';
  let other = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
    if (other) await destroyTenant(other);
  });

  async function standing(): Promise<string> {
    if (client) return client;
    const tenant = await createTenant('scr151-info-record');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'INFOREC', subObject: '*', prefix: 'IR', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into purchasing_group (client, purchasing_group, name, created_by)
        values (${client}, '001', 'Buyer', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, general_status, created_by)
        values (${client}, 'V-IR', 'ORGANIZATION', 'Info supplier', 'CREATED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${client}, 'V-IR', 'SUPPLIER', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into supplier_purchasing_org
          (client, partner_number, role_code, purchasing_org, order_currency, purchasing_group, purchasing_status, created_by)
        values (${client}, 'V-IR', 'SUPPLIER', '1000', 'USD', '001', 'CREATED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MAT-IR', 'Info material', material_type, 'EA', ${ACTOR}
        from material_type where client = ${client} order by material_type limit 1
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, procurement_type, created_by)
        values (${client}, 'MAT-IR', '1000', 'BUY', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into purchase_requisition_item
          (client, requisition_number, item_number, short_text, quantity, unit, requisition_date, delivery_date, plant, purchasing_group, created_by)
        values (${client}, 'PR-IR', 10, 'Stay', 1, 'EA', '2026-10-21', '2026-11-01', '1000', '001', ${ACTOR})
      `);
    });
    return client;
  }

  const price = {
    amount: 10, currency: 'USD', priceUnit: 1, priceUnitOfMeasure: 'EA',
    validFrom: '2020-01-01', validTo: '2099-12-31',
  };

  const orderItem = {
    materialNumber: 'MAT-IR', shortText: 'Info material', quantity: 4, unit: 'EA',
    plant: '1000', storageLocation: '', markedForDeletion: false, taxCode: '',
    scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 4 }], assignments: [] as never[],
  };

  it('creates a standard record, refuses the cuts, and a check writes nothing', async () => {
    const c = await standing();
    const before = await withTenant(c, (tx) => tx.execute(sql`
      select
        (select count(*) from purchasing_info_record where client = ${c}) as records,
        (select count(*) from journal_entry where client = ${c}) as journals,
        (select count(*) from material_document where client = ${c}) as movements,
        (select quantity from purchase_requisition_item where client = ${c} and requisition_number = 'PR-IR') as requisition
    `)) as unknown as Array<{ records: string; journals: string; movements: string; requisition: string }>;

    const preview = await previewPurchasingInfoRecord({
      client: c, changedBy: ACTOR, partnerNumber: 'V-IR', materialNumber: 'MAT-IR',
      purchasingOrg: '1000', price, plannedDeliveryDays: 7, minimumOrderQuantity: 2, minimumOrderUnit: 'EA',
    });
    expect(preview).toEqual({ infoRecordNumber: null, existing: false });
    const untouched = await withTenant(c, (tx) => tx.execute(sql`
      select current_number from number_range
       where client = ${c} and object_code = 'INFOREC'
    `)) as unknown as Array<{ current_number: string }>;
    expect(Number(untouched[0].current_number)).toBe(0);

    const created = await createPurchasingInfoRecord({
      client: c, changedBy: ACTOR, partnerNumber: 'V-IR', materialNumber: 'MAT-IR',
      purchasingOrg: '1000', price, plannedDeliveryDays: 7, minimumOrderQuantity: 2, minimumOrderUnit: 'EA',
    });
    expect(created.infoRecordNumber).toMatch(/^IR-\d{7}$/);
    expect(created.segmentNumber).toBe(1);

    await expect(createPurchasingInfoRecord({
      client: c, changedBy: ACTOR, partnerNumber: 'V-IR', materialNumber: 'MAT-IR',
      purchasingOrg: '1000', price,
    })).rejects.toThrow(created.infoRecordNumber);
    await expect(createPurchasingInfoRecord({
      client: c, changedBy: ACTOR, partnerNumber: 'V-IR', materialNumber: 'MAT-IR',
      purchasingOrg: '1000', price, materialGroup: 'RAW',
    })).rejects.toThrow('material-group');
    await expect(createPurchasingInfoRecord({
      client: c, changedBy: ACTOR, partnerNumber: 'V-IR', materialNumber: '',
      purchasingOrg: '1000', price,
    })).rejects.toThrow();
    await expect(createPurchasingInfoRecord({
      client: c, changedBy: ACTOR, partnerNumber: 'V-IR', materialNumber: 'MAT-IR',
      purchasingOrg: '1000', price, category: 'SUBCONTRACT',
    })).rejects.toThrow('SUBCONTRACT');
    await expect(createPurchasingInfoRecord({
      client: c, changedBy: ACTOR, partnerNumber: 'NOBODY', materialNumber: 'MAT-IR',
      purchasingOrg: '1000', price,
    })).rejects.toThrow('does not exist');
    await expect(createPurchasingInfoRecord({
      client: c, changedBy: ACTOR, partnerNumber: 'V-IR', materialNumber: 'MAT-IR',
      purchasingOrg: '1000', price: { ...price, amount: -1 },
    })).rejects.toThrow('negative');
    await expect(createPurchasingInfoRecord({
      client: c, changedBy: ACTOR, partnerNumber: 'V-IR', materialNumber: 'MAT-IR',
      purchasingOrg: '1000', price: { ...price, currency: 'KWD' },
    })).rejects.toThrow('not converted');
    await expect(createPurchasingInfoRecord({
      client: c, changedBy: ACTOR, partnerNumber: 'V-IR', materialNumber: 'MAT-IR',
      purchasingOrg: '1000', price: { ...price, validFrom: '2026-12-31', validTo: '2026-01-01' },
    })).rejects.toThrow('before the start');
    await expect(createPurchasingInfoRecord({
      client: c, changedBy: ACTOR, partnerNumber: 'V-IR', materialNumber: 'MAT-IR',
      purchasingOrg: '1000', price, orderUnit: 'BOX',
    })).rejects.toThrow('no conversion');

    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${c}, 'MAT-ZERO', 'Zero', material_type, 'EA', ${ACTOR}
        from material_type where client = ${c} order by material_type limit 1
      `);
    });
    const zero = await createPurchasingInfoRecord({
      client: c, changedBy: ACTOR, partnerNumber: 'V-IR', materialNumber: 'MAT-ZERO',
      purchasingOrg: '1000', price: { ...price, amount: 0 },
    });
    const stored = await withTenant(c, (tx) => tx.execute(sql`
      select amount from purchasing_info_record_price
       where client = ${c} and info_record_number = ${zero.infoRecordNumber}
    `)) as unknown as Array<{ amount: string }>;
    expect(Number(stored[0].amount)).toBe(0);

    const after = await withTenant(c, (tx) => tx.execute(sql`
      select
        (select count(*) from journal_entry where client = ${c}) as journals,
        (select count(*) from material_document where client = ${c}) as movements,
        (select quantity from purchase_requisition_item where client = ${c} and requisition_number = 'PR-IR') as requisition
    `)) as unknown as Array<{ journals: string; movements: string; requisition: string }>;
    expect(after[0]).toEqual({ journals: before[0].journals, movements: before[0].movements, requisition: before[0].requisition });
  });

  it('rolls a failed create back, including the number, and two concurrent creates leave one record', async () => {
    const c = await standing();
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${c}, 'MAT-RB', 'Rollback', material_type, 'EA', ${ACTOR}
        from material_type where client = ${c} order by material_type limit 1
      `);
    });
    const before = await withTenant(c, (tx) => tx.execute(sql`
      select current_number from number_range where client = ${c} and object_code = 'INFOREC'
    `)) as unknown as Array<{ current_number: string }>;
    await expect(withTenant(c, async (tx) => {
      await writePurchasingInfoRecord(tx, {
        client: c, changedBy: ACTOR, partnerNumber: 'V-IR', materialNumber: 'MAT-RB',
        purchasingOrg: '1000', price,
      });
      throw new Error('fail the create');
    })).rejects.toThrow('fail the create');
    const after = await withTenant(c, (tx) => tx.execute(sql`
      select
        (select count(*) from purchasing_info_record where client = ${c} and material_number = 'MAT-RB') as records,
        (select current_number from number_range where client = ${c} and object_code = 'INFOREC') as current_number
    `)) as unknown as Array<{ records: string; current_number: string }>;
    expect(Number(after[0].records)).toBe(0);
    expect(after[0].current_number).toBe(before[0].current_number);

    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${c}, 'MAT-CC', 'Concurrent', material_type, 'EA', ${ACTOR}
        from material_type where client = ${c} order by material_type limit 1
      `);
    });
    const raced = await Promise.allSettled([
      createPurchasingInfoRecord({ client: c, changedBy: ACTOR, partnerNumber: 'V-IR', materialNumber: 'MAT-CC', purchasingOrg: '1000', price }),
      createPurchasingInfoRecord({ client: c, changedBy: ACTOR, partnerNumber: 'V-IR', materialNumber: 'MAT-CC', purchasingOrg: '1000', price }),
    ]);
    expect(raced.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((row) => row.status === 'rejected')).toHaveLength(1);
    const rows = await withTenant(c, (tx) => tx.execute(sql`
      select count(*) as n from purchasing_info_record where client = ${c} and material_number = 'MAT-CC'
    `)) as unknown as Array<{ n: string }>;
    expect(Number(rows[0].n)).toBe(1);
  });

  it('closes one overlapping interval, refuses two, and a stale version names the version that stands', async () => {
    const c = await standing();
    const [standingRecord] = await withTenant(c, (tx) => tx.execute(sql`
      select info_record_number, version from purchasing_info_record
       where client = ${c} and material_number = 'MAT-CC'
    `)) as unknown as Array<{ info_record_number: string; version: number }>;
    await expect(changePurchasingInfoRecord({
      client: c, changedBy: ACTOR, reason: 'stale', infoRecordNumber: standingRecord.info_record_number,
      expectedVersion: standingRecord.version + 9, segmentNumber: 1, expectedSegmentVersion: 1,
      plannedDeliveryDays: 4,
    })).rejects.toThrow(`stands at version ${standingRecord.version}`);

    const closed = await changePurchasingInfoRecord({
      client: c, changedBy: ACTOR, reason: 'New interval', infoRecordNumber: standingRecord.info_record_number,
      expectedVersion: standingRecord.version, segmentNumber: 1, expectedSegmentVersion: 1,
      newPrice: { ...price, amount: 12, validFrom: '2026-06-01', validTo: '2026-12-31' },
    });
    const ends = await withTenant(c, (tx) => tx.execute(sql`
      select valid_from, valid_to, amount from purchasing_info_record_price
       where client = ${c} and info_record_number = ${standingRecord.info_record_number}
       order by price_sequence
    `)) as unknown as Array<{ valid_from: string; valid_to: string; amount: string }>;
    expect(ends[0].valid_to).toBe('2026-05-31');
    expect(ends[1].valid_from).toBe('2026-06-01');
    expect(closed.version).toBe(standingRecord.version + 1);

    await changePurchasingInfoRecord({
      client: c, changedBy: ACTOR, reason: 'Later interval', infoRecordNumber: standingRecord.info_record_number,
      expectedVersion: closed.version, segmentNumber: 1,
      newPrice: { ...price, amount: 14, validFrom: '2027-01-01', validTo: '2027-06-30' },
    });
    await expect(changePurchasingInfoRecord({
      client: c, changedBy: ACTOR, reason: 'Spans both', infoRecordNumber: standingRecord.info_record_number,
      expectedVersion: closed.version + 1, segmentNumber: 1,
      newPrice: { ...price, amount: 99, validFrom: '2026-05-01', validTo: '2027-03-01' },
    })).rejects.toThrow('overlaps');
  });

  it('defaults an omitted order price, keeps a typed price, and a later price does not rewrite the order', async () => {
    const c = await standing();
    const [record] = await withTenant(c, (tx) => tx.execute(sql`
      select info_record_number from purchasing_info_record
       where client = ${c} and material_number = 'MAT-IR'
    `)) as unknown as Array<{ info_record_number: string }>;
    const filled = await createOrder({
      client: c, changedBy: ACTOR, supplierNumber: 'V-IR', purchasingOrg: '1000',
      purchasingGroup: '001', companyCode: '1000', currency: '',
      items: [{ ...orderItem, quantity: 1, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 1 }] }],
    });
    expect(filled.warnings.join(' ')).toMatch(/below the info record minimum/);
    const doc = await getOrder(c, filled.orderNumber);
    expect(doc?.items[0]).toMatchObject({
      netPrice: '10.00', priceUnit: '1', infoRecordNumber: record.info_record_number, priceSequence: 1,
    });

    const typed = await createOrder({
      client: c, changedBy: ACTOR, supplierNumber: 'V-IR', purchasingOrg: '1000',
      purchasingGroup: '001', companyCode: '1000', currency: '',
      items: [{ ...orderItem, netPrice: 99, priceUnit: 1 }],
    });
    expect(typed.warnings.join(' ')).toMatch(/keeps the price that was typed/);
    const typedDoc = await getOrder(c, typed.orderNumber);
    expect(typedDoc?.items[0]).toMatchObject({ netPrice: '99.00', infoRecordNumber: record.info_record_number });

    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, procurement_type, created_by)
        values (${c}, 'MAT-RB', '1000', 'BUY', ${ACTOR})
        on conflict do nothing
      `);
    });
    const missing = await createOrder({
      client: c, changedBy: ACTOR, supplierNumber: 'V-IR', purchasingOrg: '1000',
      purchasingGroup: '001', companyCode: '1000', currency: '',
      items: [{ ...orderItem, materialNumber: 'MAT-RB', netPrice: 5, priceUnit: 1 }],
    });
    const missingDoc = await getOrder(c, missing.orderNumber);
    expect(missingDoc?.items[0].infoRecordNumber).toBeNull();

    await changePurchasingInfoRecord({
      client: c, changedBy: ACTOR, reason: 'Price moves', infoRecordNumber: record.info_record_number,
      expectedVersion: 1, segmentNumber: 1,
      newPrice: { ...price, amount: 25, validFrom: doc!.documentDate, validTo: '2099-12-31' },
    });
    const again = await getOrder(c, filled.orderNumber);
    expect(again?.items[0]).toMatchObject({ netPrice: '10.00', priceSequence: 1 });

    await changeOrder({
      client: c, changedBy: ACTOR, orderNumber: filled.orderNumber, supplierNumber: 'V-IR',
      purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
      items: [{ ...orderItem, itemNumber: 10, netPrice: 10, priceUnit: 1, quantity: 6, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 6 }] }],
    });
    const changed = await getOrder(c, filled.orderNumber);
    expect(changed?.items[0]).toMatchObject({ quantity: '6.000', netPrice: '10.00', infoRecordNumber: record.info_record_number, priceSequence: 1 });
  });

  it('applies lead time to one schedule line only, and a missing conversion does not store the reference', async () => {
    const c = await standing();
    const shifted = await createOrder({
      client: c, changedBy: ACTOR, supplierNumber: 'V-IR', purchasingOrg: '1000',
      purchasingGroup: '001', companyCode: '1000', currency: '',
      items: [{ ...orderItem, applyLeadTime: true }],
    });
    const shiftedDoc = await getOrder(c, shifted.orderNumber);
    const expected = new Date(`${shiftedDoc!.documentDate}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() + 7);
    expect(shiftedDoc?.items[0].scheduleLines).toEqual([
      expect.objectContaining({ deliveryDate: expected.toISOString().slice(0, 10), quantity: '4.000' }),
    ]);

    const split = await createOrder({
      client: c, changedBy: ACTOR, supplierNumber: 'V-IR', purchasingOrg: '1000',
      purchasingGroup: '001', companyCode: '1000', currency: '',
      items: [{
        ...orderItem,
        applyLeadTime: true,
        scheduleLines: [
          { deliveryDate: '2026-11-15', quantity: 1 },
          { deliveryDate: '2026-12-01', quantity: 3 },
        ],
      }],
    });
    expect(split.warnings.join(' ')).toMatch(/more than one schedule line/);
    const splitDoc = await getOrder(c, split.orderNumber);
    expect(splitDoc?.items[0].scheduleLines.map((line) => line.deliveryDate)).toEqual(['2026-11-15', '2026-12-01']);

    await expect(createOrder({
      client: c, changedBy: ACTOR, supplierNumber: 'V-IR', purchasingOrg: '1000',
      purchasingGroup: '001', companyCode: '1000', currency: '',
      items: [{ ...orderItem, unit: 'BOX' }],
    })).rejects.toThrow(/no conversion/i);

    const unconverted = await createOrder({
      client: c, changedBy: ACTOR, supplierNumber: 'V-IR', purchasingOrg: '1000',
      purchasingGroup: '001', companyCode: '1000', currency: '',
      items: [{ ...orderItem, unit: 'BOX', netPrice: 40, priceUnit: 1 }],
    });
    expect(unconverted.warnings.join(' ')).toMatch(/reference is not stored/);
    expect((await getOrder(c, unconverted.orderNumber))?.items[0]).toMatchObject({
      netPrice: '40.00', unit: 'BOX', infoRecordNumber: null, priceSequence: null,
    });

    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into material_uom_conversion
          (client, material_number, alternative_unit, base_unit, numerator, denominator, created_by)
        values (${c}, 'MAT-IR', 'BOX', 'EA', 12, 1, ${ACTOR})
      `);
    });
    const converted = await createOrder({
      client: c, changedBy: ACTOR, supplierNumber: 'V-IR', purchasingOrg: '1000',
      purchasingGroup: '001', companyCode: '1000', currency: '',
      items: [{ ...orderItem, unit: 'BOX', netPrice: 40, priceUnit: 1 }],
    });
    expect(converted.warnings.join(' ')).toMatch(/keeps the price that was typed/);
    expect((await getOrder(c, converted.orderNumber))?.items[0].infoRecordNumber).toMatch(/^IR-/);
  });

  it('does not fall through an inactive plant segment, and another tenant cannot read the record', async () => {
    const c = await standing();
    const [record] = await withTenant(c, (tx) => tx.execute(sql`
      select info_record_number, version from purchasing_info_record
       where client = ${c} and material_number = 'MAT-IR'
    `)) as unknown as Array<{ info_record_number: string; version: number }>;
    const plantSegment = await createPurchasingInfoRecord({
      client: c, changedBy: ACTOR, partnerNumber: 'V-IR', materialNumber: 'MAT-IR',
      purchasingOrg: '1000', plant: '1000', infoRecordNumber: record.info_record_number,
      expectedVersion: record.version, price: { ...price, amount: 20 },
    });
    expect(plantSegment.segmentNumber).toBe(2);
    await changePurchasingInfoRecord({
      client: c, changedBy: ACTOR, reason: 'Plant retired', infoRecordNumber: record.info_record_number,
      expectedVersion: record.version + 1, segmentNumber: plantSegment.segmentNumber, markSegmentDeleted: true,
    });
    const blocked = await createOrder({
      client: c, changedBy: ACTOR, supplierNumber: 'V-IR', purchasingOrg: '1000',
      purchasingGroup: '001', companyCode: '1000', currency: '',
      items: [{ ...orderItem, netPrice: 8, priceUnit: 1 }],
    });
    expect(blocked.warnings.join(' ')).toMatch(/not used in its place/);
    const blockedDoc = await getOrder(c, blocked.orderNumber);
    expect(blockedDoc?.items[0].infoRecordNumber).toBeNull();
    expect(blockedDoc?.items[0].netPrice).toBe('8.00');

    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        update material_plant set procurement_type = 'MAKE'
         where client = ${c} and material_number = 'MAT-CC' and plant = '1000'
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, procurement_type, created_by)
        values (${c}, 'MAT-CC', '1000', 'MAKE', ${ACTOR})
        on conflict do nothing
      `);
    });
    const made = await createOrder({
      client: c, changedBy: ACTOR, supplierNumber: 'V-IR', purchasingOrg: '1000',
      purchasingGroup: '001', companyCode: '1000', currency: '',
      items: [{ ...orderItem, materialNumber: 'MAT-CC', netPrice: 3, priceUnit: 1 }],
    });
    expect(made.warnings.join(' ')).toMatch(/procured by production/);
    expect((await getOrder(c, made.orderNumber))?.items[0].infoRecordNumber).toBeNull();

    other = (await createTenant('scr151-info-other')).client;
    const hidden = await withTenant(other, (tx) => resolvePurchasingInfoRecord(tx, {
      client: c, partnerNumber: 'V-IR', materialNumber: 'MAT-IR', purchasingOrg: '1000',
      plant: '1000', pricingDate: '2026-10-21', orderCurrency: 'USD',
    }));
    expect(hidden.qualified).toBe(false);
  });
});
