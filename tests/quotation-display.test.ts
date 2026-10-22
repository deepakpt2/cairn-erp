import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createRequestForQuotation } from '../src/modules/purchasing/rfq';
import { changeQuotation, createQuotation, getQuotation } from '../src/modules/purchasing/quotation';
import { displayQuotation, displayQuotationForRequest } from '../src/modules/purchasing/quotation-display';
import { createTenant, destroyTenant } from './helpers';

const ACTOR = 'SCR158_DISP';

describe('SCR-158 quotation display', () => {
  let client = '';
  let other = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
    if (other) await destroyTenant(other);
  });

  it('reads one quotation, and it writes nothing', async () => {
    const tenant = await createTenant('scr158-quotation-display');
    client = tenant.client;
    other = (await createTenant('scr158-quotation-display-other')).client;
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'RFQEVENT', subObject: '*', prefix: 'EV', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'RFQ', subObject: '*', prefix: 'RQ', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'QUOTATION', subObject: '*', prefix: 'QT', numberLength: 7, createdBy: ACTOR });
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
    });

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
      ],
    });
    const request = created.rfqNumbers[0];
    const otherRequest = created.rfqNumbers[1];
    const saved = await createQuotation({
      client,
      changedBy: ACTOR,
      rfqNumber: request,
      lines: [
        { itemNumber: 10, quantity: '8', unit: 'EA', netPrice: '250', priceUnit: '100', deliveryDate: '2026-12-20' },
        { itemNumber: 20, quantity: '3', unit: 'EA', netPrice: '0', priceUnit: '1', deliveryDate: '2026-12-15' },
      ],
    });
    const standing = await getQuotation(client, saved.quotationNumber);
    await changeQuotation({
      client,
      changedBy: ACTOR,
      rfqNumber: request,
      expectedChangedAt: standing?.changedAt ?? null,
      reason: 'Revised the price',
      lines: [
        { itemNumber: 10, quantity: '8', unit: 'EA', netPrice: '300', priceUnit: '100', deliveryDate: '2026-12-20' },
        { itemNumber: 20, quantity: '3', unit: 'EA', netPrice: '0', priceUnit: '1', deliveryDate: '2026-12-15' },
      ],
    });

    async function counts() {
      const [row] = await withTenant(client, (tx) => tx.execute(sql`
        select
          (select count(*)::int from purchasing_quotation where client = ${client}) as quotations,
          (select count(*)::int from change_document where client = ${client}) as changes,
          (select count(*)::int from journal_entry where client = ${client}) as journals,
          (select count(*)::int from material_document where client = ${client}) as movements,
          (select count(*)::int from purchasing_info_record where client = ${client}) as info_records,
          (select changed_at::text from purchasing_quotation where client = ${client} and quotation_number = ${saved.quotationNumber}) as touched
      `)) as unknown as Array<{
        quotations: number;
        changes: number;
        journals: number;
        movements: number;
        info_records: number;
        touched: string | null;
      }>;
      return row;
    }

    const before = await counts();
    const opened = await displayQuotation(client, saved.quotationNumber);
    expect(opened.found).toBe(true);
    if (!opened.found) return;
    expect(opened.quotation.partnerNumber).toBe('V-QT');
    expect(opened.quotation.partnerName).toBe('Quoted supplier');
    expect(opened.quotation.currency).toBe('USD');
    expect(opened.quotation.rfqNumber).toBe(request);
    expect(opened.quotation.quotationNumber).not.toBe(request);
    expect(opened.quotation.collectiveNumber).toBe('BID-1');
    expect(opened.quotation.companyCodes).toEqual(['1000']);
    expect(opened.quotation.lines).toHaveLength(3);
    expect(opened.quotation.lines[0].offer).toMatchObject({
      quantity: '8.000', netPrice: '300.0000', priceUnit: '100', pricePerUnit: '3.0000',
    });
    expect(opened.quotation.lines[0].askedQuantity).toBe('12.500');
    expect(opened.quotation.lines[1].offer?.netPrice).toBe('0.0000');
    expect(opened.quotation.lines[1].offer?.pricePerUnit).toBe('0.0000');
    expect(opened.quotation.lines[2].offer).toBeNull();
    expect(opened.quotation.changes.some((row) => row.fieldName === 'line10.netPrice' && row.oldValue === '250.0000' && row.newValue === '300.0000')).toBe(true);
    expect(await counts()).toEqual(before);

    const byRequest = await displayQuotationForRequest(client, request);
    expect(byRequest.found).toBe(true);
    if (byRequest.found) expect(byRequest.quotation.quotationNumber).toBe(saved.quotationNumber);
    expect(await displayQuotation(client, request)).toEqual({ found: false, reason: 'quotation', number: request });
    expect(await displayQuotationForRequest(client, otherRequest)).toEqual({ found: false, reason: 'no-offer', number: otherRequest });
    expect(await displayQuotation(other, saved.quotationNumber)).toEqual({ found: false, reason: 'quotation', number: saved.quotationNumber });
    expect(await displayQuotationForRequest(other, request)).toEqual({ found: false, reason: 'request', number: request });

    await withTenant(client, (tx) => tx.execute(sql`
      update purchasing_rfq_event
         set rfq_date = '2026-01-01', quotation_deadline = '2026-10-21'
       where client = ${client} and event_number = ${created.eventNumber}
    `));
    const late = await displayQuotation(client, saved.quotationNumber);
    expect(late.found).toBe(true);
    if (late.found) expect(late.quotation.quotationDeadline).toBe('2026-10-21');
    expect(await counts()).toEqual(before);

    const columns = await withTenant(client, (tx) => tx.execute(sql`
      select column_name from information_schema.columns
       where table_schema = 'public'
         and table_name = 'purchasing_quotation'
         and column_name in ('status', 'currency', 'partner_number', 'revision', 'price_per_unit')
    `)) as unknown as Array<{ column_name: string }>;
    expect(columns).toEqual([]);
  });
});
