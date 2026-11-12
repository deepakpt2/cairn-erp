/**
 * 9251 — money given back: the rebate.
 *
 * Every other part of Sales takes the money. A rebate is the promise that some of it comes back, and a
 * promise is three acts with time between them, which is what makes it worth a file of its own: the
 * agreement says who it was made to, the accrual says what the sales have earned so far, and the
 * settlement pays it out on a credit memo months later.
 *
 * The rules this file holds to are the ones that keep a promise from becoming a surprise. An agreement
 * accrues nothing until it is released — a provision nobody authorised is worse than no provision. It
 * accrues only inside its dates, only for the payer and the sales area it names, and only where a rate
 * stands for the day. The rebate is computed on the net value of the line and never on the tax, and it
 * changes nothing the customer is charged: the invoice is for what the invoice is for, and the rebate
 * stands beside it as a provision until it is settled. Settling more than accrued is refused, because a
 * promise is not a blank cheque. And a cancelled billing document takes its accrual with it, because a
 * provision built on a sale that was undone is an overstatement that never corrects itself.
 *
 * Nothing here goes through a screen: the services are called directly, because a screen is a way of
 * reaching a service and not a place where rules live.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { journalEntryLine } from '../src/modules/finance/schema';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import { createSalesOrder } from '../src/modules/sales/sales-order';
import { cancelBillingDocument, createBillingFromPlanDate } from '../src/modules/sales/billing';
import { saveBillingPlan } from '../src/modules/sales/billing-plan';
import {
  listRebateAgreements,
  rebateAccrualsForBilling,
  rebateRegister,
  releaseRebateAgreement,
  saveRebateAgreement,
  settleRebateAgreement,
} from '../src/modules/sales/rebate';
import { billingDocument, salesDocumentCondition } from '../src/modules/sales/schema';
import {
  assignSalesAreaDimensions,
  createTenant,
  defineTestRanges,
  destroyTenant,
  maintainMaterialSales,
  type TestTenant,
} from './helpers';
import { createSalesActor, refreshSalesActor, type SalesActor } from './helpers/sales-actor';

const ACTOR = 'SD9251_REBATE';
const AREA = 'CCA1';
const CUSTOMER = 'SD9251CUST1';
const MATERIAL = 'SD9251MAT1';
const PLANT = '1000';
const STORE = '0001';
const ORDER_DATE = '2026-10-15';
/** The day the invoice falls due, and the day the settlement is raised. */
const BILLING_DATE = '2026-11-01';
const SETTLEMENT_DATE = '2026-12-15';
/** The customer's reconciliation account, the sales deduction, and the provision the rebate builds. */
const RECON = '110000';
const DEDUCTION = '310000';
const PROVISION = '230000';
/** The rebate: ten per cent of the fifty the customer spent, which is five. */
const RATE = 10;
const REBATE = '5.00';

let counter = 0;
const key = (label: string) => `sd9251-${label}-${++counter}`;

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

/** What the agreement promises, before anything is said about the sales. */
const promise = {
  client: '',
  changedBy: ACTOR,
  customerNumber: CUSTOMER,
  salesOrg: '1000',
  distributionChannel: '10',
  division: '01',
  currency: 'USD',
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  conditionType: 'BO01',
};


const SALES_ACTOR = { username: '', userId: '', sessionId: '', authorization: { userId: '', sessionId: '' } };
let SALES_ACTOR_READY: Promise<void> | null = null;
let SALES_ACTOR_TENANT = '';

/**
 * The authority a sales service is handed.
 *
 * The actor is signed in the first time a service is called, and its Company Code
 * and Plant reach is refreshed on every call: a suite builds its masters in
 * `beforeAll` and often adds a plant after the tenant exists, and a service asked
 * before that plant was granted would answer that the actor's reach does not cover
 * it — which is the rule working, not a test failing for the wrong reason.
 * Keyed on the tenant as well, because a suite that stands two tenants needs a
 * session in each and a session from one is not a session in the other.
 */
async function salesAuthority(client: string) {
  if (!SALES_ACTOR.userId || SALES_ACTOR_TENANT !== client) {
    SALES_ACTOR_TENANT = client;
    SALES_ACTOR_READY = createSalesActor(client).then((actor) => { Object.assign(SALES_ACTOR, actor); });
    await SALES_ACTOR_READY;
  }
  await refreshSalesActor(client, SALES_ACTOR);
  return SALES_ACTOR.authorization;
}

describe('money given back: the rebate (9251)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant('sd9251-rebate');
    base.client = tenant.client;
    promise.client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(tenant.client, async (tx) => {
      for (const range of [
        { objectCode: 'SALESORD', subObject: 'OR', prefix: 'SO', numberLength: 7 },
        { objectCode: 'BILLING', subObject: 'F2', prefix: 'INV', numberLength: 7 },
        // What an invoice cancels into, which the cancellation test needs to draw a number for.
        { objectCode: 'BILLING', subObject: 'S1', prefix: 'CN', numberLength: 7 },
        // The settlement is paid on a document of its own and not on a credit memo, so it draws from an
        // interval of its own.
        { objectCode: 'BILLING', subObject: 'B1', prefix: 'RS', numberLength: 7 },
        { objectCode: 'CUSTINV', subObject: '*', prefix: 'CI', numberLength: 7 },
        { objectCode: 'REBATE_AGR', subObject: '*', prefix: 'RA', numberLength: 7 },
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
        values (${tenant.client}, ${AREA}, 'Test credit area', 'USD', 90, ${ACTOR}) on conflict do nothing
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
        values (${tenant.client}, ${CUSTOMER}, 'CUSTOMER', '1000', 'CA01', ${RECON}, 'NET30', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${tenant.client}, ${MATERIAL}, 'Rebate test material', 'RAW', 'UNT', ${ACTOR})
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
      changeReason: 'Rebate test fixture.',
    });
    // Twenty-five a unit: two units are fifty net, five tax, fifty-five gross. The rebate is a share of
    // the fifty, because a share of the tax would be a rebate on money that belongs to the state.
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      conditionType: 'PR00', customerNumber: '', materialNumber: MATERIAL, currency: 'USD',
      amount: 25, priceUnit: 1, validityFrom: '2026-01-01', validityTo: '2026-12-31',
      supersedeStanding: false,
    });
  }, 120_000);

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  /**
   * The rate the agreement is priced by: ten per cent of the net value, for this customer and material.
   * Maintained once and left standing, because one record prices this combination for this period and a
   * second one beside it would be two answers to one question.
   */
  async function rate(overrides: { customerNumber?: string; materialNumber?: string } = {}) {
    const customerNumber = overrides.customerNumber ?? CUSTOMER;
    const materialNumber = overrides.materialNumber ?? MATERIAL;
    const standing = await withTenant(tenant.client, (tx) => tx.execute(sql`
      select condition_number from sales_condition_record
       where client = ${tenant.client} and condition_type = 'BO01'
         and customer_number = ${customerNumber} and material_number = ${materialNumber}
         and validity_from = '2026-01-01'
    `));
    if (standing.length > 0) return;
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      conditionType: 'BO01',
      customerNumber, materialNumber,
      currency: 'USD', amount: RATE, priceUnit: 1,
      // Priced to the end of November: a sale billed in December falls inside the agreement's year and
      // outside its rate, which is the difference between a promise and a price.
      validityFrom: '2026-01-01', validityTo: '2026-11-30', supersedeStanding: false,
    });
  }

  /** An order of two units, invoiced in full on one plan date. */
  async function place(billingDate: string = BILLING_DATE): Promise<{ orderNumber: string; dateNumber: number }> {
    const placed = await createSalesOrder({
      ...base,
      requestKey: key('order'),
      lines: [{
        lineNumber: undefined, materialNumber: MATERIAL, plant: PLANT,
        orderQuantity: 2, quantityUnit: 'UNT', taxCode: 'T10',
      }],
    }, { authorization: await salesAuthority(tenant.client) });
    await saveBillingPlan({
      client: tenant.client, changedBy: ACTOR, orderNumber: placed.orderNumber, orderLineNumber: 10,
      planType: 'MS', reason: 'Invoiced in full on delivery.',
      dates: [{ billingDate, percentage: 100, billingRule: 'INVOICE' }],
    });
    return { orderNumber: placed.orderNumber, dateNumber: 10 };
  }

  async function bill(orderNumber: string, dateNumber: number, billingDate: string = BILLING_DATE) {
    return createBillingFromPlanDate({
      client: tenant.client, changedBy: ACTOR, orderNumber, orderLineNumber: 10,
      dateNumber, billingDate, requestKey: key('bill'),
    }, { authorization: await salesAuthority(tenant.client) });
  }

  /**
   * The two lines of one journal — account, side, amount — in the order the ledger wrote them, and
   * compared as a set: which line the engine numbers first is its business, and a test that asserted
   * an order would be asserting an implementation detail.
   */
  async function lines(documentNumber: string) {
    const rows = await withTenant(tenant.client, (tx) => tx.select({
      glAccount: journalEntryLine.glAccount,
      debitCredit: journalEntryLine.debitCredit,
      amount: journalEntryLine.amountDocument,
    }).from(journalEntryLine).where(and(
      eq(journalEntryLine.client, tenant.client),
      eq(journalEntryLine.documentNumber, documentNumber),
    )));
    expect(rows).toHaveLength(2);
    return rows;
  }

  /** The conditions a billing document carries, by type. */
  async function conditions(billingNumber: string) {
    return withTenant(tenant.client, (tx) => tx.select({
      conditionType: salesDocumentCondition.conditionType,
      amount: salesDocumentCondition.amount,
      isStatistical: salesDocumentCondition.isStatistical,
      accountKey: salesDocumentCondition.accountKey,
    }).from(salesDocumentCondition).where(and(
      eq(salesDocumentCondition.client, tenant.client),
      eq(salesDocumentCondition.documentCategory, 'BILLING'),
      eq(salesDocumentCondition.documentNumber, billingNumber),
    )));
  }

  it('provides for the rebate a billed sale earned, and charges the customer the whole of it', async () => {
    const agreement = await saveRebateAgreement({ ...promise, requestKey: key('agreement') });
    expect(agreement.status).toBe('OPEN');
    expect(agreement.agreementNumber).toMatch(/RA/);
    await rate();
    const released = await releaseRebateAgreement({
      client: tenant.client, changedBy: ACTOR, agreementNumber: agreement.agreementNumber,
    });
    expect(released.status).toBe('RELEASED');

    const { orderNumber, dateNumber } = await place();
    const billed = await bill(orderNumber, dateNumber);

    // The sale earned part of the promise, and the books hear about it on the day the invoice is
    // posted: five provided for on a basis of fifty.
    expect(billed.rebates).toHaveLength(1);
    expect(billed.rebates?.[0]).toMatchObject({
      agreementNumber: agreement.agreementNumber,
      amount: REBATE,
    });

    // What the customer pays did not move. The rebate is a provision beside the receivable, not a
    // deduction from it: fifty-five gross, and not fifty.
    expect(billed.invoice?.grossAmount).toBe('55.0000');
    expect(billed.billing.grossValue).toBe('55.0000');

    // The provision: the sale is charged with the deduction, and the accrual is credited. Two lines,
    // and they balance.
    const journal = billed.rebates?.[0].journalDocumentNumber ?? '';
    expect(await lines(journal)).toEqual(expect.arrayContaining([
      { glAccount: DEDUCTION, debitCredit: 'S', amount: '5.0000' },
      { glAccount: PROVISION, debitCredit: 'H', amount: '5.0000' },
    ]));

    // And it stands on the document, shown and never charged: what the customer can read today about
    // the money they will be given back months from now.
    const carried = await conditions(billed.billing.billingNumber);
    const rebate = carried.find((row) => row.conditionType === 'BO01');
    // Stored at the four decimals the column carries, which is what every condition on the document is
    // written at: the figure the register reports is the same five, rounded for a reader.
    expect(rebate).toMatchObject({ amount: '5.0000', isStatistical: true, accountKey: 'ERU' });

    // The register is read from the accruals and not kept beside them.
    const register = await rebateRegister(tenant.client, agreement.agreementNumber);
    expect(register.agreement).toMatchObject({
      accrued: REBATE, settled: '0.00', outstanding: REBATE, reversed: '0.00',
    });
    expect(register.accruals).toHaveLength(1);
    expect(register.accruals[0]).toMatchObject({
      billingNumber: billed.billing.billingNumber,
      materialNumber: MATERIAL,
      basisAmount: '50.00',
      rebateAmount: REBATE,
      outstanding: REBATE,
      status: 'ACCRUED',
      journalDocumentNumber: journal,
    });
    // And the document says what it earned, without the reader going looking for the agreement.
    expect(await rebateAccrualsForBilling(tenant.client, billed.billing.billingNumber))
      .toHaveLength(1);
  });

  it('accrues nothing while the agreement is open, outside its dates, or priced by no rate', async () => {
    // Open: a provision nobody authorised is worse than no provision, so an agreement that has not been
    // released provides for nothing however much the customer buys.
    const open = await saveRebateAgreement({ ...promise, requestKey: key('agreement-open') });
    await rate();
    let placed = await place();
    let billed = await bill(placed.orderNumber, placed.dateNumber);
    // Another agreement of this customer does answer for the same sale, which is the point: several
    // promises can stand at once, and each accrues on its own terms.
    expect(billed.rebates?.some((row) => row.agreementNumber === open.agreementNumber) ?? false).toBe(false);
    expect((await rebateRegister(tenant.client, open.agreementNumber)).accruals).toHaveLength(0);

    // Released, but the sale was billed after the agreement's last day.
    const lapsed = await saveRebateAgreement({
      ...promise, validFrom: '2026-01-01', validTo: '2026-10-31', requestKey: key('agreement-lapsed'),
    });
    await releaseRebateAgreement({
      client: tenant.client, changedBy: ACTOR, agreementNumber: lapsed.agreementNumber,
    });
    placed = await place();
    billed = await bill(placed.orderNumber, placed.dateNumber);
    expect(billed.rebates?.some((row) => row.agreementNumber === lapsed.agreementNumber) ?? false).toBe(false);
    expect((await rebateRegister(tenant.client, lapsed.agreementNumber)).accruals).toHaveLength(0);

    // Released and in period, but the sale was billed on a day no rate covers. A promise with no price on
    // the day of the sale is not a rebate of zero — nothing was ever promised about that day.
    const unpriced = await saveRebateAgreement({ ...promise, requestKey: key('agreement-unpriced') });
    await releaseRebateAgreement({
      client: tenant.client, changedBy: ACTOR, agreementNumber: unpriced.agreementNumber,
    });
    placed = await place('2026-12-01');
    billed = await bill(placed.orderNumber, placed.dateNumber, '2026-12-01');
    expect(billed.rebates?.some((row) => row.agreementNumber === unpriced.agreementNumber) ?? false).toBe(false);
    expect((await rebateRegister(tenant.client, unpriced.agreementNumber)).agreement.accrued).toBe('0.00');

    // And the open agreement still stands open, with nothing provided for under it.
    expect((await listRebateAgreements(tenant.client)).find(
      (row) => row.agreementNumber === open.agreementNumber,
    )).toMatchObject({ status: 'OPEN', accrued: '0.00', outstanding: '0.00' });
  });

  it('settles what stands, pays the customer on a credit memo, and releases the provision', async () => {
    const agreement = await saveRebateAgreement({ ...promise, requestKey: key('agreement-settle') });
    await rate();
    await releaseRebateAgreement({
      client: tenant.client, changedBy: ACTOR, agreementNumber: agreement.agreementNumber,
    });
    const { orderNumber, dateNumber } = await place();
    await bill(orderNumber, dateNumber);

    // A partial settlement: two of the five, and the agreement goes on accruing.
    const partial = await settleRebateAgreement({
      client: tenant.client, changedBy: ACTOR, agreementNumber: agreement.agreementNumber,
      settlementDate: SETTLEMENT_DATE, amount: 2, requestKey: key('settle-partial'),
    });
    expect(partial.amount).toBe('2.00');
    expect(partial.settlementType).toBe('PARTIAL');
    expect(partial.documents).toHaveLength(1);
    expect(partial.documents[0]).toMatchObject({ amount: '2.00', orderNumber });

    // The credit memo: a posted billing document of the credit memo type, and a receivable of its own
    // that credits the customer's account.
    const memo = partial.documents[0];
    const [credited] = await withTenant(tenant.client, (tx) => tx.select({
      documentType: billingDocument.documentType,
      status: billingDocument.status,
      customerInvoiceNumber: billingDocument.customerInvoiceNumber,
      grossValue: billingDocument.grossValue,
      orderNumber: billingDocument.orderNumber,
    }).from(billingDocument).where(and(
      eq(billingDocument.client, tenant.client),
      eq(billingDocument.billingNumber, memo.billingNumber),
    )));
    expect(credited).toMatchObject({
      documentType: 'B1', status: 'POSTED', grossValue: '2.0000',
      customerInvoiceNumber: memo.invoiceNumber, orderNumber,
    });
    // The provision is released and the customer is credited: the money goes back from the account it
    // was provided for in, and not from revenue.
    expect(await lines(memo.journalDocumentNumber)).toEqual(expect.arrayContaining([
      { glAccount: PROVISION, debitCredit: 'S', amount: '2.0000' },
      { glAccount: RECON, debitCredit: 'H', amount: '2.0000' },
    ]));

    let register = await rebateRegister(tenant.client, agreement.agreementNumber);
    expect(register.agreement).toMatchObject({
      accrued: REBATE, settled: '2.00', outstanding: '3.00', status: 'RELEASED',
    });
    expect(register.accruals[0]).toMatchObject({
      settledAmount: '2.00', outstanding: '3.00', status: 'ACCRUED',
      settlementNumber: memo.billingNumber,
    });

    // And the rest, which is the final settlement: the agreement is settled for good.
    const final = await settleRebateAgreement({
      client: tenant.client, changedBy: ACTOR, agreementNumber: agreement.agreementNumber,
      settlementDate: SETTLEMENT_DATE, requestKey: key('settle-final'),
    });
    expect(final.amount).toBe('3.00');
    expect(final.settlementType).toBe('FINAL');
    register = await rebateRegister(tenant.client, agreement.agreementNumber);
    expect(register.agreement).toMatchObject({
      accrued: REBATE, settled: REBATE, outstanding: '0.00', status: 'SETTLED',
    });
    expect(register.accruals[0]).toMatchObject({ settledAmount: REBATE, status: 'SETTLED' });

    // Settling an agreement that has paid out everything it earned is refused, and says so.
    await expect(settleRebateAgreement({
      client: tenant.client, changedBy: ACTOR, agreementNumber: agreement.agreementNumber,
      settlementDate: SETTLEMENT_DATE, requestKey: key('settle-again'),
    })).rejects.toThrow(/already settled/);
  });

  it('a cancelled billing document takes its accrual with it, and what was paid out stands', async () => {
    const agreement = await saveRebateAgreement({ ...promise, requestKey: key('agreement-cancel') });
    await rate();
    await releaseRebateAgreement({
      client: tenant.client, changedBy: ACTOR, agreementNumber: agreement.agreementNumber,
    });
    const { orderNumber, dateNumber } = await place();
    const billed = await bill(orderNumber, dateNumber);
    expect(billed.rebates?.[0].amount).toBe(REBATE);

    // Two of the five are paid out before the sale is undone.
    const paid = await settleRebateAgreement({
      client: tenant.client, changedBy: ACTOR, agreementNumber: agreement.agreementNumber,
      settlementDate: '2026-12-01', amount: 2, requestKey: key('settle-before-cancel'),
    });
    expect(paid.amount).toBe('2.00');

    await cancelBillingDocument({
      client: tenant.client, changedBy: ACTOR, billingNumber: billed.billing.billingNumber,
      postingDate: '2026-12-20', reason: 'The goods came back.', requestKey: key('cancel'),
    });

    // What was provided for and not yet paid out goes with the sale — three, not five — because a
    // provision built on a sale that was undone is an overstatement that never corrects itself.
    const register = await rebateRegister(tenant.client, agreement.agreementNumber);
    expect(register.agreement).toMatchObject({
      accrued: '0.00', settled: '2.00', outstanding: '0.00', reversed: REBATE,
    });
    expect(register.accruals[0]).toMatchObject({
      rebateAmount: REBATE, settledAmount: '2.00', outstanding: '0.00', status: 'REVERSED',
    });

    // The reversal is the mirror of the accrual: the provision released, the deduction given back, for
    // the three that had not been paid out.
    const reversed = register.accruals[0].reversalJournalDocumentNumber ?? '';
    expect(await lines(reversed)).toEqual(expect.arrayContaining([
      { glAccount: PROVISION, debitCredit: 'S', amount: '3.0000' },
      { glAccount: DEDUCTION, debitCredit: 'H', amount: '3.0000' },
    ]));
    // And the credit memo that paid the two stands where it is: undoing it is a separate act somebody
    // has to take.
    expect(register.accruals[0].settlementNumber).toBe(paid.documents[0].billingNumber);
  });

  it('refuses what a promise cannot say, and names what is missing', async () => {
    // An agreement that ends before it begins covers no days at all.
    await expect(saveRebateAgreement({
      ...promise, validFrom: '2026-06-30', validTo: '2026-01-01', requestKey: key('bad-dates'),
    })).rejects.toThrow(/covers no days at all/);

    // A promise made to nobody: the partner has to stand, and has to be a customer.
    await expect(saveRebateAgreement({
      ...promise, customerNumber: 'SD9251NOBODY', requestKey: key('bad-partner'),
    })).rejects.toThrow(/does not stand for this tenant/);

    // A rebate agreement is priced by a rebate, and a price is not one.
    await expect(saveRebateAgreement({
      ...promise, conditionType: 'PR00', requestKey: key('bad-type'),
    })).rejects.toThrow(/not a rebate/);

    // Settling an agreement nobody released: nothing has accrued under it, so nothing is owed.
    const unreleased = await saveRebateAgreement({ ...promise, requestKey: key('unreleased') });
    await expect(settleRebateAgreement({
      client: tenant.client, changedBy: ACTOR, agreementNumber: unreleased.agreementNumber,
      settlementDate: SETTLEMENT_DATE, requestKey: key('settle-unreleased'),
    })).rejects.toThrow(/has not been released/);

    // Settling more than accrued: a promise is not a blank cheque.
    const agreement = await saveRebateAgreement({ ...promise, requestKey: key('agreement-oversettle') });
    await rate();
    await releaseRebateAgreement({
      client: tenant.client, changedBy: ACTOR, agreementNumber: agreement.agreementNumber,
    });
    await expect(settleRebateAgreement({
      client: tenant.client, changedBy: ACTOR, agreementNumber: agreement.agreementNumber,
      settlementDate: SETTLEMENT_DATE, amount: 90, requestKey: key('settle-too-much'),
    })).rejects.toThrow(/Nothing has accrued/);

    const { orderNumber, dateNumber } = await place();
    await bill(orderNumber, dateNumber);
    await expect(settleRebateAgreement({
      client: tenant.client, changedBy: ACTOR, agreementNumber: agreement.agreementNumber,
      settlementDate: SETTLEMENT_DATE, amount: 12.5, requestKey: key('settle-over'),
    })).rejects.toThrow(/5\.00 USD standing, and 12\.50 was asked for/);

    // And what has accrued is history: the terms cannot be rewritten underneath money that has already
    // been provided for.
    await expect(saveRebateAgreement({
      client: tenant.client, changedBy: ACTOR, agreementNumber: agreement.agreementNumber,
      customerNumber: CUSTOMER, salesOrg: '2000', distributionChannel: '10', division: '01',
      currency: 'EUR', validFrom: '2026-01-01', validTo: '2026-12-31', conditionType: 'BO01',
    })).rejects.toThrow(/cannot be changed underneath it/);
    // The day it runs to can still be changed, which is the one thing that is still a promise about
    // days to come rather than about money already provided for.
    const moved = await saveRebateAgreement({
      client: tenant.client, changedBy: ACTOR, agreementNumber: agreement.agreementNumber,
      customerNumber: CUSTOMER, salesOrg: '1000', distributionChannel: '10', division: '01',
      currency: 'USD', validFrom: '2026-01-01', validTo: '2027-12-31', conditionType: 'BO01',
    });
    expect(moved.validTo).toBe('2027-12-31');
  });
});
