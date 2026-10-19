/**
 * Cairn ERP — walkthrough seed (standalone; not run by build, migrate or seed).
 *
 * Creates a fictional Indian company with an April–March fiscal year,
 * a complete standing configuration + master data, and real transaction
 * history posted through the application's own services, so every
 * implemented transaction/report can be used immediately after login
 * without entering any master data first.
 *
 * This file lives in the repository root. In the Docker deployment the
 * operations image bakes it in (COPY . .) and docker-compose.yml also
 * mounts the host copy over /app/walkthrough-seed.ts for the migrate
 * service, so the host file is what runs — no rebuild needed to refresh it.
 *
 * DOCKER (the normal path, after `docker compose up -d` has completed
 * and the migrate service has finished on the fresh database):
 *
 *   git pull   # walkthrough-seed.ts must stand next to docker-compose.yml
 *   docker compose run --rm migrate npx tsx walkthrough-seed.ts
 *   docker compose run --rm migrate npx tsx walkthrough-seed.ts --client=W100
 *
 * If the run answers "Cannot find module '/app/walkthrough-seed.ts'",
 * the host file or the operations image predates this seed: confirm
 * `ls walkthrough-seed.ts` succeeds beside docker-compose.yml, then
 * bake the current tree into the image and run again:
 *
 *   docker compose build migrate
 *   docker compose run --rm migrate npx tsx walkthrough-seed.ts
 *
 * Do NOT run it in the `app` container (runtime-only image, no source or
 * tsx) and do NOT source .env.local inside a container — Compose already
 * injects the correct DATABASE_URL for the operations image.
 *
 * BARE METAL (from the repository root of a fresh checkout):
 *
 *   npm run db:migrate && npm run seed:reference && npm run seed
 *   set -a; . ./.env.local; set +a
 *   npx tsx walkthrough-seed.ts                      # default tenant key 0100
 *
 * Login afterwards: tenant <client key>, user `admin`, password printed
 * at the end of the run (and defined as ADMIN_PASSWORD below).
 * Re-running against the same tenant key is refused safely.
 */
import { sql } from 'drizzle-orm';

import { withTenant, closeDb } from './src/platform/db/client';
import { createTenant } from './src/platform/tenancy';
import { applyStandardStructure } from './src/platform/tenancy/standard-structure';
import { maintainNumberRange } from './src/modules/foundation/number-ranges';
import { defineRange } from './src/platform/numbering';
import { postJournalEntry } from './src/platform/posting';
import { createOrder } from './src/modules/purchasing/orders';
import { postGoodsReceipt } from './src/modules/inventory/goods-receipt';
import { postSupplierInvoice } from './src/modules/purchasing/invoice-verification';
import { initializeMaterialPeriodControl, getMaterialPeriodControl, shiftMaterialPeriod } from './src/modules/inventory/material-period-control';
import { createPaymentRun, generateProposal, executePaymentRun } from './src/modules/finance/payment-run';
import { postCustomerInvoice } from './src/modules/finance/customer-invoice';
import { postIncomingPayment } from './src/modules/finance/incoming-payment';
import { calculateCashflow } from './src/modules/finance/cash-flow';

const ACTOR = 'WALKTHROUGH';
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'Meridian-2026-admin';
const COMPANY = '1000';
const COMPANY_NAME = 'Meridian Auto Components Pvt Ltd';

const argClient = process.argv.find((a) => a.startsWith('--client='))?.split('=')[1];
const CLIENT = (argClient ?? '0100').toUpperCase();

/** April–March fiscal calendar: FY named by its April start year. */
function fyPeriod(isoDate: string): { fiscalYear: number; period: number } {
  const [y, m] = isoDate.split('-').map(Number) as [number, number];
  return m >= 4 ? { fiscalYear: y, period: m - 3 } : { fiscalYear: y - 1, period: m + 9 };
}

function warn(step: string, error: unknown) {
  console.log(`  ! ${step} skipped: ${error instanceof Error ? error.message : String(error)}`);
}

async function main() {
  console.log(`Walkthrough seed → tenant ${CLIENT}`);
  const created = await createTenant({
    clientKey: CLIENT,
    name: COMPANY_NAME,
    legalName: COMPANY_NAME,
    country: 'IN',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    creationType: 'standard',
    administrator: {
      username: ADMIN_USERNAME,
      fullName: 'Walkthrough Administrator',
      email: 'admin@meridian.example',
      password: ADMIN_PASSWORD,
    },
    createdBy: ACTOR,
  });
  console.log(`  tenant created (admin: ${created.administratorUsername}, accounts: ${created.accountsCreated ?? '?'})`);

  await applyStandardStructure({ client: CLIENT, companyCode: COMPANY, companyName: COMPANY_NAME, country: 'IN', currency: 'INR', changedBy: ACTOR });
  console.log('  enterprise structure applied (plant / purchasing org / sales org)');

  /* Resolve the standing accounts the package created. */
  const standing = await withTenant(CLIENT, async (tx) => {
    const rows = await tx.execute(sql`
      select account_number, account_type, reconciliation_type, name from gl_account
      where client = ${CLIENT} and chart_of_accounts = 'CA01' order by account_number
    `) as unknown as Array<{ account_number: string; account_type: string; reconciliation_type: string | null; name: string }>;
    const first = (pred: (r: (typeof rows)[number]) => boolean) => rows.find(pred)?.account_number ?? '';
    return {
      bank: first((r) => r.name.toLowerCase().includes('bank')),
      recv: first((r) => r.reconciliation_type === 'CUSTOMERS'),
      pay: first((r) => r.reconciliation_type === 'VENDORS'),
      revenue: first((r) => r.account_type === 'REVENUE'),
      equity: first((r) => r.account_type === 'EQUITY'),
      inventory: '120000',
      grIr: '210000',
    };
  });
  console.log(`  standing accounts: bank=${standing.bank} recv=${standing.recv} pay=${standing.pay} revenue=${standing.revenue} equity=${standing.equity}`);

  await withTenant(CLIENT, async (tx) => {
    /* April–March fiscal year variant V3 + assignment to the company. */
    await tx.execute(sql`
      insert into fiscal_year_variant (client, variant, name, is_calendar_year, regular_periods, special_periods, is_year_dependent, is_active, created_by)
      values (${CLIENT}, 'V3', 'April-March (India)', false, 12, 0, false, true, ${ACTOR}) on conflict do nothing
    `);
    const periods: Array<[number, number, number, number]> = [
      [1, 4, 30, 0], [2, 5, 31, 0], [3, 6, 30, 0], [4, 7, 31, 0], [5, 8, 31, 0], [6, 9, 30, 0],
      [7, 10, 31, 0], [8, 11, 30, 0], [9, 12, 31, 0], [10, 1, 31, 1], [11, 2, 31, 1], [12, 3, 31, 1],
    ];
    for (const [period, month, day, shift] of periods) {
      await tx.execute(sql`
        insert into fiscal_year_period (client, variant, calendar_year, period, period_type, month, day, year_shift, created_by)
        values (${CLIENT}, 'V3', 0, ${period}, 'REGULAR', ${month}, ${day}, ${shift}, ${ACTOR}) on conflict do nothing
      `);
    }
    await tx.execute(sql`
      update company_code set name = ${COMPANY_NAME}, fiscal_year_variant = 'V3',
        city = 'Pune', tax_registration_number = '27AAQCM0000A1Z5'
      where client = ${CLIENT} and company_code = ${COMPANY}
    `);
    await tx.execute(sql`update client_settings set fiscal_year_variant = 'V3' where client = ${CLIENT}`);
    await tx.execute(sql`
      update chart_of_accounts set name = 'Meridian Chart of Accounts (sample)'
      where client = ${CLIENT} and chart_of_accounts = 'CA01'
    `);

    /* House bank on the bank G/L account — the cash-flow statement's cash. */
    await tx.execute(sql`
      insert into bank_master (bank_country, bank_key, name, created_by)
      values ('IN', 'HDFC01', 'Meridian Bank (fictional)', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into house_bank (client, company_code, house_bank_key, bank_country, bank_key, created_by)
      values (${CLIENT}, ${COMPANY}, 'HB01', 'IN', 'HDFC01', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bank_account (client, company_code, house_bank_key, account_id, account_number, currency, gl_account, created_by)
      values (${CLIENT}, ${COMPANY}, 'HB01', 'MAIN', '50200012345678', 'INR', ${standing.bank}, ${ACTOR}) on conflict do nothing
    `);

    /* GST-flavoured tax codes (simplified: rate + TAX determination standing). */
    await tx.execute(sql`
      insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
      values (${CLIENT}, 'IN', 'G18', 'GST 18 percent', 'GST', 18, ${ACTOR}),
             (${CLIENT}, 'IN', 'G0', 'GST zero rated', 'GST', 0, ${ACTOR}) on conflict do nothing
    `);

    /* Payment terms + methods (country IN). */
    await tx.execute(sql`
      insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
      values (${CLIENT}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into payment_method (client, country, method_code, description, allowed_direction, created_by)
      values (${CLIENT}, 'IN', 'T', 'Bank transfer', 'OUTGOING', ${ACTOR}),
             (${CLIENT}, 'IN', 'C', 'Cheque', 'OUTGOING', ${ACTOR}) on conflict do nothing
    `);

    /* Cost centres so the controlling reports have actuals to read. */
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
      values (${CLIENT}, 'A000', 'PROD', '2026-04-01', '9999-12-31', 'Production', 'PRODUCTION', ${COMPANY}, ${ACTOR}),
             (${CLIENT}, 'A000', 'ADMIN', '2026-04-01', '9999-12-31', 'Administration', 'ADMINISTRATION', ${COMPANY}, ${ACTOR})
      on conflict do nothing
    `);

    /* Business partners: 3 vendors, 2 customers, with company + purchasing data. */
    const vendors: Array<[string, string]> = [['V10000', 'Sharma Steel Traders'], ['V20000', 'Krishna Polymers Ltd'], ['V30000', 'Deccan Logistics']];
    const customers: Array<[string, string]> = [['C10000', 'Apex Motors Ltd'], ['C20000', 'Nova Vehicles Pvt Ltd']];
    for (const [number, name] of vendors) {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${CLIENT}, ${number}, 'ORGANIZATION', ${name}, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${CLIENT}, ${number}, 'SUPPLIER', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_company_code (client, partner_number, role_code, company_code, chart_of_accounts, reconciliation_account, payment_terms_code, payment_methods, created_by)
        values (${CLIENT}, ${number}, 'SUPPLIER', ${COMPANY}, 'CA01', ${standing.pay}, 'NET30', 'T', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
        values (${CLIENT}, ${number}, 'SUPPLIER', ${COMPANY}, 'INR', ${ACTOR}) on conflict do nothing
      `);
    }
    for (const [number, name] of customers) {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${CLIENT}, ${number}, 'ORGANIZATION', ${name}, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${CLIENT}, ${number}, 'CUSTOMER', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into customer_company_code (client, partner_number, role_code, company_code, chart_of_accounts, reconciliation_account, payment_terms_code, created_by)
        values (${CLIENT}, ${number}, 'CUSTOMER', ${COMPANY}, 'CA01', ${standing.recv}, 'NET30', ${ACTOR}) on conflict do nothing
      `);
    }

    /* Materials with plant + valuation so purchasing and inventory post. */
    const materials: Array<[string, string, string]> = [
      ['MAT-10001', 'Steel plate 5mm', 'RAW_INVENTORY'], ['MAT-10002', 'Polymer resin pellets', 'RAW_INVENTORY'],
      ['MAT-20001', 'Gear housing casting', 'RAW_INVENTORY'], ['MAT-90001', 'Finished gear assembly', 'RAW_INVENTORY'],
    ];
    for (const [number, description, valuationClass] of materials) {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${CLIENT}, ${number}, ${description}, 'RAW', 'PC', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by)
        values (${CLIENT}, ${number}, ${COMPANY}, 0, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control, standard_price, moving_average_price, price_unit, currency, created_by)
        values (${CLIENT}, ${number}, ${COMPANY}, ${valuationClass}, 'MOVING_AVERAGE', 0, 0, 1, 'INR', ${ACTOR}) on conflict do nothing
      `);
    }
    await tx.execute(sql`
      insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${CLIENT}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
             (${CLIENT}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR}),
             (${CLIENT}, 'CA01', 'PRICE_DIFFERENCE', 'RAW_INVENTORY', '', '410200', ${ACTOR}),
             (${CLIENT}, 'CA01', 'TAX', '', '', '240000', ${ACTOR})
      on conflict do nothing
    `);
  });
  console.log('  master data + configuration standing (partners, materials, banks, tax, terms)');

  /* Number ranges the posting engines draw from. */
  try {
    await maintainNumberRange({
      client: CLIENT, objectCode: 'RF_BELEG', companyCode: COMPANY, subObject: 'GENERAL', fiscalYear: 0,
      prefix: 'JE', fromNumber: 1, toNumber: 999999, numberLength: 6, displayStyle: 'READABLE',
      status: 'ACTIVE', mode: 'CREATE', reason: 'Walkthrough setup', changedBy: ACTOR,
    });
  } catch (error) { warn('RF_BELEG range', error); }
  await withTenant(CLIENT, async (tx) => {
    await defineRange(tx, { client: CLIENT, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client: CLIENT, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
    await defineRange(tx, { client: CLIENT, objectCode: 'VENDINV', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
  });

  const ensureMaterialPeriod = async (isoDate: string) => {
    const target = fyPeriod(isoDate);
    const control = await getMaterialPeriodControl(CLIENT, COMPANY);
    if (!control) {
      await initializeMaterialPeriodControl({
        client: CLIENT, changedBy: ACTOR, companyCode: COMPANY,
        fiscalYear: target.fiscalYear, period: target.period, reason: 'Walkthrough setup',
      });
      return;
    }
    let guard = 0;
    let current = control as unknown as { currentFiscalYear: number; currentPeriod: number };
    while ((current.currentFiscalYear < target.fiscalYear
      || (current.currentFiscalYear === target.fiscalYear && current.currentPeriod < target.period)) && guard < 24) {
      await shiftMaterialPeriod({ client: CLIENT, changedBy: ACTOR, companyCode: COMPANY, reason: 'Walkthrough setup' });
      current = await getMaterialPeriodControl(CLIENT, COMPANY) as unknown as { currentFiscalYear: number; currentPeriod: number };
      guard += 1;
    }
  };

  const journal = async (postingDate: string, headerText: string, lines: Array<{ glAccount: string; debitCredit: 'S' | 'H'; amount: string; costCenter?: string }>) => {
    const { fiscalYear, period } = fyPeriod(postingDate);
    return withTenant(CLIENT, (tx) => postJournalEntry(tx, {
      client: CLIENT, companyCode: COMPANY, documentType: 'SA',
      documentDate: postingDate, postingDate, fiscalYear, postingPeriod: period,
      currency: 'INR', localCurrency: 'INR', headerText, postedBy: ACTOR,
      lines: lines.map((line) => ({ ...line, amountLocal: line.amount })),
    }));
  };

  /* Opening balances, 1 April 2026 (FY2026 period 1). */
  await journal('2026-04-01', 'Opening balances FY2026', [
    { glAccount: standing.bank, debitCredit: 'S', amount: '2500000' },
    { glAccount: standing.inventory, debitCredit: 'S', amount: '800000' },
    { glAccount: standing.equity, debitCredit: 'H', amount: '3300000' },
  ]);
  console.log('  opening balances posted');

  /* ── Purchase-to-procure: three full cycles across the year ────────── */
  const cycles = [
    { vendor: 'V10000', material: 'MAT-10001', qty: 10, price: 1000, orderDate: '2026-05-10', receiveDate: '2026-05-20', invoiceDate: '2026-05-22', key: 'wt-p2p-1', pay: true },
    { vendor: 'V20000', material: 'MAT-10002', qty: 20, price: 450, orderDate: '2026-08-10', receiveDate: '2026-08-21', invoiceDate: '2026-08-24', key: 'wt-p2p-2', pay: true },
    { vendor: 'V10000', material: 'MAT-20001', qty: 8, price: 2200, orderDate: '2026-11-09', receiveDate: '2026-11-20', invoiceDate: '2026-11-23', key: 'wt-p2p-3', pay: false },
  ];
  const paidInvoices: Array<{ vendor: string; dueDate: string }> = [];
  for (const cycle of cycles) {
    const order = await createOrder({
      client: CLIENT, changedBy: ACTOR,
      supplierNumber: cycle.vendor, purchasingOrg: COMPANY, purchasingGroup: '001', companyCode: COMPANY, currency: 'INR',
      items: [{
        materialNumber: cycle.material, shortText: cycle.material, quantity: cycle.qty, unit: 'PC',
        netPrice: cycle.price, priceUnit: 1, taxCode: '', plant: COMPANY, storageLocation: '',
        markedForDeletion: false,
        scheduleLines: [{ deliveryDate: cycle.receiveDate, quantity: cycle.qty }],
        assignments: [],
      }],
    });
    try {
      await ensureMaterialPeriod(cycle.receiveDate);
    } catch (error) { warn('material period control', error); }
    await postGoodsReceipt({
      client: CLIENT, changedBy: ACTOR, orderNumber: order.orderNumber,
      documentDate: cycle.receiveDate, postingDate: cycle.receiveDate,
      requestKey: `${cycle.key}-gr`, lines: [{ itemNumber: 10, quantity: cycle.qty }],
    });
    await postSupplierInvoice({
      client: CLIENT, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: `INV-${cycle.key.toUpperCase()}`, invoiceDate: cycle.invoiceDate, postingDate: cycle.invoiceDate,
      grossAmount: cycle.qty * cycle.price, requestKey: `${cycle.key}-iv`,
      lines: [{ itemNumber: 10, quantity: cycle.qty, netAmount: cycle.qty * cycle.price }],
    });
    if (cycle.pay) paidInvoices.push({ vendor: cycle.vendor, dueDate: cycle.invoiceDate });
    console.log(`  P2P cycle ${cycle.key}: order ${order.orderNumber} received + invoiced${cycle.pay ? ' (to pay)' : ' (left open)'}`);
  }

  /* One payment run settles the first two supplier invoices (F110). */
  if (paidInvoices.length > 0) {
    try {
      await createPaymentRun({
        client: CLIENT, changedBy: ACTOR,
        runDate: '2026-12-10', runId: 'WT01', postingDate: '2026-12-10',
        documentCutoffDate: '2026-12-10', nextPaymentDate: '2026-12-15',
        companies: [{ companyCode: COMPANY, payingCompanyCode: COMPANY }], methods: ['T'],
      });
      const proposal = await generateProposal({ client: CLIENT, changedBy: ACTOR, runDate: '2026-12-10', runId: 'WT01' });
      console.log(`  payment run WT01 proposal: ${proposal.proposal.length} item(s)`);
      await executePaymentRun({
        client: CLIENT, changedBy: ACTOR, runDate: '2026-12-10', runId: 'WT01',
        houseBankKey: 'HB01', bankAccountId: 'MAIN',
      });
      console.log('  payment run WT01 executed (open items cleared)');
    } catch (error) { warn('payment run WT01', error); }
  }

  /* ── Sales side: two customer invoices, one received ────────────────── */
  let firstInvoiceDoc = '';
  try {
    const invoice = await postCustomerInvoice({
      client: CLIENT, changedBy: ACTOR, customerNumber: 'C10000', companyCode: COMPANY,
      documentDate: '2026-09-14', postingDate: '2026-09-14', reference: 'SO-1001',
      currency: 'INR', paymentTermsCode: 'NET30', grossAmount: 118000,
      requestKey: 'wt-ar-1',
      lines: [{ glAccount: standing.revenue, netAmount: 100000, taxCode: 'G18' }],
    });
    firstInvoiceDoc = (invoice as unknown as { journalDocumentNumber?: string | null }).journalDocumentNumber ?? '';
    console.log(`  customer invoice posted ${firstInvoiceDoc}`);
  } catch (error) {
    warn('customer invoice with GST (retrying without tax)', error);
    const invoice = await postCustomerInvoice({
      client: CLIENT, changedBy: ACTOR, customerNumber: 'C10000', companyCode: COMPANY,
      documentDate: '2026-09-14', postingDate: '2026-09-14', reference: 'SO-1001',
      currency: 'INR', paymentTermsCode: 'NET30', grossAmount: 100000,
      requestKey: 'wt-ar-1b',
      lines: [{ glAccount: standing.revenue, netAmount: 100000 }],
    });
    firstInvoiceDoc = (invoice as unknown as { journalDocumentNumber?: string | null }).journalDocumentNumber ?? '';
    console.log(`  customer invoice posted (no tax) ${firstInvoiceDoc}`);
  }
  try {
    await postCustomerInvoice({
      client: CLIENT, changedBy: ACTOR, customerNumber: 'C20000', companyCode: COMPANY,
      documentDate: '2026-12-08', postingDate: '2026-12-08', reference: 'SO-1002',
      currency: 'INR', paymentTermsCode: 'NET30', grossAmount: 59000,
      requestKey: 'wt-ar-2',
      lines: [{ glAccount: standing.revenue, netAmount: 50000, taxCode: 'G18' }],
    });
    console.log('  second customer invoice posted (left open)');
  } catch (error) { warn('second customer invoice', error); }

  /* Receive the first customer invoice in full (F-28). */
  if (firstInvoiceDoc) {
    try {
      const open = await withTenant(CLIENT, async (tx) => {
        const rows = await tx.execute(sql`
          select document_number, fiscal_year, line_number from journal_entry_line
          where client = ${CLIENT} and document_number = ${firstInvoiceDoc}
            and business_partner = 'C10000' and debit_credit = 'S' limit 1
        `) as unknown as Array<{ document_number: string; fiscal_year: number; line_number: number }>;
        return rows[0];
      });
      if (open) {
        const invoiceLines = await withTenant(CLIENT, async (tx) => {
          const rows = await tx.execute(sql`
            select amount_local::text as amount from journal_entry_line
            where client = ${CLIENT} and document_number = ${firstInvoiceDoc}
              and business_partner = 'C10000' and debit_credit = 'S' limit 1
          `) as unknown as Array<{ amount: string }>;
          return rows[0]?.amount ?? '0';
        });
        await postIncomingPayment({
          client: CLIENT, changedBy: ACTOR, customerNumber: 'C10000', companyCode: COMPANY,
          documentDate: '2026-10-05', postingDate: '2026-10-05', clearingDate: '2026-10-05',
          bankGlAccount: standing.bank, amount: Number(invoiceLines), currency: 'INR',
          requestKey: 'wt-ar-1-pay',
          items: [{ documentNumber: open.document_number, fiscalYear: open.fiscal_year, lineNumber: open.line_number }],
        });
        console.log('  first customer invoice received and cleared');
      }
    } catch (error) { warn('incoming payment', error); }
  }

  /* Operating expense journals through the year (cost-centre actuals). */
  const expenseAccounts = await withTenant(CLIENT, async (tx) => {
    const rows = await tx.execute(sql`
      select account_number, name from gl_account where client = ${CLIENT} and chart_of_accounts = 'CA01'
        and account_type = 'EXPENSE' order by account_number limit 6
    `) as unknown as Array<{ account_number: string; name: string }>;
    return rows;
  });
  const rent = expenseAccounts[1]?.account_number ?? expenseAccounts[0]?.account_number ?? '';
  const salaries = expenseAccounts[2]?.account_number ?? rent;
  try {
    await journal('2026-06-30', 'Office rent Q1', [
      { glAccount: rent, debitCredit: 'S', amount: '150000', costCenter: 'ADMIN' },
      { glAccount: standing.bank, debitCredit: 'H', amount: '150000' },
    ]);
    await journal('2026-09-30', 'Salaries Q2', [
      { glAccount: salaries, debitCredit: 'S', amount: '420000', costCenter: 'PROD' },
      { glAccount: standing.bank, debitCredit: 'H', amount: '420000' },
    ]);
    await journal('2026-12-31', 'Office rent Q3', [
      { glAccount: rent, debitCredit: 'S', amount: '150000', costCenter: 'ADMIN' },
      { glAccount: standing.bank, debitCredit: 'H', amount: '150000' },
    ]);
    console.log('  expense journals posted (rent, salaries)');
  } catch (error) { warn('expense journals', error); }

  /* Verification: the reports already read this data. */
  const journalCount = await withTenant(CLIENT, async (tx) => {
    const rows = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${CLIENT}`) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  });
  try {
    const cf = await calculateCashflow({
      client: CLIENT,
      selection: { companyCodes: [COMPANY], fiscalYear: 2026, periodFrom: 1, periodTo: 12, method: 'INDIRECT', ledger: '0L', comparative: false },
    });
    console.log(`  cash flow FY2026: opening ${cf.openingCash} → closing ${cf.closingCash} (net ${cf.netCashChange}, reconciliation difference ${cf.reconciliationDifference})`);
  } catch (error) { warn('cash-flow verification', error); }
  console.log(`  journal entries standing: ${journalCount}`);

  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log(' WALKTHROUGH READY');
  console.log(`   Tenant (client): ${CLIENT}`);
  console.log(`   Company:         ${COMPANY} · ${COMPANY_NAME} (INR, April–March FY2026)`);
  console.log(`   Username:        ${ADMIN_USERNAME}`);
  console.log(`   Password:        ${ADMIN_PASSWORD}`);
  console.log('   Change the password after your first login.');
  console.log('════════════════════════════════════════════════════════════');
  await closeDb();
}

main().catch(async (error) => {
  console.error('Walkthrough seed failed:', error instanceof Error ? error.message : error);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
