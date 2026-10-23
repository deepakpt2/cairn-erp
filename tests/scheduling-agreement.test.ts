import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { releaseDocument } from '../src/modules/purchasing/release';
import { closeDb, createTenant, destroyTenant } from './helpers';
import {
  SchedulingAgreementError,
  changeSchedulingAgreement,
  createSchedulingAgreement,
  getSchedulingAgreement,
} from '../src/modules/purchasing/scheduling-agreement';
import { openSchedulingAgreementDisplay } from '../src/modules/purchasing/scheduling-agreement-display';

const ACTOR = 'SCHED_TEST';
const clients: string[] = [];

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

async function standing(seed: string): Promise<string> {
  const tenant = await createTenant(seed);
  clients.push(tenant.client);
  const client = tenant.client;
  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'SCHEDAGREE', subObject: '*', prefix: '55', numberLength: 10, createdBy: ACTOR });
    await tx.execute(sql`
      insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
      values (${client}, '1000', 'Test purchasing organization', '1000', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_org_plant (client, purchasing_org, plant, created_by)
      values (${client}, '1000', '1000', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by)
      values (${client}, 'V10000', 'ORGANIZATION', 'Test Supplier', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'V10000', 'SUPPLIER', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
      values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      values (${client}, 'MAT-SA', 'Agreement material', 'RAW', 'PC', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      values (${client}, 'MAT-SA', '1000', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into scheduling_agreement_type (client, document_type, description, category, created_by)
      values (${client}, 'LP', 'Scheduling agreement', 'SCHEDULING', ${ACTOR})
      on conflict do nothing
    `);
  });
  return client;
}

function header(type = 'LP') {
  return {
    documentType: type,
    supplierNumber: 'V10000',
    purchasingOrg: '1000',
    purchasingGroup: '001',
    companyCode: '1000',
    currency: 'USD',
    validityStart: '2026-01-01',
    validityEnd: '2026-12-31',
  };
}

describe('scheduling agreement', () => {
  it('creates an agreement without a schedule line, a contract, a purchase order, or a posting', async () => {
    const client = await standing('me31l-create');
    const before = await withTenant(client, async (tx) => {
      const [docs] = await tx.execute(sql`select count(*)::int as n from material_document where client = ${client}`) as unknown as Array<{ n: number }>;
      const [journals] = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
      const [contracts] = await tx.execute(sql`select count(*)::int as n from purchase_contract where client = ${client}`) as unknown as Array<{ n: number }>;
      const [orders] = await tx.execute(sql`select count(*)::int as n from purchase_order where client = ${client}`) as unknown as Array<{ n: number }>;
      return { docs: Number(docs.n), journals: Number(journals.n), contracts: Number(contracts.n), orders: Number(orders.n) };
    });
    const saved = await createSchedulingAgreement({
      client, changedBy: ACTOR, ...header(),
      items: [{ materialNumber: 'MAT-SA', shortText: 'Steel', targetQuantity: 10, unit: 'PC', netPrice: 5, plant: '1000' }],
    });
    const document = await getSchedulingAgreement(client, saved.agreementNumber);
    expect(document?.documentType).toBe('LP');
    expect(document?.items[0].targetQuantity).toBe('10.000');
    expect(document?.items[0].scheduledQuantity).toBe('0.000');
    expect(document?.scheduleLines).toEqual([]);
    expect(document?.releaseStatus).toBe('NOT_REQUIRED');
    const after = await withTenant(client, async (tx) => {
      const [docs] = await tx.execute(sql`select count(*)::int as n from material_document where client = ${client}`) as unknown as Array<{ n: number }>;
      const [journals] = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
      const [contracts] = await tx.execute(sql`select count(*)::int as n from purchase_contract where client = ${client}`) as unknown as Array<{ n: number }>;
      const [orders] = await tx.execute(sql`select count(*)::int as n from purchase_order where client = ${client}`) as unknown as Array<{ n: number }>;
      const [lines] = await tx.execute(sql`select count(*)::int as n from scheduling_agreement_schedule_line where client = ${client}`) as unknown as Array<{ n: number }>;
      return { docs: Number(docs.n), journals: Number(journals.n), contracts: Number(contracts.n), orders: Number(orders.n), lines: Number(lines.n) };
    });
    expect(after.docs).toBe(before.docs);
    expect(after.journals).toBe(before.journals);
    expect(after.contracts).toBe(before.contracts);
    expect(after.orders).toBe(before.orders);
    expect(after.lines).toBe(0);
  });

  it('refuses an unconfigured type, a missing supplier, a bad date, and a failed item without a partial header', async () => {
    const client = await standing('me31l-bad');
    await expect(createSchedulingAgreement({
      client, changedBy: ACTOR, ...header('ZZ'),
      items: [{ shortText: 'Steel', targetQuantity: 1, unit: 'PC', netPrice: 1 }],
    })).rejects.toThrow(/not an active scheduling-agreement type/);
    await expect(createSchedulingAgreement({
      client, changedBy: ACTOR, ...header(), supplierNumber: 'MISSING',
      items: [{ shortText: 'Steel', targetQuantity: 1, unit: 'PC', netPrice: 1 }],
    })).rejects.toThrow(/does not exist/);
    await expect(createSchedulingAgreement({
      client, changedBy: ACTOR, ...header(), validityEnd: '2025-01-01',
      items: [{ shortText: 'Steel', targetQuantity: 1, unit: 'PC', netPrice: 1 }],
    })).rejects.toThrow(/validity end/);
    await expect(createSchedulingAgreement({
      client, changedBy: ACTOR, ...header(),
      items: [{ materialNumber: 'NO-MAT', shortText: 'Steel', targetQuantity: 1, unit: 'PC', netPrice: 1 }],
    })).rejects.toThrow(/does not exist/);
    await expect(createSchedulingAgreement({
      client, changedBy: ACTOR, ...header(),
      items: [{ shortText: 'Steel', targetQuantity: 1, unit: 'ZZZ', netPrice: 1 }],
    })).rejects.toThrow(/Unit ZZZ/);
    const count = await withTenant(client, async (tx) => {
      const [row] = await tx.execute(sql`select count(*)::int as n from scheduling_agreement where client = ${client}`) as unknown as Array<{ n: number }>;
      return Number(row.n);
    });
    expect(count).toBe(0);
  });

  it('returns the same agreement for the same request key and draws a different number for another save', async () => {
    const client = await standing('me31l-key');
    const first = await createSchedulingAgreement({
      client, changedBy: ACTOR, ...header(), requestKey: 'same',
      items: [{ shortText: 'Steel', targetQuantity: 2, unit: 'PC', netPrice: 1 }],
    });
    const retry = await createSchedulingAgreement({
      client, changedBy: ACTOR, ...header(), requestKey: 'same',
      items: [{ shortText: 'Steel', targetQuantity: 2, unit: 'PC', netPrice: 1 }],
    });
    const second = await createSchedulingAgreement({
      client, changedBy: ACTOR, ...header(), requestKey: 'other',
      items: [{ shortText: 'Steel', targetQuantity: 2, unit: 'PC', netPrice: 1 }],
    });
    expect(retry.agreementNumber).toBe(first.agreementNumber);
    expect(second.agreementNumber).not.toBe(first.agreementNumber);
    const count = await withTenant(client, async (tx) => {
      const [row] = await tx.execute(sql`select count(*)::int as n from scheduling_agreement where client = ${client}`) as unknown as Array<{ n: number }>;
      return Number(row.n);
    });
    expect(count).toBe(2);
  });

  it('changes the price without rewriting a schedule line and records the old and new price', async () => {
    const client = await standing('me31l-line');
    const saved = await createSchedulingAgreement({
      client, changedBy: ACTOR, ...header(),
      items: [{ materialNumber: 'MAT-SA', shortText: 'Steel', targetQuantity: 10, unit: 'PC', netPrice: 2, plant: '1000' }],
    });
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${client}, 'MAT-ALT', 'Other material', 'RAW', 'PC', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${client}, 'MAT-ALT', '1000', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into scheduling_agreement_schedule_line (
          client, agreement_number, item_number, line_number, delivery_date, quantity, unit, created_by
        ) values (${client}, ${saved.agreementNumber}, 10, 1, '2026-06-01', 4, 'PC', ${ACTOR})
      `);
    });
    await expect(changeSchedulingAgreement({
      client, changedBy: ACTOR, ...header(), agreementNumber: saved.agreementNumber,
      items: [{ itemNumber: 10, materialNumber: 'MAT-ALT', shortText: 'Steel', targetQuantity: 10, unit: 'PC', netPrice: 9, plant: '1000' }],
    })).rejects.toThrow(/material cannot change/);
    await expect(changeSchedulingAgreement({
      client, changedBy: ACTOR, ...header(), agreementNumber: saved.agreementNumber,
      items: [{ itemNumber: 10, materialNumber: 'MAT-SA', shortText: 'Steel', targetQuantity: 10, unit: 'PC', netPrice: 9, plant: '2000' }],
    })).rejects.toThrow(/plant cannot change/);
    await changeSchedulingAgreement({
      client, changedBy: ACTOR, ...header(), agreementNumber: saved.agreementNumber,
      items: [{ itemNumber: 10, materialNumber: 'MAT-SA', shortText: 'Steel', targetQuantity: 10, unit: 'PC', netPrice: 9, plant: '1000' }],
    });
    const document = await getSchedulingAgreement(client, saved.agreementNumber);
    expect(document?.items[0].netPrice).toBe('9.00');
    expect(document?.items[0].scheduledQuantity).toBe('4.000');
    expect(document?.scheduleLines[0].quantity).toBe('4.000');
    const history = await withTenant(client, async (tx) => {
      const [row] = await tx.execute(sql`
        select i.old_value, i.new_value, d.transaction_code
          from change_document d
          join change_document_item i on i.client = d.client and i.change_document_id = d.id
         where d.client = ${client} and d.object_class = 'scheduling_agreement'
           and d.object_key = ${saved.agreementNumber} and i.field_name = 'item10Price'
      `) as unknown as Array<{ old_value: string; new_value: string; transaction_code: string }>;
      return row;
    });
    expect(history.old_value).toBe('2.00');
    expect(history.new_value).toBe('9.00');
    expect(history.transaction_code).toBe('ME32L');
  });

  it('displays an agreement without writing and refuses a display-mode change', async () => {
    const client = await standing('me31l-show');
    const other = await standing('me31l-hide');
    const saved = await createSchedulingAgreement({
      client, changedBy: ACTOR, ...header(),
      items: [{ shortText: 'Shown', targetQuantity: 5, unit: 'PC', netPrice: 4 }],
    });
    const before = await withTenant(client, async (tx) => {
      const [row] = await tx.execute(sql`
        select changed_at from scheduling_agreement where client = ${client} and agreement_number = ${saved.agreementNumber}
      `) as unknown as Array<{ changed_at: Date | null }>;
      return row.changed_at;
    });
    const refused = await openSchedulingAgreementDisplay(client, { agreement: saved.agreementNumber, netPrice: '1' });
    expect(refused.refusal?.message).toMatch(/price change/i);
    expect(refused.document).toBeNull();
    const opened = await openSchedulingAgreementDisplay(client, { agreement: saved.agreementNumber });
    expect(opened.document?.items[0].netPrice).toBe('4.00');
    expect(opened.document?.scheduleLines).toEqual([]);
    const hidden = await openSchedulingAgreementDisplay(other, { agreement: saved.agreementNumber });
    expect(hidden.document).toBeNull();
    expect(hidden.refusal?.message).toMatch(/does not exist/);
    const after = await withTenant(client, async (tx) => {
      const [row] = await tx.execute(sql`
        select changed_at from scheduling_agreement where client = ${client} and agreement_number = ${saved.agreementNumber}
      `) as unknown as Array<{ changed_at: Date | null }>;
      return row.changed_at;
    });
    expect(after).toEqual(before);
  });

  it('refuses a change after the agreement is released', async () => {
    const client = await standing('me31l-rel');
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into characteristic (client, characteristic_name, description, data_format, value_length, decimal_places, lifecycle_status, created_by)
        values (${client}, 'TOTAL_VALUE', 'Total document value', 'NUM', 13, 2, 'ACTIVE', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into class_type (client, class_type, description, object_category, created_by)
        values (${client}, 'SCHED_AGREEMENT', 'Agreement release classes', 'PURCHASING', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into classification_class (client, class_type, class_name, description, lifecycle_status, created_by)
        values (${client}, 'SCHED_AGREEMENT', 'SA_RELEASE', 'Agreement release', 'ACTIVE', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into class_assignment (client, class_type, class_name, position, characteristic_name, created_by)
        values (${client}, 'SCHED_AGREEMENT', 'SA_RELEASE', 1, 'TOTAL_VALUE', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into release_group (client, group_code, document_category, description, created_by)
        values (${client}, 'SA', 'SCHED_AGREEMENT', 'Agreement releases', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into release_code (client, group_code, code, description, created_by)
        values (${client}, 'SA', 'MGR', 'Agreement manager', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into release_strategy (client, group_code, strategy_code, description, class_type, class_name, priority, lifecycle_status, created_by)
        values (${client}, 'SA', 'ALL', 'All agreements', 'SCHED_AGREEMENT', 'SA_RELEASE', 100, 'ACTIVE', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into release_strategy_criterion (client, group_code, strategy_code, characteristic_name, operator, value_from, created_by)
        values (${client}, 'SA', 'ALL', 'TOTAL_VALUE', 'GE', '0', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into release_strategy_step (client, group_code, strategy_code, step, release_code, created_by)
        values (${client}, 'SA', 'ALL', 1, 'MGR', ${ACTOR})
      `);
    });
    const saved = await createSchedulingAgreement({
      client, changedBy: ACTOR, ...header(),
      items: [{ shortText: 'Held', targetQuantity: 2, unit: 'PC', netPrice: 1 }],
    });
    expect((await getSchedulingAgreement(client, saved.agreementNumber))?.releaseStatus).toBe('PENDING');
    await releaseDocument({
      client, changedBy: ACTOR, documentCategory: 'SCHED_AGREEMENT',
      documentNumber: saved.agreementNumber, releaseCode: 'MGR',
    });
    await expect(changeSchedulingAgreement({
      client, changedBy: ACTOR, ...header(), agreementNumber: saved.agreementNumber,
      items: [{ itemNumber: 10, shortText: 'Held', targetQuantity: 2, unit: 'PC', netPrice: 8 }],
    })).rejects.toBeInstanceOf(SchedulingAgreementError);
  });
});
