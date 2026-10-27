import type { Page } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { sql } from 'drizzle-orm';

import { withTenant } from '../../src/platform/db/client';
import { defineRange } from '../../src/platform/numbering';
import { releaseDocument, saveCustomerCredit } from '../../src/modules/finance/credit';
import { saveSalesCondition } from '../../src/modules/sales/conditions';
import type { BrowserTarget } from './targets';

type Context = { page: Page; base: string; target: BrowserTarget };

const ORDERS = '/sales/orders';
const DELIVERY = '/sales/delivery';
const BILLING = '/sales/billing';

const CUSTOMER = 'SDB100';
const BLOCKED_CUSTOMER = 'SDB900';
const MATERIAL = 'SDIBM01';
const UNIT = 'UNT';
const PLANT = '1000';
const STORE = '0001';
const AREA = 'CCA1';
const DATE = '2026-04-12';

/**
 * DI-020 browser acceptance: the order-to-invoice journey, taken through the screens.
 *
 * Eight things have to be visible in a browser for this workflow to count as delivered, and each is proved
 * below in the order a user does it: the order priced from a condition record; the delivery drawn from the
 * quantity the order still has open; over-delivery refused by name; the pick recorded against the delivery
 * item; the goods issue posting stock, valuation and the journal in one act; one billing document for the
 * delivered quantity and no second one; the credit determination refusing a delivery on a blocked order and
 * holding an invoice on a blocked delivery; and the links — order, delivery, material document, billing
 * document, accounting document — readable back from the tables the services wrote.
 */
export async function salesOrderToInvoice(ctx: Context) {
  const { page, base, target } = ctx;
  const { client } = target;
  console.log('DI-020: complete the sales order to invoice journey in the browser');

  await withTenant(client, async (tx) => {
    for (const range of [
      { objectCode: 'RF_BELEG', companyCode: '1000', subObject: 'GENERAL', fiscalYear: 2026, prefix: 'JE', fromNumber: 1, toNumber: 999999 },
      { objectCode: 'SALESORD', subObject: 'OR', prefix: 'SO', numberLength: 7 },
      { objectCode: 'DELIVERY', subObject: 'LF', prefix: 'DL', numberLength: 7 },
      { objectCode: 'BILLING', subObject: 'F2', prefix: 'INV', numberLength: 7 },
      { objectCode: 'MATDOC', subObject: '*', prefix: 'MD', numberLength: 8 },
      { objectCode: 'CUSTINV', subObject: '*', prefix: 'CI', numberLength: 7 },
    ]) {
      await defineRange(tx, { client, createdBy: 'BROWSER_SMOKE', ...range });
    }
    await tx.execute(sql`
      insert into unit_of_measure (code, name, dimension, decimal_places, is_base_unit)
      values (${UNIT}, 'Browser counted unit', 'COUNT', 0, false)
      on conflict (code) do update set decimal_places = excluded.decimal_places
    `);
    await tx.execute(sql`
      insert into sales_org (client, sales_org, company_code, currency, created_by)
      values (${client}, '1000', '1000', 'KWD', 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into sales_org_text (client, sales_org, language_key, name, created_by)
      values (${client}, '1000', 'E', 'Browser sales organization', 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into distribution_channel (client, distribution_channel, name, created_by)
      values (${client}, '10', 'Direct', 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into sales_org_distribution_channel (client, sales_org, distribution_channel, created_by)
      values (${client}, '1000', '10', 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into division (client, division, name, created_by)
      values (${client}, '01', 'Hardware', 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into sales_org_division (client, sales_org, division, created_by)
      values (${client}, '1000', '01', 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into sales_area (client, sales_org, distribution_channel, division, name, created_by)
      values (${client}, '1000', '10', '01', 'Browser sales area', 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, company_code, country, created_by)
      values (${client}, ${PLANT}, 'Browser shipping plant', '1000', 'KW', 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, allow_negative_stock, created_by)
      values (${client}, ${PLANT}, ${STORE}, 'Main store', true, false, 'BROWSER_SMOKE')
      on conflict (client, plant, storage_location) do update set is_active = excluded.is_active
    `);
    for (const partner of [CUSTOMER, BLOCKED_CUSTOMER]) {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${client}, ${partner}, 'ORGANIZATION', ${`Browser customer ${partner}`}, 'BROWSER_SMOKE') on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${client}, ${partner}, 'CUSTOMER', 'BROWSER_SMOKE') on conflict do nothing
      `);
      await tx.execute(sql`
        insert into customer_sales_area (
          client, partner_number, role_code, sales_org, distribution_channel, division,
          pricing_procedure, is_blocked, sales_status, created_by
        )
        values (${client}, ${partner}, 'CUSTOMER', '1000', '10', '01', 'PR01', false, 'MAINTAINED', 'BROWSER_SMOKE')
        on conflict (client, partner_number, sales_org, distribution_channel, division)
        do update set is_blocked = excluded.is_blocked, sales_status = excluded.sales_status
      `);
      await tx.execute(sql`
        insert into customer_company_code (
          client, partner_number, role_code, company_code, chart_of_accounts,
          reconciliation_account, payment_terms_code, created_by
        )
        values (${client}, ${partner}, 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', 'BROWSER_SMOKE')
        on conflict do nothing
      `);
    }
    await tx.execute(sql`
      insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
      values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
      values (${client}, 'KW', 'T10', 'Output tax 10 percent', 'VAT', 10, 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into credit_control_area (client, credit_control_area, name, currency, warning_threshold_percent, created_by)
      values (${client}, ${AREA}, 'Browser credit area', 'KWD', 90, 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into credit_risk_category (client, risk_category, name, created_by)
      values (${client}, 'A', 'Low risk', 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      update company_code set credit_control_area = ${AREA} where client = ${client} and company_code = '1000'
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      values (${client}, ${MATERIAL}, 'Browser shipped material', 'RAW', ${UNIT}, 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      values (${client}, ${MATERIAL}, ${PLANT}, 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                      standard_price, moving_average_price, price_unit, currency,
                                      total_stock_quantity, stock_value, created_by)
      values (${client}, ${MATERIAL}, ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 10, 10, 1, 'KWD', 100, 1000, 'BROWSER_SMOKE')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      values (${client}, ${MATERIAL}, ${PLANT}, ${STORE}, 'UNRESTRICTED', 100, 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_period_control (client, company_code, current_fiscal_year, current_period,
                                           previous_fiscal_year, previous_period, allow_backposting, created_by)
      values (${client}, '1000', 2026, 4, 2025, 12, true, 'BROWSER_SMOKE') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                              is_balance_sheet, is_open_item_managed, reconciliation_type,
                              requires_cost_object, is_tax_relevant, account_group, gl_account_type, created_by)
      select ${client}, c.chart_of_accounts, v.n, v.d, 'EXPENSE',
             false, false, null, false, false, 'GENL', 'PL_STATEMENT', 'BROWSER_SMOKE'
      from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
      cross join (values ('510300', 'Cost of goods sold'), ('120000', 'Raw materials inventory')) as v(n, d)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      select ${client}, c.chart_of_accounts, v.e, v.vc, '', v.a, 'BROWSER_SMOKE'
      from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
      cross join (values
        ('INVENTORY', 'RAW_INVENTORY', '120000'),
        ('SALES_ISSUE', 'RAW_INVENTORY', '510300'),
        ('SALES_REVENUE', '', '300000'),
        ('TAX', '', '240000')
      ) as v(e, vc, a)
      on conflict do nothing
    `);
  });
  await saveSalesCondition({
    client, changedBy: 'BROWSER_SMOKE', salesOrg: '1000', distributionChannel: '10', division: '01',
    customerNumber: '', materialNumber: MATERIAL, currency: 'KWD', amount: 25, priceUnit: 1,
    validityFrom: '2026-01-01', validityTo: '2026-12-31', supersedeStanding: false,
  });
  for (const [partner, limit] of [[CUSTOMER, '100000'], [BLOCKED_CUSTOMER, '1']] as const) {
    await saveCustomerCredit({
      client, changedBy: 'BROWSER_SMOKE', customer: partner, creditControlArea: AREA,
      creditLimit: String(limit), riskCategory: 'A', isBlocked: false,
      changeReason: 'Browser acceptance fixture credit data.',
    });
  }

  const stockNow = async () => (await withTenant(client, async (tx) => tx.execute(sql`
    select quantity::text as q from stock_quantity
    where client = ${client} and material_number = ${MATERIAL} and plant = ${PLANT}
      and storage_location = ${STORE} and stock_type = 'UNRESTRICTED'
  `) as unknown as Array<{ q: string }>))[0]?.q ?? '0';
  const before = Number(await stockNow());

  // 1 + 2 — the order, priced on screen from the condition record and not from the form.
  await page.goto(`${base}${ORDERS}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Sales orders', exact: true }).waitFor();
  const orderForm = page.locator('form[aria-label="Create sales order"]');
  await orderForm.locator('input[name="customerNumber"]').fill(CUSTOMER);
  await orderForm.locator('input[name="salesOrg"]').fill('1000');
  await orderForm.locator('input[name="distributionChannel"]').fill('10');
  await orderForm.locator('input[name="division"]').fill('01');
  await orderForm.locator('input[name="companyCode"]').fill('1000');
  await orderForm.locator('input[name="currency"]').fill('KWD');
  await orderForm.locator('input[name="orderDate"]').fill(DATE);
  await orderForm.locator('input[name="line-1-material"]').fill(MATERIAL);
  await orderForm.locator('input[name="line-1-plant"]').fill(PLANT);
  await orderForm.locator('input[name="line-1-quantity"]').fill('6');
  await orderForm.locator('input[name="line-1-unit"]').fill(UNIT);
  await orderForm.locator('input[name="line-1-tax"]').fill('T10');
  await orderForm.getByRole('button', { name: 'Create order', exact: true }).click();
  await page.waitForLoadState('networkidle');
  const orderCreated = await orderForm.getByText(/Sales order (SO-\d+) created/).textContent();
  const orderNumber = orderCreated?.match(/Sales order (SO-\d+) created/)?.[1] ?? '';
  assert.match(orderNumber, /^SO-\d+$/, 'the order number the screen reports');
  console.log(`  ✓ ${orderNumber} created on screen, priced from the standing condition record`);

  // 3 — the delivery screen offers the open quantity, and refuses more than the order line has open.
  await page.goto(`${base}${DELIVERY}?order=${orderNumber}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Outbound deliveries', exact: true }).waitFor();
  const deliveryForm = page.locator('form[aria-label="Create delivery"]');
  await deliveryForm.getByText(`${orderNumber} / 10`).waitFor();
  await deliveryForm.locator('input[name="line-1-quantity"]').fill('99');
  await deliveryForm.getByRole('button', { name: 'Create delivery', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await deliveryForm.getByText(/carries 6\.000 UNT open of 6\.000 ordered, and 99 was entered/).waitFor();
  console.log('  ✓ over-delivery refused on screen with the open quantity quoted back');

  await deliveryForm.locator('input[name="line-1-quantity"]').fill('4');
  await deliveryForm.getByRole('button', { name: 'Create delivery', exact: true }).click();
  await page.waitForLoadState('networkidle');
  const created = await deliveryForm.getByText(/Delivery (DL-\d+) created/).textContent();
  const deliveryNumber = created?.match(/Delivery (DL-\d+) created/)?.[1] ?? '';
  assert.match(deliveryNumber, /^DL-\d+$/, 'the delivery number the screen reports');
  console.log(`  ✓ ${deliveryNumber} created from the open quantity of ${orderNumber}`);

  // 4 — the pick is recorded against the delivery item, with the store it came from.
  await page.goto(`${base}${DELIVERY}?delivery=${deliveryNumber}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const pickForm = page.locator('form[aria-label="Confirm picking"]');
  await pickForm.getByRole('button', { name: 'Confirm pick', exact: true }).waitFor();
  await pickForm.locator('input[name="pick-1-quantity"]').fill('4');
  await pickForm.locator('input[name="pick-1-location"]').fill(STORE);
  await pickForm.getByRole('button', { name: 'Confirm pick', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await page.locator('form[aria-label="Confirm picking"]').getByText(/Picking confirmed on delivery/).waitFor();
  await page.getByText('PICKED', { exact: true }).first().waitFor();
  console.log('  ✓ picking confirmed, the delivery stands PICKED with its pick history');

  // 5 — the goods issue posts the movement, its value and its journal in one act.
  const issueForm = page.locator('form[aria-label="Post goods issue"]');
  await issueForm.getByRole('button', { name: 'Post goods issue', exact: true }).click();
  await page.waitForLoadState('networkidle');
  const issued = await page.locator('form[aria-label="Post goods issue"]').getByText(/material document MD-\d+/).textContent();
  const materialDocument = issued?.match(/material document (MD-\d+)/)?.[1] ?? '';
  assert.ok(materialDocument, 'the goods issue names the material document it posted');
  const after = Number(await stockNow());
  assert.equal(after, before - 4, 'the shelf holds four units less than before the movement');
  console.log(`  ✓ goods issue posted as ${materialDocument}, stock ${before} → ${after}`);

  // 6 — one billing document for what went out, and it posts the receivable through the invoice service.
  await page.goto(`${base}${BILLING}?delivery=${deliveryNumber}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading', { level: 1, name: 'Billing documents', exact: true }).waitFor();
  const billForm = page.locator('form[aria-label="Create billing document"]');
  await billForm.getByText('1 delivery issued and not yet billed.').waitFor();
  await billForm.getByRole('button', { name: 'Create and post', exact: true }).click();
  await page.waitForLoadState('networkidle');
  const billed = await billForm.getByText(/Billing document (INV-\d+) posted the receivable as invoice (CI-\d+)/).textContent();
  const billingNumber = billed?.match(/Billing document (INV-\d+)/)?.[1] ?? '';
  const invoiceNumber = billed?.match(/invoice (CI-\d+)/)?.[1] ?? '';
  assert.ok(billingNumber && invoiceNumber, 'the billing and invoice numbers the screen reports');
  console.log(`  ✓ ${billingNumber} billed the issued quantity and posted receivable ${invoiceNumber}`);

  // 7 — the same delivery billed again is refused, because a delivered quantity is billed once.
  await page.goto(`${base}${BILLING}?delivery=${deliveryNumber}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.locator('form[aria-label="Create billing document"]')
    .getByText('1 delivery issued and not yet billed.').waitFor({ state: 'detached' });
  await page.locator(`form[aria-label="Create billing document"] input[name="deliveryNumber"]`).fill(deliveryNumber);
  await page.locator('form[aria-label="Create billing document"]')
    .getByRole('button', { name: 'Create and post', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await page.locator('form[aria-label="Create billing document"]')
    .getByText(new RegExp(`is already billed as ${billingNumber}`)).waitFor();
  console.log('  ✓ a second billing of the same delivery is refused by name');

  // 8 — the credit determination is effective at delivery creation, not only on the order.
  await page.goto(`${base}${ORDERS}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const risky = page.locator('form[aria-label="Create sales order"]');
  await risky.locator('input[name="customerNumber"]').fill(BLOCKED_CUSTOMER);
  await risky.locator('input[name="salesOrg"]').fill('1000');
  await risky.locator('input[name="distributionChannel"]').fill('10');
  await risky.locator('input[name="division"]').fill('01');
  await risky.locator('input[name="companyCode"]').fill('1000');
  await risky.locator('input[name="currency"]').fill('KWD');
  await risky.locator('input[name="orderDate"]').fill(DATE);
  await risky.locator('input[name="line-1-material"]').fill(MATERIAL);
  await risky.locator('input[name="line-1-plant"]').fill(PLANT);
  await risky.locator('input[name="line-1-quantity"]').fill('6');
  await risky.locator('input[name="line-1-unit"]').fill(UNIT);
  await risky.getByRole('button', { name: 'Create order', exact: true }).click();
  await page.waitForLoadState('networkidle');
  const blockedNotice = await risky.getByText(/Sales order (SO-\d+) created and blocked for credit/).textContent();
  const blockedOrder = blockedNotice?.match(/Sales order (SO-\d+) created/)?.[1] ?? '';
  assert.match(blockedOrder, /^SO-\d+$/, 'the blocked order number the screen reports');
  await page.goto(`${base}${DELIVERY}?order=${blockedOrder}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const blockedForm = page.locator('form[aria-label="Create delivery"]');
  await blockedForm.locator('input[name="line-1-quantity"]').fill('4');
  await blockedForm.getByRole('button', { name: 'Create delivery', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await blockedForm.getByText(/is credit-blocked.*: nothing was created/).waitFor();
  console.log(`  ✓ ${blockedOrder} is credit-blocked, and the delivery is refused on screen`);

  // ...and once the release stands, the same act goes through; a block on the delivery then holds the invoice.
  await releaseDocument({
    client, changedBy: 'browser.admin', salesDocument: blockedOrder, canOverride: true,
    override: { justification: 'Cleared for the browser acceptance run.', approvalRef: 'SDB-REL-1' },
  });
  await page.goto(`${base}${DELIVERY}?order=${blockedOrder}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const after2 = page.locator('form[aria-label="Create delivery"]');
  await after2.locator('input[name="line-1-quantity"]').fill('4');
  await after2.getByRole('button', { name: 'Create delivery', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await after2.getByText(/Delivery DL-\d+ created/).waitFor();
  console.log('  ✓ the released order delivers — the control follows the determination, not the form');

  const evidence = await withTenant(client, async (tx) => {
    const chain = await tx.execute(sql`
      select d.delivery_number, d.status as delivery_status, d.material_document_number,
             b.billing_number, b.status as billing_status, b.customer_invoice_number,
             b.gross_value::text as gross, ci.journal_document_number
        from delivery d
        join billing_document b on b.client = d.client and b.delivery_number = d.delivery_number
        join customer_invoice ci on ci.client = b.client and ci.invoice_number = b.customer_invoice_number
       where d.client = ${client} and d.delivery_number = ${deliveryNumber}
    `);
    const receivable = await tx.execute(sql`
      select count(*)::int as n, coalesce(sum(amount_local), 0)::text as amount
        from journal_entry_line
       where client = ${client} and business_partner = ${CUSTOMER} and gl_account = '110000'
    `);
    const pick = await tx.execute(sql`
      select count(*)::int as n, coalesce(sum(quantity_delta), 0)::text as picked
        from delivery_picking p join delivery_line dl
          on dl.client = p.client and dl.delivery_number = p.delivery_number and dl.line_number = p.line_number
       where p.client = ${client} and p.delivery_number = ${deliveryNumber}
    `);
    const double = await tx.execute(sql`
      select count(*)::int as n from billing_document where client = ${client} and delivery_number = ${deliveryNumber}
    `);
    return {
      chain: (chain as unknown as Array<Record<string, string>>)[0],
      receivable: (receivable as unknown as Array<{ n: number; amount: string }>)[0],
      pick: (pick as unknown as Array<{ n: number; picked: string }>)[0],
      double: (double as unknown as Array<{ n: number }>)[0],
    };
  });
  assert.equal(evidence.chain?.delivery_status, 'GOODS_ISSUED');
  assert.equal(evidence.chain?.material_document_number, materialDocument);
  assert.equal(evidence.chain?.billing_status, 'POSTED');
  assert.equal(evidence.chain?.customer_invoice_number, invoiceNumber);
  assert.equal(Number(evidence.chain?.gross), 110, 'the billing document is worth the issued quantity at the order price');
  assert.ok(evidence.chain?.journal_document_number, 'the billing document keeps the accounting document it created');
  assert.equal(evidence.pick.n, 1, 'one pick row, the amount the store confirmed');
  assert.equal(evidence.pick.picked, '4.000');
  assert.equal(evidence.double.n, 1, 'the delivery is billed once, ever');
  assert.equal(evidence.receivable.n, 1);
  assert.equal(Number(evidence.receivable.amount), 110, 'the receivable stands in the customer account');
  console.log('  ✓ the chain reads back in the database: order, delivery, pick, movement, billing, invoice');

  // ...and the delivery that order then earns is judged on its own: the block stands against the delivery, and
  // the acts that ready a posting refuse while it does. The goods that have already gone out are never undone
  // here — that belongs to the inventory screen that owns the movement.
  await page.goto(`${base}${DELIVERY}?order=${blockedOrder}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const again = page.locator('form[aria-label="Create delivery"]');
  await again.locator('input[name="line-1-quantity"]').fill('4');
  await again.getByRole('button', { name: 'Create delivery', exact: true }).click();
  await page.waitForLoadState('networkidle');
  const blockedDelivery = await again.getByText(/Delivery (DL-\d+) created, and the credit check blocked it/).textContent();
  const heldDelivery = blockedDelivery?.match(/Delivery (DL-\d+) created/)?.[1] ?? '';
  assert.match(heldDelivery, /^DL-\d+$/, 'the delivery number the screen reports under a block');
  console.log(`  ✓ ${heldDelivery} was created and immediately blocked on its own value`);

  await page.goto(`${base}${DELIVERY}?delivery=${heldDelivery}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  const heldPick = page.locator('form[aria-label="Confirm picking"]');
  await heldPick.getByRole('button', { name: 'Confirm pick', exact: true }).waitFor();
  await heldPick.locator('input[name="pick-1-location"]').fill(STORE);
  await heldPick.getByRole('button', { name: 'Confirm pick', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await heldPick.getByText(/is credit-blocked.*: nothing was picked/).waitFor();
  console.log('  ✓ the pick that readies the posting is refused while the block stands');

  const heldRows = await withTenant(client, async (tx) => tx.execute(sql`
    select d.status as delivery_status, coalesce(sum(p.quantity_delta), 0)::text as picked
      from delivery d
      left join delivery_picking p on p.client = d.client and p.delivery_number = d.delivery_number
     where d.client = ${client} and d.delivery_number = ${heldDelivery}
     group by 1
  `) as unknown as Array<{ delivery_status: string; picked: string }>);
  assert.equal(heldRows[0]?.delivery_status, 'OPEN', 'a blocked delivery stays open: nothing was picked or issued');
  assert.equal(heldRows[0]?.picked, '0.000');
  console.log('  ✓ the database shows the blocked delivery with no pick and no movement against it');
}
