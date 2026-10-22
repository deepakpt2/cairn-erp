import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { suggestConstrainedValues } from '../src/modules/foundation/constrained-values';
import { createRequestForQuotation } from '../src/modules/purchasing/rfq';
import { createQuotation } from '../src/modules/purchasing/quotation';
import { ComparisonError, compareQuotations } from '../src/modules/purchasing/quotation-comparison';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR159_CMP';

describe('SCR-159 quotation comparison', () => {
  let client = '';
  let other = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
    if (other) await destroyTenant(other);
  });

  it('ranks one event by the net price per asked unit, and it writes nothing', async () => {
    const tenant = await createTenant('scr159-quotation-comparison');
    client = tenant.client;
    other = (await createTenant('scr159-quotation-comparison-other')).client;
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'RFQEVENT', subObject: '*', prefix: 'EV', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'RFQ', subObject: '*', prefix: 'RQ', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'QUOTATION', subObject: '*', prefix: 'QT', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, general_status, created_by)
        values
          (${client}, 'V-QT', 'ORGANIZATION', 'Quoted supplier', 'CREATED', ${ACTOR}),
          (${client}, 'V-QT2', 'ORGANIZATION', 'Second supplier', 'CREATED', ${ACTOR}),
          (${client}, 'V-QT3', 'ORGANIZATION', 'Later supplier', 'CREATED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values
          (${client}, 'V-QT', 'SUPPLIER', ${ACTOR}),
          (${client}, 'V-QT2', 'SUPPLIER', ${ACTOR}),
          (${client}, 'V-QT3', 'SUPPLIER', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into supplier_purchasing_org
          (client, partner_number, role_code, purchasing_org, order_currency, purchasing_group, purchasing_status, created_by)
        values
          (${client}, 'V-QT', 'SUPPLIER', '1000', 'USD', '001', 'CREATED', ${ACTOR}),
          (${client}, 'V-QT2', 'SUPPLIER', '1000', 'USD', '001', 'CREATED', ${ACTOR}),
          (${client}, 'V-QT3', 'SUPPLIER', '1000', 'USD', '001', 'CREATED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MAT-QT', 'Asked material', t.material_type, 'EA', ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MAT-OTHER', 'Not asked', t.material_type, 'EA', ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, procurement_type, created_by)
        values (${client}, 'MAT-QT', '1000', 'BUY', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_uom_conversion
          (client, material_number, alternative_unit, base_unit, numerator, denominator, created_by)
        values (${client}, 'MAT-QT', 'CS', 'EA', 3, 1, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into purchasing_org (client, purchasing_org, name, company_code, is_active, created_by)
        values (${client}, '2000', 'Other buying', '1000', true, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${client}, '2000', 'Other plant', '1000', 'KW', ${ACTOR})
      `);
    });
    await withTenant(other, async (tx) => {
      await defineRange(tx, { client: other, objectCode: 'RFQEVENT', subObject: '*', prefix: 'EV', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client: other, objectCode: 'RFQ', subObject: '*', prefix: 'RQ', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, general_status, created_by)
        values (${other}, 'V-OT', 'ORGANIZATION', 'Other tenant', 'CREATED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${other}, 'V-OT', 'SUPPLIER', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into supplier_purchasing_org
          (client, partner_number, role_code, purchasing_org, order_currency, purchasing_group, purchasing_status, created_by)
        values (${other}, 'V-OT', 'SUPPLIER', '1000', 'USD', '001', 'CREATED', ${ACTOR})
      `);
    });
    const foreign = await createRequestForQuotation({
      client: other,
      changedBy: ACTOR,
      purchasingOrg: '1000',
      purchasingGroup: '001',
      rfqDate: '2026-10-22',
      quotationDeadline: '2026-12-31',
      collectiveNumber: 'FOREIGN',
      suppliers: [{ partnerNumber: 'V-OT' }],
      lines: [{ shortText: 'Foreign', quantity: '1', unit: 'EA', plant: '1000', deliveryDate: '2026-12-01' }],
    });
    await expect(compareQuotations({ client, eventNumber: foreign.eventNumber, purchasingOrg: '1000' }))
      .rejects.toThrow(`Event ${foreign.eventNumber} does not stand.`);

    const created = await createRequestForQuotation({
      client,
      changedBy: ACTOR,
      purchasingOrg: '1000',
      purchasingGroup: '001',
      rfqDate: '2026-10-22',
      quotationDeadline: '2026-12-31',
      collectiveNumber: 'BID-1',
      suppliers: [{ partnerNumber: 'V-QT' }, { partnerNumber: 'V-QT2' }],
      lines: [
        { materialNumber: 'MAT-QT', quantity: '12.5', plant: '1000', deliveryDate: '2026-12-01' },
        { materialNumber: 'MAT-QT', quantity: '3', plant: '1000', deliveryDate: '2026-12-15' },
        { materialNumber: 'MAT-QT', quantity: '1', plant: '1000', deliveryDate: '2026-12-20' },
        { materialNumber: 'MAT-QT', quantity: '1', plant: '1000', deliveryDate: '2026-12-20' },
      ],
    });
    const request = created.rfqNumbers[0];
    const otherRequest = created.rfqNumbers[1];
    await createQuotation({
      client,
      changedBy: ACTOR,
      rfqNumber: request,
      lines: [
        { itemNumber: 10, quantity: '8', unit: 'EA', netPrice: '250', priceUnit: '100', deliveryDate: '2026-12-20' },
        { itemNumber: 20, quantity: '1', unit: 'CS', netPrice: '2', priceUnit: '1', deliveryDate: '2026-12-15' },
        { itemNumber: 30, quantity: '1', unit: 'EA', netPrice: '5', priceUnit: '1', deliveryDate: '2026-12-20' },
        { itemNumber: 40, quantity: '1', unit: 'EA', netPrice: '0', priceUnit: '1', deliveryDate: '2026-12-20' },
      ],
    });
    await createQuotation({
      client,
      changedBy: ACTOR,
      rfqNumber: otherRequest,
      lines: [
        { itemNumber: 10, quantity: '12.5', unit: 'EA', netPrice: '0', priceUnit: '1', deliveryDate: '2026-12-01' },
        { itemNumber: 20, quantity: '3', unit: 'EA', netPrice: '1', priceUnit: '1', deliveryDate: '2026-12-15' },
        { itemNumber: 30, quantity: '1', unit: 'EA', netPrice: '5', priceUnit: '1', deliveryDate: '2026-12-20' },
      ],
    });
    await withTenant(client, (tx) => tx.execute(sql`
      update purchasing_rfq_event_item set unit = 'CS'
       where client = ${client} and event_number = ${created.eventNumber} and item_number = 30
    `));
    await withTenant(client, (tx) => tx.execute(sql`
      update purchasing_rfq_event_item set unit = 'KG'
       where client = ${client} and event_number = ${created.eventNumber} and item_number = 40
    `));

    async function counts() {
      const [row] = await withTenant(client, (tx) => tx.execute(sql`
        select
          (select count(*)::int from purchasing_quotation where client = ${client}) as quotations,
          (select count(*)::int from purchasing_quotation_item where client = ${client}) as quotation_items,
          (select count(*)::int from change_document where client = ${client}) as changes,
          (select count(*)::int from journal_entry where client = ${client}) as journals,
          (select count(*)::int from material_document where client = ${client}) as movements,
          (select count(*)::int from purchasing_info_record where client = ${client}) as info_records,
          (select count(*)::int from purchase_order where client = ${client}) as orders,
          (select count(*)::int from purchase_requisition_item where client = ${client}) as requisitions,
          (select current_number from number_range where client = ${client} and object_code = 'QUOTATION') as quotation_number
      `)) as unknown as Array<{
        quotations: number;
        quotation_items: number;
        changes: number;
        journals: number;
        movements: number;
        info_records: number;
        orders: number;
        requisitions: number;
        quotation_number: string;
      }>;
      return row;
    }

    const before = await counts();
    const compared = await compareQuotations({
      client,
      eventNumber: created.eventNumber,
      purchasingOrg: '1000',
    });
    expect(compared.eventNumber).toBe(created.eventNumber);
    expect(compared.collectiveNumber).toBe('BID-1');
    expect(compared.currency).toBe('USD');
    expect(compared.evaluationDate).toBe(new Date().toISOString().slice(0, 10));
    expect(compared.currencyNote).toContain('USD');
    expect(compared.currencyNote).toContain('not converted');
    expect(compared.priceNote).toContain('not stored');
    expect(compared.priceNote).toContain('not an award');

    const item10 = compared.items.find((item) => item.itemNumber === 10);
    const cheap = item10?.bids.find((bid) => bid.partnerNumber === 'V-QT2');
    const dear = item10?.bids.find((bid) => bid.partnerNumber === 'V-QT');
    expect(cheap).toMatchObject({
      partnerName: 'Second supplier',
      eligible: true,
      rank: 1,
      tie: false,
      reason: null,
      offer: { comparableUnitPrice: '0.0000', extendedCost: '0.0000', quantityDiffers: false },
    });
    expect(dear).toMatchObject({
      eligible: true,
      rank: 2,
      tie: false,
      offer: { pricePerOfferedUnit: '2.5000', comparableUnitPrice: '2.5000', extendedCost: '31.2500', quantityDiffers: true },
    });

    const item20 = compared.items.find((item) => item.itemNumber === 20);
    expect(item20?.bids.find((bid) => bid.partnerNumber === 'V-QT')).toMatchObject({
      rank: 1,
      offer: { unit: 'CS', comparableUnitPrice: '0.6667', extendedCost: '2.0001' },
    });
    expect(item20?.bids.find((bid) => bid.partnerNumber === 'V-QT2')?.offer?.comparableUnitPrice).toBe('1.0000');

    const item30 = compared.items.find((item) => item.itemNumber === 30);
    expect(item30?.unit).toBe('CS');
    expect(item30?.bids.map((bid) => bid.rank)).toEqual([1, 1]);
    expect(item30?.bids.every((bid) => bid.tie && bid.offer?.comparableUnitPrice === '15.0000')).toBe(true);

    const item40 = compared.items.find((item) => item.itemNumber === 40);
    const unconverted = item40?.bids.find((bid) => bid.partnerNumber === 'V-QT');
    const missing = item40?.bids.find((bid) => bid.partnerNumber === 'V-QT2');
    expect(unconverted).toMatchObject({ eligible: false, rank: null, offer: { netPrice: '0.0000', comparableUnitPrice: null } });
    expect(unconverted?.reason).toContain('no conversion from EA to KG');
    expect(missing).toMatchObject({ eligible: false, rank: null, offer: null, reason: 'No offer.' });
    expect(await counts()).toEqual(before);

    await withTenant(client, (tx) => tx.execute(sql`
      update purchasing_rfq_event
         set rfq_date = '2026-01-01', quotation_deadline = '2026-10-21'
       where client = ${client} and event_number = ${created.eventNumber}
    `));
    const late = await compareQuotations({ client, eventNumber: created.eventNumber, purchasingOrg: '1000' });
    expect(late.items.find((item) => item.itemNumber === 10)?.bids.find((bid) => bid.partnerNumber === 'V-QT2')?.rank).toBe(1);
    expect(await counts()).toEqual(before);

    const labeled = await compareQuotations({ client, collectiveNumber: 'BID-1', purchasingOrg: '1000' });
    expect(labeled.eventNumber).toBe(created.eventNumber);

    const second = await createRequestForQuotation({
      client,
      changedBy: ACTOR,
      purchasingOrg: '1000',
      purchasingGroup: '001',
      rfqDate: '2026-10-22',
      quotationDeadline: '2026-12-31',
      collectiveNumber: 'BID-1',
      suppliers: [{ partnerNumber: 'V-QT3' }],
      lines: [{ materialNumber: 'MAT-QT', quantity: '1', plant: '1000', deliveryDate: '2026-12-01' }],
    });
    await expect(compareQuotations({ client, collectiveNumber: 'BID-1', purchasingOrg: '1000' }))
      .rejects.toThrow(`Collective number BID-1 is a label on ${created.eventNumber}, ${second.eventNumber}. It is not the key.`);
    const stillOne = await compareQuotations({ client, eventNumber: created.eventNumber, purchasingOrg: '1000' });
    expect(stillOne.items[0].bids.map((bid) => bid.partnerNumber)).not.toContain('V-QT3');

    await expect(compareQuotations({ client, collectiveNumber: 'FOREIGN', purchasingOrg: '1000' }))
      .rejects.toThrow('No event carries collective number FOREIGN.');
    await expect(compareQuotations({ client, eventNumber: created.eventNumber, purchasingOrg: '2000' }))
      .rejects.toThrow(`Event ${created.eventNumber} is purchasing organisation 1000, not 2000.`);
    await expect(compareQuotations({ client, eventNumber: created.eventNumber, purchasingOrg: '1000', plant: '9999' }))
      .rejects.toThrow('Plant 9999 does not stand.');
    await expect(compareQuotations({ client, eventNumber: created.eventNumber, purchasingOrg: '1000', materialNumber: 'MAT-MISSING' }))
      .rejects.toThrow('Material MAT-MISSING does not stand.');
    const emptyPlant = await compareQuotations({ client, eventNumber: created.eventNumber, purchasingOrg: '1000', plant: '2000' });
    expect(emptyPlant.items).toEqual([]);
    expect(emptyPlant.filterNote).toContain('No line');
    const emptyMaterial = await compareQuotations({ client, eventNumber: created.eventNumber, purchasingOrg: '1000', materialNumber: 'MAT-OTHER' });
    expect(emptyMaterial.items).toEqual([]);

    const held = await counts();
    const today = new Date().toISOString().slice(0, 10);
    for (const [input, message] of [
      [{ purchasingOrg: '' }, 'A purchasing organisation is required.'],
      [{ purchasingOrg: '1000' }, 'An event number is required.'],
      [{ eventNumber: created.eventNumber, purchasingOrg: '1000', currency: 'EUR' }, 'local currency USD'],
      [{ eventNumber: created.eventNumber, purchasingOrg: '1000', currency: 'USD' }, 'not a field on the comparison'],
      [{ eventNumber: created.eventNumber, purchasingOrg: '1000', evaluationDate: today }, 'not entered'],
      [{ eventNumber: created.eventNumber, purchasingOrg: '1000', priceBasis: 'EFFECTIVE_LANDED_COST' }, 'landed cost is not calculated'],
      [{ eventNumber: created.eventNumber, purchasingOrg: '1000', freight: '1' }, 'landed cost is not calculated'],
      [{ eventNumber: created.eventNumber, purchasingOrg: '1000', award: 'V-QT' }, 'award is not created'],
      [{ eventNumber: created.eventNumber, purchasingOrg: '1000', status: 'SUBMITTED' }, 'no stored status'],
      [{ eventNumber: created.eventNumber, purchasingOrg: '1000', revision: '2' }, 'revision is not stored'],
      [{ eventNumber: created.eventNumber, purchasingOrg: '1000', orderNumber: 'PO-1' }, 'order is not created'],
      [{ eventNumber: created.eventNumber, purchasingOrg: '1000', requestKey: 'key' }, 'request key is not stored'],
    ] as const) {
      await expect(compareQuotations({ client, ...input })).rejects.toThrow(message);
    }
    await expect(compareQuotations({ client, eventNumber: 'EV-NO', purchasingOrg: '1000' })).rejects.toBeInstanceOf(ComparisonError);
    expect(await counts()).toEqual(held);

    expect(await suggestConstrainedValues(client, 'quotation-event', '')).toEqual([]);
    expect(await suggestConstrainedValues(client, 'quotation-event', 'BID-1')).toEqual([]);
    for (let index = 0; index < 4; index += 1) {
      await createRequestForQuotation({
        client,
        changedBy: ACTOR,
        purchasingOrg: '1000',
        purchasingGroup: '001',
        rfqDate: '2026-10-22',
        quotationDeadline: '2026-12-31',
        collectiveNumber: `LBL-${index}`,
        suppliers: [{ partnerNumber: 'V-QT' }],
        lines: [{ materialNumber: 'MAT-QT', quantity: '1', plant: '1000', deliveryDate: '2026-12-01' }],
      });
    }
    const matches = await suggestConstrainedValues(client, 'quotation-event', 'EV');
    expect(matches).toHaveLength(5);
    expect(matches.every((row) => row.code.startsWith('EV-'))).toBe(true);
    expect(matches.map((row) => row.code)).not.toContain('BID-1');
    const last = matches[matches.length - 1].code;
    const again = await suggestConstrainedValues(client, 'quotation-event', 'EV');
    expect(again.map((row) => row.code)).toEqual(matches.map((row) => row.code));
    expect(last).not.toBe('');
  });
});
