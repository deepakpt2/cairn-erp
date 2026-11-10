import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import {
  determineBatches, listBatchDeterminationRules, saveBatchDeterminationRule,
} from '../src/modules/sales/batch-determination';
import {
  confirmDeliveryPicks, createDelivery, listDeliverableOrderLines,
} from '../src/modules/sales/delivery';
import { createSalesOrder } from '../src/modules/sales/sales-order';
import {
  assignSalesAreaDimensions, createTenant, destroyTenant, maintainMaterialSales,
  type TestTenant,
} from './helpers';

/**
 * §5.5a — batch determination for sales.
 *
 * The question is asked at the dock: a delivery item is asking for six of a material, there are four
 * batches of it in the store, and somebody has to take the boxes off a shelf. Which ones?
 *
 * Four promises are proved, and the first is the one the whole increment rests on:
 *
 * **Nothing is determined where no rule stands.** No rule is seeded, so a tenant that maintains none
 * picks exactly as it did the day before — with no batch named, as the picker has always done it.
 * Determination is not a default a tenant has to switch off; it is an answer they have to ask for.
 *
 * **A picker who names a batch keeps it.** A clerk who knows better than the rule is not overruled
 * by it, and a correction is never re-determined underneath the person making it.
 *
 * **A batch the books will not release is not proposed.** Restricted stock that cannot be issued is
 * not stock a picker can be told to take.
 *
 * **A short determination says how short it is.** Claiming six from a shelf holding four would be
 * worse than saying four.
 */
const ACTOR = 'SD9259_BATCH';
const AREA = 'CCA1';
const CUSTOMER = 'SD9259CUST1';
const MATERIAL = 'SD9259MAT1';
const PLANT = '1000';
const STORE = '0001';
const DATE = '2026-10-16';

const base = {
  client: '',
  changedBy: ACTOR,
  salesOrg: '1000',
  distributionChannel: '10',
  division: '01',
  customerNumber: CUSTOMER,
  companyCode: '1000',
  currency: 'USD',
  orderDate: DATE,
  documentType: 'OR',
};

describe('batch determination for sales (§5.5a)', () => {
  let tenant: TestTenant;
  let counter = 0;
  const key = (what: string) => `sd9259-${what}-${++counter}`;

  /**
   * A rule saved in this tenant's name. Every test maintains the *same* rule number, so a later test
   * changes the one answer rather than adding a second one that would tie with it and lose.
   */
  async function maintain(
    sortRule: 'FIFO' | 'LIFO' | 'EXPIRY' | 'BATCH_NUMBER',
    extra: Record<string, string> = {},
    number = 'BD1',
  ) {
    return saveBatchDeterminationRule({
      client: tenant.client, changedBy: ACTOR, ruleNumber: number,
      customerNumber: CUSTOMER, materialNumber: MATERIAL, sortRule,
      validityFrom: '2026-01-01', validityTo: '2026-12-31', ...extra,
    });
  }

  const ask = (quantity: number, sortRule?: string) => determineBatches(tenant.client, {
    materialNumber: MATERIAL, plant: PLANT, quantity, documentDate: DATE,
    salesOrg: '1000', distributionChannel: '10', customerNumber: CUSTOMER,
  });

  beforeAll(async () => {
    tenant = await createTenant('sd9259-batch');
    base.client = tenant.client;
    await withTenant(tenant.client, async (tx) => {
      await defineRange(tx, {
        client: tenant.client, objectCode: 'SALESORD', subObject: 'OR', prefix: 'SO',
        numberLength: 7, createdBy: ACTOR,
      });
      await defineRange(tx, {
        client: tenant.client, objectCode: 'DELIVERY', subObject: 'LF', prefix: 'DV',
        numberLength: 7, createdBy: ACTOR,
      });
      await defineRange(tx, {
        client: tenant.client, objectCode: 'BILLING', subObject: 'F2', prefix: 'INV',
        numberLength: 7, createdBy: ACTOR,
      });
      await defineRange(tx, {
        client: tenant.client, objectCode: 'CUSTINV', subObject: '*', prefix: 'CI',
        numberLength: 7, createdBy: ACTOR,
      });
      // The cancellation type S1 draws its own number, because a credit memo is a document of its
      // own kind and not a second invoice.
      await defineRange(tx, {
        client: tenant.client, objectCode: 'BILLING', subObject: 'S1', prefix: 'CN',
        numberLength: 7, createdBy: ACTOR,
      });
      await defineRange(tx, {
        client: tenant.client, objectCode: 'MATDOC', subObject: '*', prefix: '',
        numberLength: 10, createdBy: ACTOR,
      });
      await defineRange(tx, {
        client: tenant.client, objectCode: 'RF_BELEG', subObject: 'GENERAL', prefix: 'JE',
        numberLength: 6, companyCode: '1000', fiscalYear: 2026, createdBy: ACTOR,
      });
      await assignSalesAreaDimensions(tenant, '1000', [{ distributionChannel: '10', division: '01' }]);
      await tx.execute(sql`
        insert into unit_of_measure (code, name, dimension, decimal_places, is_base_unit)
        values ('UNT', 'Test counted unit', 'COUNT', 0, false)
        on conflict (code) do update set decimal_places = excluded.decimal_places
      `);
      await tx.execute(sql`
        insert into sales_org (client, sales_org, company_code, currency, created_by)
        values (${tenant.client}, '1000', '1000', 'USD', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into sales_org_text (client, sales_org, language_key, name, created_by)
        values (${tenant.client}, '1000', 'E', 'Test sales organization', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into sales_area (client, sales_org, distribution_channel, division, name, created_by)
        values (${tenant.client}, '1000', '10', '01', 'Test sales area', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, country, created_by)
        values (${tenant.client}, '1000', 'Test plant', 'KW', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active,
                                      allow_negative_stock, created_by)
        values (${tenant.client}, ${PLANT}, ${STORE}, 'Test store', true, false, ${ACTOR})
        on conflict (client, plant, storage_location) do update set is_active = excluded.is_active
      `);
      await tx.execute(sql`
        insert into credit_control_area (client, credit_control_area, name, currency,
                                         warning_threshold_percent, created_by)
        values (${tenant.client}, ${AREA}, 'Test credit area', 'USD', 90, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into credit_risk_category (client, risk_category, name, created_by)
        values (${tenant.client}, 'A', 'Low risk', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        update company_code set credit_control_area = ${AREA}
        where client = ${tenant.client} and company_code = '1000'
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${tenant.client}, ${CUSTOMER}, 'ORGANIZATION', 'Batch test customer', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${tenant.client}, ${CUSTOMER}, 'CUSTOMER', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into customer_sales_area (
          client, partner_number, role_code, sales_org, distribution_channel, division,
          pricing_procedure, is_blocked, sales_status, created_by
        )
        values (${tenant.client}, ${CUSTOMER}, 'CUSTOMER', '1000', '10', '01', 'PR01', false,
                'MAINTAINED', ${ACTOR})
        on conflict (client, partner_number, sales_org, distribution_channel, division)
        do update set is_blocked = false, sales_status = 'MAINTAINED'
      `);
      await tx.execute(sql`
        insert into customer_company_code (
          client, partner_number, role_code, company_code, chart_of_accounts,
          reconciliation_account, payment_terms_code, created_by
        )
        values (${tenant.client}, ${CUSTOMER}, 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
        values (${tenant.client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${tenant.client}, ${MATERIAL}, 'Batch test material', 'RAW', 'UNT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class,
                                        price_control, standard_price, moving_average_price, price_unit,
                                        currency, total_stock_quantity, stock_value, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1,
                'USD', 100, 1000, ${ACTOR})
        on conflict (client, material_number, valuation_area)
        do update set moving_average_price = excluded.moving_average_price
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type,
                                    quantity, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, ${STORE}, 'UNRESTRICTED', 100, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        -- Unbatched stock is emptied, so every figure in these tests is a figure about batches.
        update stock_quantity set quantity = 0
         where client = ${tenant.client} and material_number = ${MATERIAL} and batch_number = ''
      `);
      for (const [number, made, expires, restricted, quantity] of [
        ['B1', '2026-09-01', '2026-12-01', '', 4],
        ['B2', '2026-09-02', '2026-10-05', '', 4],
        ['B3', '2026-09-03', '2026-11-15', '', 4],
        ['B9', '2026-08-01', '2026-12-31', 'X', 50],
      ] as const) {
        await tx.execute(sql`
          insert into batch (id, client, batch_number, material_number, plant,
                             batch_level_at_creation, shelf_life_expiration_date, restricted_use,
                             created_by, changed_by, created_at, changed_at)
          values (${`${tenant.client}-${number}`}, ${tenant.client}, ${number}, ${MATERIAL}, ${PLANT},
                  '0', ${expires}::date, ${restricted || null}, ${ACTOR}, ${ACTOR},
                  ${`${made}T00:00:00Z`}::timestamptz, ${`${made}T00:00:00Z`}::timestamptz)
          on conflict (id) do update set shelf_life_expiration_date = excluded.shelf_life_expiration_date
        `);
        await tx.execute(sql`
          insert into stock_quantity (client, material_number, plant, storage_location, stock_type,
                                      batch_number, quantity, created_by)
          values (${tenant.client}, ${MATERIAL}, ${PLANT}, ${STORE}, 'UNRESTRICTED', ${number},
                  ${quantity}, ${ACTOR})
          on conflict (client, material_number, plant, storage_location, stock_type, batch_number)
          do update set quantity = excluded.quantity
        `);
      }
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
        values (${tenant.client}, 'OPENING_BALANCE', 'Opening balance', 'RECEIPT', 'MATERIAL_DOCUMENT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date,
                                       posting_date, header_text, status, created_by)
        values (${tenant.client}, 'MD-BAT001', 2026, ${DATE}, ${DATE}, 'Opening balance', 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (client, material_document_number, line_number, movement_type,
                                            material_number, plant, storage_location, stock_type,
                                            line_direction, entry_quantity, entry_unit, base_quantity,
                                            base_unit, created_by)
        values (${tenant.client}, 'MD-BAT001', 1, 'OPENING_BALANCE', ${MATERIAL}, ${PLANT}, ${STORE},
                'UNRESTRICTED', 'RECEIPT', 100, 'UNT', 100, 'UNT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                                is_balance_sheet, is_open_item_managed, reconciliation_type,
                                requires_cost_object, is_tax_relevant, account_group, gl_account_type,
                                created_by)
        select ${tenant.client}, c.chart_of_accounts, v.n, v.d, 'EXPENSE',
               false, false, null, false, false, 'GENL', 'PL_STATEMENT', ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${tenant.client} limit 1) c
        cross join (values ('510300', 'Cost of goods sold'), ('120000', 'Raw materials inventory')) as v(n, d)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class,
                                           general_modifier, gl_account, created_by)
        select ${tenant.client}, c.chart_of_accounts, v.e, v.vc, '', v.a, ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${tenant.client} limit 1) c
        cross join (values
          ('INVENTORY', 'RAW_INVENTORY', '120000'),
          ('SALES_ISSUE', 'RAW_INVENTORY', '510300'),
          ('SALES_REVENUE', '', '300000'),
          ('TAX', '', '240000')
        ) as v(e, vc, a)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                             previous_fiscal_year, previous_period, allow_backposting, created_by)
        values (${tenant.client}, '1000', 2026, 10, 2026, 9, true, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
        values (${tenant.client}, 'KW', 'T10', 'Output tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
      `);
    });

    await maintainMaterialSales(tenant, { materialNumber: MATERIAL, deliveringPlant: PLANT });
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10',
      division: '01', customerNumber: CUSTOMER, materialNumber: MATERIAL, currency: 'USD',
      amount: 25, priceUnit: 1, validityFrom: '2026-01-01', validityTo: '2026-12-31',
      supersedeStanding: false,
    });
    await saveCustomerCredit({
      client: tenant.client, changedBy: ACTOR, customer: CUSTOMER, creditControlArea: AREA,
      creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false,
      changeReason: 'Batch test credit data.',
    });
  });

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  /** An order delivered but not picked, which is the state a pick is confirmed from. */
  async function forPicking(units: number) {
    const created = await createSalesOrder({
      ...base, requestKey: key('order'),
      lines: [{
        lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: units, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    });
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: created.orderNumber });
    const built = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: created.orderNumber, deliveryDate: DATE,
      goodsMovementDate: DATE, headerText: 'Batch fixture',
      items: [{ orderLineNumber: open[0].lineNumber, quantity: String(units) }],
      requestKey: key('delivery'),
    });
    return { orderNumber: created.orderNumber, deliveryNumber: built.deliveryNumber };
  }

  /** The pick rows that stand on one item, in the order they were written. */
  async function picksOf(deliveryNumber: string) {
    return withTenant(tenant.client, async (tx) => {
      const rows = await tx.execute(sql`
        select batch_number, storage_location, quantity_delta::text as quantity
          from delivery_picking
         where client = ${tenant.client} and delivery_number = ${deliveryNumber}
         order by line_number, pick_number
      `);
      return rows as unknown as Array<{ batch_number: string; storage_location: string; quantity: string }>;
    });
  }

  it('determines nothing at all where a tenant maintains no rule', async () => {
    // The promise the increment is built on. No rule is seeded, so a pick that names no batch is
    // confirmed with no batch — exactly as it has always been.
    expect(await listBatchDeterminationRules(tenant.client)).toEqual([]);
    const answer = await ask(4);
    expect(answer.rule).toBeNull();
    expect(answer.proposals).toEqual([]);

    const { deliveryNumber } = await forPicking(4);
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber,
      items: [{ lineNumber: 10, quantity: '4', storageLocation: STORE }],
      requestKey: key('pick'),
    });
    const picks = await picksOf(deliveryNumber);
    expect(picks).toHaveLength(1);
    expect(picks[0].batch_number).toBe('');
  });

  it('takes the batches in the order the rule names, and splits the item when one cannot cover it', async () => {
    await maintain('FIFO');
    const answer = await ask(6);
    expect(answer.sortRule).toBe('FIFO');
    // Six asked for, four in the oldest batch: two pick rows, and the second is for the remainder.
    expect(answer.proposals.map((row) => row.batchNumber)).toEqual(['B1', 'B2']);
    expect(Number(answer.proposals[0].quantity)).toBe(4);
    expect(Number(answer.proposals[1].quantity)).toBe(2);
    expect(answer.covered).toBe('6');
    expect(answer.shortfall).toBe('0');

    // And the pick says the same thing: one row per batch, written in the order they were taken.
    const { deliveryNumber } = await forPicking(6);
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber,
      items: [{ lineNumber: 10, quantity: '6' }],
      requestKey: key('pick'),
    });
    const picks = await picksOf(deliveryNumber);
    expect(picks).toHaveLength(2);
    expect(picks[0].batch_number).toBe('B1');
    expect(Number(picks[0].quantity)).toBe(4);
    expect(picks[1].batch_number).toBe('B2');
    expect(Number(picks[1].quantity)).toBe(2);
    // The location came from the stock the batch stands in, not from a guess.
    expect(picks[0].storage_location).toBe(STORE);
  });

  it('takes the batch that expires soonest where the rule says so', async () => {
    // FEFO, and the reason it is a rule rather than a default: a perishable store does not want the
    // oldest batch, it wants the one that will go off first, and those are not the same thing. B2
    // was made second but expires on 5 October, before B1's 1 December.
    await maintain('EXPIRY');
    const answer = await ask(6);
    expect(answer.sortRule).toBe('EXPIRY');
    expect(answer.proposals.map((row) => row.batchNumber)).toEqual(['B2', 'B3']);
    // B1, the oldest, is last — which is the whole point of the rule.
    expect(await ask(12)).toMatchObject({ covered: '12' });
    expect((await ask(12)).proposals.map((row) => row.batchNumber)).toEqual(['B2', 'B3', 'B1']);
  });

  it('never proposes a batch the books will not release', async () => {
    // B9 holds fifty — more than anything else in the store — and it is in restricted use. Stock
    // that cannot be issued is not stock a picker can be told to take.
    await maintain('FIFO');
    const answer = await ask(50);
    expect(answer.proposals.map((row) => row.batchNumber)).not.toContain('B9');
    // It was seen and passed over, and the answer says why rather than hiding it.
    const skipped = answer.skipped.find((row) => row.batchNumber === 'B9');
    expect(skipped?.why).toBe('restricted');
  });

  it('a picker who names a batch keeps it', async () => {
    // The rule is an answer, not an instruction. A clerk who knows better than the rule is not
    // overruled by it — and a correction to a pick is never re-determined underneath them.
    await maintain('FIFO');
    const { deliveryNumber } = await forPicking(2);
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber,
      items: [{ lineNumber: 10, quantity: '2', storageLocation: STORE, batchNumber: 'B3' }],
      requestKey: key('pick'),
    });
    const picks = await picksOf(deliveryNumber);
    expect(picks).toHaveLength(1);
    expect(picks[0].batch_number).toBe('B3');
  });

  it('says how short it is rather than claiming stock the store does not hold', async () => {
    // Twelve is asked for and twelve stands, so this one is covered; twenty is asked for and twelve
    // stands, and the answer has to say eight rather than promising twenty.
    await maintain('FIFO');
    const covered = await ask(12);
    expect(covered.covered).toBe('12');
    expect(covered.shortfall).toBe('0');

    const short = await ask(20);
    expect(short.covered).toBe('12');
    expect(short.shortfall).toBe('8');
    // And the pick takes what stands, leaving the item open rather than picking nothing at all.
    const { deliveryNumber } = await forPicking(20);
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber,
      items: [{ lineNumber: 10, quantity: '20' }],
      requestKey: key('pick'),
    });
    const picks = await picksOf(deliveryNumber);
    expect(picks.reduce((sum, row) => sum + Number(row.quantity), 0)).toBe(12);
  });

  it('the more specific rule wins, and a rule for another customer does not answer', async () => {
    await maintain('FIFO', {}, 'RGENERAL');
    // A rule naming this customer and this material is more specific than one naming the customer
    // alone, so it is the one that answers.
    await maintain('EXPIRY', { plant: PLANT }, 'RSPECIFIC');
    const answer = await ask(6);
    expect(answer.rule?.ruleNumber).toBe('RSPECIFIC');
    expect(answer.sortRule).toBe('EXPIRY');

    // And a rule maintained for somebody else is not a fallback: the wrong customer's instruction is
    // not an answer to this question at all.
    await saveBatchDeterminationRule({
      client: tenant.client, changedBy: ACTOR, ruleNumber: 'ROTHER',
      customerNumber: 'SD9259OTHER', materialNumber: MATERIAL, sortRule: 'LIFO',
      validityFrom: '2026-01-01', validityTo: '2026-12-31',
    });
    expect((await ask(6)).rule?.ruleNumber).toBe('RSPECIFIC');
  });
});
