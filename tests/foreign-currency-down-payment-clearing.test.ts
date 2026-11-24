import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { reverseJournalEntry } from '../src/platform/posting';
import { postVendorInvoice } from '../src/modules/finance/vendor-invoice';
import { postCustomerInvoice } from '../src/modules/finance/customer-invoice';
import {
  getVendorDownPayments, postVendorDownPayment,
} from '../src/modules/finance/vendor-down-payment';
import {
  getCustomerDownPayments, postCustomerDownPayment,
} from '../src/modules/finance/customer-down-payment';
import { getPayables } from '../src/modules/finance/outgoing-payment';
import { getReceivables } from '../src/modules/finance/incoming-payment';
import {
  clearDownPayments, getDownPaymentClearing,
} from '../src/modules/finance/vendor-down-payment-clearing';
import {
  clearCustomerDownPayments, getCustomerDownPaymentClearing,
} from '../src/modules/finance/customer-down-payment-clearing';
import { getVendorAgeing } from '../src/modules/finance/vendor-ageing';
import { getCustomerAgeing } from '../src/modules/finance/customer-ageing';
import { proposeDunningRun } from '../src/modules/finance/dunning';
import { createPaymentRun, generateProposal } from '../src/modules/finance/payment-run';
import { resetClearing } from '../src/modules/finance/clearing-reset';
import { executeFxValuation } from '../src/modules/finance/fx-valuation';
import { createFinanceActor, type FinanceActor } from './helpers/finance-actor';
import {
  createTenant, defineTestRanges, destroyTenant, seedAccounts, type TestTenant,
} from './helpers';

/**
 * Foreign-currency down-payment clearings book their transfer legs at each item's own carrying
 * amount and post the difference as a local-only realized exchange difference.
 *
 * Local currency KWD (3 decimals), document currency USD. Invoice USD 1,200 @ 0.300, advance USD
 * 1,000 @ 0.305, application USD 800 @ 0.310. Every open-item consumer must then see the invoice
 * at USD 400 / KWD 120.000 and the advance at USD 200 / KWD 61.000.
 */

const ACTOR = 'FC_DP_CLEARING_TEST';
const COMPANY = '1000';
const LOCAL = 'KWD';
const DOC = 'USD';
const ALT = '230000';
const FXGAIN = '590100';
const FXLOSS = '590200';
const RECON: Record<Side, string> = { vendor: '200000', customer: '110000' };

type Side = 'vendor' | 'customer';

interface Fixture { tenant: TestTenant; actor: FinanceActor }
interface Posted { journalDocumentNumber: string }

let vendorFixture: Fixture;
let customerFixture: Fixture;

function partnerOf(side: Side, index: number): string {
  return `${side === 'vendor' ? 'V' : 'C'}${String(index + 1).padStart(4, '0')}`;
}

async function setupSide(side: Side): Promise<Fixture> {
  const tenant = await createTenant(`fc-dp-clearing-${side}`, { currency: LOCAL });
  await defineTestRanges(tenant, { fiscalYear: 2026 });
  await seedAccounts(tenant, [FXGAIN, FXLOSS]);
  const client = tenant.client;
  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client, objectCode: side === 'vendor' ? 'VENDINV' : 'CUSTINV', subObject: '*',
      prefix: side === 'vendor' ? 'VI' : 'CI', numberLength: 7, createdBy: ACTOR,
    });
    const partners = Array.from({ length: 9 }, (_, i) => partnerOf(side, i));
    for (const partner of partners) {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${client}, ${partner}, 'ORGANIZATION', ${`FC ${partner}`}, ${ACTOR})
        on conflict do nothing`);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${client}, ${partner}, ${side === 'vendor' ? 'SUPPLIER' : 'CUSTOMER'}, ${ACTOR})
        on conflict do nothing`);
    }
    await tx.execute(sql`
      insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
      values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR})
      on conflict do nothing`);
    for (const partner of partners) {
      if (side === 'vendor') {
        await tx.execute(sql`
          insert into supplier_company_code
            (client, partner_number, role_code, company_code, chart_of_accounts,
             reconciliation_account, payment_terms_code, payment_methods, created_by)
          values (${client}, ${partner}, 'SUPPLIER', ${COMPANY}, 'CA01', ${RECON.vendor}, 'NET30', 'T', ${ACTOR})
          on conflict do nothing`);
      } else {
        await tx.execute(sql`
          insert into customer_company_code
            (client, partner_number, role_code, company_code, chart_of_accounts,
             reconciliation_account, payment_terms_code, dunning_procedure, created_by)
          values (${client}, ${partner}, 'CUSTOMER', ${COMPANY}, 'CA01', ${RECON.customer}, 'NET30', 'DUN1', ${ACTOR})
          on conflict do nothing`);
      }
    }
    await tx.execute(sql`
      insert into special_gl_config
        (client, company_code, account_type, indicator, alternative_reconciliation_account, description, created_by)
      values (${client}, '', ${side === 'vendor' ? 'AP' : 'AR'}, 'A', ${ALT}, 'Advances', ${ACTOR})
      on conflict do nothing`);
    await tx.execute(sql`
      insert into payment_method (client, country, method_code, description, allowed_direction, created_by)
      values (${client}, 'KW', 'T', 'Bank transfer', 'OUTGOING', ${ACTOR}) on conflict do nothing`);
    await tx.execute(sql`
      insert into account_determination
        (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
      values (${client}, 'CA01', 'FXGAIN', '', '', ${FXGAIN}, ${ACTOR}),
             (${client}, 'CA01', 'FXLOSS', '', '', ${FXLOSS}, ${ACTOR})
      on conflict do nothing`);
    // 0.300 until 16 Oct, 0.305 from then, 0.310 from 20 Oct, 0.295 from 22 Oct.
    await tx.execute(sql`
      insert into exchange_rate (client, rate_type, from_currency, to_currency, valid_from, rate, created_by) values
        (${client}, 'AVERAGE', 'USD', 'KWD', '2026-01-01', 0.300, ${ACTOR}),
        (${client}, 'AVERAGE', 'USD', 'KWD', '2026-10-16', 0.305, ${ACTOR}),
        (${client}, 'AVERAGE', 'USD', 'KWD', '2026-10-20', 0.310, ${ACTOR}),
        (${client}, 'AVERAGE', 'USD', 'KWD', '2026-10-22', 0.295, ${ACTOR})
      on conflict do nothing`);
  });
  const actor = await createFinanceActor(client);
  return { tenant, actor };
}

beforeAll(async () => {
  vendorFixture = await setupSide('vendor');
  customerFixture = await setupSide('customer');
}, 180_000);

afterAll(async () => {
  if (vendorFixture) await destroyTenant(vendorFixture.tenant.client);
  if (customerFixture) await destroyTenant(customerFixture.tenant.client);
}, 300_000);

// ───────────────────────────── posting helpers ─────────────────────────────

async function postInvoice(
  fixture: Fixture, side: Side, partner: string, gross: number, key: string,
  currency = DOC, date = '2026-10-10',
): Promise<Posted> {
  const base = {
    client: fixture.tenant.client, changedBy: ACTOR, companyCode: COMPANY,
    documentDate: date, postingDate: date, reference: key, currency, grossAmount: gross,
    requestKey: key, lines: [{ glAccount: side === 'vendor' ? '400000' : '300000', netAmount: gross }],
  };
  const posted = side === 'vendor'
    ? await postVendorInvoice({ ...base, vendorNumber: partner })
    : await postCustomerInvoice({ ...base, customerNumber: partner });
  return { journalDocumentNumber: posted.journalDocumentNumber! };
}

async function postAdvance(
  fixture: Fixture, side: Side, partner: string, amount: number, key: string,
  currency = DOC, date = '2026-10-17',
): Promise<Posted> {
  const base = {
    client: fixture.tenant.client, changedBy: ACTOR, companyCode: COMPANY,
    documentDate: date, postingDate: date, bankGlAccount: '101000',
    amount, currency, specialGlIndicator: 'A', requestKey: key,
  };
  const posted = side === 'vendor'
    ? await postVendorDownPayment({ ...base, vendorNumber: partner })
    : await postCustomerDownPayment({ ...base, customerNumber: partner });
  return { journalDocumentNumber: posted.journalDocumentNumber! };
}

async function apply(
  fixture: Fixture, side: Side, partner: string, invoice: Posted, advance: Posted,
  applied: number, key: string, date = '2026-10-21', currency = DOC,
): Promise<Posted> {
  const client = fixture.tenant.client;
  if (side === 'vendor') {
    const view = await getDownPaymentClearing(client, partner, COMPANY, 'A');
    const dp = view.downPayments.find((i) => i.documentNumber === advance.journalDocumentNumber)!;
    const inv = view.invoices.find((i) => i.documentNumber === invoice.journalDocumentNumber)!;
    const posted = await clearDownPayments({
      client, changedBy: ACTOR, vendorNumber: partner, companyCode: COMPANY, indicator: 'A',
      documentDate: date, postingDate: date, clearingDate: date, currency, requestKey: key,
      downPayments: [{ documentNumber: dp.documentNumber, fiscalYear: dp.fiscalYear, lineNumber: dp.lineNumber, applied }],
      invoices: [{ documentNumber: inv.documentNumber, fiscalYear: inv.fiscalYear, lineNumber: inv.lineNumber, applied }],
    });
    return { journalDocumentNumber: posted.journalDocumentNumber };
  }
  const view = await getCustomerDownPaymentClearing(client, partner, COMPANY, 'A');
  const dp = view.downPayments.find((i) => i.documentNumber === advance.journalDocumentNumber)!;
  const inv = view.invoices.find((i) => i.documentNumber === invoice.journalDocumentNumber)!;
  const posted = await clearCustomerDownPayments({
    client, changedBy: ACTOR, customerNumber: partner, companyCode: COMPANY, indicator: 'A',
    documentDate: date, postingDate: date, clearingDate: date, currency, requestKey: key,
    allocations: [{
      downPayment: { documentNumber: dp.documentNumber, fiscalYear: dp.fiscalYear, lineNumber: dp.lineNumber },
      invoice: { documentNumber: inv.documentNumber, fiscalYear: inv.fiscalYear, lineNumber: inv.lineNumber },
      amount: applied,
    }],
  });
  return { journalDocumentNumber: posted.journalDocumentNumber };
}

// ───────────────────────────── read helpers ─────────────────────────────

interface JournalLine {
  gl_account: string; debit_credit: string; doc: string; local: string;
  currency: string; is_local_only: boolean; line_text: string;
}

async function journalLines(client: string, documentNumber: string): Promise<JournalLine[]> {
  return withTenant(client, async (tx) => (await tx.execute(sql`
    select l.gl_account, l.debit_credit, l.amount_document::text as doc, l.amount_local::text as local,
           l.currency, l.is_local_only, l.line_text
      from journal_entry_line l
     where l.client = ${client} and l.document_number = ${documentNumber}
     order by l.line_number`)) as unknown as JournalLine[]);
}

async function accountLocal(client: string, partner: string, account: string): Promise<string> {
  return withTenant(client, async (tx) => {
    const rows = (await tx.execute(sql`
      select coalesce(sum(case when l.debit_credit = 'S' then l.amount_local else -l.amount_local end), 0)::text as bal
        from journal_entry_line l
        join journal_entry h
          on h.client = l.client and h.document_number = l.document_number and h.fiscal_year = l.fiscal_year
       where l.client = ${client} and l.company_code = ${COMPANY}
         and l.business_partner = ${partner} and l.gl_account = ${account}
         and h.status = 'POSTED' and h.reversal_of is null`)) as unknown as Array<{ bal: string }>;
    return rows[0]?.bal ?? '0';
  });
}

async function openDocumentItems(fixture: Fixture, side: Side, partner: string) {
  const client = fixture.tenant.client;
  return side === 'vendor'
    ? (await getPayables(client, partner, COMPANY)).openItems
    : (await getReceivables(client, partner, COMPANY)).openItems;
}

async function advanceReport(fixture: Fixture, side: Side, partner: string) {
  const client = fixture.tenant.client;
  return side === 'vendor'
    ? getVendorDownPayments(client, partner, COMPANY)
    : getCustomerDownPayments(client, partner, COMPANY);
}

async function ageingItems(fixture: Fixture, side: Side, partner: string) {
  const client = fixture.tenant.client;
  return side === 'vendor'
    ? (await getVendorAgeing(client, {
      companyCode: COMPANY, keyDate: '2026-12-31', supplierFrom: partner, supplierTo: partner,
      includeSpecialGl: true, authorization: fixture.actor.authorization,
    })).items
    : (await getCustomerAgeing(client, {
      companyCode: COMPANY, keyDate: '2026-12-31', customerFrom: partner, customerTo: partner,
      includeSpecialGl: true, authorization: fixture.actor.authorization,
    })).items;
}

/**
 * The shared expectation for one partner: document remainders from every open-item consumer and
 * local remainders from ageing, the advance report, and the partner's own subledger accounts.
 */
async function expectRemainders(input: {
  fixture: Fixture; side: Side; partner: string;
  invoice: Posted; advance: Posted | null;
  invoiceDocument: string; invoiceLocal: string;
  advanceDocument: string | null; advanceLocal: string | null;
}) {
  const { fixture, side, partner, invoice, advance } = input;
  const items = await openDocumentItems(fixture, side, partner);
  expect(items.map((i) => [i.documentNumber, i.amount])).toEqual([[invoice.journalDocumentNumber, input.invoiceDocument]]);

  const advances = await advanceReport(fixture, side, partner);
  if (input.advanceDocument === null) {
    expect(advances).toHaveLength(0);
  } else {
    expect(advances.map((i) => [i.documentNumber, i.amount, i.amountLocal]))
      .toEqual([[advance!.journalDocumentNumber, input.advanceDocument, input.advanceLocal]]);
  }

  const aged = await ageingItems(fixture, side, partner);
  expect(aged.find((i) => i.documentNumber === invoice.journalDocumentNumber))
    .toMatchObject({ amount: input.invoiceLocal, documentAmount: input.invoiceDocument });
  const agedAdvance = aged.find((i) => i.documentNumber === advance?.journalDocumentNumber);
  if (input.advanceDocument === null) {
    expect(agedAdvance).toBeUndefined();
  } else {
    expect(agedAdvance).toMatchObject({ amount: input.advanceLocal, documentAmount: input.advanceDocument });
  }

  // The partner's reconciliation and alternative accounts carry exactly the open-item remainders:
  // no unposted exchange difference is left in either subledger balance.
  const reconSign = side === 'vendor' ? -1 : 1;
  const altSign = side === 'vendor' ? 1 : -1;
  const recon = Number(await accountLocal(fixture.tenant.client, partner, RECON[side]));
  const alt = Number(await accountLocal(fixture.tenant.client, partner, ALT));
  expect(recon).toBeCloseTo(reconSign * Number(input.invoiceLocal), 4);
  expect(alt).toBeCloseTo(altSign * Number(input.advanceLocal ?? '0'), 4);
}

// ───────────────────────────── vendor scenarios ─────────────────────────────

describe('foreign-currency down-payment clearing — vendor', () => {
  it('base: invoice 1,200 @0.300, advance 1,000 @0.305, apply 800 @0.310', async () => {
    const partner = partnerOf('vendor', 0);
    const invoice = await postInvoice(vendorFixture, 'vendor', partner, 1200, 'fc-v-base-inv');
    const advance = await postAdvance(vendorFixture, 'vendor', partner, 1000, 'fc-v-base-dp');
    const clearing = await apply(vendorFixture, 'vendor', partner, invoice, advance, 800, 'fc-v-base-clr');

    await expectRemainders({
      fixture: vendorFixture, side: 'vendor', partner, invoice, advance,
      invoiceDocument: '400.0000', invoiceLocal: '120.0000',
      advanceDocument: '200.0000', advanceLocal: '61.0000',
    });

    const lines = await journalLines(vendorFixture.tenant.client, clearing.journalDocumentNumber);
    expect(lines).toEqual([
      { gl_account: RECON.vendor, debit_credit: 'S', doc: '800.0000', local: '240.0000', currency: DOC, is_local_only: false, line_text: `Settles ${invoice.journalDocumentNumber}` },
      { gl_account: ALT, debit_credit: 'H', doc: '800.0000', local: '244.0000', currency: DOC, is_local_only: false, line_text: `Applied from ${advance.journalDocumentNumber}` },
      { gl_account: FXLOSS, debit_credit: 'S', doc: '0.0000', local: '4.0000', currency: LOCAL, is_local_only: true, line_text: 'Realized exchange loss' },
    ]);
  }, 90_000);

  it('full apply: invoice 200 / 60.000, advance fully cleared, FX 5.000 loss', async () => {
    const partner = partnerOf('vendor', 1);
    const invoice = await postInvoice(vendorFixture, 'vendor', partner, 1200, 'fc-v-full-inv');
    const advance = await postAdvance(vendorFixture, 'vendor', partner, 1000, 'fc-v-full-dp');
    const clearing = await apply(vendorFixture, 'vendor', partner, invoice, advance, 1000, 'fc-v-full-clr');

    await expectRemainders({
      fixture: vendorFixture, side: 'vendor', partner, invoice, advance,
      invoiceDocument: '200.0000', invoiceLocal: '60.0000',
      advanceDocument: null, advanceLocal: null,
    });
    const lines = await journalLines(vendorFixture.tenant.client, clearing.journalDocumentNumber);
    expect(lines.find((l) => l.gl_account === FXLOSS))
      .toMatchObject({ debit_credit: 'S', local: '5.0000', is_local_only: true });
  }, 90_000);

  it('several partials at different rates: 500 @0.310 then 300 @0.295', async () => {
    const partner = partnerOf('vendor', 2);
    const invoice = await postInvoice(vendorFixture, 'vendor', partner, 1200, 'fc-v-multi-inv');
    const advance = await postAdvance(vendorFixture, 'vendor', partner, 1000, 'fc-v-multi-dp');
    await apply(vendorFixture, 'vendor', partner, invoice, advance, 500, 'fc-v-multi-1', '2026-10-21');
    await apply(vendorFixture, 'vendor', partner, invoice, advance, 300, 'fc-v-multi-2', '2026-10-23');

    await expectRemainders({
      fixture: vendorFixture, side: 'vendor', partner, invoice, advance,
      invoiceDocument: '400.0000', invoiceLocal: '120.0000',
      advanceDocument: '200.0000', advanceLocal: '61.0000',
    });
  }, 90_000);

  it('same rate at clearing and original: no FX line, results unchanged', async () => {
    const partner = partnerOf('vendor', 3);
    const invoice = await postInvoice(vendorFixture, 'vendor', partner, 1200, 'fc-v-same-inv', DOC, '2026-10-10');
    const advance = await postAdvance(vendorFixture, 'vendor', partner, 1000, 'fc-v-same-dp', DOC, '2026-10-10');
    const clearing = await apply(vendorFixture, 'vendor', partner, invoice, advance, 800, 'fc-v-same-clr', '2026-10-11');

    await expectRemainders({
      fixture: vendorFixture, side: 'vendor', partner, invoice, advance,
      invoiceDocument: '400.0000', invoiceLocal: '120.0000',
      advanceDocument: '200.0000', advanceLocal: '60.0000',
    });
    const lines = await journalLines(vendorFixture.tenant.client, clearing.journalDocumentNumber);
    expect(lines.some((l) => l.is_local_only)).toBe(false);
  }, 90_000);

  it('rounding: 333.33 applied at 0.310 nets to exact 3-decimal remainders', async () => {
    const partner = partnerOf('vendor', 4);
    const invoice = await postInvoice(vendorFixture, 'vendor', partner, 1200, 'fc-v-round-inv');
    const advance = await postAdvance(vendorFixture, 'vendor', partner, 1000, 'fc-v-round-dp');
    const clearing = await apply(vendorFixture, 'vendor', partner, invoice, advance, 333.33, 'fc-v-round-clr');

    await expectRemainders({
      fixture: vendorFixture, side: 'vendor', partner, invoice, advance,
      invoiceDocument: '866.6700', invoiceLocal: '260.0010',
      advanceDocument: '666.6700', advanceLocal: '203.3340',
    });
    const lines = await journalLines(vendorFixture.tenant.client, clearing.journalDocumentNumber);
    expect(lines.find((l) => l.gl_account === FXLOSS))
      .toMatchObject({ local: '1.6670', is_local_only: true });
    // Local debits equal local credits exactly: no penny drift.
    const signed = lines.reduce(
      (s, l) => s + (l.debit_credit === 'S' ? Number(l.local) : -Number(l.local)), 0,
    );
    expect(signed).toBeCloseTo(0, 6);
  }, 90_000);

  it('over-application is refused', async () => {
    const partner = partnerOf('vendor', 5);
    const invoice = await postInvoice(vendorFixture, 'vendor', partner, 1200, 'fc-v-over-inv');
    const advance = await postAdvance(vendorFixture, 'vendor', partner, 1000, 'fc-v-over-dp');
    await expect(apply(vendorFixture, 'vendor', partner, invoice, advance, 1300, 'fc-v-over-clr'))
      .rejects.toThrow(/exceeds its remaining/);
  }, 90_000);

  it('reset reverses the transfer legs and the FX line and restores the originals', async () => {
    const partner = partnerOf('vendor', 6);
    const invoice = await postInvoice(vendorFixture, 'vendor', partner, 1200, 'fc-v-reset-inv');
    const advance = await postAdvance(vendorFixture, 'vendor', partner, 1000, 'fc-v-reset-dp');
    const clearing = await apply(vendorFixture, 'vendor', partner, invoice, advance, 1000, 'fc-v-reset-clr');

    await resetClearing({
      client: vendorFixture.tenant.client, changedBy: ACTOR, companyCode: COMPANY,
      clearingDocument: clearing.journalDocumentNumber, fiscalYear: 2026,
      reason: 'foreign currency clearing reset', requestKey: 'fc-v-reset-fbra',
    });

    await expectRemainders({
      fixture: vendorFixture, side: 'vendor', partner, invoice, advance,
      invoiceDocument: '1200.0000', invoiceLocal: '360.0000',
      advanceDocument: '1000.0000', advanceLocal: '305.0000',
    });
    // The clearing journal (with its FX line) now stands reversed.
    const status = await withTenant(vendorFixture.tenant.client, async (tx) => {
      const rows = (await tx.execute(sql`
        select status from journal_entry where client = ${vendorFixture.tenant.client}
          and document_number = ${clearing.journalDocumentNumber}`)) as unknown as Array<{ status: string }>;
      return rows[0]?.status;
    });
    expect(status).toBe('REVERSED');
  }, 90_000);

  it('same-currency KWD clearing: unchanged, no FX line', async () => {
    const partner = partnerOf('vendor', 7);
    const invoice = await postInvoice(vendorFixture, 'vendor', partner, 1200, 'fc-v-kwd-inv', LOCAL);
    const advance = await postAdvance(vendorFixture, 'vendor', partner, 1000, 'fc-v-kwd-dp', LOCAL);
    const clearing = await apply(vendorFixture, 'vendor', partner, invoice, advance, 800, 'fc-v-kwd-clr', '2026-10-11', LOCAL);

    await expectRemainders({
      fixture: vendorFixture, side: 'vendor', partner, invoice, advance,
      invoiceDocument: '400.0000', invoiceLocal: '400.0000',
      advanceDocument: '200.0000', advanceLocal: '200.0000',
    });
    const lines = await journalLines(vendorFixture.tenant.client, clearing.journalDocumentNumber);
    expect(lines.some((l) => l.is_local_only)).toBe(false);
    expect(lines.map((l) => [l.gl_account, l.debit_credit, l.local])).toEqual([
      [RECON.vendor, 'S', '800.0000'],
      [ALT, 'H', '800.0000'],
    ]);
  }, 90_000);
});

// ───────────────────────────── customer scenarios ─────────────────────────────

describe('foreign-currency down-payment clearing — customer', () => {
  it('base: invoice 1,200 @0.300, advance 1,000 @0.305, apply 800 @0.310', async () => {
    const partner = partnerOf('customer', 0);
    const invoice = await postInvoice(customerFixture, 'customer', partner, 1200, 'fc-c-base-inv');
    const advance = await postAdvance(customerFixture, 'customer', partner, 1000, 'fc-c-base-dp');
    const clearing = await apply(customerFixture, 'customer', partner, invoice, advance, 800, 'fc-c-base-clr');

    await expectRemainders({
      fixture: customerFixture, side: 'customer', partner, invoice, advance,
      invoiceDocument: '400.0000', invoiceLocal: '120.0000',
      advanceDocument: '200.0000', advanceLocal: '61.0000',
    });

    const lines = await journalLines(customerFixture.tenant.client, clearing.journalDocumentNumber);
    expect(lines).toEqual([
      { gl_account: ALT, debit_credit: 'S', doc: '800.0000', local: '244.0000', currency: DOC, is_local_only: false, line_text: `Applied from ${advance.journalDocumentNumber}` },
      { gl_account: RECON.customer, debit_credit: 'H', doc: '800.0000', local: '240.0000', currency: DOC, is_local_only: false, line_text: `Settles ${invoice.journalDocumentNumber}` },
      { gl_account: FXGAIN, debit_credit: 'H', doc: '0.0000', local: '4.0000', currency: LOCAL, is_local_only: true, line_text: 'Realized exchange gain' },
    ]);

    // Dunning reads the net local overdue amount; the application line never appears.
    const run = await proposeDunningRun({
      client: customerFixture.tenant.client, changedBy: ACTOR, runDate: '2026-12-20', runId: 'FC1',
      dunningDate: '2026-12-20', postedThrough: '2026-12-20', companyCodes: [COMPANY],
      customerFrom: partner, customerTo: partner,
    }, { authorization: customerFixture.actor.authorization });
    expect(run.items.map((i) => [i.documentNumber, i.overdueAmount]))
      .toEqual([[invoice.journalDocumentNumber, '120.0000']]);
    expect(run.items.some((i) => i.documentNumber === clearing.journalDocumentNumber)).toBe(false);
  }, 90_000);

  it('full apply: invoice 200 / 60.000, advance fully cleared, FX 5.000 gain', async () => {
    const partner = partnerOf('customer', 1);
    const invoice = await postInvoice(customerFixture, 'customer', partner, 1200, 'fc-c-full-inv');
    const advance = await postAdvance(customerFixture, 'customer', partner, 1000, 'fc-c-full-dp');
    const clearing = await apply(customerFixture, 'customer', partner, invoice, advance, 1000, 'fc-c-full-clr');

    await expectRemainders({
      fixture: customerFixture, side: 'customer', partner, invoice, advance,
      invoiceDocument: '200.0000', invoiceLocal: '60.0000',
      advanceDocument: null, advanceLocal: null,
    });
    const lines = await journalLines(customerFixture.tenant.client, clearing.journalDocumentNumber);
    expect(lines.find((l) => l.gl_account === FXGAIN))
      .toMatchObject({ debit_credit: 'H', local: '5.0000', is_local_only: true });
  }, 90_000);

  it('several partials at different rates: 500 @0.310 then 300 @0.295', async () => {
    const partner = partnerOf('customer', 2);
    const invoice = await postInvoice(customerFixture, 'customer', partner, 1200, 'fc-c-multi-inv');
    const advance = await postAdvance(customerFixture, 'customer', partner, 1000, 'fc-c-multi-dp');
    await apply(customerFixture, 'customer', partner, invoice, advance, 500, 'fc-c-multi-1', '2026-10-21');
    await apply(customerFixture, 'customer', partner, invoice, advance, 300, 'fc-c-multi-2', '2026-10-23');

    await expectRemainders({
      fixture: customerFixture, side: 'customer', partner, invoice, advance,
      invoiceDocument: '400.0000', invoiceLocal: '120.0000',
      advanceDocument: '200.0000', advanceLocal: '61.0000',
    });
  }, 90_000);

  it('no FX when clearing rate equals original rate', async () => {
    const partner = partnerOf('customer', 3);
    const invoice = await postInvoice(customerFixture, 'customer', partner, 1200, 'fc-c-same-inv', DOC, '2026-10-10');
    const advance = await postAdvance(customerFixture, 'customer', partner, 1000, 'fc-c-same-dp', DOC, '2026-10-10');
    const clearing = await apply(customerFixture, 'customer', partner, invoice, advance, 800, 'fc-c-same-clr', '2026-10-11');
    await expectRemainders({
      fixture: customerFixture, side: 'customer', partner, invoice, advance,
      invoiceDocument: '400.0000', invoiceLocal: '120.0000',
      advanceDocument: '200.0000', advanceLocal: '60.0000',
    });
    expect((await journalLines(customerFixture.tenant.client, clearing.journalDocumentNumber))
      .some((l) => l.is_local_only)).toBe(false);
  }, 90_000);

  it('rounding nets exactly with a 3-decimal local currency', async () => {
    const partner = partnerOf('customer', 4);
    const invoice = await postInvoice(customerFixture, 'customer', partner, 1200, 'fc-c-round-inv');
    const advance = await postAdvance(customerFixture, 'customer', partner, 1000, 'fc-c-round-dp');
    const clearing = await apply(customerFixture, 'customer', partner, invoice, advance, 333.33, 'fc-c-round-clr');
    await expectRemainders({
      fixture: customerFixture, side: 'customer', partner, invoice, advance,
      invoiceDocument: '866.6700', invoiceLocal: '260.0010',
      advanceDocument: '666.6700', advanceLocal: '203.3340',
    });
    expect((await journalLines(customerFixture.tenant.client, clearing.journalDocumentNumber))
      .find((l) => l.gl_account === FXGAIN)).toMatchObject({ local: '1.6670', is_local_only: true });
  }, 90_000);

  it('over-application is refused', async () => {
    const partner = partnerOf('customer', 5);
    const invoice = await postInvoice(customerFixture, 'customer', partner, 1200, 'fc-c-over-inv');
    const advance = await postAdvance(customerFixture, 'customer', partner, 1000, 'fc-c-over-dp');
    await expect(apply(customerFixture, 'customer', partner, invoice, advance, 1300, 'fc-c-over-clr'))
      .rejects.toThrow(/exceeds its remaining/);
  }, 90_000);

  it('reversing a partial clearing restores the balances and reverses the FX line', async () => {
    const partner = partnerOf('customer', 6);
    const invoice = await postInvoice(customerFixture, 'customer', partner, 1200, 'fc-c-rev-inv');
    const advance = await postAdvance(customerFixture, 'customer', partner, 1000, 'fc-c-rev-dp');
    const clearing = await apply(customerFixture, 'customer', partner, invoice, advance, 800, 'fc-c-rev-clr');

    await withTenant(customerFixture.tenant.client, (tx) => reverseJournalEntry(tx, {
      client: customerFixture.tenant.client, documentNumber: clearing.journalDocumentNumber,
      fiscalYear: 2026, reversalDate: '2026-10-24', reason: 'fc partial clearing reversal',
      reversedBy: ACTOR,
    }));

    await expectRemainders({
      fixture: customerFixture, side: 'customer', partner, invoice, advance,
      invoiceDocument: '1200.0000', invoiceLocal: '360.0000',
      advanceDocument: '1000.0000', advanceLocal: '305.0000',
    });
  }, 90_000);

  it('same-currency KWD clearing: unchanged, no FX line', async () => {
    const partner = partnerOf('customer', 7);
    const invoice = await postInvoice(customerFixture, 'customer', partner, 1200, 'fc-c-kwd-inv', LOCAL);
    const advance = await postAdvance(customerFixture, 'customer', partner, 1000, 'fc-c-kwd-dp', LOCAL);
    const clearing = await apply(customerFixture, 'customer', partner, invoice, advance, 800, 'fc-c-kwd-clr', '2026-10-11', LOCAL);
    await expectRemainders({
      fixture: customerFixture, side: 'customer', partner, invoice, advance,
      invoiceDocument: '400.0000', invoiceLocal: '400.0000',
      advanceDocument: '200.0000', advanceLocal: '200.0000',
    });
    const lines = await journalLines(customerFixture.tenant.client, clearing.journalDocumentNumber);
    expect(lines.some((l) => l.is_local_only)).toBe(false);
    expect(lines.map((l) => [l.gl_account, l.debit_credit, l.local])).toEqual([
      [ALT, 'S', '800.0000'],
      [RECON.customer, 'H', '800.0000'],
    ]);
  }, 90_000);
});

// ───────────────────────────── period-end revaluation ─────────────────────────────

describe('period-end revaluation on the advance', () => {
  it('refuses a down-payment clearing over an active valuation, as the ordinary clearing does', async () => {
    const partner = partnerOf('vendor', 8);
    const invoice = await postInvoice(vendorFixture, 'vendor', partner, 1200, 'fc-v-reval-inv');
    const advance = await postAdvance(vendorFixture, 'vendor', partner, 1000, 'fc-v-reval-dp');
    // The alternative (advance) account must stand open-item managed for the valuation to hold it.
    await withTenant(vendorFixture.tenant.client, async (tx) => {
      await tx.execute(sql`
        update gl_account set account_type = 'ASSET', gl_account_type = 'BALANCE_SHEET',
          is_balance_sheet = true, is_open_item_managed = true
        where client = ${vendorFixture.tenant.client} and chart_of_accounts = 'CA01'
          and account_number = ${ALT}`);
    });

    const valuation = await executeFxValuation({
      client: vendorFixture.tenant.client, changedBy: ACTOR,
      selection: {
        companyCode: COMPANY, valuationArea: 'FCR', valuationKeyDate: '2026-11-30',
        postingDate: '2026-11-30', fiscalYear: 2026, valuationMethod: 'AVERAGE',
        includeOpenItems: true, includeBalances: false, testRun: false,
        documentType: 'SA', requestKey: 'fc-v-reval-run',
      },
      authorization: vendorFixture.actor.authorization,
    });
    expect(valuation.postingDocument).toBeTruthy();
    expect(valuation.items.some((i) => i.sourceDocument === advance.journalDocumentNumber)).toBe(true);

    // The active valuation already accounts for the same exchange difference a clearing would
    // realize, so the clearing is refused exactly as `vendor-clearing`/`customer-clearing` are.
    await expect(apply(vendorFixture, 'vendor', partner, invoice, advance, 800, 'fc-v-reval-clr', '2026-12-05'))
      .rejects.toThrow(/valued at period end/);
  }, 90_000);
});

// ───────────────────────────── payment run ─────────────────────────────

describe('payment run uses the unchanged document remainder', () => {
  it('proposes the invoice at its document remainder after a foreign advance clearing', async () => {
    const partner = partnerOf('vendor', 0);
    // The base vendor scenario above leaves V0001 with USD 400 open.
    await createPaymentRun({
      client: vendorFixture.tenant.client, changedBy: ACTOR, runDate: '2026-12-01', runId: 'FCR1',
      postingDate: '2026-12-01', documentCutoffDate: '2026-12-31', nextPaymentDate: '2026-12-31',
      companies: [{ companyCode: COMPANY, payingCompanyCode: COMPANY }], methods: ['T'],
      supplierFrom: partner, supplierTo: partner,
    });
    const run = await generateProposal({
      client: vendorFixture.tenant.client, changedBy: ACTOR, runDate: '2026-12-01', runId: 'FCR1',
    });
    const proposed = run.proposal.filter((item) => item.accountId === partner);
    expect(proposed.map((item) => item.amount)).toEqual(['400.0000']);
  }, 90_000);
});
