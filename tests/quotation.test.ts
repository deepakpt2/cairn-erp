import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createRequestForQuotation, getRequestForQuotation } from '../src/modules/purchasing/rfq';
import {
  changeQuotation, createQuotation, getQuotation, previewQuotation, previewQuotationChange, writeQuotationChange,
} from '../src/modules/purchasing/quotation';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR157_QT';

describe('SCR-157 quotation', () => {
  let client = '';
  let other = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
    if (other) await destroyTenant(other);
  });

  async function standing(): Promise<string> {
    if (client) return client;
    const tenant = await createTenant('scr157-quotation');
    client = tenant.client;
    other = (await createTenant('scr157-quotation-other')).client;
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'RFQEVENT', subObject: '*', prefix: 'EV', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'RFQ', subObject: '*', prefix: 'RQ', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'QUOTATION', subObject: '*', prefix: 'QT', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into unit_of_measure (code, name) values ('BX', 'Box'), ('CS', 'Case') on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, general_status, created_by)
        values
          (${client}, 'V-QT', 'ORGANIZATION', 'Quoted supplier', 'CREATED', ${ACTOR}),
          (${client}, 'V-QT2', 'ORGANIZATION', 'Other supplier', 'CREATED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values
          (${client}, 'V-QT', 'SUPPLIER', ${ACTOR}),
          (${client}, 'V-QT2', 'SUPPLIER', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into supplier_purchasing_org
          (client, partner_number, role_code, purchasing_org, order_currency, purchasing_group, purchasing_status, created_by)
        values
          (${client}, 'V-QT', 'SUPPLIER', '1000', 'USD', '001', 'CREATED', ${ACTOR}),
          (${client}, 'V-QT2', 'SUPPLIER', '1000', 'USD', '001', 'CREATED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, 'MAT-QT', 'Asked material', t.material_type, 'EA', ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, procurement_type, created_by)
        values (${client}, 'MAT-QT', '1000', 'BUY', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material_uom_conversion
          (client, material_number, alternative_unit, base_unit, numerator, denominator, created_by)
        values (${client}, 'MAT-QT', 'BX', 'EA', 1, 1, ${ACTOR})
      `);
      await tx.execute(sql`
        insert into purchase_requisition_item
          (client, requisition_number, item_number, short_text, quantity, unit, requisition_date, delivery_date, plant, purchasing_group, created_by)
        values (${client}, 'PR-QT', 10, 'Stay', 1, 'EA', '2026-10-22', '2026-11-01', '1000', '001', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into purchase_order
          (client, order_number, supplier_number, purchasing_org, purchasing_group, company_code, currency, document_date, created_by)
        values (${client}, 'PO-QT', 'V-QT', '1000', '001', '1000', 'USD', '2026-10-21', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into purchase_order_item
          (client, order_number, item_number, material_number, short_text, quantity, unit, net_price, net_value, plant, created_by)
        values (${client}, 'PO-QT', 10, 'MAT-QT', 'Stay', 1, 'EA', 1, 1, '1000', ${ACTOR})
      `);
    });
    return client;
  }

  const header = {
    purchasingOrg: '1000',
    purchasingGroup: '001',
    rfqDate: '2026-10-22',
    quotationDeadline: '2026-12-31',
  };
  const asked = [{
    materialNumber: 'MAT-QT', quantity: '12.5', plant: '1000', deliveryDate: '2026-12-01',
  }, {
    materialNumber: 'MAT-QT', quantity: '3', plant: '1000', deliveryDate: '2026-12-15',
  }];

  async function counts(c: string) {
    const [row] = await withTenant(c, (tx) => tx.execute(sql`
      select
        (select count(*)::int from purchasing_quotation where client = ${c}) as quotations,
        (select count(*)::int from purchasing_info_record where client = ${c}) as info_records,
        (select count(*)::int from journal_entry where client = ${c}) as journals,
        (select count(*)::int from material_document where client = ${c}) as movements,
        (select current_number::int from number_range where client = ${c} and object_code = 'QUOTATION') as drawn,
        (select quantity::text from purchase_requisition_item where client = ${c} and requisition_number = 'PR-QT') as requisition,
        (select supplier_number from purchase_order where client = ${c} and order_number = 'PO-QT') as supplier,
        (select quantity::text from purchase_order_item where client = ${c} and order_number = 'PO-QT') as ordered
    `)) as unknown as Array<{
      quotations: number;
      info_records: number;
      journals: number;
      movements: number;
      drawn: number;
      requisition: string;
      supplier: string;
      ordered: string;
    }>;
    return row;
  }

  it('prices one request, and a check writes nothing', async () => {
    const c = await standing();
    const created = await createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, suppliers: [{ partnerNumber: 'V-QT' }, { partnerNumber: 'V-QT2' }], lines: asked,
    });
    const opened = await getRequestForQuotation(c, created.eventNumber);
    const request = opened?.requests[0];
    const otherRequest = opened?.requests[1];
    const offer = {
      client: c,
      changedBy: ACTOR,
      rfqNumber: request!.rfqNumber,
      lines: [{ itemNumber: 10, quantity: '8', unit: 'BX', netPrice: '250', priceUnit: '100', deliveryDate: '2026-12-20', plant: '1000', materialNumber: 'MAT-QT' }],
    };
    const before = await counts(c);
    const preview = await previewQuotation(offer);
    expect(preview.quotationNumber).toBeNull();
    expect(preview.nothingWritten).toBe(true);
    expect(preview.message).toBe('Nothing has been written. The number was not drawn.');
    expect(preview.currency).toBe('USD');
    expect(preview.currencyNote).toBe("The price is in USD, the company's currency.");
    expect(preview.partnerNumber).toBe('V-QT');
    expect(preview.lines[0].asked).toMatchObject({ quantity: '12.500', deliveryDate: '2026-12-01' });
    expect(preview.lines[0].after).toMatchObject({ quantity: '8.000', unit: 'BX', netPrice: '250.0000', priceUnit: '100', pricePerUnit: '2.5000' });
    expect(preview.unquoted.map((line) => line.itemNumber)).toEqual([20]);
    expect(await counts(c)).toEqual(before);

    const saved = await createQuotation({
      ...offer,
      lines: [{ itemNumber: 10, quantity: '8', unit: 'BX', netPrice: '0', priceUnit: '100', deliveryDate: '2026-12-20' }],
    });
    expect(saved.quotationNumber).toMatch(/^QT-\d{7}$/);
    const quotation = await getQuotation(c, saved.quotationNumber);
    expect(quotation?.rfqNumber).toBe(request!.rfqNumber);
    expect(quotation?.lines).toEqual([{
      itemNumber: 10, quantity: '8.000', unit: 'BX', netPrice: '0.0000', priceUnit: '100', deliveryDate: '2026-12-20', remark: null, infoUpdate: false,
    }]);
    const after = await getRequestForQuotation(c, created.eventNumber);
    expect(after?.lines[0]).toMatchObject({ quantity: '12.500', deliveryDate: '2026-12-01' });
    expect(after?.requests[0].lines[0]).toMatchObject({ quantity: '12.500', unit: 'EA' });
    expect(after?.requests[1].lines[0].quantity).toBe('12.500');
    const [otherQuote] = await withTenant(c, (tx) => tx.execute(sql`
      select quotation_number from purchasing_quotation where client = ${c} and rfq_number = ${otherRequest!.rfqNumber}
    `)) as unknown as Array<{ quotation_number: string }>;
    expect(otherQuote).toBeUndefined();
    const end = await counts(c);
    expect(end.quotations).toBe(before.quotations + 1);
    expect(end.drawn).toBe(before.drawn + 1);
    expect(end.info_records).toBe(before.info_records);
    expect(end.journals).toBe(before.journals);
    expect(end.movements).toBe(before.movements);
    expect(end.requisition).toBe('1.000');
    expect(end.supplier).toBe('V-QT');
    expect(end.ordered).toBe('1.000');
    const columns = await withTenant(c, (tx) => tx.execute(sql`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'purchasing_quotation_item' and column_name = 'price_per_unit'
    `)) as unknown as Array<{ column_name: string }>;
    expect(columns).toEqual([]);
  });

  it('refuses a second quotation and the named cuts, and writes nothing', async () => {
    const c = await standing();
    const [row] = await withTenant(c, (tx) => tx.execute(sql`
      select q.rfq_number, r.event_number
        from purchasing_quotation q
        join purchasing_rfq r on r.client = q.client and r.rfq_number = q.rfq_number
       where q.client = ${c}
       order by q.quotation_number
       limit 1
    `)) as unknown as Array<{ rfq_number: string; event_number: string }>;
    const opened = await getRequestForQuotation(c, row.event_number);
    const otherRequest = opened?.requests.find((request) => request.rfqNumber !== row.rfq_number);
    const before = await counts(c);
    const base = {
      client: c,
      changedBy: ACTOR,
      rfqNumber: otherRequest!.rfqNumber,
      lines: [{ itemNumber: 10, quantity: '1', netPrice: '4', priceUnit: '1', deliveryDate: '2026-12-20' }],
    };
    await expect(createQuotation({ ...base, rfqNumber: row.rfq_number })).rejects.toThrow('already stands');
    await expect(createQuotation({ ...base, rfqNumber: 'NO-RQ' })).rejects.toThrow('does not stand');
    await expect(createQuotation({ ...base, quotationNumber: 'QT-9' })).rejects.toThrow('is drawn');
    await expect(createQuotation({ ...base, partnerNumber: 'V-QT' })).rejects.toThrow("not the request's supplier");
    await expect(createQuotation({ ...base, lines: [{ itemNumber: 30, quantity: '1', netPrice: '4', priceUnit: '1', deliveryDate: '2026-12-20' }] }))
      .rejects.toThrow('not on the request');
    await expect(createQuotation({ ...base, lines: [{ itemNumber: 10, quantity: '1', netPrice: '4', priceUnit: '1', deliveryDate: '2026-12-20', plant: '2000' }] }))
      .rejects.toThrow('plant is not changed');
    await expect(createQuotation({ ...base, currency: 'KWD' })).rejects.toThrow("company's local currency USD");
    await expect(createQuotation({ ...base, lines: [{ itemNumber: 10, quantity: '1', priceUnit: '1', deliveryDate: '2026-12-20' }] }))
      .rejects.toThrow('A price is required.');
    await expect(createQuotation({ ...base, lines: [{ itemNumber: 10, quantity: '1', netPrice: '-1', priceUnit: '1', deliveryDate: '2026-12-20' }] }))
      .rejects.toThrow('must not be negative');
    await expect(createQuotation({ ...base, lines: [{ itemNumber: 10, quantity: '0', netPrice: '4', priceUnit: '1', deliveryDate: '2026-12-20' }] }))
      .rejects.toThrow('greater than zero');
    await expect(createQuotation({ ...base, lines: [{ itemNumber: 10, quantity: '1', netPrice: '4', priceUnit: '0', deliveryDate: '2026-12-20' }] }))
      .rejects.toThrow('positive integer');
    await expect(createQuotation({ ...base, lines: [{ itemNumber: 10, quantity: '1', netPrice: '4', priceUnit: '1', unit: 'ZZ', deliveryDate: '2026-12-20' }] }))
      .rejects.toThrow('not a standing unit');
    await expect(createQuotation({ ...base, lines: [{ itemNumber: 10, quantity: '1', netPrice: '4', priceUnit: '1', unit: 'CS', deliveryDate: '2026-12-20' }] }))
      .rejects.toThrow('no conversion');
    await expect(createQuotation({ ...base, companyCode: '1000' })).rejects.toThrow('company code is not a column');
    await expect(createQuotation({ ...base, status: 'SUBMITTED' })).rejects.toThrow('no stored status');
    await expect(createQuotation({ ...base, requestKey: 'again' })).rejects.toThrow('request key');
    await expect(createQuotation({ ...base, award: 'yes' })).rejects.toThrow('not created');
    await expect(createQuotation({ ...base, revision: '2' })).rejects.toThrow('revision is not stored');
    await expect(createQuotation({ ...base, condition: 'FREIGHT' })).rejects.toThrow('condition is not stored');
    await expect(createQuotation({ ...base, lines: [] })).rejects.toThrow('no line');
    expect(await counts(c)).toEqual(before);
  });

  it('changes the standing offer, and a failure rolls the document back', async () => {
    const c = await standing();
    const [row] = await withTenant(c, (tx) => tx.execute(sql`
      select quotation_number, rfq_number from purchasing_quotation where client = ${c} order by quotation_number limit 1
    `)) as unknown as Array<{ quotation_number: string; rfq_number: string }>;
    const loaded = await getQuotation(c, row.quotation_number);
    const change = {
      client: c,
      changedBy: ACTOR,
      rfqNumber: row.rfq_number,
      expectedChangedAt: loaded?.changedAt,
      reason: 'Named a second line',
      lines: [
        { itemNumber: 10, quantity: '8', unit: 'BX', netPrice: '0', priceUnit: '100', deliveryDate: '2026-12-20' },
        { itemNumber: 20, quantity: '3', unit: 'EA', netPrice: '9', priceUnit: '1', deliveryDate: '2026-12-18' },
      ],
    };
    const beforeDocs = await withTenant(c, (tx) => tx.execute(sql`
      select count(*)::int as n from change_document where client = ${c} and change_type = 'CHANGE'
    `)) as unknown as Array<{ n: number }>;
    const preview = await previewQuotationChange(change);
    expect(preview.nothingWritten).toBe(true);
    expect(preview.message).toBe('Nothing has been written.');
    expect(preview.lines.find((line) => line.itemNumber === 20)?.before).toBeNull();
    expect(preview.lines.find((line) => line.itemNumber === 20)?.after.netPrice).toBe('9.0000');
    expect(preview.unquoted).toEqual([]);
    expect((await withTenant(c, (tx) => tx.execute(sql`
      select count(*)::int as n from change_document where client = ${c} and change_type = 'CHANGE'
    `)) as unknown as Array<{ n: number }>)[0].n).toBe(beforeDocs[0].n);

    const changed = await changeQuotation(change);
    expect(changed.changedAt).toBeTruthy();
    const after = await getQuotation(c, row.quotation_number);
    expect(after?.lines.map((line) => line.itemNumber)).toEqual([10, 20]);
    expect(after?.lines[1]).toMatchObject({ quantity: '3.000', netPrice: '9.0000', deliveryDate: '2026-12-18' });
    const docs = await withTenant(c, (tx) => tx.execute(sql`
      select i.field_name, i.old_value, i.new_value
        from change_document d
        join change_document_item i on i.change_document_id = d.id
       where d.client = ${c} and d.object_key = ${row.quotation_number} and d.change_type = 'CHANGE'
    `)) as unknown as Array<{ field_name: string; old_value: string | null; new_value: string | null }>;
    expect(docs.find((entry) => entry.field_name === 'line20.netPrice')).toMatchObject({ old_value: null, new_value: '9.0000' });
    expect(docs.some((entry) => entry.field_name === 'pricePerUnit')).toBe(false);

    const fresh = {
      client: c,
      changedBy: ACTOR,
      rfqNumber: row.rfq_number,
      expectedChangedAt: after?.changedAt,
      reason: 'Should be refused',
      lines: change.lines,
    };
    await expect(changeQuotation({ ...fresh, lines: [change.lines[1]] })).rejects.toThrow('not removed');
    await expect(changeQuotation({ ...fresh, expectedChangedAt: null })).rejects.toThrow('stands as of');
    await expect(changeQuotation({ ...fresh, quotationNumber: 'QT-9' })).rejects.toThrow('not changed');
    await expect(changeQuotation({
      ...fresh, reason: null, lines: [{ ...change.lines[0], netPrice: '1' }, change.lines[1]],
    })).rejects.toThrow('A reason is required.');
    await expect(previewQuotationChange(fresh)).resolves.toMatchObject({ unchanged: true, message: 'Nothing would change.' });
    await expect(changeQuotation(fresh)).rejects.toThrow('Nothing would change.');

    await withTenant(c, (tx) => tx.execute(sql`
      update purchasing_rfq_event set rfq_date = '2026-01-01', quotation_deadline = '2026-10-21'
       where client = ${c} and event_number = (
         select event_number from purchasing_rfq where client = ${c} and rfq_number = ${row.rfq_number}
       )
    `));
    const held = await counts(c);
    await expect(changeQuotation({
      ...fresh, lines: [{ ...change.lines[0], netPrice: '2' }, change.lines[1]],
    })).rejects.toThrow('after the quotation deadline');
    const [otherRequest] = await withTenant(c, (tx) => tx.execute(sql`
      select rfq_number from purchasing_rfq
       where client = ${c} and rfq_number <> ${row.rfq_number}
       limit 1
    `)) as unknown as Array<{ rfq_number: string }>;
    await expect(createQuotation({
      client: c, changedBy: ACTOR, rfqNumber: otherRequest.rfq_number,
      lines: [{ itemNumber: 10, quantity: '1', netPrice: '4', priceUnit: '1', deliveryDate: '2026-12-20' }],
    })).rejects.toThrow('after the quotation deadline');
    expect(await counts(c)).toEqual(held);

    await withTenant(c, (tx) => tx.execute(sql`
      update purchasing_rfq_event set quotation_deadline = '2026-12-31'
       where client = ${c} and event_number = (
         select event_number from purchasing_rfq where client = ${c} and rfq_number = ${row.rfq_number}
       )
    `));
    const beforeRollback = (await getQuotation(c, row.quotation_number))?.lines[1].netPrice;
    await expect(withTenant(c, async (tx) => {
      await writeQuotationChange(tx, {
        ...fresh, lines: [{ ...change.lines[0], netPrice: '3' }, change.lines[1]], reason: 'Roll this back',
      });
      throw new Error('fail the change');
    })).rejects.toThrow('fail the change');
    expect((await getQuotation(c, row.quotation_number))?.lines[1].netPrice).toBe(beforeRollback);
    expect((await getQuotation(c, row.quotation_number))?.lines[0].netPrice).toBe('0.0000');

    const raced = await Promise.allSettled([
      changeQuotation({ ...fresh, lines: [{ ...change.lines[0], netPrice: '5' }, change.lines[1]], reason: 'First writer' }),
      changeQuotation({ ...fresh, lines: [{ ...change.lines[0], netPrice: '6' }, change.lines[1]], reason: 'Second writer' }),
    ]);
    expect(raced.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((entry) => entry.status === 'rejected').map((entry) => String((entry as PromiseRejectedResult).reason))).toEqual([
      expect.stringContaining('stands as of'),
    ]);
    await expect(changeQuotation({ ...fresh, client: other, lines: change.lines })).rejects.toThrow('does not stand');
    const end = await counts(c);
    expect(end.journals).toBe(held.journals);
    expect(end.movements).toBe(held.movements);
    expect(end.info_records).toBe(held.info_records);
    expect(end.supplier).toBe('V-QT');
    expect(end.ordered).toBe('1.000');
  });
});
