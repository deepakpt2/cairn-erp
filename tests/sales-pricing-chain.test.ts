/**
 * DI-018 — the conditions a document is priced by, carried through the chain that follows it.
 *
 * An order is priced once. What follows it — a delivery, an invoice, a credit memo — is never priced
 * again, because a price looked up today is today's price and a customer is invoiced at the price they
 * were sold at. Each follow-on document repeats the arithmetic of the document it follows at the
 * quantity it covers, which is why the invoice below is the order's own price at six tenths of the
 * goods, and the credit is two of those six units given back — discount, freight, header charge and
 * tax included, not a share of a total.
 *
 * Nothing here is mocked: the order, the delivery, the pick, the goods issue, the invoice and the
 * credit memo are raised by the services that own them, and the condition rows asserted are the ones
 * those services wrote.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import { changeSalesOrder, createSalesOrder, getSalesOrder } from '../src/modules/sales/sales-order';
import { salesDocumentConditionsOf } from '../src/modules/sales/pricing-procedure';
import {
  confirmDeliveryPicks, createDelivery, getDelivery, listDeliverableOrderLines, postDeliveryGoodsIssue,
} from '../src/modules/sales/delivery';
import { postBillingDocument } from '../src/modules/sales/billing';
import { createCreditMemo } from '../src/modules/sales/credit-memo';
import {
  assignSalesAreaDimensions, createTenant, defineTestRanges, destroyTenant, maintainMaterialSales,
  type TestTenant,
} from './helpers';

const ACTOR = 'SD9239_CHAIN_TEST';
const AREA = 'CCA1';
const CUSTOMER = 'SD9239CUST1';
const MATERIAL = 'SD9239MAT1';
const PLANT = '1000';
const STORE = '0001';
const DATE = '2026-10-15';

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
};

let counter = 0;
const key = (what: string) => `sd9239-${what}-${++counter}`;

describe('the conditions a document is priced by, through the chain that follows it', () => {
  let tenant: TestTenant;
  /** The order raised with conditions and then stripped of them — what every order in the books is. */
  let historicOrder = '';
  /** The record that raised the price on 20 October. It must not reach back over what came before. */
  let increasedRecord = '';

  beforeAll(async () => {
    tenant = await createTenant('sd9239-pricing-chain');
    base.client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(tenant.client, async (tx) => {
      for (const range of [
        { objectCode: 'SALESORD', subObject: 'OR', prefix: 'SO', numberLength: 7 },
        { objectCode: 'DELIVERY', subObject: 'LF', prefix: 'DL', numberLength: 7 },
        { objectCode: 'BILLING', subObject: 'F2', prefix: 'INV', numberLength: 7 },
        { objectCode: 'BILLING', subObject: 'G2', prefix: 'CM', numberLength: 7 },
        { objectCode: 'MATDOC', subObject: '*', prefix: 'MD', numberLength: 8 },
        { objectCode: 'CUSTINV', subObject: '*', prefix: 'CI', numberLength: 7 },
      ]) {
        await defineRange(tx, { client: tenant.client, createdBy: ACTOR, ...range });
      }
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
        values (${tenant.client}, '1000', 'E', 'Chain test sales organization', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into sales_area (client, sales_org, distribution_channel, division, name, created_by)
        values (${tenant.client}, '1000', '10', '01', 'Chain test sales area', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${tenant.client}, ${PLANT}, 'Chain test plant', '1000', 'KW', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
        values (${tenant.client}, ${PLANT}, ${STORE}, 'Main store', true, false, ${ACTOR})
        on conflict (client, plant, storage_location) do update set is_active = excluded.is_active
      `);
      await tx.execute(sql`
        insert into credit_control_area (client, credit_control_area, name, currency, warning_threshold_percent, created_by)
        values (${tenant.client}, ${AREA}, 'Chain test credit area', 'USD', 90, ${ACTOR}) on conflict do nothing
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
        insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
        values (${tenant.client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${tenant.client}, ${CUSTOMER}, 'ORGANIZATION', 'Chain test customer', ${ACTOR}) on conflict do nothing
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
      await tx.execute(sql`
        insert into customer_company_code (
          client, partner_number, role_code, company_code, chart_of_accounts,
          reconciliation_account, payment_terms_code, created_by
        )
        values (${tenant.client}, ${CUSTOMER}, 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${tenant.client}, ${MATERIAL}, 'Chain test material', 'RAW', 'UNT', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, ${ACTOR}) on conflict do nothing
      `);
      // What the books say the goods are worth: the rate the statistical cost is read from, and the stock
      // the goods issue draws down.
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency,
                                        total_stock_quantity, stock_value, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, 'USD',
                100, 1000, ${ACTOR})
        on conflict (client, material_number, valuation_area)
        do update set moving_average_price = excluded.moving_average_price
      `);
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, ${STORE}, 'UNRESTRICTED', 100, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
        values (${tenant.client}, 'OPENING_BALANCE', 'Opening balance', 'RECEIPT', 'MATERIAL_DOCUMENT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document (client, material_document_number, document_year, document_date,
                                       posting_date, header_text, status, created_by)
        values (${tenant.client}, 'MD-CHAIN001', 2026, ${DATE}, ${DATE}, 'Opening balance', 'POSTED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_document_line (client, material_document_number, line_number, movement_type,
                                            material_number, plant, storage_location, stock_type, line_direction,
                                            entry_quantity, entry_unit, base_quantity, base_unit, created_by)
        values (${tenant.client}, 'MD-CHAIN001', 1, 'OPENING_BALANCE', ${MATERIAL}, ${PLANT}, ${STORE},
                'UNRESTRICTED', 'RECEIPT', 100, 'UNT', 100, 'UNT', ${ACTOR})
        on conflict do nothing
      `);
      // The accounts the movement and the receivable post through. The chart the company code carries is
      // the standard one, so only the two sales-specific accounts have to be added to it.
      await tx.execute(sql`
        insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                                is_balance_sheet, is_open_item_managed, reconciliation_type,
                                requires_cost_object, is_tax_relevant, account_group, gl_account_type, created_by)
        select ${tenant.client}, c.chart_of_accounts, v.n, v.d, 'EXPENSE',
               false, false, null, false, false, 'GENL', 'PL_STATEMENT', ${ACTOR}
        from (select chart_of_accounts from chart_of_accounts where client = ${tenant.client} limit 1) c
        cross join (values ('510300', 'Cost of goods sold'), ('120000', 'Raw materials inventory')) as v(n, d)
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
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

    // The material stands for sale in the sales area: the plant says the warehouse can carry it, and
    // the sales view says it may be sold there.
    await maintainMaterialSales(tenant, { materialNumber: MATERIAL, deliveringPlant: PLANT });
    const area = { salesOrg: '1000', distributionChannel: '10', division: '01' };
    const period = { validityFrom: '2026-01-01', validityTo: '2026-12-31', supersedeStanding: false };
    // The price list this chain is sold under: 25.00 a unit, less ten per cent, plus 5.00 a unit of
    // freight, plus a 15.00 document charge carried at the header.
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, ...area, customerNumber: CUSTOMER, materialNumber: MATERIAL,
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
      creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false, changeReason: 'Chain test credit data.',
    });
  });

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  /** Order `ordered` units, deliver and invoice `delivered` of them. */
  async function invoicedChain(label: string, ordered: number, delivered: number) {
    const placed = await createSalesOrder({
      ...base, requestKey: key(`${label}-order`),
      lines: [{
        lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: ordered, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    });
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: placed.orderNumber });
    const shipped = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: placed.orderNumber, deliveryDate: DATE,
      items: [{ orderLineNumber: open[0].lineNumber, quantity: String(delivered) }],
      requestKey: key(`${label}-delivery`),
    });
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: shipped.deliveryNumber,
      items: [{ lineNumber: 10, quantity: String(delivered), storageLocation: STORE }],
      requestKey: key(`${label}-pick`),
    });
    const standing = await getDelivery(tenant.client, shipped.deliveryNumber);
    await postDeliveryGoodsIssue({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: shipped.deliveryNumber,
      expectedVersion: standing!.version, postingDate: DATE,
    });
    const invoiced = await postBillingDocument({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: shipped.deliveryNumber, billingDate: DATE,
      requestKey: key(`${label}-invoice`),
    });
    return {
      orderNumber: placed.orderNumber,
      deliveryNumber: shipped.deliveryNumber,
      billing: invoiced.billing,
      invoice: invoiced.invoice,
    };
  }

  let invoiced: Awaited<ReturnType<typeof invoicedChain>>;

  it('prices the order once, at ten units: 250 less 25 plus 50 plus 15, and tax on all of it', async () => {
    const placed = await createSalesOrder({
      ...base, requestKey: key('ten-order'),
      lines: [{
        lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: 10, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    });
    const view = await getSalesOrder(tenant.client, placed.orderNumber);
    expect(Number(view!.netValue)).toBe(290);
    expect(Number(view!.taxValue)).toBe(29);
    expect(Number(view!.lines[0].netPrice)).toBe(29);

    const conditions = await salesDocumentConditionsOf(tenant.client, 'ORDER', placed.orderNumber);
    const at = (conditionType: string) => conditions.find(
      (row) => row.conditionType === conditionType && row.lineNumber === 10,
    );
    expect(Number(at('PR00')!.amount)).toBe(250);
    expect(Number(at('K007')!.amount)).toBe(-25);
    expect(Number(at('KF00')!.amount)).toBe(50);
    // The header charge is one condition the document carries, distributed over the lines that earned it.
    expect(Number(at('HD00')!.amount)).toBe(15);
    expect(Number(at('MWST')!.amount)).toBe(29);
    // The cost stands beside the price and is no part of it.
    expect(Number(at('VPRS')!.amount)).toBe(100);
    expect(at('VPRS')!.isStatistical).toBe(true);
  });

  it('invoices six of the ten at the price they were sold at, not at a second price', async () => {
    invoiced = await invoicedChain('six', 10, 6);
    const line = invoiced.billing.lines[0];
    expect(line.billingQuantity).toBe('6.000');
    // The price of a unit is what it was: the discount, the freight and the charge all travel with it.
    expect(line.netPrice).toBe('29.0000');
    expect(Number(line.netAmount)).toBe(174);
    expect(Number(line.taxAmount)).toBe(17.4);
    expect(Number(invoiced.billing.netValue)).toBe(174);
    expect(Number(invoiced.billing.grossValue)).toBe(191.4);

    const conditions = await salesDocumentConditionsOf(
      tenant.client, 'BILLING', invoiced.billing.billingNumber,
    );
    const at = (conditionType: string) => conditions.find((row) => row.conditionType === conditionType);
    // 150 less 15 plus 30 plus nine tenths of the header charge.
    expect(Number(at('PR00')!.amount)).toBe(150);
    expect(Number(at('K007')!.amount)).toBe(-15);
    expect(Number(at('KF00')!.amount)).toBe(30);
    expect(Number(at('HD00')!.amount)).toBe(9);
    expect(Number(at('MWST')!.amount)).toBe(17.4);
    expect(Number(at('VPRS')!.amount)).toBe(60);
    // The conditions written are the value of the line: no figure on the invoice is held anywhere else.
    const summed = conditions
      .filter((row) => !row.isStatistical && row.conditionType !== 'MWST')
      .reduce((total, row) => total + Number(row.amount), 0);
    expect(Number(summed.toFixed(2))).toBe(174);
  });

  it('credits two of those six for what those two were charged — discount, freight and charge included', async () => {
    const raised = await createCreditMemo({
      client: tenant.client, changedBy: ACTOR, billingNumber: invoiced.billing.billingNumber,
      billingDate: DATE, requestKey: key('credit-two'),
      items: [{ billingLineNumber: 10, quantity: 2 }],
    });
    // 50 less 5 plus 10 plus 3, negated: the two units' own share of everything the invoice charged.
    expect(raised.netValue).toBe('-58.00');
    expect(raised.taxValue).toBe('-5.80');
    expect(raised.grossValue).toBe('-63.80');

    const conditions = await salesDocumentConditionsOf(tenant.client, 'BILLING', raised.billingNumber);
    const at = (conditionType: string) => conditions.find((row) => row.conditionType === conditionType);
    expect(Number(at('PR00')!.amount)).toBe(-50);
    // The discount is given back with the goods: it is a positive credit because the charge was a deduction.
    expect(Number(at('K007')!.amount)).toBe(5);
    expect(Number(at('KF00')!.amount)).toBe(-10);
    expect(Number(at('HD00')!.amount)).toBe(-3);
    // Ten per cent of the value going back, which is what makes the credit the invoice's own arithmetic
    // in reverse. A third of the invoice's tax would have been the same here by luck of the numbers and
    // wrong in general: a tax is a rate on a value, not a share of a total.
    expect(Number(at('MWST')!.amount)).toBe(-5.8);
    expect(Number(at('MWST')!.rate)).toBe(10);
    const summed = conditions
      .filter((row) => !row.isStatistical && row.conditionType !== 'MWST')
      .reduce((total, row) => total + Number(row.amount), 0);
    expect(Number(summed.toFixed(2))).toBe(-58);
  });

  it('posts each part of the sale where determination says: revenue, the discount, freight and the tax', async () => {
    // 150.00 of price, 15.00 of discount, 30.00 of freight and 9.00 of the document charge, plus 17.40
    // of tax: four figures of four kinds, and four accounts — none of them chosen by the service that
    // posted them.
    const journal = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select jl.gl_account, jl.debit_credit, jl.amount_local::text as amount
        from journal_entry_line jl
       where jl.client = ${tenant.client} and jl.document_number = ${invoiced.invoice?.journalDocumentNumber ?? ''}
       order by jl.gl_account, jl.debit_credit
    `) as unknown as Promise<Array<{ gl_account: string; debit_credit: string; amount: string }>>);
    const at = (account: string, side: string) => journal.find(
      (row) => row.gl_account === account && row.debit_credit === side,
    );
    // The customer owes the whole of it.
    expect(at('110000', 'S')?.amount).toBe('191.4000');
    // The price is revenue. The discount is not revenue and is not credited to it — it is debited to a
    // deduction account, which is the only place a reader can see what the customer was given off.
    expect(at('300000', 'H')?.amount).toBe('150.0000');
    expect(at('310000', 'S')?.amount).toBe('15.0000');
    // Freight is earned by carrying the goods, not by selling them: both the freight on the line and the
    // document's own charge, to one account, because the determination says what they are.
    expect(at('320000', 'H')?.amount).toBe('39.0000');
    // And the tax, on the account its own key names.
    expect(at('220000', 'H')?.amount).toBe('17.4000');
    // It balances: what the customer owes is what the four accounts took between them.
    const owed = journal.filter((row) => row.debit_credit === 'S')
      .reduce((total, row) => total + Number(row.amount), 0);
    const earned = journal.filter((row) => row.debit_credit === 'H')
      .reduce((total, row) => total + Number(row.amount), 0);
    expect(Number(owed.toFixed(2))).toBe(Number(earned.toFixed(2)));
    expect(journal.map((row) => row.gl_account).sort()).toEqual(['110000', '220000', '300000', '310000', '320000']);
  });

  it('refuses to post an invoice where no account is determined, and names the screen', async () => {
    // The determination for revenue is made to answer for a customer group this customer does not carry.
    // It is changed rather than withdrawn because the application role holds no DELETE on configuration:
    // a tenant that loses a determination by accident has to be able to put it back.
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update sales_account_determination set customer_account_assignment_group = 'ZZZZ', changed_by = ${ACTOR}
        where client = ${tenant.client} and account_key = 'ERL'
      `);
    });
    let refusal: { message: string; remedy?: string } | undefined;
    try {
      await invoicedChain('undetermined', 1, 1);
    } catch (error) {
      refusal = error as { message: string; remedy?: string };
    } finally {
      await withTenant(tenant.client, async (tx) => {
        await tx.execute(sql`
          update sales_account_determination set customer_account_assignment_group = '', changed_by = ${ACTOR}
          where client = ${tenant.client} and account_key = 'ERL'
        `);
      });
    }
    // The refusal names the key, the customer group and the material group it was looking for, and the
    // screen where the answer is maintained. An invoice posted to an account nobody chose would be worse
    // than an invoice that was never raised, because this one only has to be fixed.
    expect(refusal?.message).toMatch(/No G\/L account is determined for ERL/);
    expect(refusal?.remedy).toContain('/config/sales-account-determination');
  });

  it('posts to the most specific row that fits when a customer and a material are named', async () => {
    // A group for this customer, and a group on the material's own sales view. A determination maintained
    // for exactly that pair stands over the row that names neither.
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update customer_sales_area set account_assignment_group = 'HOME', changed_by = ${ACTOR}
        where client = ${tenant.client} and partner_number = ${CUSTOMER}
          and sales_org = '1000' and distribution_channel = '10' and division = '01'
      `);
      await tx.execute(sql`
        update material_sales set material_account_assignment_group = 'GOOD', changed_by = ${ACTOR}
        where client = ${tenant.client} and material_number = ${MATERIAL}
          and sales_org = '1000' and distribution_channel = '10'
      `);
      // The chart the company code keeps, which is the same chart billing determines against.
      await tx.execute(sql`
        insert into sales_account_determination (
          client, chart_of_accounts, sales_org, customer_account_assignment_group,
          material_account_assignment_group, account_key, gl_account, is_active, created_by, changed_by
        )
        values (
          ${tenant.client},
          (select chart_of_accounts from company_code where client = ${tenant.client} and company_code = '1000'),
          '1000', 'HOME', 'GOOD', 'ERL', '300100', true, ${ACTOR}, ${ACTOR}
        )
        on conflict do nothing
      `);
    });
    const specific = await invoicedChain('specific', 2, 2);
    const journal = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select jl.gl_account, jl.debit_credit, jl.amount_local::text as amount
        from journal_entry_line jl
       where jl.client = ${tenant.client} and jl.document_number = ${specific.invoice?.journalDocumentNumber ?? ''}
       order by jl.gl_account
    `) as unknown as Promise<Array<{ gl_account: string; debit_credit: string; amount: string }>>);
    // Export revenue, not domestic: the row naming this customer and this material is the one that
    // answered, and the row naming neither stood behind it and was not asked.
    expect(journal.find((row) => row.gl_account === '300100')?.amount).toBe('50.0000');
    expect(journal.some((row) => row.gl_account === '300000')).toBe(false);
    // Everything else is unchanged: the same deduction, the same freight, the same tax.
    // 10.00 of freight on the line plus the whole 15.00 the document carries, because one line earned
    // all of it; and ten per cent of 70.00, which is what the two units came to.
    expect(journal.find((row) => row.gl_account === '310000')?.amount).toBe('5.0000');
    expect(journal.find((row) => row.gl_account === '320000')?.amount).toBe('25.0000');
    expect(journal.find((row) => row.gl_account === '220000')?.amount).toBe('7.0000');

    // Put the master data back, so what runs after this sees the tenant as it stood.
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update customer_sales_area set account_assignment_group = null, changed_by = ${ACTOR}
        where client = ${tenant.client} and partner_number = ${CUSTOMER}
          and sales_org = '1000' and distribution_channel = '10' and division = '01'
      `);
      await tx.execute(sql`
        update material_sales set material_account_assignment_group = null, changed_by = ${ACTOR}
        where client = ${tenant.client} and material_number = ${MATERIAL}
          and sales_org = '1000' and distribution_channel = '10'
      `);
    });
  });

  it('bills on the determination alone, needing the rows it used to need no more', async () => {
    // Before this section a tenant had to maintain two rows in the finance account determination —
    // revenue by event, tax by chart — before it could raise a single invoice. The sales determination
    // answers the same question with more meaning in it, so those rows are a prerequisite no longer.
    const chart = (await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select chart_of_accounts from company_code where client = ${tenant.client} and company_code = '1000'
    `) as unknown as Promise<Array<{ chart_of_accounts: string }>>))[0]?.chart_of_accounts ?? 'CA01';
    const standing = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select event, valuation_class, general_modifier, gl_account from account_determination
       where client = ${tenant.client} and event in ('SALES_REVENUE', 'TAX')
    `) as unknown as Promise<Array<{
      event: string; valuation_class: string; general_modifier: string; gl_account: string;
    }>>);
    expect(standing.length).toBeGreaterThan(0);
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        delete from account_determination
         where client = ${tenant.client} and event in ('SALES_REVENUE', 'TAX')
      `);
    });
    try {
      const billed = await invoicedChain('determined', 4, 4);
      const journal = await withTenant(tenant.client, async (tx) => tx.execute(sql`
        select jl.gl_account, jl.debit_credit, jl.amount_local::text as amount
          from journal_entry_line jl
         where jl.client = ${tenant.client} and jl.document_number = ${billed.invoice?.journalDocumentNumber ?? ''}
         order by jl.gl_account
      `) as unknown as Promise<Array<{ gl_account: string; debit_credit: string; amount: string }>>);
      // Four units: 100.00 of price, 10.00 off, 20.00 of freight and the document's own 15.00, and
      // 12.50 of tax. Every account is one the determination named, and none of them was maintained
      // anywhere else.
      expect(journal.find((row) => row.gl_account === '300000')?.amount).toBe('100.0000');
      expect(journal.find((row) => row.gl_account === '310000')?.amount).toBe('10.0000');
      expect(journal.find((row) => row.gl_account === '320000')?.amount).toBe('35.0000');
      expect(journal.find((row) => row.gl_account === '220000')?.amount).toBe('12.5000');
      expect(journal.find((row) => row.gl_account === '110000')?.amount).toBe('137.5000');
    } finally {
      // Put them back, so the tenant is as it stood for whatever runs next.
      for (const row of standing) {
        await withTenant(tenant.client, async (tx) => {
          await tx.execute(sql`
            insert into account_determination (
              client, chart_of_accounts, event, valuation_class, general_modifier, gl_account,
              created_by, changed_by
            ) values (
              ${tenant.client}, ${chart}, ${row.event}, ${row.valuation_class}, ${row.general_modifier},
              ${row.gl_account}, ${ACTOR}, ${ACTOR}
            )
          `);
        });
      }
    }
  });

  it('bills a document that carries no conditions by the figures it has always carried', async () => {
    // A document raised before the conditions existed: the line holds its price, and nothing else. This
    // is what every order in the books looks like the morning this is deployed, and none of them may move.
    const placed = await createSalesOrder({
      ...base, requestKey: key('historic-order'),
      lines: [{
        lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: 10, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    });
    historicOrder = placed.orderNumber;
    // Rename them onto a document that does not exist, which is the cheapest way to reach the state the
    // books are actually in: the application role is granted no DELETE on a condition, because what priced
    // a document is evidence, not working storage, and a tenant cannot quietly unwrite it.
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update sales_document_condition set document_number = 'SD9239-ARCHIVED', changed_by = ${ACTOR}
        where client = ${tenant.client} and document_category = 'ORDER' and document_number = ${placed.orderNumber}
      `);
    });
    expect(await salesDocumentConditionsOf(tenant.client, 'ORDER', placed.orderNumber)).toEqual([]);

    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: placed.orderNumber });
    const shipped = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: placed.orderNumber, deliveryDate: DATE,
      items: [{ orderLineNumber: open[0].lineNumber, quantity: '4' }], requestKey: key('historic-delivery'),
    });
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: shipped.deliveryNumber,
      items: [{ lineNumber: 10, quantity: '4', storageLocation: STORE }], requestKey: key('historic-pick'),
    });
    const standing = await getDelivery(tenant.client, shipped.deliveryNumber);
    await postDeliveryGoodsIssue({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: shipped.deliveryNumber,
      expectedVersion: standing!.version, postingDate: DATE,
    });
    const invoicedHistoric = await postBillingDocument({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: shipped.deliveryNumber, billingDate: DATE,
      requestKey: key('historic-invoice'),
    });
    const line = invoicedHistoric.billing.lines[0];
    // Four units at the price the line has always carried, and the tax the master stands at today.
    expect(line.netPrice).toBe('29.0000');
    expect(Number(line.netAmount)).toBe(116);
    expect(Number(line.taxAmount)).toBe(11.6);
    expect(Number(invoicedHistoric.billing.grossValue)).toBe(127.6);
    // No pricing condition was invented for it: a line that carries none is billed on the price it has
    // always carried. What the document does record is the tax, because tax is a step of the procedure
    // that ran over the line's subtotal (§4.7) — and on a line with no other condition the subtotal is
    // the line, which is why the figure is the one this document has always carried.
    const historic = await salesDocumentConditionsOf(
      tenant.client, 'BILLING', invoicedHistoric.billing.billingNumber,
    );
    expect(historic.map((row) => [row.conditionType, row.conditionClass])).toEqual([['MWST', 'TAX']]);
    expect(Number(historic[0].amount)).toBe(11.6);
    expect(Number(historic[0].baseValue)).toBe(116);
    expect(Number(historic[0].rate)).toBe(10);
    expect(historic[0].accountKey).toBe('MWS');
  });

  it('posts the tax the document stored, on the account the tax key named', async () => {
    // Tax is determined once, by pricing (§4.7). What the receivable posts is the figure the document
    // stored — not a rate the accounting-invoice service looked up again for itself — and it lands on
    // the account MWS determined, not on the standing tax account the chart happens to carry.
    const billed = await invoicedChain('stored-tax', 3, 3);
    const stored = Number(billed.billing.lines[0].taxAmount);
    expect(Number(billed.invoice?.taxAmount)).toBe(stored);
    const journal = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select jl.gl_account, jl.amount_local::text as amount
        from journal_entry_line jl
       where jl.client = ${tenant.client} and jl.document_number = ${billed.invoice?.journalDocumentNumber ?? ''}
       order by jl.gl_account
    `) as unknown as Promise<Array<{ gl_account: string; amount: string }>>);
    expect(Number(journal.find((row) => row.gl_account === '220000')?.amount)).toBe(stored);
    // 240000 is the account this tenant maintains for the tax event by chart. It was not asked.
    expect(journal.some((row) => row.gl_account === '240000')).toBe(false);
  });

  it('refuses, at the moment it is billed, a tax code that no longer stands for the country', async () => {
    // The refusal the fallback has always made, and the reason it cannot simply read a rate: a code that
    // stood when the order was raised need not stand when the delivery is invoiced (§4.7).
    const placed = await createSalesOrder({
      ...base, requestKey: key('lapsed-order'),
      lines: [{
        lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: 2, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    });
    // Stripped of its conditions, which is the state a document carries no pricing for: the tax is then
    // priced at the moment of billing, from the master as it stands at that moment.
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        update sales_document_condition set document_number = 'SD9239-LAPSED', changed_by = ${ACTOR}
        where client = ${tenant.client} and document_category = 'ORDER' and document_number = ${placed.orderNumber}
      `);
    });
    const open = await listDeliverableOrderLines(tenant.client, { orderNumber: placed.orderNumber });
    const shipped = await createDelivery({
      client: tenant.client, changedBy: ACTOR, orderNumber: placed.orderNumber, deliveryDate: DATE,
      items: [{ orderLineNumber: open[0].lineNumber, quantity: '2' }], requestKey: key('lapsed-delivery'),
    });
    await confirmDeliveryPicks({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: shipped.deliveryNumber,
      items: [{ lineNumber: 10, quantity: '2', storageLocation: STORE }], requestKey: key('lapsed-pick'),
    });
    const standing = await getDelivery(tenant.client, shipped.deliveryNumber);
    await postDeliveryGoodsIssue({
      client: tenant.client, changedBy: ACTOR, deliveryNumber: shipped.deliveryNumber,
      expectedVersion: standing!.version, postingDate: DATE,
    });
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        delete from tax_code where client = ${tenant.client} and country = 'KW' and tax_code = 'T10'
      `);
    });
    try {
      await expect(postBillingDocument({
        client: tenant.client, changedBy: ACTOR, deliveryNumber: shipped.deliveryNumber, billingDate: DATE,
        requestKey: key('lapsed-invoice'),
      })).rejects.toThrow(/T10 no longer stands for country KW/);
    } finally {
      await withTenant(tenant.client, async (tx) => {
        await tx.execute(sql`
          insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
          values (${tenant.client}, 'KW', 'T10', 'Output tax 10 percent', 'VAT', 10, ${ACTOR})
          on conflict do nothing
        `);
      });
    }
  });

  it('leaves a document standing at the price it was priced at when the price list moves', async () => {
    const area = { salesOrg: '1000', distributionChannel: '10', division: '01' };
    const before = await salesDocumentConditionsOf(
      tenant.client, 'BILLING', invoiced.billing.billingNumber,
    );
    // The price goes up for business written from now on.
    const raised = await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, ...area, customerNumber: CUSTOMER, materialNumber: MATERIAL,
      currency: 'USD', amount: 30, priceUnit: 1, supersedeStanding: true,
      validityFrom: '2026-10-20', validityTo: '2026-12-31',
    });
    increasedRecord = raised.condition.conditionNumber;
    const after = await salesDocumentConditionsOf(
      tenant.client, 'BILLING', invoiced.billing.billingNumber,
    );
    expect(after).toEqual(before);

    // A new order, dated after the increase, is priced at the increase.
    const placed = await createSalesOrder({
      ...base, orderDate: '2026-10-25', requestKey: key('after-increase'),
      lines: [{
        lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: 1, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    });
    const conditions = await salesDocumentConditionsOf(tenant.client, 'ORDER', placed.orderNumber);
    expect(Number(conditions.find((row) => row.conditionType === 'PR00')!.amount)).toBe(30);
    // And it names the record the increase created — which is what makes the assertions below, that no
    // older document ever names it, worth reading.
    expect(increasedRecord).not.toBe('');
    expect(conditions.find((row) => row.conditionType === 'PR00')!.conditionNumber).toBe(increasedRecord);
  });
  it('re-prices a document at the price its own date resolves, not at the price that stands now', async () => {
    // The property worth protecting. Every order in the books was priced by a record that stood on the
    // day it was raised. Re-priced today — after the increase of 20 October — it must answer to that
    // record and not to the one that stands now, or the whole of history moves the day a price list is
    // maintained.
    const before = (await getSalesOrder(tenant.client, invoiced.orderNumber))!;
    const beforeLine = before.lines[0];
    const beforeConditions = await salesDocumentConditionsOf(tenant.client, 'ORDER', invoiced.orderNumber);

    const repriced = await changeSalesOrder({
      ...base, orderNumber: invoiced.orderNumber, expectedVersion: before.version,
      requestKey: key('reprice'), rejectLines: [],
      lines: [{
        lineNumber: beforeLine.lineNumber, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: 10, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    });

    const afterLine = repriced.lines.find((row) => row.lineNumber === beforeLine.lineNumber)!;
    // Ten units at 29.00, which is 250 less 25 plus 50 plus 15 spread over ten, and tax on all of it.
    expect(afterLine.netPrice).toBe('29.0000');
    expect(afterLine.netAmount).toBe('290.0000');
    expect(afterLine.taxAmount).toBe('29.0000');
    expect(repriced.netValue).toBe(before.netValue);
    expect(repriced.grossValue).toBe(before.grossValue);
    // The same record answered, and it is not the record the increase created.
    expect(afterLine.conditionNumber).toBe(beforeLine.conditionNumber);
    expect(afterLine.conditionNumber).not.toBe(increasedRecord);
    // And the arithmetic beside the line is the arithmetic that stood there before it was re-priced.
    const afterConditions = await salesDocumentConditionsOf(tenant.client, 'ORDER', invoiced.orderNumber);
    const shape = (rows: typeof afterConditions) => rows.map(
      (row) => [row.conditionType, row.stepNumber, row.amount, row.conditionNumber],
    );
    expect(shape(afterConditions)).toEqual(shape(beforeConditions));
  });

  it('re-prices a document raised before the conditions existed at the figure it has always carried', async () => {
    // The order raised with conditions and then stripped of them, which is the state every document in
    // the books is in the morning this is deployed: a line holding 29.00 a unit, and nothing else.
    const before = (await getSalesOrder(tenant.client, historicOrder))!;
    expect(before.lines[0].netPrice).toBe('29.0000');
    expect(await salesDocumentConditionsOf(tenant.client, 'ORDER', historicOrder)).toEqual([]);

    const repriced = await changeSalesOrder({
      ...base, orderNumber: historicOrder, expectedVersion: before.version,
      requestKey: key('reprice-historic'), rejectLines: [],
      lines: [{
        lineNumber: before.lines[0].lineNumber, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: 10, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    });
    const line = repriced.lines[0];
    // It did not move: not to the increased price, and not to a figure the procedure invented for it.
    expect(line.netPrice).toBe('29.0000');
    expect(line.netAmount).toBe('290.0000');
    expect(line.taxAmount).toBe('29.0000');
    expect(Number(repriced.netValue)).toBe(290);
    expect(Number(repriced.grossValue)).toBe(319);
    // Re-priced, it gains the arithmetic it never had — written from the records that stood on its own
    // date, which is why the figure it always carried is the figure it carries still.
    const conditions = await salesDocumentConditionsOf(tenant.client, 'ORDER', historicOrder);
    const price = conditions.find((row) => row.conditionType === 'PR00')!;
    expect(Number(price.amount)).toBe(250);
    expect(price.conditionNumber).toBe(line.conditionNumber);
    expect(price.conditionNumber).not.toBe(increasedRecord);
    // And what was billed against it before it was re-priced still stands at what it billed.
    expect(Number(invoiced.billing.grossValue)).toBe(191.4);
  });

});
