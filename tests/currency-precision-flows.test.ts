import { sql } from 'drizzle-orm';
import { withFinanceAuth, financeAuth } from './helpers/finance-actor';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { saveSalesConditionForProvisioning as saveSalesCondition } from '../src/modules/sales/conditions';
import { createSalesOrder } from '../src/modules/sales/sales-order';
import { createBillingFromPlanDate } from '../src/modules/sales/billing';
import { saveBillingPlan } from '../src/modules/sales/billing-plan';
import { createOrderForProvisioning as createOrder } from '../src/modules/purchasing/orders';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { cancelSupplierInvoice as cancelSupplierInvoiceRaw, getSupplierInvoice as getSupplierInvoiceRaw, postSupplierInvoice as postSupplierInvoiceRaw, InvoiceVerificationError } from '../src/modules/purchasing/invoice-verification';
import { postGoodsReceipt } from './helpers/goods-receipt-authorized';
import { assignSalesAreaDimensions, createTenant, defineTestRanges, destroyTenant, maintainMaterialSales, type TestTenant } from './helpers';
import { createSalesActor, refreshSalesActor } from './helpers/sales-actor';

const cancelSupplierInvoice = withFinanceAuth(cancelSupplierInvoiceRaw);
const getSupplierInvoice = async (client: string, key: string) => getSupplierInvoiceRaw(client, key, await financeAuth(client));
const postSupplierInvoice = withFinanceAuth(postSupplierInvoiceRaw);

/**
 * The real callers upstream of finance, in a three-decimal currency: purchase order → goods receipt → invoice
 * verification, and sales order → billing plan → billing → customer invoice. Precision must survive every hop to the
 * ledger, so the figures below are read back from the posted journals and the stored documents.
 */
const ACTOR = 'CURRENCY_FLOWS_TEST';
const tenants: string[] = [];
afterAll(async () => { for (const t of tenants) await destroyTenant(t); }, 180_000);

const journal = async (client: string, documentNumber: string) => withTenant(client, async (tx) => (await tx.execute(sql`
  select gl_account, debit_credit, amount_document::text as amount from journal_entry_line
   where client = ${client} and document_number = ${documentNumber} order by line_number`)) as unknown as Array<{ gl_account: string; debit_credit: string; amount: string }>);

describe('purchasing: order (4-decimal price) → goods receipt → invoice verification, in KWD', () => {
  it('keeps the order value, the GR/IR credit, the variance and the payable exact to the fils, and cancels exactly', async () => {
    let client = '';
    await (async () => {
      const tenant = await createTenant('currency-iv-kwd', { currency: 'KWD' });
      client = tenant.client;
      await defineTestRanges(tenant, { fiscalYear: 2026 });
      await withTenant(client, async (tx) => {
        await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
        await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
        await defineRange(tx, { client, objectCode: 'VENDINV', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
        await tx.execute(sql`
          insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
          values (${client}, '1000', 'Test purchasing organization', '1000', ${ACTOR}) on conflict do nothing
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
          values (${client}, 'V10000', 'SUPPLIER', '1000', 'KWD', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
          values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into supplier_company_code (
            client, partner_number, role_code, company_code, chart_of_accounts,
            reconciliation_account, payment_terms_code, created_by
          )
          values (${client}, 'V10000', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
          values (${client}, 'KW', 'T10', 'Input tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into material (client, material_number, description, material_type, base_unit, created_by)
          values (${client}, 'MAT-10001', 'Industrial steel plate', 'RAW', 'PC', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by)
          values (${client}, 'MAT-10001', '1000', 0, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into material_valuation (
            client, material_number, valuation_area, valuation_class, price_control,
            standard_price, moving_average_price, price_unit, currency, created_by
          )
          values (${client}, 'MAT-10001', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'KWD', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
          values (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
                 (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR}),
                 (${client}, 'CA01', 'PRICE_DIFFERENCE', 'RAW_INVENTORY', '', '410200', ${ACTOR}),
                 (${client}, 'CA01', 'TAX', '', '', '140000', ${ACTOR})
          on conflict do nothing
        `);
      });
      tenants.push(client);
      await initializeMaterialPeriodControl({ client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'currency precision' });
    })();
    const header = { supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '' };
    // 3 PC at 1.2375 KWD (a four-decimal unit price, which is not a posted amount) is worth 3.7125 → 3.713.
    const order = await createOrder({
      client, changedBy: ACTOR, ...header,
      items: [{
        materialNumber: 'MAT-10001', shortText: 'Steel plate', quantity: 3, unit: 'PC', netPrice: 1.2375, priceUnit: 1, taxCode: '', plant: '1000',
        storageLocation: '', markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 3 }], assignments: [] as never[],
      }],
    });
    const stored = await withTenant(client, async (tx) => (await tx.execute(sql`
      select net_price::text as price, net_value::text as value from purchase_order_item where client = ${client} and order_number = ${order.orderNumber}`)) as unknown as Array<{ price: string; value: string }>);
    expect(stored[0]).toEqual({ price: '1.2375', value: '3.7130' }); // the price keeps its fourth decimal; the value is a posted amount
    await expect(createOrder({
      client, changedBy: ACTOR, ...header,
      items: [{ materialNumber: 'MAT-10001', shortText: 'x', quantity: 1, unit: 'PC', netPrice: 1.23456, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '', markedForDeletion: false, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 1 }], assignments: [] as never[] }],
    })).rejects.toThrow(/more than 4 decimal places/);

    const receipt = await postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: order.orderNumber, documentDate: '2026-10-18', postingDate: '2026-10-18',
      requestKey: 'kwd-gr', lines: [{ itemNumber: 10, quantity: 3 }],
    });
    const grLines = await journal(client, receipt.journalDocumentNumber!);
    expect(grLines.map((l) => [l.gl_account, l.debit_credit, l.amount])).toEqual([['120000', 'S', '3.7130'], ['210000', 'H', '3.7130']]);

    // Invoice 3.800 net (0.087 over the order value) + 10 % tax 0.380 = 4.180 gross.
    await expect(postSupplierInvoice({
      client, changedBy: ACTOR, orderNumber: order.orderNumber, supplierReference: 'KWD-INV-0', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 4.18, requestKey: 'kwd-iv-bad', lines: [{ itemNumber: 10, quantity: 3, netAmount: 3.8001, taxCode: 'T10' }],
    })).rejects.toBeInstanceOf(InvoiceVerificationError);
    const invoice = await postSupplierInvoice({
      client, changedBy: ACTOR, orderNumber: order.orderNumber, supplierReference: 'KWD-INV-1', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 4.18, requestKey: 'kwd-iv', lines: [{ itemNumber: 10, quantity: 3, netAmount: 3.8, taxCode: 'T10' }],
    });
    expect(invoice).toMatchObject({ grossAmount: '4.1800', taxAmount: '0.3800' });
    const ivLines = await journal(client, invoice.journalDocumentNumber!);
    expect(ivLines.map((l) => [l.gl_account, l.debit_credit, l.amount])).toEqual([
      ['210000', 'S', '3.7130'], ['410200', 'S', '0.0870'], ['140000', 'S', '0.3800'], ['200000', 'H', '4.1800'],
    ]);
    // GR/IR nets to zero: the receipt credited 3.713 and the invoice debited the same 3.713.
    const grir = await withTenant(client, async (tx) => (await tx.execute(sql`
      select coalesce(sum(case when debit_credit = 'S' then amount_local else -amount_local end), 0)::text as balance
        from journal_entry_line where client = ${client} and gl_account = '210000'`)) as unknown as Array<{ balance: string }>);
    expect(Number(grir[0]!.balance)).toBe(0);

    const cancelled = await cancelSupplierInvoice({ client, changedBy: ACTOR, invoiceNumber: invoice.invoiceNumber, postingDate: '2026-10-25', requestKey: 'kwd-iv-cancel' });
    const mirror = await journal(client, cancelled.journalDocumentNumber!);
    expect(mirror.map((l) => [l.gl_account, l.debit_credit === 'S' ? 'H' : 'S', l.amount])).toEqual(ivLines.map((l) => [l.gl_account, l.debit_credit, l.amount]));
    expect((await getSupplierInvoice(client, invoice.invoiceNumber))?.status).toBe('CANCELLED');
  });
});

describe('sales: order → billing plan → billing → customer invoice, in KWD', () => {
  it('prices 1.237 × 2 with tax 0.247 and bills half of it to the fils', async () => {
    const ACTOR2 = ACTOR;
    const AREA = 'CCA1'; const CUSTOMER = 'SD9248CUST1'; const MATERIAL = 'SD9248MAT1'; const PLANT = '1000'; const STORE = '0001'; const DATE = '2026-10-15';
    let tenant!: TestTenant;
    const base = { client: '', changedBy: ACTOR2, salesOrg: '1000', distributionChannel: '10', division: '01', customerNumber: CUSTOMER, companyCode: '1000', currency: 'KWD', orderDate: DATE };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const ACTOR_ = ACTOR2;
    void ACTOR_;
    {
      const ACTOR = ACTOR2;
    tenant = await createTenant('currency-billing-kwd', { currency: 'KWD' });
    base.client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(tenant.client, async (tx) => {
      for (const range of [
        { objectCode: 'SALESORD', subObject: 'OR', prefix: 'SO', numberLength: 7 },
        { objectCode: 'BILLING', subObject: 'F2', prefix: 'INV', numberLength: 7 },
        // What a cancellation document draws from: the release test cancels what it billed.
        { objectCode: 'BILLING', subObject: 'S1', prefix: 'CN', numberLength: 7 },
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
        values (${tenant.client}, '1000', '1000', 'KWD', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into sales_area (client, sales_org, distribution_channel, division, name, created_by)
        values (${tenant.client}, '1000', '10', '01', 'Test sales area', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${tenant.client}, ${PLANT}, 'Test shipping plant', '1000', 'KW', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
        values (${tenant.client}, ${PLANT}, ${STORE}, 'Main store', true, false, ${ACTOR})
        on conflict (client, plant, storage_location) do update set is_active = excluded.is_active
      `);
      await tx.execute(sql`
        insert into credit_control_area (client, credit_control_area, name, currency, warning_threshold_percent, created_by)
        values (${tenant.client}, ${AREA}, 'Test credit area', 'KWD', 90, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        update company_code set credit_control_area = ${AREA}
        where client = ${tenant.client} and company_code = '1000'
      `);
      await tx.execute(sql`
        insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
        values (${tenant.client}, 'KW', 'T10', 'Output tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into credit_risk_category (client, risk_category, name, created_by)
        values (${tenant.client}, 'A', 'Low risk', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${tenant.client}, ${CUSTOMER}, 'ORGANIZATION', ${`Test customer ${CUSTOMER}`}, ${ACTOR})
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
        values (${tenant.client}, ${CUSTOMER}, 'CUSTOMER', '1000', '10', '01', 'PR01', false, 'MAINTAINED', ${ACTOR})
        on conflict (client, partner_number, sales_org, distribution_channel, division)
        do update set sales_status = excluded.sales_status
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
        values (${tenant.client}, ${MATERIAL}, 'Billing plan test material', 'RAW', 'UNT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, ${ACTOR}) on conflict do nothing
      `);
    });
    await maintainMaterialSales(tenant, { materialNumber: MATERIAL, deliveringPlant: PLANT });
    await saveCustomerCredit({
      client: tenant.client, changedBy: ACTOR, customer: CUSTOMER, creditControlArea: AREA,
      creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false,
      changeReason: 'Billing plan test fixture.',
    });
    // Twenty-five a unit: two units is fifty net, five tax, fifty-five gross, and a quarter of that is
    // what each of the four dates bills.
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      customerNumber: '', materialNumber: MATERIAL, currency: 'KWD', amount: 1.237, priceUnit: 1,
      validityFrom: '2026-01-01', validityTo: '2026-12-31', supersedeStanding: false,
    });

    }
    tenants.push(tenant.client);
    const authorization = async () => { const a = await createSalesActor(tenant.client); await refreshSalesActor(tenant.client, a); return a.authorization; };
    const actor = await authorization();
    const placed = await createSalesOrder({
      ...base, client: tenant.client, requestKey: 'kwd-order',
      lines: [{ lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT, orderQuantity: 2, quantityUnit: 'UNT', taxCode: 'T10' }],
    }, { authorization: actor });
    const orderRows = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select net_value::text as net, tax_value::text as tax, gross_value::text as gross from sales_order where client = ${tenant.client} and order_number = ${placed.orderNumber}`)) as unknown as Array<Record<string, string>>);
    expect(orderRows[0]).toEqual({ net: '2.4740', tax: '0.2470', gross: '2.7210' }); // 2.474 net; 0.2474 tax → 0.247

    await saveBillingPlan({
      client: tenant.client, changedBy: ACTOR2, orderNumber: placed.orderNumber, orderLineNumber: 10, planType: 'MS',
      dates: [{ billingDate: '2026-10-01', percentage: 50 }, { billingDate: '2026-11-01', percentage: 50 }], reason: 'currency precision',
    });
    const result = await createBillingFromPlanDate({
      client: tenant.client, changedBy: ACTOR2, orderNumber: placed.orderNumber, orderLineNumber: 10, dateNumber: 10, billingDate: '2026-10-01', requestKey: 'kwd-bill-1',
    }, { authorization: await authorization() });
    expect(result.posted).toBe(true);
    // Half the item: net 1.237, tax 0.1237 → 0.124, gross 1.361. Nothing was cut to two decimals on the way.
    expect(result.billing.netValue).toBe('1.2370');
    expect(result.billing.taxValue).toBe('0.1240');
    expect(result.billing.grossValue).toBe('1.3610');
    const invoice = await withTenant(tenant.client, async (tx) => (await tx.execute(sql`
      select i.gross_amount::text as gross, i.tax_amount::text as tax, i.journal_document_number as journal
        from customer_invoice i where i.client = ${tenant.client} and i.invoice_number = ${result.billing.customerInvoiceNumber}`)) as unknown as Array<Record<string, string>>);
    expect(invoice[0]).toMatchObject({ gross: '1.3610', tax: '0.1240' });
    const posted = await journal(tenant.client, invoice[0]!.journal!);
    expect(posted.map((l) => [l.debit_credit, l.amount]).sort()).toEqual([['H', '0.1240'], ['H', '1.2370'], ['S', '1.3610']]);
  });
});
