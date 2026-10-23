import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { closeDb, createTenant, destroyTenant } from './helpers';
import { releaseDocument } from '../src/modules/purchasing/release';
import { createSchedulingAgreement } from '../src/modules/purchasing/scheduling-agreement';
import { maintainDeliverySchedule } from '../src/modules/purchasing/scheduling-agreement-schedule';
import {
  assignReleaseProfile,
  createSchedulingAgreementReleases,
  listSchedulingAgreementReleases,
  saveReleaseProfile,
} from '../src/modules/purchasing/scheduling-agreement-release';

const ACTOR = 'SA_RELEASE_TEST';
const clients: string[] = [];

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

async function standing(seed: string, documentType = 'LPA'): Promise<string> {
  const tenant = await createTenant(seed);
  clients.push(tenant.client);
  const client = tenant.client;
  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'SCHEDAGREE', subObject: '*', prefix: '55', numberLength: 10, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'SARELEASE', subObject: '*', prefix: '56', numberLength: 10, createdBy: ACTOR });
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
      insert into scheduling_agreement_type (
        client, document_type, description, category, release_documentation, created_by
      ) values
        (${client}, 'LP', 'Scheduling agreement', 'SCHEDULING', false, ${ACTOR}),
        (${client}, 'LPA', 'Release documentation', 'SCHEDULING', true, ${ACTOR})
      on conflict do nothing
    `);
  });
  return client;
}

function header(documentType = 'LPA') {
  return {
    documentType,
    supplierNumber: 'V10000',
    purchasingOrg: '1000',
    purchasingGroup: '001',
    companyCode: '1000',
    currency: 'USD',
    validityStart: '2026-01-01',
    validityEnd: '2026-12-31',
  };
}

async function counts(client: string) {
  return withTenant(client, async (tx) => {
    const [orders] = await tx.execute(sql`select count(*)::int as n from purchase_order where client = ${client}`) as unknown as Array<{ n: number }>;
    const [docs] = await tx.execute(sql`select count(*)::int as n from material_document where client = ${client}`) as unknown as Array<{ n: number }>;
    const [journals] = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
    const [output] = await tx.execute(sql`select count(*)::int as n from output_message where client = ${client}`) as unknown as Array<{ n: number }>;
    return { orders: Number(orders.n), docs: Number(docs.n), journals: Number(journals.n), output: Number(output.n) };
  });
}

describe('scheduling agreement release', () => {
  it('creates a forecast snapshot and does not post or notify', async () => {
    const client = await standing('me84-create');
    await saveReleaseProfile({
      client, changedBy: ACTOR, profileCode: 'FR01', description: 'Forecast daily',
      releaseType: 'FRC', horizonDays: 30, aggregation: 'DAY', comparisonMode: 'LINE', tolerancePercent: null,
    });
    await assignReleaseProfile({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', plant: '1000',
      releaseType: 'FRC', profileCode: 'FR01',
    });
    const saved = await createSchedulingAgreement({
      client, changedBy: ACTOR, ...header(),
      items: [{ materialNumber: 'MAT-SA', shortText: 'Steel', targetQuantity: 20, unit: 'PC', netPrice: 5, plant: '1000' }],
    });
    await maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 10,
      lines: [
        { deliveryDate: '2026-11-15', quantity: 4 },
        { deliveryDate: '2026-12-20', quantity: 6 },
      ],
    });
    const before = await counts(client);
    const run = await createSchedulingAgreementReleases({
      client, changedBy: ACTOR, agreementFrom: saved.agreementNumber, releaseTypes: ['FRC'], generationDate: '2026-11-01',
    });
    expect(run.failed).toEqual([]);
    expect(run.created).toHaveLength(1);
    expect(run.created[0].transmissionStatus).toBe('NOT_TRANSMITTED');
    expect(run.created[0].releasedQuantity).toBe('4.000');
    expect(run.created[0].transmissionDetail).toMatch(/not notified/i);
    const history = await listSchedulingAgreementReleases(client, saved.agreementNumber);
    expect(history[0].lines).toEqual([{ lineNumber: 1, deliveryDate: '2026-11-15', quantity: '4.000', unit: 'PC' }]);
    const again = await createSchedulingAgreementReleases({
      client, changedBy: ACTOR, agreementFrom: saved.agreementNumber, releaseTypes: ['FRC'], generationDate: '2026-11-01',
    });
    expect(again.created).toEqual([]);
    expect(again.skipped[0].reason).toMatch(/No qualifying change/);
    const after = await counts(client);
    expect(after).toEqual(before);
    const [schedule] = await withTenant(client, async (tx) => tx.execute(sql`
      select quantity from scheduling_agreement_schedule_line
       where client = ${client} and agreement_number = ${saved.agreementNumber} and delivery_date = '2026-12-20'
    `) as unknown as Array<{ quantity: string }>);
    expect(schedule.quantity).toBe('6.000');
  });

  it('skips an agreement whose document type has no release documentation', async () => {
    const client = await standing('me84-lp');
    const saved = await createSchedulingAgreement({
      client, changedBy: ACTOR, ...header('LP'),
      items: [{ shortText: 'Steel', targetQuantity: 10, unit: 'PC', netPrice: 2, plant: '1000' }],
    });
    await maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 10,
      lines: [{ deliveryDate: '2026-11-15', quantity: 4 }],
    });
    const run = await createSchedulingAgreementReleases({
      client, changedBy: ACTOR, agreementFrom: saved.agreementNumber, releaseTypes: ['FRC'], generationDate: '2026-11-01',
    });
    expect(run.created).toEqual([]);
    expect(run.skipped[0].reason).toMatch(/does not use release documentation/);
    expect(await listSchedulingAgreementReleases(client, saved.agreementNumber)).toEqual([]);
  });

  it('skips JIT until the item and the material plant both allow it', async () => {
    const client = await standing('me84-jit');
    await saveReleaseProfile({
      client, changedBy: ACTOR, profileCode: 'JT01', description: 'JIT daily',
      releaseType: 'JIT', horizonDays: 14, aggregation: 'DAY', comparisonMode: 'LINE', tolerancePercent: null,
    });
    const saved = await createSchedulingAgreement({
      client, changedBy: ACTOR, ...header(),
      items: [{ materialNumber: 'MAT-SA', shortText: 'Steel', targetQuantity: 10, unit: 'PC', netPrice: 2, plant: '1000' }],
    });
    await maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 10,
      lines: [{ deliveryDate: '2026-11-05', quantity: 2 }],
    });
    const denied = await createSchedulingAgreementReleases({
      client, changedBy: ACTOR, agreementFrom: saved.agreementNumber, releaseTypes: ['JIT'],
      generationDate: '2026-11-01', profileCode: 'JT01',
    });
    expect(denied.created).toEqual([]);
    expect(denied.skipped[0].reason).toMatch(/not enabled on this agreement item/);
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        update scheduling_agreement_item set jit_enabled = true
         where client = ${client} and agreement_number = ${saved.agreementNumber}
      `);
      await tx.execute(sql`
        update material_plant set jit_delivery_schedule = true
         where client = ${client} and material_number = 'MAT-SA' and plant = '1000'
      `);
    });
    const allowed = await createSchedulingAgreementReleases({
      client, changedBy: ACTOR, agreementFrom: saved.agreementNumber, releaseTypes: ['JIT'],
      generationDate: '2026-11-01', profileCode: 'JT01',
    });
    expect(allowed.created).toHaveLength(1);
    expect(allowed.created[0].releaseType).toBe('JIT');
  });

  it('aggregates a week from the configured profile and keeps the first snapshot', async () => {
    const client = await standing('me84-week');
    await saveReleaseProfile({
      client, changedBy: ACTOR, profileCode: 'WK01', description: 'Forecast week',
      releaseType: 'FRC', horizonDays: 40, aggregation: 'WEEK', comparisonMode: 'OVERALL', tolerancePercent: 10,
    });
    const saved = await createSchedulingAgreement({
      client, changedBy: ACTOR, ...header(),
      items: [{ materialNumber: 'MAT-SA', shortText: 'Steel', targetQuantity: 30, unit: 'PC', netPrice: 2, plant: '1000' }],
    });
    await maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 10,
      lines: [
        { deliveryDate: '2026-11-02', quantity: 4 },
        { deliveryDate: '2026-11-04', quantity: 6 },
      ],
    });
    const first = await createSchedulingAgreementReleases({
      client, changedBy: ACTOR, agreementFrom: saved.agreementNumber, releaseTypes: ['FRC'],
      generationDate: '2026-11-01', profileCode: 'WK01',
    });
    expect(first.created[0].releasedQuantity).toBe('10.000');
    const [line] = (await listSchedulingAgreementReleases(client, saved.agreementNumber))[0].lines;
    expect(line.deliveryDate).toBe('2026-11-02');
    expect(line.quantity).toBe('10.000');
    await maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 10,
      lines: [{ lineNumber: 1, deliveryDate: '2026-11-02', quantity: 4.4 }],
    });
    const within = await createSchedulingAgreementReleases({
      client, changedBy: ACTOR, agreementFrom: saved.agreementNumber, releaseTypes: ['FRC'],
      generationDate: '2026-11-01', profileCode: 'WK01',
    });
    expect(within.created).toEqual([]);
    expect(within.skipped[0].reason).toMatch(/No qualifying change/);
    await maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 10,
      lines: [{ lineNumber: 1, deliveryDate: '2026-11-02', quantity: 8 }],
    });
    const beyond = await createSchedulingAgreementReleases({
      client, changedBy: ACTOR, agreementFrom: saved.agreementNumber, releaseTypes: ['FRC'],
      generationDate: '2026-11-01', profileCode: 'WK01',
    });
    expect(beyond.created).toHaveLength(1);
    const history = await listSchedulingAgreementReleases(client, saved.agreementNumber);
    const original = history.find((row) => row.releaseNumber === first.created[0].releaseNumber);
    expect(original?.lines[0].quantity).toBe('10.000');
    expect(original?.releasedQuantity).toBe('10.000');
  });

  it('reports a missing agreement and does not cross clients', async () => {
    const client = await standing('me84-miss');
    const other = await standing('me84-other');
    const saved = await createSchedulingAgreement({
      client, changedBy: ACTOR, ...header(),
      items: [{ shortText: 'Steel', targetQuantity: 10, unit: 'PC', netPrice: 2, plant: '1000' }],
    });
    const missing = await createSchedulingAgreementReleases({
      client, changedBy: ACTOR, agreementFrom: '5500000099', releaseTypes: ['FRC'], generationDate: '2026-11-01',
    });
    expect(missing.skipped[0].reason).toMatch(/does not exist/);
    expect(await listSchedulingAgreementReleases(other, saved.agreementNumber)).toEqual([]);
  });

  it('does not create a release while approval is pending, and a repeated request does not duplicate', async () => {
    const client = await standing('me84-pend');
    await saveReleaseProfile({
      client, changedBy: ACTOR, profileCode: 'FR01', description: 'Forecast',
      releaseType: 'FRC', horizonDays: null, aggregation: 'NONE', comparisonMode: 'LINE', tolerancePercent: null,
    });
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
      items: [{ materialNumber: 'MAT-SA', shortText: 'Steel', targetQuantity: 10, unit: 'PC', netPrice: 2, plant: '1000' }],
    });
    await maintainDeliverySchedule({
      client, changedBy: ACTOR, agreementNumber: saved.agreementNumber, itemNumber: 10,
      lines: [{ deliveryDate: '2026-06-01', quantity: 3 }],
    });
    const pending = await createSchedulingAgreementReleases({
      client, changedBy: ACTOR, agreementFrom: saved.agreementNumber, releaseTypes: ['FRC'],
      generationDate: '2026-06-01', profileCode: 'FR01',
    });
    expect(pending.created).toEqual([]);
    expect(pending.skipped[0].reason).toMatch(/waiting for release/);
    await releaseDocument({
      client, changedBy: ACTOR, documentCategory: 'SCHED_AGREEMENT',
      documentNumber: saved.agreementNumber, releaseCode: 'MGR',
    });
    const [left, right] = await Promise.all([
      createSchedulingAgreementReleases({
        client, changedBy: ACTOR, agreementFrom: saved.agreementNumber, releaseTypes: ['FRC'],
        generationDate: '2026-06-01', profileCode: 'FR01', requestKey: 'run-1',
      }),
      createSchedulingAgreementReleases({
        client, changedBy: ACTOR, agreementFrom: saved.agreementNumber, releaseTypes: ['FRC'],
        generationDate: '2026-06-01', profileCode: 'FR01', requestKey: 'run-1',
      }),
    ]);
    const numbers = new Set([...left.created, ...right.created].map((row) => row.releaseNumber));
    expect(numbers.size).toBe(1);
    const [count] = await withTenant(client, async (tx) => tx.execute(sql`
      select count(*)::int as n from scheduling_agreement_release where client = ${client}
    `) as unknown as Array<{ n: number }>);
    expect(Number(count.n)).toBe(1);
  });
});
