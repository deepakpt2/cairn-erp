import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { reverseJournalEntry } from '../src/platform/posting';
import { postVendorInvoice } from '../src/modules/finance/vendor-invoice';
import { postCustomerInvoice } from '../src/modules/finance/customer-invoice';
import { getVendorDownPayments, postVendorDownPayment } from '../src/modules/finance/vendor-down-payment';
import { getCustomerDownPayments, postCustomerDownPayment } from '../src/modules/finance/customer-down-payment';
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
import { createFinanceActor, type FinanceActor } from './helpers/finance-actor';
import { createTenant, defineTestRanges, destroyTenant, type TestTenant } from './helpers';

/**
 * Open-item consumers after a partial advance clearing.
 *
 * Invoice 1200, advance 1000, applied 800 leaves the invoice open at 400 and the advance at 200.
 * A partial clearing deliberately leaves the `Settles …` / `Applied from …` pair unstamped, so
 * every open-item consumer must exclude those application lines itself; netting the source line
 * and returning the application line would count the same 800 twice.
 *
 * These tests assert the whole filtered result set for one partner, never a `.find()` existence.
 */

const ACTOR = 'OPEN_ITEM_NETTING_TEST';
const COMPANY = '1000';
const CURRENCY = 'USD';
const RECON: Record<Side, string> = { vendor: '200000', customer: '110000' };
const ALT = '230000';

type Side = 'vendor' | 'customer';

interface Fixture {
  tenant: TestTenant;
  actor: FinanceActor;
}

let vendorFixture: Fixture;
let customerFixture: Fixture;

async function setupSide(side: Side): Promise<Fixture> {
  const tenant = await createTenant(`open-item-netting-${side}`, { currency: CURRENCY });
  await defineTestRanges(tenant, { fiscalYear: 2026 });
  const client = tenant.client;

  await withTenant(client, async (tx) => {
    await defineRange(tx, {
      client,
      objectCode: side === 'vendor' ? 'VENDINV' : 'CUSTINV',
      subObject: '*', prefix: side === 'vendor' ? 'VI' : 'CI', numberLength: 7, createdBy: ACTOR,
    });
    const prefix = side === 'vendor' ? 'V' : 'C';
    const role = side === 'vendor' ? 'SUPPLIER' : 'CUSTOMER';
    const partners = Array.from({ length: 6 }, (_, i) => `${prefix}2000${i + 1}`);
    for (const partner of partners) {
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${client}, ${partner}, 'ORGANIZATION', ${`Netting ${partner}`}, ${ACTOR})
        on conflict do nothing`);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${client}, ${partner}, ${role}, ${ACTOR}) on conflict do nothing`);
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
  });

  const actor = await createFinanceActor(client);
  return { tenant, actor };
}

function partnerOf(side: Side, index: number): string {
  return `${side === 'vendor' ? 'V' : 'C'}2000${index + 1}`;
}

interface PostedDoc { journalDocumentNumber: string }

function documentOf(posted: { journalDocumentNumber: string | null }): PostedDoc {
  if (!posted.journalDocumentNumber) throw new Error('The posting carried no journal document.');
  return { journalDocumentNumber: posted.journalDocumentNumber };
}

async function postInvoice(
  fixture: Fixture, side: Side, partner: string, amount: number, key: string,
): Promise<PostedDoc> {
  const base = {
    client: fixture.tenant.client, changedBy: ACTOR, companyCode: COMPANY,
    documentDate: '2026-10-16', postingDate: '2026-10-18', reference: key,
    currency: CURRENCY, grossAmount: amount, requestKey: key,
    lines: [{ glAccount: side === 'vendor' ? '400000' : '300000', netAmount: amount }],
  };
  return documentOf(side === 'vendor'
    ? await postVendorInvoice({ ...base, vendorNumber: partner })
    : await postCustomerInvoice({ ...base, customerNumber: partner }));
}

async function postAdvance(
  fixture: Fixture, side: Side, partner: string, amount: number, key: string,
): Promise<PostedDoc> {
  const base = {
    client: fixture.tenant.client, changedBy: ACTOR, companyCode: COMPANY,
    documentDate: '2026-10-19', postingDate: '2026-10-19', bankGlAccount: '101000',
    amount, currency: CURRENCY, specialGlIndicator: 'A', requestKey: key,
  };
  return documentOf(side === 'vendor'
    ? await postVendorDownPayment({ ...base, vendorNumber: partner })
    : await postCustomerDownPayment({ ...base, customerNumber: partner }));
}

async function applyAdvance(
  fixture: Fixture, side: Side, partner: string, invoice: PostedDoc, advance: PostedDoc,
  applied: number, key: string,
) {
  const client = fixture.tenant.client;
  if (side === 'vendor') {
    const view = await getDownPaymentClearing(client, partner, COMPANY, 'A');
    const dp = view.downPayments.find((item) => item.documentNumber === advance.journalDocumentNumber)!;
    const inv = view.invoices.find((item) => item.documentNumber === invoice.journalDocumentNumber)!;
    return clearDownPayments({
      client, changedBy: ACTOR, vendorNumber: partner, companyCode: COMPANY, indicator: 'A',
      documentDate: '2026-10-25', postingDate: '2026-10-25', clearingDate: '2026-10-26',
      currency: CURRENCY, requestKey: key,
      downPayments: [{ documentNumber: dp.documentNumber, fiscalYear: dp.fiscalYear, lineNumber: dp.lineNumber, applied }],
      invoices: [{ documentNumber: inv.documentNumber, fiscalYear: inv.fiscalYear, lineNumber: inv.lineNumber, applied }],
    });
  }
  const view = await getCustomerDownPaymentClearing(client, partner, COMPANY, 'A');
  const dp = view.downPayments.find((item) => item.documentNumber === advance.journalDocumentNumber)!;
  const inv = view.invoices.find((item) => item.documentNumber === invoice.journalDocumentNumber)!;
  return clearCustomerDownPayments({
    client, changedBy: ACTOR, customerNumber: partner, companyCode: COMPANY, indicator: 'A',
    documentDate: '2026-10-25', postingDate: '2026-10-25', clearingDate: '2026-10-26',
    currency: CURRENCY, requestKey: key,
    allocations: [{
      downPayment: { documentNumber: dp.documentNumber, fiscalYear: dp.fiscalYear, lineNumber: dp.lineNumber },
      invoice: { documentNumber: inv.documentNumber, fiscalYear: inv.fiscalYear, lineNumber: inv.lineNumber },
      amount: applied,
    }],
  });
}

async function openItems(fixture: Fixture, side: Side, partner: string) {
  const client = fixture.tenant.client;
  return side === 'vendor'
    ? (await getPayables(client, partner, COMPANY)).openItems
    : (await getReceivables(client, partner, COMPANY)).openItems;
}

async function advanceItems(fixture: Fixture, side: Side, partner: string) {
  const client = fixture.tenant.client;
  return side === 'vendor'
    ? getVendorDownPayments(client, partner, COMPANY)
    : getCustomerDownPayments(client, partner, COMPANY);
}

async function ageing(fixture: Fixture, side: Side, partner: string, keyDate = '2026-11-30') {
  const client = fixture.tenant.client;
  return side === 'vendor'
    ? getVendorAgeing(client, {
      companyCode: COMPANY, keyDate, supplierFrom: partner, supplierTo: partner,
      includeSpecialGl: true, authorization: fixture.actor.authorization,
    })
    : getCustomerAgeing(client, {
      companyCode: COMPANY, keyDate, customerFrom: partner, customerTo: partner,
      includeSpecialGl: true, authorization: fixture.actor.authorization,
    });
}

const RUN_SEED = Date.now().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-3);
let dunningRun = 0;
async function dunningItems(fixture: Fixture, partner: string) {
  dunningRun += 1;
  const runId = `${RUN_SEED}${String(dunningRun).padStart(2, '0')}`.slice(-6);
  const run = await proposeDunningRun({
    client: fixture.tenant.client, changedBy: ACTOR, runDate: '2026-12-20', runId,
    dunningDate: '2026-12-20', postedThrough: '2026-12-20', companyCodes: [COMPANY],
    customerFrom: partner, customerTo: partner,
  }, { authorization: fixture.actor.authorization });
  return run.items;
}

let paymentRun = 0;
async function paymentRunItems(fixture: Fixture, partner: string) {
  paymentRun += 1;
  const runId = `${RUN_SEED}${String(paymentRun).padStart(2, '0')}`.slice(-5);
  await createPaymentRun({
    client: fixture.tenant.client, changedBy: ACTOR, runDate: '2026-12-01', runId,
    postingDate: '2026-12-01', documentCutoffDate: '2026-12-01', nextPaymentDate: '2026-12-31',
    companies: [{ companyCode: COMPANY, payingCompanyCode: COMPANY }], methods: ['T'],
    supplierFrom: partner, supplierTo: partner,
  });
  const run = await generateProposal({
    client: fixture.tenant.client, changedBy: ACTOR, runDate: '2026-12-01', runId,
  });
  return run.proposal.filter((item) => item.accountId === partner);
}

beforeAll(async () => {
  vendorFixture = await setupSide('vendor');
  customerFixture = await setupSide('customer');
}, 120_000);

afterAll(async () => {
  if (vendorFixture) await destroyTenant(vendorFixture.tenant.client);
  if (customerFixture) await destroyTenant(customerFixture.tenant.client);
});

/**
 * The shared shape of every scenario: assert the consumer result set for one partner, then
 * assert that the advance side and ageing agree with it.
 */
async function expectScenario(input: {
  fixture: Fixture;
  side: Side;
  partner: string;
  invoice: PostedDoc;
  advance: PostedDoc | null;
  /** The exact open obligations the open-item consumer must return. */
  obligations: Array<[string, string]>;
  /** The advance remainder, or null when a full application stamped it away. */
  advanceAmount: string | null;
  clearingDocument: string | null;
}) {
  const { fixture, side, partner, obligations, advanceAmount, clearingDocument } = input;
  const client = fixture.tenant.client;

  const items = await openItems(fixture, side, partner);
  expect(items.map((item) => [item.documentNumber, item.amount])).toEqual(obligations);
  if (clearingDocument) {
    expect(items.every((item) => item.documentNumber !== clearingDocument)).toBe(true);
  }

  const advances = await advanceItems(fixture, side, partner);
  if (advanceAmount === null) {
    expect(advances).toHaveLength(0);
  } else {
    expect(advances.map((item) => [item.documentNumber, item.amount]))
      .toEqual([[input.advance!.journalDocumentNumber, advanceAmount]]);
  }

  // Ageing must name the same invoice remainder and the same advance remainder.
  const aged = await ageing(fixture, side, partner);
  expect(aged.items.find((item) => item.documentNumber === input.invoice.journalDocumentNumber)?.amount)
    .toBe(obligations[0][1]);
  const agedAdvance = aged.items.find((item) => item.documentNumber === input.advance?.journalDocumentNumber);
  if (advanceAmount === null) {
    expect(agedAdvance).toBeUndefined();
  } else {
    expect(agedAdvance?.amount).toBe(advanceAmount);
  }
  // Ageing's documented rule keeps a reset/reversed counter-line visible as an unapplied
  // credit, so only the open-item consumers above are required to hide every application
  // line. Ageing is asserted for the same per-item amounts, never changed.

  if (side === 'customer') {
    const dunned = await dunningItems(fixture, partner);
    expect(dunned.map((item) => [item.documentNumber, item.overdueAmount])).toEqual(obligations);
    if (clearingDocument) {
      expect(dunned.every((item) => item.documentNumber !== clearingDocument)).toBe(true);
    }
  } else {
    const proposed = await paymentRunItems(fixture, partner);
    expect(proposed.map((item) => [item.journalDocumentNumber, item.amount])).toEqual(obligations);
    if (clearingDocument) {
      expect(proposed.every((item) => item.journalDocumentNumber !== clearingDocument)).toBe(true);
    }
  }
}

describe('open-item consumers — vendor', () => {
  it('base: invoice 1200, advance 1000, applied 800', async () => {
    const partner = partnerOf('vendor', 0);
    const invoice = await postInvoice(vendorFixture, 'vendor', partner, 1200, 'oi-v-base-inv');
    const advance = await postAdvance(vendorFixture, 'vendor', partner, 1000, 'oi-v-base-dp');
    const clearing = await applyAdvance(vendorFixture, 'vendor', partner, invoice, advance, 800, 'oi-v-base-clr');
    await expectScenario({
      fixture: vendorFixture, side: 'vendor', partner, invoice, advance,
      obligations: [[invoice.journalDocumentNumber, '400.0000']],
      advanceAmount: '200.0000', clearingDocument: clearing.journalDocumentNumber,
    });
  }, 90_000);

  it('full clearing: invoice 1200, advance 1000, applied 1000', async () => {
    const partner = partnerOf('vendor', 1);
    const invoice = await postInvoice(vendorFixture, 'vendor', partner, 1200, 'oi-v-full-inv');
    const advance = await postAdvance(vendorFixture, 'vendor', partner, 1000, 'oi-v-full-dp');
    const clearing = await applyAdvance(vendorFixture, 'vendor', partner, invoice, advance, 1000, 'oi-v-full-clr');
    await expectScenario({
      fixture: vendorFixture, side: 'vendor', partner, invoice, advance,
      obligations: [[invoice.journalDocumentNumber, '200.0000']],
      advanceAmount: null, clearingDocument: clearing.journalDocumentNumber,
    });
  }, 90_000);

  it('several partial applications: 500 then 300', async () => {
    const partner = partnerOf('vendor', 2);
    const invoice = await postInvoice(vendorFixture, 'vendor', partner, 1200, 'oi-v-many-inv');
    const advance = await postAdvance(vendorFixture, 'vendor', partner, 1000, 'oi-v-many-dp');
    const first = await applyAdvance(vendorFixture, 'vendor', partner, invoice, advance, 500, 'oi-v-many-1');
    const second = await applyAdvance(vendorFixture, 'vendor', partner, invoice, advance, 300, 'oi-v-many-2');
    await expectScenario({
      fixture: vendorFixture, side: 'vendor', partner, invoice, advance,
      obligations: [[invoice.journalDocumentNumber, '400.0000']],
      advanceAmount: '200.0000', clearingDocument: second.journalDocumentNumber,
    });
    const items = await openItems(vendorFixture, 'vendor', partner);
    expect(items.some((item) => item.documentNumber === first.journalDocumentNumber)).toBe(false);
    expect(items.some((item) => item.documentNumber === second.journalDocumentNumber)).toBe(false);
  }, 90_000);

  it('reversing the partial clearing restores invoice 1200 and advance 1000', async () => {
    const partner = partnerOf('vendor', 3);
    const invoice = await postInvoice(vendorFixture, 'vendor', partner, 1200, 'oi-v-rev-inv');
    const advance = await postAdvance(vendorFixture, 'vendor', partner, 1000, 'oi-v-rev-dp');
    const clearing = await applyAdvance(vendorFixture, 'vendor', partner, invoice, advance, 800, 'oi-v-rev-clr');
    await withTenant(vendorFixture.tenant.client, (tx) => reverseJournalEntry(tx, {
      client: vendorFixture.tenant.client, documentNumber: clearing.journalDocumentNumber, fiscalYear: 2026,
      reversalDate: '2026-10-27', reason: 'netting consistency reversal', reversedBy: ACTOR,
    }));
    await expectScenario({
      fixture: vendorFixture, side: 'vendor', partner, invoice, advance,
      obligations: [[invoice.journalDocumentNumber, '1200.0000']],
      advanceAmount: '1000.0000', clearingDocument: clearing.journalDocumentNumber,
    });
  }, 90_000);

  it('resetting a full advance application restores invoice 1200 and advance 1000', async () => {
    const partner = partnerOf('vendor', 4);
    const invoice = await postInvoice(vendorFixture, 'vendor', partner, 1200, 'oi-v-rst-inv');
    const advance = await postAdvance(vendorFixture, 'vendor', partner, 1000, 'oi-v-rst-dp');
    const clearing = await applyAdvance(vendorFixture, 'vendor', partner, invoice, advance, 1000, 'oi-v-rst-clr');
    await resetClearing({
      client: vendorFixture.tenant.client, changedBy: ACTOR, companyCode: COMPANY,
      clearingDocument: clearing.journalDocumentNumber, fiscalYear: 2026,
      reason: 'netting consistency reset', requestKey: 'oi-v-rst-fbra',
    });
    await expectScenario({
      fixture: vendorFixture, side: 'vendor', partner, invoice, advance,
      obligations: [[invoice.journalDocumentNumber, '1200.0000']],
      advanceAmount: '1000.0000', clearingDocument: clearing.journalDocumentNumber,
    });
  }, 90_000);

  it('unapplied advance stands at 1000 and creates no payable', async () => {
    const partner = partnerOf('vendor', 5);
    const advance = await postAdvance(vendorFixture, 'vendor', partner, 1000, 'oi-v-open-dp');
    expect(await openItems(vendorFixture, 'vendor', partner)).toEqual([]);
    const advances = await advanceItems(vendorFixture, 'vendor', partner);
    expect(advances.map((item) => [item.documentNumber, item.amount]))
      .toEqual([[advance.journalDocumentNumber, '1000.0000']]);
    expect((await paymentRunItems(vendorFixture, partner))).toEqual([]);
  }, 90_000);
});

describe('open-item consumers — customer', () => {
  it('base: invoice 1200, advance 1000, applied 800', async () => {
    const partner = partnerOf('customer', 0);
    const invoice = await postInvoice(customerFixture, 'customer', partner, 1200, 'oi-c-base-inv');
    const advance = await postAdvance(customerFixture, 'customer', partner, 1000, 'oi-c-base-dp');
    const clearing = await applyAdvance(customerFixture, 'customer', partner, invoice, advance, 800, 'oi-c-base-clr');
    await expectScenario({
      fixture: customerFixture, side: 'customer', partner, invoice, advance,
      obligations: [[invoice.journalDocumentNumber, '400.0000']],
      advanceAmount: '200.0000', clearingDocument: clearing.journalDocumentNumber,
    });
  }, 90_000);

  it('full clearing: invoice 1200, advance 1000, applied 1000', async () => {
    const partner = partnerOf('customer', 1);
    const invoice = await postInvoice(customerFixture, 'customer', partner, 1200, 'oi-c-full-inv');
    const advance = await postAdvance(customerFixture, 'customer', partner, 1000, 'oi-c-full-dp');
    const clearing = await applyAdvance(customerFixture, 'customer', partner, invoice, advance, 1000, 'oi-c-full-clr');
    await expectScenario({
      fixture: customerFixture, side: 'customer', partner, invoice, advance,
      obligations: [[invoice.journalDocumentNumber, '200.0000']],
      advanceAmount: null, clearingDocument: clearing.journalDocumentNumber,
    });
  }, 90_000);

  it('several partial applications: 500 then 300', async () => {
    const partner = partnerOf('customer', 2);
    const invoice = await postInvoice(customerFixture, 'customer', partner, 1200, 'oi-c-many-inv');
    const advance = await postAdvance(customerFixture, 'customer', partner, 1000, 'oi-c-many-dp');
    const first = await applyAdvance(customerFixture, 'customer', partner, invoice, advance, 500, 'oi-c-many-1');
    const second = await applyAdvance(customerFixture, 'customer', partner, invoice, advance, 300, 'oi-c-many-2');
    await expectScenario({
      fixture: customerFixture, side: 'customer', partner, invoice, advance,
      obligations: [[invoice.journalDocumentNumber, '400.0000']],
      advanceAmount: '200.0000', clearingDocument: second.journalDocumentNumber,
    });
    const items = await openItems(customerFixture, 'customer', partner);
    expect(items.some((item) => item.documentNumber === first.journalDocumentNumber)).toBe(false);
    expect(items.some((item) => item.documentNumber === second.journalDocumentNumber)).toBe(false);
  }, 90_000);

  it('reversing the partial clearing restores invoice 1200 and advance 1000', async () => {
    const partner = partnerOf('customer', 3);
    const invoice = await postInvoice(customerFixture, 'customer', partner, 1200, 'oi-c-rev-inv');
    const advance = await postAdvance(customerFixture, 'customer', partner, 1000, 'oi-c-rev-dp');
    const clearing = await applyAdvance(customerFixture, 'customer', partner, invoice, advance, 800, 'oi-c-rev-clr');
    await withTenant(customerFixture.tenant.client, (tx) => reverseJournalEntry(tx, {
      client: customerFixture.tenant.client, documentNumber: clearing.journalDocumentNumber, fiscalYear: 2026,
      reversalDate: '2026-10-27', reason: 'netting consistency reversal', reversedBy: ACTOR,
    }));
    await expectScenario({
      fixture: customerFixture, side: 'customer', partner, invoice, advance,
      obligations: [[invoice.journalDocumentNumber, '1200.0000']],
      advanceAmount: '1000.0000', clearingDocument: clearing.journalDocumentNumber,
    });
  }, 90_000);

  it('resetting a full advance application restores invoice 1200 and advance 1000', async () => {
    const partner = partnerOf('customer', 4);
    const invoice = await postInvoice(customerFixture, 'customer', partner, 1200, 'oi-c-rst-inv');
    const advance = await postAdvance(customerFixture, 'customer', partner, 1000, 'oi-c-rst-dp');
    const clearing = await applyAdvance(customerFixture, 'customer', partner, invoice, advance, 1000, 'oi-c-rst-clr');
    await resetClearing({
      client: customerFixture.tenant.client, changedBy: ACTOR, companyCode: COMPANY,
      clearingDocument: clearing.journalDocumentNumber, fiscalYear: 2026,
      reason: 'netting consistency reset', requestKey: 'oi-c-rst-fbra',
    });
    await expectScenario({
      fixture: customerFixture, side: 'customer', partner, invoice, advance,
      obligations: [[invoice.journalDocumentNumber, '1200.0000']],
      advanceAmount: '1000.0000', clearingDocument: clearing.journalDocumentNumber,
    });
  }, 90_000);

  it('unapplied advance stands at 1000 and creates no receivable', async () => {
    const partner = partnerOf('customer', 5);
    const advance = await postAdvance(customerFixture, 'customer', partner, 1000, 'oi-c-open-dp');
    expect(await openItems(customerFixture, 'customer', partner)).toEqual([]);
    const advances = await advanceItems(customerFixture, 'customer', partner);
    expect(advances.map((item) => [item.documentNumber, item.amount]))
      .toEqual([[advance.journalDocumentNumber, '1000.0000']]);
    expect(await dunningItems(customerFixture, partner)).toEqual([]);
  }, 90_000);
});
