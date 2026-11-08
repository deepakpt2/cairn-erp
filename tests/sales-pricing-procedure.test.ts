import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import { createSalesOrder, getSalesOrder } from '../src/modules/sales/sales-order';
import { salesConditionType } from '../src/modules/sales/schema';
import {
  DELIVERED_CONDITION_TYPES, PRICING_PROCEDURE_ROUTE, STANDARD_DOCUMENT_PRICING_PROCEDURE,
  STANDARD_PRICING_PROCEDURE, pricingProcedureDeterminationRows, salesDocumentConditionsOf,
} from '../src/modules/sales/pricing-procedure';
import { assignSalesAreaDimensions, createTenant, destroyTenant, maintainMaterialSales, sql, type TestTenant } from './helpers';

const ACTOR = 'SD9238_PRICING_TEST';
const AREA = 'CCA1';
const CUSTOMER = 'SD9238CUST1';
const MATERIAL_A = 'SD9238MAT1';
const MATERIAL_B = 'SD9238MAT2';
const MATERIAL_UNVALUED = 'SD9238MAT3';
const PLANT = '1000';
const ORDER_DATE = '2026-01-15';

const base = {
  client: '',
  changedBy: ACTOR,
  salesOrg: '1000',
  distributionChannel: '10',
  division: '01',
  customerNumber: CUSTOMER,
  companyCode: '1000',
  currency: 'USD',
  orderDate: ORDER_DATE,
};

/**
 * The condition technique (plan §2.1): a document priced by a procedure of ordered steps, every step
 * written beside the figures it produced, a freight charge on the document distributed to the lines that
 * earned it, and a cost the document shows and never charges.
 *
 * The figures below are not asserted as arithmetic the test happens to agree with. They are the document
 * a reader would expect: 5 at 25.00 less 10%, plus 5.00 a unit of freight, plus its share of 15.00 of
 * freight on the document, taxed at 10% on what survived all three.
 */
describe('the pricing procedure and the conditions it writes', () => {
  let tenant: TestTenant;
  let orderNumber = '';

  beforeAll(async () => {
    tenant = await createTenant('sd9238-pricing-procedure');
    base.client = tenant.client;
    await withTenant(tenant.client, async (tx) => {
      await defineRange(tx, {
        client: tenant.client, objectCode: 'SALESORD', subObject: 'OR', prefix: 'SO', numberLength: 7, createdBy: ACTOR,
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
        insert into credit_control_area (client, credit_control_area, name, currency, warning_threshold_percent, created_by)
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
        values (${tenant.client}, ${CUSTOMER}, 'ORGANIZATION', 'Test customer', ${ACTOR}) on conflict do nothing
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
        values (${tenant.client}, ${CUSTOMER}, 'CUSTOMER', '1000', '10', '01', 'PR01', false, 'MAINTAINED', ${ACTOR})
        on conflict (client, partner_number, sales_org, distribution_channel, division)
        do update set is_blocked = false, sales_status = 'MAINTAINED'
      `);
      for (const [materialNumber, description] of [
        [MATERIAL_A, 'Priced material A'], [MATERIAL_B, 'Priced material B'], [MATERIAL_UNVALUED, 'Unvalued material'],
      ] as const) {
        await tx.execute(sql`
          insert into material (client, material_number, description, material_type, base_unit, created_by)
          values (${tenant.client}, ${materialNumber}, ${description}, 'RAW', 'UNT', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into material_plant (client, material_number, plant, created_by)
          values (${tenant.client}, ${materialNumber}, ${PLANT}, ${ACTOR}) on conflict do nothing
        `);
      }
      // What the books say the goods are worth — the rate a statistical cost is read from, and the only
      // place it is read from.
      for (const [materialNumber, standardPrice] of [[MATERIAL_A, '8.0000'], [MATERIAL_B, '10.0000']] as const) {
        await tx.execute(sql`
          insert into material_valuation (
            client, material_number, valuation_area, price_control, standard_price,
            moving_average_price, price_unit, currency, created_by
          )
          values (${tenant.client}, ${materialNumber}, ${PLANT}, 'STANDARD', ${standardPrice}, '0', 1, 'USD', ${ACTOR})
          on conflict (client, material_number, valuation_area) do update set standard_price = excluded.standard_price
        `);
      }
      await tx.execute(sql`
        insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
        values (${tenant.client}, 'KW', 'T10', 'Output tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
      `);
    });

    // The three materials stand for sale in the sales area, so a refusal in these tests is a refusal
    // of the pricing and not a refusal of the master data.
    for (const materialNumber of [MATERIAL_A, MATERIAL_B, MATERIAL_UNVALUED]) {
      await maintainMaterialSales(tenant, { materialNumber, deliveringPlant: PLANT });
    }
    const area = { salesOrg: '1000', distributionChannel: '10', division: '01' };
    const period = { validityFrom: '2026-01-01', validityTo: '2026-12-31', supersedeStanding: false };
    // The prices: 25.00 the first material, 40.00 the second.
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, ...area, customerNumber: CUSTOMER, materialNumber: MATERIAL_A,
      currency: 'USD', amount: 25, priceUnit: 1, ...period,
    });
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, ...area, customerNumber: CUSTOMER, materialNumber: MATERIAL_B,
      currency: 'USD', amount: 40, priceUnit: 1, ...period,
    });
    // A material with no valuation is still sold at a price. What it has no cost for is the cost.
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, ...area, customerNumber: CUSTOMER, materialNumber: MATERIAL_UNVALUED,
      currency: 'USD', amount: 25, priceUnit: 1, ...period,
    });
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, ...area, customerNumber: CUSTOMER, materialNumber: '',
      currency: 'USD', amount: 10, priceUnit: 1, ...period, conditionType: 'K007',
    });
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, ...area, customerNumber: CUSTOMER, materialNumber: '',
      currency: 'USD', amount: 5, priceUnit: 1, ...period, conditionType: 'KF00',
    });
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, ...area, customerNumber: CUSTOMER, materialNumber: '',
      currency: 'USD', amount: 15, priceUnit: 1, ...period, conditionType: 'HD00',
    });
    await saveCustomerCredit({
      client: tenant.client, changedBy: ACTOR, customer: CUSTOMER, creditControlArea: AREA,
      creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false, changeReason: 'Test fixture credit data.',
    });
  });

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  it('prices a document through the procedure, and writes every step that ran', async () => {
    const created = await createSalesOrder({
      ...base, requestKey: 'SD9238-CREATE-0001',
      lines: [
        { lineNumber: undefined, materialNumber: MATERIAL_A, plant: PLANT, orderQuantity: 5, quantityUnit: 'UNT', taxCode: 'T10' },
        { lineNumber: undefined, materialNumber: MATERIAL_B, plant: PLANT, orderQuantity: 3, quantityUnit: 'UNT', taxCode: 'T10' },
      ],
    });
    orderNumber = created.orderNumber;
    const view = await getSalesOrder(tenant.client, orderNumber);
    const [first, second] = view!.lines;

    // 125.00 less 10%, plus 25.00 of freight, plus 7.92 of the freight on the document.
    expect(Number(first.netAmount)).toBe(145.42);
    // 120.00 less 10%, plus 15.00 of freight, plus 7.08 of the freight on the document.
    expect(Number(second.netAmount)).toBe(130.08);
    // The unit price is the net value over the quantity, so the line's own arithmetic stands.
    expect(Number(first.netPrice)).toBeCloseTo(29.084, 3);
    expect(Number(second.netPrice)).toBeCloseTo(43.36, 2);

    expect(Number(view!.netValue)).toBe(275.5);
    expect(Number(view!.taxValue)).toBe(27.55);
    expect(Number(view!.grossValue)).toBe(303.05);

    const conditions = await salesDocumentConditionsOf(tenant.client, 'ORDER', orderNumber);
    // Six steps on two lines, and the one condition the header carries whole.
    expect(conditions.length).toBe(13);
    const steps = conditions.filter((row) => row.lineNumber === 10).map((row) => row.stepNumber);
    expect(steps).toEqual([10, 20, 30, 35, 40, 50]);
  });

  it('distributes the condition the header carries, and the parts sum to the whole', async () => {
    const conditions = await salesDocumentConditionsOf(tenant.client, 'ORDER', orderNumber);
    const header = conditions.find((row) => row.lineNumber === 0);
    expect(header).toMatchObject({ conditionType: 'HD00', stepNumber: 35, origin: 'HEADER', amount: '15.0000' });

    const shares = conditions.filter((row) => row.stepNumber === 35 && row.lineNumber > 0)
      .sort((a, b) => a.lineNumber - b.lineNumber);
    expect(shares.map((row) => row.origin)).toEqual(['DISTRIBUTED', 'DISTRIBUTED']);
    expect(Number(shares[0].amount)).toBe(7.92);
    expect(Number(shares[1].amount)).toBe(7.08);
    // A header condition is never worth a cent more or less than the sum of what the lines carry.
    expect(Number(shares[0].amount) + Number(shares[1].amount)).toBe(Number(header!.amount));
  });

  it('shows the cost and charges nothing for it', async () => {
    const conditions = await salesDocumentConditionsOf(tenant.client, 'ORDER', orderNumber);
    const costs = conditions.filter((row) => row.conditionType === 'VPRS' && row.lineNumber > 0)
      .sort((a, b) => a.lineNumber - b.lineNumber);
    // 5 at 8.00 and 3 at 10.00, read from the valuation and not from a record.
    expect(Number(costs[0].amount)).toBe(40);
    expect(Number(costs[1].amount)).toBe(30);
    expect(costs.every((row) => row.isStatistical)).toBe(true);
    expect(costs.every((row) => row.accountKey === null)).toBe(true);

    // The cost is in no total: every figure the document carries adds up to its value, and the cost is
    // the seventy it would take to make that sum wrong.
    const charged = conditions
      .filter((row) => row.lineNumber > 0 && !row.isStatistical)
      .reduce((total, row) => total + Number(row.amount), 0);
    const shown = conditions
      .filter((row) => row.lineNumber > 0)
      .reduce((total, row) => total + Number(row.amount), 0);
    expect(Number(charged.toFixed(2))).toBe(303.05);
    expect(Number((shown - charged).toFixed(2))).toBe(70);

    const view = await getSalesOrder(tenant.client, orderNumber);
    expect(Number(view!.netValue)).toBe(275.5);
    expect(Number(view!.taxValue)).toBe(27.55);
  });

  it('charges the tax on what survived the discount, not on the gross', async () => {
    const conditions = await salesDocumentConditionsOf(tenant.client, 'ORDER', orderNumber);
    const tax = conditions.find((row) => row.conditionType === 'MWST' && row.lineNumber === 10);
    // 10% of 145.42, which is the price less the discount plus both freights. 10% of the gross would
    // have been 15.00: a tax on money the customer never owed.
    expect(Number(tax!.baseValue)).toBe(145.42);
    expect(Number(tax!.amount)).toBe(14.54);
    expect(tax!.conditionNumber).toBeNull();
    expect(tax!.accountKey).toBe('MWS');

    const discount = conditions.find((row) => row.conditionType === 'K007' && row.lineNumber === 10);
    expect(Number(discount!.amount)).toBe(-12.5);
    expect(Number(discount!.baseValue)).toBe(125);
    expect(discount!.accountKey).toBe('ERS');
    // The record that answered, so the discount can be traced to what maintained it.
    expect(discount!.conditionNumber).toMatch(/^K007/);
  });

  it('leaves the cost out where the books carry none, rather than pricing it at zero', async () => {
    const created = await createSalesOrder({
      ...base, requestKey: 'SD9238-CREATE-0002',
      lines: [{ lineNumber: undefined, materialNumber: MATERIAL_UNVALUED, plant: PLANT, orderQuantity: 2, quantityUnit: 'UNT' }],
    });
    const conditions = await salesDocumentConditionsOf(tenant.client, 'ORDER', created.orderNumber);
    const cost = conditions.find((row) => row.conditionType === 'VPRS');
    // The step ran and found nothing. That is written down as a fact, not left as an absence.
    expect(cost).toMatchObject({ amount: '0.0000', isStatistical: true, conditionNumber: null });
  });

  it('refuses a record maintained for a condition type that does not stand', async () => {
    await expect(saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      customerNumber: CUSTOMER, materialNumber: '', currency: 'USD', amount: 1, priceUnit: 1,
      validityFrom: '2026-01-01', validityTo: '2026-12-31', supersedeStanding: false, conditionType: 'ZZZZ',
    })).rejects.toThrow(/Condition type ZZZZ does not stand/);
  });

  it('refuses to maintain a cost as a record, because a cost is what the books say', async () => {
    await expect(saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      customerNumber: CUSTOMER, materialNumber: '', currency: 'USD', amount: 1, priceUnit: 1,
      validityFrom: '2026-01-01', validityTo: '2026-12-31', supersedeStanding: false, conditionType: 'VPRS',
    })).rejects.toThrow(/a cost is read from the valuation of the material/);
  });

  it('refuses a document where no procedure is determined, and names the screen', async () => {
    const standing = await pricingProcedureDeterminationRows(tenant.client);
    expect(standing.length).toBeGreaterThan(0);
    // The row is made to answer for a key no document type carries, which is the same refusal as no row
    // at all. It is changed rather than deleted because the application role holds no DELETE on
    // configuration — and a tenant that loses its determination by accident should be able to put it back.
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`update sales_procedure_determination
        set document_pricing_procedure = 'ZZZZ', changed_by = ${ACTOR}
        where client = ${tenant.client}`);
    });
    let refusal: { message: string; remedy?: string } | undefined;
    try {
      await createSalesOrder({
        ...base, requestKey: 'SD9238-CREATE-0003',
        lines: [{ lineNumber: undefined, materialNumber: MATERIAL_A, plant: PLANT, orderQuantity: 1, quantityUnit: 'UNT' }],
      });
    } catch (error) {
      refusal = error as { message: string; remedy?: string };
    } finally {
      // Restored whatever the refusal did or did not do, so the tenant stands as it did for whatever
      // runs after this.
      await withTenant(tenant.client, async (tx) => {
        await tx.execute(sql`update sales_procedure_determination
          set document_pricing_procedure = ${STANDARD_DOCUMENT_PRICING_PROCEDURE}, changed_by = ${ACTOR}
          where client = ${tenant.client}`);
      });
    }
    expect(refusal?.message).toMatch(/No pricing procedure is determined for document procedure A/);
    // The refusal names the screen, because a reader who has been told no procedure stands needs to be
    // told where one is maintained.
    expect(refusal?.remedy).toContain(PRICING_PROCEDURE_ROUTE);
    expect(await pricingProcedureDeterminationRows(tenant.client)).toEqual(standing);
  });

  it('delivers the master, the procedure and the determination the package promises', async () => {
    const types = await withTenant(tenant.client, async (tx) => tx
      .select({ conditionType: salesConditionType.conditionType, isStatistical: salesConditionType.isStatistical })
      .from(salesConditionType)
      .where(eq(salesConditionType.client, tenant.client))
      .orderBy(asc(salesConditionType.conditionType)));
    expect(types.map((row) => row.conditionType).sort())
      .toEqual(DELIVERED_CONDITION_TYPES.map((row) => row.conditionType).sort());
    expect(types.filter((row) => row.isStatistical).map((row) => row.conditionType)).toEqual(['VPRS']);

    const determination = await pricingProcedureDeterminationRows(tenant.client);
    expect(determination[0]).toMatchObject({
      documentPricingProcedure: STANDARD_DOCUMENT_PRICING_PROCEDURE,
      customerPricingProcedure: '*',
      procedureCode: STANDARD_PRICING_PROCEDURE,
      salesOrg: '',
    });
  });
});
