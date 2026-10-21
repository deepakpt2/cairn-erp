import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import {
  createRequestForQuotation, getRequestForQuotation, previewRequestForQuotation, writeRequestForQuotation,
} from '../src/modules/purchasing/rfq';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR155_RFQ';

describe('SCR-155 request for quotation', () => {
  let client = '';
  let other = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
    if (other) await destroyTenant(other);
  });

  async function standing(): Promise<string> {
    if (client) return client;
    const tenant = await createTenant('scr155-rfq');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'RFQEVENT', subObject: '*', prefix: 'EV', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'RFQ', subObject: '*', prefix: 'RQ', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into unit_of_measure (code, name)
        values ('BX', 'Box')
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, general_status, created_by)
        values
          (${client}, 'V-RFQ', 'ORGANIZATION', 'Asked supplier', 'CREATED', ${ACTOR}),
          (${client}, 'V-RFQ2', 'ORGANIZATION', 'Other supplier', 'CREATED', ${ACTOR}),
          (${client}, 'V-BLOCK', 'ORGANIZATION', 'Blocked supplier', 'CREATED', ${ACTOR}),
          (${client}, 'V-BARE', 'ORGANIZATION', 'Unassigned supplier', 'CREATED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values
          (${client}, 'V-RFQ', 'SUPPLIER', ${ACTOR}),
          (${client}, 'V-RFQ2', 'SUPPLIER', ${ACTOR}),
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
          (${client}, 'V-RFQ', 'SUPPLIER', '1000', 'USD', '001', 'CREATED', ${ACTOR}),
          (${client}, 'V-RFQ2', 'SUPPLIER', '1000', 'USD', '001', 'CREATED', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, m.material_number, m.description, t.material_type, 'EA', ${ACTOR}
        from (select material_type from material_type where client = ${client} order by material_type limit 1) t
        cross join (values
          ('MAT-RFQ', 'Asked material'), ('MAT-BARE', 'No plant'), ('MAT-BLOCK', 'Blocked material')
        ) as m(material_number, description)
      `);
      await tx.execute(sql`
        update material set is_blocked = true
         where client = ${client} and material_number = 'MAT-BLOCK'
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, procurement_type, created_by)
        values
          (${client}, 'MAT-RFQ', '1000', 'BUY', ${ACTOR}),
          (${client}, 'MAT-BLOCK', '1000', 'BUY', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${client}, '2000', 'Unassigned plant', '1000', 'KW', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into company_code (client, company_code, name, currency, country, created_by)
        values (${client}, '2000', 'Other company', 'USD', 'KW', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${client}, '3000', 'Other company plant', '2000', 'KW', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_org_plant (client, purchasing_org, plant, created_by)
        values (${client}, '1000', '3000', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_group (client, purchasing_group, name, purchasing_org, created_by)
        values (${client}, '009', 'Other buyers', '2000', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_requisition_item
          (client, requisition_number, item_number, short_text, quantity, unit, requisition_date, delivery_date, plant, purchasing_group, created_by)
        values (${client}, 'PR-RFQ', 10, 'Stay', 1, 'EA', '2026-10-22', '2026-11-01', '1000', '001', ${ACTOR})
      `);
    });
    return client;
  }

  const header = {
    purchasingOrg: '1000',
    purchasingGroup: '001',
    rfqDate: '2026-10-22',
    quotationDeadline: '2026-11-05',
    collectiveNumber: 'BID-1',
  };
  const suppliers = [{ partnerNumber: 'V-RFQ' }, { partnerNumber: 'V-RFQ2' }];
  const lines = [{
    materialNumber: 'MAT-RFQ', quantity: '12.5', plant: '1000', storageLocation: '0001', deliveryDate: '2026-12-01',
  }];

  async function counts(c: string) {
    const [row] = await withTenant(c, (tx) => tx.execute(sql`
      select
        (select count(*) from purchasing_rfq_event where client = ${c}) as events,
        (select count(*) from purchase_order where client = ${c}) as orders,
        (select count(*) from journal_entry where client = ${c}) as journals,
        (select count(*) from material_document where client = ${c}) as movements,
        (select quantity from purchase_requisition_item where client = ${c} and requisition_number = 'PR-RFQ') as requisition
    `)) as unknown as Array<{ events: string; orders: string; journals: string; movements: string; requisition: string }>;
    return row;
  }

  it('creates one event and one request per supplier, and a check writes nothing', async () => {
    const c = await standing();
    const before = await counts(c);
    const preview = await previewRequestForQuotation({ client: c, changedBy: ACTOR, ...header, suppliers, lines });
    expect(preview.eventNumber).toBeNull();
    expect(preview.nothingCreated).toBe(true);
    expect(preview.message).toBe('Nothing has been created.');
    expect(preview.currency).toBe('USD');
    expect(preview.lines.map((line) => line.itemNumber)).toEqual([10]);
    expect(preview.lines[0]).toMatchObject({ shortText: 'Asked material', unit: 'EA', quantity: '12.500' });
    expect(preview.requests.map((request) => request.rfqNumber)).toEqual([null, null]);
    const untouched = await withTenant(c, (tx) => tx.execute(sql`
      select object_code, current_number
        from number_range
       where client = ${c} and object_code in ('RFQEVENT', 'RFQ')
       order by object_code
    `)) as unknown as Array<{ object_code: string; current_number: string }>;
    expect(untouched.map((row) => Number(row.current_number))).toEqual([0, 0]);

    const created = await createRequestForQuotation({ client: c, changedBy: ACTOR, ...header, suppliers, lines });
    expect(created.eventNumber).toMatch(/^EV-\d{7}$/);
    expect(created.rfqNumbers).toHaveLength(2);
    expect(created.rfqNumbers[0]).toMatch(/^RQ-\d{7}$/);
    expect(created.rfqNumbers[1]).not.toBe(created.rfqNumbers[0]);
    const opened = await getRequestForQuotation(c, created.eventNumber);
    expect(opened?.collectiveNumber).toBe('BID-1');
    expect(opened?.eventNumber).not.toBe('BID-1');
    expect(opened?.currency).toBe('USD');
    expect(opened?.requests.map((request) => request.partnerNumber)).toEqual(['V-RFQ', 'V-RFQ2']);
    expect(opened?.requests[0].lines[0]).toMatchObject({
      itemNumber: 10, shortText: 'Asked material', quantity: '12.500', unit: 'EA', materialNumber: 'MAT-RFQ',
    });
    expect(opened?.requests[1].lines[0].shortText).toBe('Asked material');

    const again = await createRequestForQuotation({ client: c, changedBy: ACTOR, ...header, suppliers, lines });
    expect(again.eventNumber).not.toBe(created.eventNumber);

    await withTenant(c, (tx) => tx.execute(sql`
      update material set description = 'Changed later'
       where client = ${c} and material_number = 'MAT-RFQ'
    `));
    expect((await getRequestForQuotation(c, created.eventNumber))?.requests[0].lines[0].shortText).toBe('Asked material');

    const counters = await withTenant(c, (tx) => tx.execute(sql`
      select object_code, current_number
        from number_range
       where client = ${c} and object_code in ('RFQEVENT', 'RFQ')
    `)) as unknown as Array<{ object_code: string; current_number: string }>;
    const held = Object.fromEntries(counters.map((row) => [row.object_code, row.current_number]));

    await expect(createRequestForQuotation({ client: c, changedBy: ACTOR, ...header, eventNumber: 'EV-9', suppliers, lines }))
      .rejects.toThrow('does not assign the event number');
    await expect(createRequestForQuotation({ client: c, changedBy: ACTOR, ...header, rfqNumber: 'RQ-9', suppliers, lines }))
      .rejects.toThrow('does not assign the request number');
    await expect(createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, suppliers, lines: [{ ...lines[0], itemNumber: 10 }],
    })).rejects.toThrow('does not assign the item number');
    await expect(createRequestForQuotation({ client: c, changedBy: ACTOR, ...header, suppliers, lines: [] }))
      .rejects.toThrow('no line');
    await expect(createRequestForQuotation({ client: c, changedBy: ACTOR, ...header, suppliers: [], lines }))
      .rejects.toThrow('no supplier');
    await expect(createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, suppliers: [suppliers[0], suppliers[0]], lines,
    })).rejects.toThrow('invited twice');
    await expect(createRequestForQuotation({ client: c, changedBy: ACTOR, ...header, documentType: 'AN', suppliers, lines }))
      .rejects.toThrow('does not stand');
    await expect(createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, quotationDeadline: '2026-10-01', suppliers, lines,
    })).rejects.toThrow('before the RFQ date');
    await expect(createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, suppliers, lines: [{ ...lines[0], quantity: 0 }],
    })).rejects.toThrow('greater than zero');
    await expect(createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, suppliers, lines: [{ ...lines[0], quantity: -1 }],
    })).rejects.toThrow('greater than zero');
    await expect(createRequestForQuotation({ client: c, changedBy: ACTOR, ...header, companyCode: '1000', suppliers, lines }))
      .rejects.toThrow('company code is not a column');
    await expect(createRequestForQuotation({ client: c, changedBy: ACTOR, ...header, requestKey: 'again', suppliers, lines }))
      .rejects.toThrow('request key');
    await expect(createRequestForQuotation({ client: c, changedBy: ACTOR, ...header, price: '10', suppliers, lines }))
      .rejects.toThrow('no price');
    await expect(createRequestForQuotation({ client: c, changedBy: ACTOR, ...header, status: 'DRAFT', suppliers, lines }))
      .rejects.toThrow('no stored status');
    await expect(createRequestForQuotation({ client: c, changedBy: ACTOR, ...header, deliveryChannel: 'EMAIL', suppliers, lines }))
      .rejects.toThrow('no dispatcher');
    await expect(createRequestForQuotation({ client: c, changedBy: ACTOR, ...header, requisitionNumber: 'PR-RFQ', suppliers, lines }))
      .rejects.toThrow('not converted');
    await expect(createRequestForQuotation({ client: c, changedBy: ACTOR, ...header, orderNumber: 'PO-1', suppliers, lines }))
      .rejects.toThrow('not created');
    await expect(createRequestForQuotation({ client: c, changedBy: ACTOR, ...header, deleteEvent: true, suppliers, lines }))
      .rejects.toThrow('not physically deleted');
    await expect(createRequestForQuotation({ client: c, changedBy: ACTOR, ...header, currency: 'KWD', suppliers, lines }))
      .rejects.toThrow('local currency');
    await expect(createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, purchasingGroup: '009', suppliers, lines,
    })).rejects.toThrow('belongs to organisation 2000');
    await expect(createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, suppliers, lines: [{ ...lines[0], materialNumber: 'NO-MAT' }],
    })).rejects.toThrow('does not exist');
    await expect(createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, suppliers, lines: [{ ...lines[0], materialNumber: 'MAT-BARE' }],
    })).rejects.toThrow('not extended');
    await expect(createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, suppliers, lines: [{ ...lines[0], materialNumber: 'MAT-BLOCK' }],
    })).rejects.toThrow('is blocked');
    await expect(createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, suppliers, lines: [{ ...lines[0], plant: '9999' }],
    })).rejects.toThrow('Plant 9999 does not exist');
    await expect(createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, suppliers,
      lines: [{ shortText: 'Text', quantity: 1, unit: 'EA', plant: '2000', deliveryDate: '2026-12-01' }],
    })).rejects.toThrow('not assigned');
    await expect(createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, suppliers,
      lines: [{ shortText: 'Text', quantity: 1, unit: 'EA', plant: '3000', deliveryDate: '2026-12-01' }],
    })).rejects.toThrow('not purchasing organisation 1000');
    await expect(createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, suppliers, lines: [{ ...lines[0], storageLocation: '9999' }],
    })).rejects.toThrow('does not stand active');
    await expect(createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, suppliers, lines: [{ ...lines[0], unit: 'ZZ' }],
    })).rejects.toThrow('not a standing unit');
    await expect(createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, suppliers, lines: [{ ...lines[0], unit: 'BX' }],
    })).rejects.toThrow('no conversion');
    await expect(createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, suppliers: [{ partnerNumber: 'NOBODY' }], lines,
    })).rejects.toThrow('does not exist');
    await expect(createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, suppliers: [{ partnerNumber: 'V-BLOCK' }], lines,
    })).rejects.toThrow('is blocked');
    await expect(createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, suppliers: [{ partnerNumber: 'V-BARE' }], lines,
    })).rejects.toThrow('no purchasing assignment');

    const afterCounters = await withTenant(c, (tx) => tx.execute(sql`
      select object_code, current_number
        from number_range
       where client = ${c} and object_code in ('RFQEVENT', 'RFQ')
    `)) as unknown as Array<{ object_code: string; current_number: string }>;
    expect(Object.fromEntries(afterCounters.map((row) => [row.object_code, row.current_number]))).toEqual(held);

    const boxed = await createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, collectiveNumber: null, suppliers: [suppliers[0]],
      lines: [{ ...lines[0], unit: 'BX', quantity: '2', shortText: 'Boxed' }],
    }).catch(async (error: unknown) => {
      await withTenant(c, (tx) => tx.execute(sql`
        insert into material_uom_conversion
          (client, material_number, alternative_unit, base_unit, numerator, denominator, created_by)
        values (${c}, 'MAT-RFQ', 'BX', 'EA', 1, 1, ${ACTOR})
      `));
      if (error instanceof Error && error.message.includes('no conversion')) return null;
      throw error;
    });
    expect(boxed).toBeNull();
    const converted = await createRequestForQuotation({
      client: c, changedBy: ACTOR, ...header, suppliers: [suppliers[0]],
      lines: [{ ...lines[0], unit: 'BX', quantity: '2', shortText: 'Boxed' }],
    });
    const boxedEvent = await getRequestForQuotation(c, converted.eventNumber);
    expect(boxedEvent?.requests[0].lines[0]).toMatchObject({ quantity: '2.000', unit: 'BX', shortText: 'Boxed' });

    const after = await counts(c);
    expect(after.journals).toBe(before.journals);
    expect(after.movements).toBe(before.movements);
    expect(after.orders).toBe(before.orders);
    expect(after.requisition).toBe(before.requisition);
    expect(Number(after.events)).toBe(Number(before.events) + 3);
  });

  it('rolls a failed create back, and two concurrent creates both stand', async () => {
    const c = await standing();
    const before = await withTenant(c, (tx) => tx.execute(sql`
      select object_code, current_number
        from number_range
       where client = ${c} and object_code in ('RFQEVENT', 'RFQ')
       order by object_code
    `)) as unknown as Array<{ current_number: string }>;
    await expect(withTenant(c, async (tx) => {
      await writeRequestForQuotation(tx, {
        client: c, changedBy: ACTOR, ...header, collectiveNumber: 'ROLL', suppliers, lines,
      });
      throw new Error('fail the create');
    })).rejects.toThrow('fail the create');
    const after = await withTenant(c, (tx) => tx.execute(sql`
      select object_code, current_number
        from number_range
       where client = ${c} and object_code in ('RFQEVENT', 'RFQ')
       order by object_code
    `)) as unknown as Array<{ current_number: string }>;
    expect(after.map((row) => row.current_number)).toEqual(before.map((row) => row.current_number));
    const leaked = await withTenant(c, (tx) => tx.execute(sql`
      select count(*) as n from purchasing_rfq_event where client = ${c} and collective_number = 'ROLL'
    `)) as unknown as Array<{ n: string }>;
    expect(Number(leaked[0].n)).toBe(0);

    const raced = await Promise.allSettled([
      createRequestForQuotation({ client: c, changedBy: ACTOR, ...header, collectiveNumber: 'RACE', suppliers: [suppliers[0]], lines }),
      createRequestForQuotation({ client: c, changedBy: ACTOR, ...header, collectiveNumber: 'RACE', suppliers: [suppliers[1]], lines }),
    ]);
    expect(raced.filter((row) => row.status === 'fulfilled')).toHaveLength(2);
    const events = await withTenant(c, (tx) => tx.execute(sql`
      select event_number from purchasing_rfq_event
       where client = ${c} and collective_number = 'RACE'
       order by event_number
    `)) as unknown as Array<{ event_number: string }>;
    expect(events).toHaveLength(2);
    expect(events[0].event_number).not.toBe(events[1].event_number);

    const audits = await withTenant(c, (tx) => tx.execute(sql`
      select object_class, count(*) as n
        from change_document
       where client = ${c} and object_class in ('purchasing_rfq_event', 'purchasing_rfq')
       group by object_class
       order by object_class
    `)) as unknown as Array<{ object_class: string; n: string }>;
    expect(audits.every((row) => Number(row.n) > 0)).toBe(true);

    other = (await createTenant('scr155-rfq-other')).client;
    expect(await getRequestForQuotation(other, events[0].event_number)).toBeNull();
  });
});
