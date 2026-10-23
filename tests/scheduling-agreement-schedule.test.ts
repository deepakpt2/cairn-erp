import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { releaseDocument } from '../src/modules/purchasing/release';
import { closeDb, createTenant, destroyTenant } from './helpers';
import { createSchedulingAgreement, getSchedulingAgreement } from '../src/modules/purchasing/scheduling-agreement';
import {
  SchedulingAgreementScheduleError,
  maintainDeliverySchedule,
} from '../src/modules/purchasing/scheduling-agreement-schedule';
import { openDeliveryScheduleDisplay } from '../src/modules/purchasing/scheduling-agreement-schedule-display';

const ACTOR = 'SCHED_LINE_TEST';
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
      values (${client}, '1000', 'Test purchasing organization', '1000', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_org_plant (client, purchasing_org, plant, created_by)
      values (${client}, '1000', '1000', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by)
      values (${client}, 'V10000', 'ORGANIZATION', 'Test Supplier', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'V10000', 'SUPPLIER', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
      values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      values (${client}, 'MAT-SA', 'Agreement material', 'RAW', 'PC', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      values (${client}, 'MAT-SA', '1000', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into scheduling_agreement_type (client, document_type, description, category, created_by)
      values (${client}, 'LP', 'Scheduling agreement', 'SCHEDULING', ${ACTOR}) on conflict do nothing
    `);
  });
  return client;
}

function header() {
  return {
    documentType: 'LP',
    supplierNumber: 'V10000',
    purchasingOrg: '1000',
    purchasingGroup: '001',
    companyCode: '1000',
    currency: 'USD',
    validityStart: '2026-01-01',
    validityEnd: '2026-12-31',
  };
}

describe('delivery schedule', () => {
  it('saves a partial schedule without a purchase order, a goods receipt, or a supplier release', async () => {
    const client = await standing('me38-save');
    const saved = await createSchedulingAgreement({
      client, changedBy: ACTOR, ...header(),
      items: [{ materialNumber: 'MAT-SA', shortText: 'Steel', targetQuantity: 10, unit: 'PC', netPrice: 5, plant: '1000' }],
    });
    const before = await withTenant(client, async (tx) => {
      const [headerRow] = await tx.execute(sql`
        select changed_at from scheduling_agreement where client = ${client} and agreement_number = ${saved.agreementNumber}
      `) as unknown as Array<{ changed_at: Date | null }>;
      const [docs] = await tx.execute(sql`select count(*)::int as n from material_document where client = ${client}`) as unknown as Array<{ n: number }>;
      const [orders] = await tx.execute(sql`select count(*)::int as n from purchase_order where client = ${client}`) as unknown as Array<{ n: number }>;
      return { changedAt: headerRow.changed_at, docs: Number(docs.n), orders: Number(orders.n) };
    });
    await maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 10,
      lines: [{ deliveryDate: '2026-06-01', quantity: 4 }],
    });
    await maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 10,
      lines: [{ deliveryDate: '2026-07-01', quantity: 3 }],
    });
    const document = await getSchedulingAgreement(client, saved.agreementNumber);
    expect(document?.items[0].scheduledQuantity).toBe('7.000');
    expect(document?.items[0].remainingQuantity).toBe('3.000');
    expect(document?.items[0].netPrice).toBe('5.00');
    expect(document?.scheduleLines.map((line) => line.quantity)).toEqual(['4.000', '3.000']);
    expect(document?.releaseStatus).toBe('NOT_REQUIRED');
    const after = await withTenant(client, async (tx) => {
      const [headerRow] = await tx.execute(sql`
        select changed_at from scheduling_agreement where client = ${client} and agreement_number = ${saved.agreementNumber}
      `) as unknown as Array<{ changed_at: Date | null }>;
      const [docs] = await tx.execute(sql`select count(*)::int as n from material_document where client = ${client}`) as unknown as Array<{ n: number }>;
      const [orders] = await tx.execute(sql`select count(*)::int as n from purchase_order where client = ${client}`) as unknown as Array<{ n: number }>;
      const [history] = await tx.execute(sql`
        select d.transaction_code, i.new_value
          from change_document d
          join change_document_item i on i.client = d.client and i.change_document_id = d.id
         where d.client = ${client} and d.object_key = ${saved.agreementNumber} and d.transaction_code = 'ME38'
           and i.field_name = 'line1Quantity'
      `) as unknown as Array<{ transaction_code: string; new_value: string }>;
      return { changedAt: headerRow.changed_at, docs: Number(docs.n), orders: Number(orders.n), history };
    });
    expect(after.changedAt).toEqual(before.changedAt);
    expect(after.docs).toBe(before.docs);
    expect(after.orders).toBe(before.orders);
    expect(after.history.transaction_code).toBe('ME38');
    expect(after.history.new_value).toBe('4.000');
  });

  it('rejects an excess, a bad date, a wrong unit, a duplicate line, and another item without saving the excess', async () => {
    const client = await standing('me38-over');
    const saved = await createSchedulingAgreement({
      client, changedBy: ACTOR, ...header(),
      items: [{ shortText: 'Steel', targetQuantity: 10, unit: 'PC', netPrice: 2 }],
    });
    await maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 10,
      lines: [{ deliveryDate: '2026-06-01', quantity: 4 }],
    });
    await expect(maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 10,
      lines: [{ deliveryDate: '2026-06-15', quantity: 7 }],
    })).rejects.toThrow(/exceeds target quantity/);
    await expect(maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 10,
      lines: [{ deliveryDate: '2027-01-01', quantity: 1 }],
    })).rejects.toThrow(/outside agreement validity/);
    await expect(maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 10,
      lines: [{ deliveryDate: '2026-02-31', quantity: 1 }],
    })).rejects.toThrow(/not a calendar date/);
    await expect(maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 10,
      lines: [{ deliveryDate: '2026-06-01', quantity: 1, unit: 'KG' }],
    })).rejects.toThrow(/does not match item unit/);
    await expect(maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 10,
      lines: [
        { lineNumber: 1, deliveryDate: '2026-06-01', quantity: 1 },
        { lineNumber: 1, deliveryDate: '2026-06-02', quantity: 1 },
      ],
    })).rejects.toThrow(/named more than once/);
    await expect(maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 20,
      lines: [{ deliveryDate: '2026-06-01', quantity: 1 }],
    })).rejects.toThrow(/does not belong/);
    await expect(maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 10,
      lines: [{ deliveryDate: '2026-06-01', quantity: 1, firmZone: 10 } as never],
    })).rejects.toBeInstanceOf(SchedulingAgreementScheduleError);
    const document = await getSchedulingAgreement(client, saved.agreementNumber);
    expect(document?.scheduleLines).toHaveLength(1);
    expect(document?.scheduleLines[0].quantity).toBe('4.000');
  });

  it('cancels a line without deleting it and keeps the scheduled quantity off the target', async () => {
    const client = await standing('me38-cancel');
    const saved = await createSchedulingAgreement({
      client, changedBy: ACTOR, ...header(),
      items: [{ shortText: 'Steel', targetQuantity: 10, unit: 'PC', netPrice: 2 }],
    });
    await maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 10,
      lines: [{ deliveryDate: '2026-06-01', quantity: 4 }],
    });
    await maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 10,
      lines: [{ lineNumber: 1, deliveryDate: '2026-06-01', quantity: 4, markedForDeletion: true }],
    });
    const document = await getSchedulingAgreement(client, saved.agreementNumber);
    expect(document?.scheduleLines).toHaveLength(1);
    expect(document?.scheduleLines[0].markedForDeletion).toBe(true);
    expect(document?.items[0].scheduledQuantity).toBe('0.000');
    expect(document?.items[0].remainingQuantity).toBe('10.000');
  });

  it('displays a schedule without writing and hides another tenant', async () => {
    const client = await standing('me38-show');
    const other = await standing('me38-other');
    const saved = await createSchedulingAgreement({
      client, changedBy: ACTOR, ...header(),
      items: [{ shortText: 'Shown', targetQuantity: 5, unit: 'PC', netPrice: 4 }],
    });
    await maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 10,
      lines: [{ deliveryDate: '2026-06-01', quantity: 2 }],
    });
    const before = await getSchedulingAgreement(client, saved.agreementNumber);
    const refused = await openDeliveryScheduleDisplay(client, { agreement: saved.agreementNumber, quantity: '9' });
    expect(refused.refusal?.message).toMatch(/quantity change/i);
    expect(refused.document).toBeNull();
    const opened = await openDeliveryScheduleDisplay(client, { agreement: saved.agreementNumber, item: '10' });
    expect(opened.document?.scheduleLines[0].quantity).toBe('2.000');
    const hidden = await openDeliveryScheduleDisplay(other, { agreement: saved.agreementNumber });
    expect(hidden.document).toBeNull();
    const after = await getSchedulingAgreement(client, saved.agreementNumber);
    expect(after?.scheduleLines[0].quantity).toBe(before?.scheduleLines[0].quantity);
  });

  it('does not reset a released agreement when a schedule line is saved', async () => {
    const client = await standing('me38-rel');
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into characteristic (client, characteristic_name, description, data_format, value_length, decimal_places, lifecycle_status, created_by)
        values (${client}, 'TOTAL_VALUE', 'Total document value', 'NUM', 13, 2, 'ACTIVE', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into class_type (client, class_type, description, object_category, created_by)
        values (${client}, 'SCHED_AGREEMENT', 'Agreement release classes', 'PURCHASING', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into classification_class (client, class_type, class_name, description, lifecycle_status, created_by)
        values (${client}, 'SCHED_AGREEMENT', 'SA_RELEASE', 'Agreement release', 'ACTIVE', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into class_assignment (client, class_type, class_name, position, characteristic_name, created_by)
        values (${client}, 'SCHED_AGREEMENT', 'SA_RELEASE', 1, 'TOTAL_VALUE', ${ACTOR}) on conflict do nothing
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
      items: [{ shortText: 'Held', targetQuantity: 8, unit: 'PC', netPrice: 1 }],
    });
    await releaseDocument({
      client, changedBy: ACTOR, documentCategory: 'SCHED_AGREEMENT',
      documentNumber: saved.agreementNumber, releaseCode: 'MGR',
    });
    await maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 10,
      lines: [{ deliveryDate: '2026-06-01', quantity: 2 }],
    });
    const document = await getSchedulingAgreement(client, saved.agreementNumber);
    expect(document?.releaseStatus).toBe('RELEASED');
    const release = await withTenant(client, async (tx) => {
      const [row] = await tx.execute(sql`
        select status, current_step from document_release
         where client = ${client} and document_category = 'SCHED_AGREEMENT' and document_number = ${saved.agreementNumber}
      `) as unknown as Array<{ status: string; current_step: number }>;
      return row;
    });
    expect(release.status).toBe('RELEASED');
    expect(Number(release.current_step)).toBe(1);
  });
});
