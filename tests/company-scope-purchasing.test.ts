/**
 * Company-scope authorization for the purchasing money-figure services (adversarial): the PO list and display,
 * the invoice overview, payment blocks and the GR/IR worklist/clearing. Two companies (A 1000, B 2000) in one
 * tenant, a second tenant, and actors who hold the capability but not the company, no scope, no capability, or a
 * plant limit. A capability alone must never reach another company's figures.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';
import { withTenant } from '../src/platform/db/client';
import { authOrgRestriction } from '../src/platform/tables/security';
import { displayPurchaseOrder, openPurchaseOrderDisplay, searchPurchaseOrders } from '../src/modules/purchasing/purchase-order-display';
import { listPurchaseOrders } from '../src/modules/purchasing/purchase-order-list';
import { listInvoiceOverview, readInvoiceOverviewDocument } from '../src/modules/purchasing/invoice-overview';
import { listBlockEvents, listBlockedInvoices, placePaymentBlock, previewPaymentBlock } from '../src/modules/purchasing/blocked-invoice';
import { listGrIrExceptions } from '../src/modules/purchasing/grir-reconciliation';
import { listGrIrMaintenance, listGrIrResiduals, postGrIrClearing, previewGrIrClearing, reverseGrIrClearing } from '../src/modules/purchasing/grir-clearing';
import {
  cancelSupplierInvoice, getInvoiceOrder, getSupplierInvoice, listInvoiceTaxCodes, postSupplierInvoice,
} from '../src/modules/purchasing/invoice-verification';
import {
  getParkedInvoice, listRecentParkedInvoices, openOrderForPark, parkSupplierInvoice, previewParkedInvoice,
} from '../src/modules/purchasing/parked-invoice';
import { changeOrder, createOrder, getOrder, orderChoices } from '../src/modules/purchasing/orders';
import { changeRequisition, createRequisition, getRequisition, requisitionChoices } from '../src/modules/purchasing/requisitions';
import { listPurchaseRequisitions } from '../src/modules/purchasing/requisition-list';
import { cancelDocumentRelease, getDocumentRelease, releaseDocument } from '../src/modules/purchasing/release';
import { defineRange } from '../src/platform/numbering';
import { changePurchaseContract, createPurchaseContract, contractChoices, getPurchaseContract, listPurchaseContracts } from '../src/modules/purchasing/contract';
import {
  changeRequestForQuotation, createRequestForQuotation, getRequestForQuotation, listRecentRequestsForQuotation,
  previewRequestForQuotationChange, resolveRequestForQuotation,
} from '../src/modules/purchasing/rfq';
import { createQuotation, getQuotation, listRecentQuotationRequests, openQuotation, previewQuotation } from '../src/modules/purchasing/quotation';
import { displayQuotation, displayQuotationForRequest } from '../src/modules/purchasing/quotation-display';
import { compareQuotations } from '../src/modules/purchasing/quotation-comparison';
import {
  changePurchasingInfoRecord, createPurchasingInfoRecord, findPurchasingInfoRecord, getPurchasingInfoRecord,
  infoRecordChoices, previewPurchasingInfoRecord, previewPurchasingInfoRecordChange,
} from '../src/modules/purchasing/info-record';
import {
  changeSourceListEntry, createSourceListEntry, getSourceList, getSourceListEntry, listRecentSourceEntries, previewSourceListEntry,
} from '../src/modules/purchasing/source-list';
import {
  changeQuotaArrangement, createQuotaArrangement, getQuotaArrangement, listQuotaArrangements, listRecentQuotaArrangements,
  previewQuotaArrangement, previewQuotaSelection,
} from '../src/modules/purchasing/quota-arrangement';
import { checkVendorEvaluation, listVendorEvaluation, saveManualScore } from '../src/modules/purchasing/vendor-evaluation';
import { orderDraftFromQuotation, orderDraftFromRequisition } from '../src/modules/purchasing/follow-on';
import { listDeliveryCompletionPolicy, setDeliveryCompletionPlantPolicy, setDeliveryCompletionPolicy } from '../src/modules/purchasing/delivery-completion';
import { openPurchaseContractDisplay } from '../src/modules/purchasing/contract-display';
import {
  changeSchedulingAgreement, createSchedulingAgreement, getSchedulingAgreement, listSchedulingAgreements, schedulingAgreementChoices,
} from '../src/modules/purchasing/scheduling-agreement';
import { openSchedulingAgreementDisplay } from '../src/modules/purchasing/scheduling-agreement-display';
import { maintainDeliverySchedule, readDeliverySchedule } from '../src/modules/purchasing/scheduling-agreement-schedule';
import { createSchedulingAgreementReleases, listSchedulingAgreementReleases } from '../src/modules/purchasing/scheduling-agreement-release';
import { saveCharacteristic } from '../src/modules/foundation/characteristic-definition';
import { saveClass, setClassStatus } from '../src/modules/foundation/class-definition';
import { saveReleaseGroup, saveReleaseStrategy, setReleaseStrategyStatus } from '../src/modules/foundation/release-strategy-definition';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';
import { FINANCE_ACTOR_CAPABILITIES, createFinanceActor, type FinanceActor } from './helpers/finance-actor';

const A = '1000';
const B = '2000';
const SEED = 'SCOPE_PURCH_SEED';
const ORDER_A = '4500000001';
const ORDER_B = '4500000002';
const INV_A = '5100000001';
const INV_B = '5100000002';

let tenant: TestTenant;
let other: TestTenant;
let client = '';
let onlyA: FinanceActor;
let onlyB: FinanceActor;
let both: FinanceActor;
let noCapability: FinanceActor;
let noScope: FinanceActor;
let plantLimited: FinanceActor;
let otherTenantActor: FinanceActor;

/** The refusal is thrown and does not disclose existence of anything in another company. */
async function refused(p: Promise<unknown>, pattern: RegExp = /scope|Company Code|includes a company|capabilit|authori|session|signed-in|not hold|No company/i) {
  let thrown: unknown;
  try { await p; } catch (error) { thrown = error; }
  expect(thrown, 'a refusal was expected').toBeInstanceOf(Error);
  expect((thrown as Error).message).toMatch(pattern);
  expect((thrown as Error).message).not.toMatch(/does not stand/);
}

async function count(table: string): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql.raw(`select count(*)::int as n from ${table} where client = '${client}'`));
    return Number((rows as unknown as Array<{ n: number }>)[0]!.n);
  });
}

const rangeSel = (companyFrom: string, companyTo?: string) => ({
  companyFrom, ...(companyTo ? { companyTo } : {}), fiscalYear: '2026',
});

beforeAll(async () => {
  tenant = await createTenant('scope-purchasing');
  client = tenant.client;
  other = await createTenant('scope-purchasing-2');
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into company_code (client, company_code, name, chart_of_accounts, fiscal_year_variant, posting_period_variant,
        currency, country, intercompany_clearing_account, created_by)
      select client, ${B}, 'B company', chart_of_accounts, fiscal_year_variant, posting_period_variant,
             currency, country, intercompany_clearing_account, ${SEED}
        from company_code where client = ${client} and company_code = ${A} on conflict do nothing`);
    const country = ((await tx.execute(sql`select country from company_code where client = ${client} and company_code = ${A}`)) as unknown as Array<{ country: string }>)[0]!.country;
    await tx.execute(sql`
      insert into plant (client, plant, name, country, company_code, created_by) values
        (${client}, 'PLA1', 'Plant A1', ${country}, ${A}, ${SEED}), (${client}, 'PLA2', 'Plant A2', ${country}, ${A}, ${SEED}),
        (${client}, 'PLB1', 'Plant B1', ${country}, ${B}, ${SEED}), (${client}, 'PLB2', 'Plant B2', ${country}, ${B}, ${SEED})
      on conflict do nothing`);
    await tx.execute(sql`insert into business_partner (client, partner_number, name, created_by) values (${client}, 'V10000', 'Vendor', ${SEED}) on conflict do nothing`);
    await tx.execute(sql`insert into purchasing_org (client, purchasing_org, name, created_by) values (${client}, 'O100', 'Org', ${SEED}) on conflict do nothing`);
    await tx.execute(sql`insert into purchasing_group (client, purchasing_group, name, created_by) values (${client}, 'G01', 'Group', ${SEED}) on conflict do nothing`);
    await tx.execute(sql`insert into material (client, material_number, description, material_type, base_unit, created_by) values (${client}, 'M100', 'Material', 'RAW', 'PC', ${SEED}) on conflict do nothing`);
    await tx.execute(sql`
      insert into purchase_order (client, order_number, document_type, supplier_number, purchasing_org, purchasing_group,
        company_code, currency, document_date, release_status, created_by) values
        (${client}, ${ORDER_A}, 'STANDARD', 'V10000', 'O100', 'G01', ${A}, 'USD', '2026-02-01', 'RELEASED', ${SEED}),
        (${client}, ${ORDER_B}, 'STANDARD', 'V10000', 'O100', 'G01', ${B}, 'USD', '2026-02-02', 'RELEASED', ${SEED})`);
    await tx.execute(sql`
      insert into purchase_order_item (client, order_number, item_number, item_category, material_number, short_text,
        quantity, unit, net_price, price_unit, net_value, plant, created_by) values
        (${client}, ${ORDER_A}, 10, 'STANDARD', 'M100', 'Line A', 10, 'PC', 10, 1, 100, 'PLA1', ${SEED}),
        (${client}, ${ORDER_B}, 10, 'STANDARD', 'M100', 'Line B', 20, 'PC', 10, 1, 200, 'PLB1', ${SEED})`);
    for (const [number, company, order] of [[INV_A, A, ORDER_A], [INV_B, B, ORDER_B]] as const) {
      await tx.execute(sql`
        insert into supplier_invoice (client, invoice_number, fiscal_year, supplier_number, company_code, purchase_order_number,
          invoice_date, posting_date, supplier_reference, currency, gross_amount, status, created_by)
        values (${client}, ${number}, 2026, 'V10000', ${company}, ${order}, '2026-03-01', '2026-03-01', ${`REF-${number}`}, 'USD', 100, 'POSTED', ${SEED})`);
    }
  });
  const caps = FINANCE_ACTOR_CAPABILITIES;
  onlyA = await createFinanceActor(client, { capabilities: caps, companyScopes: [A] });
  onlyB = await createFinanceActor(client, { capabilities: caps, companyScopes: [B] });
  both = await createFinanceActor(client, { capabilities: caps, companyScopes: [A, B] });
  noCapability = await createFinanceActor(client, { capabilities: ['FIN.JOURNAL.DISPLAY'], companyScopes: [A, B] });
  noScope = await createFinanceActor(client, { capabilities: caps, companyScopes: [] });
  plantLimited = await createFinanceActor(client, { capabilities: caps, companyScopes: [A, B], plantScopes: ['PLA1', 'PLB1'] });
  otherTenantActor = await createFinanceActor(other.client, { capabilities: caps });
}, 240_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
  if (other) await destroyTenant(other.client);
  await closeDb();
}, 240_000);

describe('purchase order list and display', () => {
  const orders = (r: { rows: Array<{ orderNumber: string }> }) => [...new Set(r.rows.map((x) => x.orderNumber))].sort();
  const list = (authorization: FinanceActor['authorization'] | undefined) =>
    listPurchaseOrders({ client, authorization, selection: { perspective: 'ORDER', maxHits: 100 } });

  it('lists only the orders of the companies the session may read', async () => {
    expect(orders(await list(onlyA.authorization))).toEqual([ORDER_A]);
    expect(orders(await list(onlyB.authorization))).toEqual([ORDER_B]);
    expect(orders(await list(both.authorization))).toEqual([ORDER_A, ORDER_B]);
    // A plant limit does not refuse a list of documents.
    expect(orders(await list(plantLimited.authorization))).toEqual([ORDER_A, ORDER_B]);
  });

  it('hides an out-of-scope order even when it is asked for by its number', async () => {
    const ask = (order: string) => listPurchaseOrders({ client, authorization: onlyA.authorization, selection: { perspective: 'ORDER', orderFrom: order, orderTo: order } })
      .then(() => 'listed', (e: Error) => e.message.replace(order, '#'));
    // Another company's order answers exactly as a number that does not exist.
    expect(await ask(ORDER_B)).toBe(await ask('4599999999'));
    expect(await ask(ORDER_B)).toMatch(/does not stand/);
  });

  it('refuses no session, no capability, no scope and another tenant', async () => {
    for (const bad of [undefined, noCapability.authorization, noScope.authorization, otherTenantActor.authorization]) {
      await refused(list(bad));
    }
  });

  it('displays a single order only inside the scope, and answers another as not found', async () => {
    expect((await displayPurchaseOrder(client, ORDER_A, onlyA.authorization)).found).toBe(true);
    const hidden = await displayPurchaseOrder(client, ORDER_B, onlyA.authorization);
    const missing = await displayPurchaseOrder(client, '4599999999', onlyA.authorization);
    expect(hidden).toEqual({ ...missing, message: expect.any(String) });
    expect(hidden.found).toBe(false);
    expect((await displayPurchaseOrder(client, ORDER_B, both.authorization)).found).toBe(true);
    expect((await displayPurchaseOrder(client, ORDER_B, plantLimited.authorization)).found).toBe(true);
    for (const bad of [undefined, noCapability.authorization, noScope.authorization, otherTenantActor.authorization]) {
      await refused(displayPurchaseOrder(client, ORDER_A, bad));
    }
  });

  it('searches only the readable companies, and the open entry point refuses an out-of-scope number as not found', async () => {
    const found = await searchPurchaseOrders(client, {}, onlyA.authorization);
    expect(found.rows.map((r) => r.orderNumber)).toEqual([ORDER_A]);
    expect((await searchPurchaseOrders(client, {}, both.authorization)).rows.map((r) => r.orderNumber).sort()).toEqual([ORDER_A, ORDER_B]);
    await refused(searchPurchaseOrders(client, {}, noScope.authorization));
    const opened = await openPurchaseOrderDisplay(client, { order: ORDER_B }, onlyA.authorization);
    expect(opened.order?.found).toBe(false);
  });
});

describe('invoice overview', () => {
  const overview = (authorization: FinanceActor['authorization'] | undefined, from: string, to?: string) =>
    listInvoiceOverview({ client, authorization, selection: rangeSel(from, to) });

  it('lists a company only to a session whose scope holds it', async () => {
    expect((await overview(onlyA.authorization, A)).rows.map((r) => r.documentNumber)).toEqual([INV_A]);
    expect((await overview(onlyB.authorization, B)).rows.map((r) => r.documentNumber)).toEqual([INV_B]);
    await refused(overview(onlyA.authorization, B));
  });

  it('refuses a range as a whole when one company is outside the scope, naming no derived company', async () => {
    await refused(overview(onlyA.authorization, A, B), /includes a company/i);
    await refused(overview(onlyB.authorization, A, B), /includes a company/i);
    expect((await overview(both.authorization, A, B)).rows.map((r) => r.documentNumber).sort()).toEqual([INV_A, INV_B]);
  });

  it('refuses no session, no capability, no scope, another tenant, and a plant-limited user a company-wide aggregate', async () => {
    for (const bad of [undefined, noCapability.authorization, noScope.authorization, otherTenantActor.authorization, plantLimited.authorization]) {
      await refused(overview(bad, A));
    }
  });

  it('reads one document only inside the scope; another company\'s is null, like a missing one', async () => {
    expect(await readInvoiceOverviewDocument(client, INV_A, onlyA.authorization)).not.toBeNull();
    expect(await readInvoiceOverviewDocument(client, INV_B, onlyA.authorization)).toBeNull();
    expect(await readInvoiceOverviewDocument(client, '5199999999', onlyA.authorization)).toBeNull();
    expect(await readInvoiceOverviewDocument(client, INV_B, both.authorization)).not.toBeNull();
    await refused(readInvoiceOverviewDocument(client, INV_A, noScope.authorization));
  });
});

describe('payment blocks', () => {
  const place = (authorization: FinanceActor['authorization'] | undefined, invoiceNumber: string) =>
    placePaymentBlock({ client, changedBy: 'SPOOFED_NAME', authorization, invoiceNumber, comment: 'hold', requestKey: `k-${invoiceNumber}-${Math.random()}` });

  it('refuses a hold, a preview and the history for an invoice of another company, writing nothing', async () => {
    const before = [await count('supplier_invoice_payment_block'), await count('supplier_invoice_payment_block_event')];
    await expect(place(onlyA.authorization, INV_B)).rejects.toThrow(/Invoice 5100000002 does not stand/);
    await expect(place(onlyA.authorization, '5199999999')).rejects.toThrow(/Invoice 5199999999 does not stand/);
    await expect(previewPaymentBlock({ client, changedBy: 'X', authorization: onlyA.authorization, invoiceNumber: INV_B, comment: 'hold', action: 'place' }))
      .rejects.toThrow(/does not stand/);
    expect(await listBlockEvents(client, INV_B, onlyA.authorization).then((r) => r.length, () => -1)).toBe(-1);
    expect([await count('supplier_invoice_payment_block'), await count('supplier_invoice_payment_block_event')]).toEqual(before);
  });

  it('refuses no session, no capability, no scope and another tenant before any invoice is read', async () => {
    for (const bad of [undefined, noCapability.authorization, noScope.authorization, otherTenantActor.authorization]) {
      await refused(place(bad, INV_A));
    }
  });

  it('refuses the blocked-invoice list for a range with an out-of-scope company, and for a plant-limited user', async () => {
    const list = (authorization: FinanceActor['authorization'] | undefined, from: string, to?: string) =>
      listBlockedInvoices({ client, authorization, companyFrom: from, ...(to ? { companyTo: to } : {}), fiscalYear: '2026' });
    await refused(list(onlyA.authorization, A, B), /includes a company/i);
    await refused(list(onlyA.authorization, B));
    expect(await list(onlyA.authorization, A)).toEqual([]);
    expect(await list(both.authorization, A, B)).toEqual([]);
    await refused(list(noScope.authorization, A));
  });
});

describe('GR/IR worklist and clearing', () => {
  const key = '2026-06-30';

  it('refuses a residual list or worklist whose range holds an out-of-scope company, as a whole', async () => {
    await refused(listGrIrResiduals({ client, authorization: onlyA.authorization, companyFrom: A, companyTo: B, keyDate: key }), /includes a company/i);
    await refused(listGrIrExceptions({ client, authorization: onlyA.authorization, companyFrom: A, companyTo: B, keyDate: key }), /includes a company/i);
    await refused(listGrIrMaintenance({ client, authorization: onlyA.authorization, companyFrom: B, keyDate: key }));
    await listGrIrResiduals({ client, authorization: onlyA.authorization, companyFrom: A, keyDate: key });
    await listGrIrResiduals({ client, authorization: both.authorization, companyFrom: A, companyTo: B, keyDate: key });
  });

  it('refuses no session, no capability, no scope, another tenant and a plant-limited user', async () => {
    for (const bad of [undefined, noCapability.authorization, noScope.authorization, otherTenantActor.authorization, plantLimited.authorization]) {
      await refused(listGrIrResiduals({ client, authorization: bad, companyFrom: A, keyDate: key }));
      await refused(listGrIrExceptions({ client, authorization: bad, companyFrom: A, keyDate: key }));
    }
  });

  it('answers a clearing preview, post or reversal for another company as not found, writing nothing', async () => {
    const before = await count('gr_ir_maintenance_link');
    await expect(previewGrIrClearing({ client, authorization: onlyA.authorization, orderNumber: ORDER_B, itemNumber: 10, keyDate: key }))
      .rejects.toThrow(/Purchase order 4500000002 does not stand/);
    await expect(postGrIrClearing({
      client, changedBy: 'SPOOFED_NAME', authorization: onlyA.authorization, orderNumber: ORDER_B, itemNumber: 10, keyDate: key,
      postingDate: key, fingerprint: 'x', comment: 'clear', requestKey: 'scope-grir-post',
    })).rejects.toThrow(/does not stand/);
    for (const bad of [undefined, noCapability.authorization, noScope.authorization, otherTenantActor.authorization]) {
      await refused(postGrIrClearing({
        client, changedBy: 'X', authorization: bad, orderNumber: ORDER_A, itemNumber: 10, keyDate: key,
        postingDate: key, fingerprint: 'x', comment: 'clear', requestKey: 'scope-grir-post-2',
      }));
      await refused(reverseGrIrClearing({
        client, changedBy: 'X', authorization: bad, documentNumber: '1', fiscalYear: 2026, reversalDate: key, comment: 'r', requestKey: 'scope-grir-rev',
      }));
    }
    expect(await count('gr_ir_maintenance_link')).toBe(before);
  });
});

describe('invoice verification and parked invoices', () => {
  const bad = () => [undefined, noCapability.authorization, noScope.authorization, otherTenantActor.authorization];
  const invoiceInput = (authorization: FinanceActor['authorization'] | undefined, order: string, key: string) => ({
    client, authorization, changedBy: 'SPOOFED_NAME', orderNumber: order, supplierReference: `R-${key}`,
    invoiceDate: '2026-03-02', postingDate: '2026-03-02', grossAmount: 100, requestKey: key,
    lines: [{ itemNumber: 10, quantity: 1, netAmount: 10 }],
  });
  const ask = (p: Promise<unknown>, needle: string) => p.then(() => 'done', (e: Error) => e.message.replace(needle, '#'));

  it('answers a posting against another company\'s order as a missing order and writes nothing', async () => {
    const before = [await count('supplier_invoice'), await count('journal_entry')];
    expect(await ask(postSupplierInvoice(invoiceInput(onlyA.authorization, ORDER_B, 'scope-iv-1')), ORDER_B))
      .toBe(await ask(postSupplierInvoice(invoiceInput(onlyA.authorization, '4599999999', 'scope-iv-2')), '4599999999'));
    expect(await ask(postSupplierInvoice(invoiceInput(onlyA.authorization, ORDER_B, 'scope-iv-1')), ORDER_B)).toMatch(/does not exist/);
    expect([await count('supplier_invoice'), await count('journal_entry')]).toEqual(before);
  });

  it('refuses a posting with no session, capability, scope or another tenant', async () => {
    for (const authorization of bad()) await refused(postSupplierInvoice(invoiceInput(authorization, ORDER_A, 'scope-iv-3')));
  });

  it('answers a cancellation of another company\'s invoice as a missing invoice and changes nothing', async () => {
    const input = (authorization: FinanceActor['authorization'] | undefined, invoice: string, key: string) =>
      ({ client, authorization, changedBy: 'SPOOFED_NAME', invoiceNumber: invoice, postingDate: '2026-03-02', requestKey: key });
    expect(await ask(cancelSupplierInvoice(input(onlyA.authorization, INV_B, 'scope-cx-1')), INV_B))
      .toBe(await ask(cancelSupplierInvoice(input(onlyA.authorization, '5199999999', 'scope-cx-2')), '5199999999'));
    for (const authorization of bad()) await refused(cancelSupplierInvoice(input(authorization, INV_A, 'scope-cx-3')));
    expect(await withTenant(client, async (tx) =>
      ((await tx.execute(sql`select status from supplier_invoice where client = ${client} and invoice_number = ${INV_B}`)) as unknown as Array<{ status: string }>)[0]!.status))
      .toBe('POSTED');
  });

  it('reads an invoice, its order and tax codes only inside the scope', async () => {
    expect((await getSupplierInvoice(client, INV_A, onlyA.authorization))?.invoiceNumber).toBe(INV_A);
    expect(await getSupplierInvoice(client, INV_B, onlyA.authorization)).toBeNull();
    expect((await getSupplierInvoice(client, INV_B, onlyB.authorization))?.invoiceNumber).toBe(INV_B);
    expect(await getInvoiceOrder(client, ORDER_B, onlyA.authorization)).toBeNull();
    expect((await getInvoiceOrder(client, ORDER_B, onlyB.authorization))?.orderNumber).toBe(ORDER_B);
    expect(await listInvoiceTaxCodes(client, B, onlyA.authorization)).toEqual([]);
    for (const authorization of bad()) {
      await refused(getSupplierInvoice(client, INV_A, authorization));
      await refused(getInvoiceOrder(client, ORDER_A, authorization));
      await refused(listInvoiceTaxCodes(client, A, authorization));
    }
  });

  it('answers parking, previewing and opening another company\'s order as a missing order, writing nothing', async () => {
    const before = await count('parked_supplier_invoice');
    const park = (authorization: FinanceActor['authorization'] | undefined, order: string, key: string) => ({
      client, authorization, changedBy: 'SPOOFED_NAME', orderNumber: order, supplierReference: `P-${key}`,
      invoiceDate: '2026-03-02', postingDate: '2026-03-02', grossAmount: 100, requestKey: key,
      lines: [{ itemNumber: 10, quantity: 1, netAmount: 10 }],
    });
    expect(await ask(parkSupplierInvoice(park(onlyA.authorization, ORDER_B, 'scope-pk-1')), ORDER_B))
      .toBe(await ask(parkSupplierInvoice(park(onlyA.authorization, '4599999999', 'scope-pk-2')), '4599999999'));
    expect(await ask(previewParkedInvoice(park(onlyA.authorization, ORDER_B, 'scope-pk-3')), ORDER_B))
      .toBe(await ask(previewParkedInvoice(park(onlyA.authorization, '4599999999', 'scope-pk-3')), '4599999999'));
    expect(await openOrderForPark(client, ORDER_B, onlyA.authorization)).toBeNull();
    expect((await openOrderForPark(client, ORDER_B, onlyB.authorization))?.orderNumber).toBe(ORDER_B);
    expect(await getParkedInvoice(client, 'PK0000000001', onlyA.authorization)).toBeNull();
    expect(await listRecentParkedInvoices(client, onlyA.authorization)).toEqual([]);
    for (const authorization of bad()) {
      await refused(parkSupplierInvoice(park(authorization, ORDER_A, 'scope-pk-4')));
      await refused(openOrderForPark(client, ORDER_A, authorization));
      await refused(getParkedInvoice(client, 'PK0000000001', authorization));
      await refused(listRecentParkedInvoices(client, authorization));
    }
    expect(await count('parked_supplier_invoice')).toBe(before);
  });
});

describe('orders, requisitions and release', () => {
  const R = 'Scope release setup';
  const bad = () => [undefined, noCapability.authorization, noScope.authorization, otherTenantActor.authorization];
  const header = (company: string) => ({
    supplierNumber: 'V10000', purchasingOrg: company === A ? '1000' : '2000', purchasingGroup: '001', companyCode: company, currency: '',
  });
  const orderItem = (plant: string) => ({
    materialNumber: '', shortText: 'Steel plate', quantity: 10, unit: 'PC', netPrice: 150, priceUnit: 1, taxCode: '',
    plant, storageLocation: '', markedForDeletion: false,
    scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 10 }], assignments: [] as never[],
  });
  const reqItem = (plant: string) => ({
    materialNumber: '', shortText: 'Steel plate', quantity: 10, unit: 'PC', deliveryDate: '2026-11-15', plant,
    storageLocation: '', purchasingGroup: '001', estimatedPrice: 150, priceUnit: 1, currency: 'USD',
    markedForDeletion: false, assignments: [] as never[],
  });
  const createdBy = (table: string, keyColumn: string, key: string) => withTenant(client, async (tx) =>
    ((await tx.execute(sql.raw(`select created_by from ${table} where client = '${client}' and ${keyColumn} = '${key}'`))) as unknown as Array<{ created_by: string }>)[0]?.created_by);
  const ask = (p: Promise<unknown>, needle: string) => p.then(() => 'done', (e: Error) => e.message.replace(needle, '#'));
  let orderA = '';
  let orderB = '';
  let reqA = '';
  let reqB = '';

  beforeAll(async () => {
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: R });
      await defineRange(tx, { client, objectCode: 'PURCHREQ', subObject: 'NB', prefix: 'PR', numberLength: 7, createdBy: R });
      await tx.execute(sql`insert into purchasing_org (client, purchasing_org, name, company_code, created_by) values (${client}, '1000', 'Org 1000', ${A}, ${R}) on conflict do nothing`);
      await tx.execute(sql`insert into purchasing_org (client, purchasing_org, name, company_code, created_by) values (${client}, '2000', 'Org 2000', ${B}, ${R}) on conflict do nothing`);
      await tx.execute(sql`insert into purchasing_org_plant (client, purchasing_org, plant, created_by) values (${client}, '1000', 'PLA1', ${R}), (${client}, '1000', 'PLA2', ${R}), (${client}, '2000', 'PLB1', ${R}), (${client}, '2000', 'PLB2', ${R}) on conflict do nothing`);
      await tx.execute(sql`insert into bp_role (client, partner_number, role_code, created_by) values (${client}, 'V10000', 'SUPPLIER', ${R}) on conflict do nothing`);
      await tx.execute(sql`insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by) values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', ${R}), (${client}, 'V10000', 'SUPPLIER', '2000', 'USD', ${R}) on conflict do nothing`);
      await tx.execute(sql`insert into purchasing_group (client, purchasing_group, name, created_by) values (${client}, '001', 'Group 001', ${R}) on conflict do nothing`);
    });
    await saveCharacteristic({
      client, changedBy: R, mode: 'CREATE', characteristicName: 'TOTAL_VALUE', description: 'Total document value',
      dataFormat: 'NUM', valueLength: 13, decimalPlaces: 2, unit: '', currency: '', negativeValuesAllowed: false,
      caseSensitive: false, intervalsAllowed: true, additionalValuesAllowed: true, valueAssignment: 'SINGLE',
      requiredEntry: false, values: [], reason: R,
    });
    await saveClass({
      client, changedBy: R, mode: 'CREATE', classType: 'PURCHASE_ORDER', className: 'PO_RELEASE', description: 'PO release class',
      assignments: [{ characteristicName: 'TOTAL_VALUE', requiredForClassification: true }], reason: R,
    });
    await setClassStatus({ client, changedBy: R, classType: 'PURCHASE_ORDER', className: 'PO_RELEASE', status: 'ACTIVE', reason: R });
    await saveReleaseGroup({
      client, changedBy: R, mode: 'CREATE', groupCode: 'PO', documentCategory: 'PURCHASE_ORDER', description: 'PO releases',
      codes: [{ code: 'MGR', description: 'Manager' }], reason: R,
    });
    await saveReleaseStrategy({
      client, changedBy: R, mode: 'CREATE', groupCode: 'PO', strategyCode: 'HIGH', description: 'High value', className: 'PO_RELEASE',
      priority: 100, criteria: [{ characteristicName: 'TOTAL_VALUE', operator: 'GE', valueFrom: '1000', valueTo: '' }],
      steps: ['MGR'], reason: R,
    });
    await setReleaseStrategyStatus({ client, changedBy: R, groupCode: 'PO', strategyCode: 'HIGH', status: 'ACTIVE', reason: R });
    // Real, scoped creations: each company's own actor creates its own documents.
    orderA = (await createOrder({ client, authorization: onlyA.authorization, changedBy: 'SPOOFED_NAME', ...header(A), items: [orderItem('PLA1')] })).orderNumber;
    orderB = (await createOrder({ client, authorization: onlyB.authorization, changedBy: 'SPOOFED_NAME', ...header(B), items: [orderItem('PLB1')] })).orderNumber;
    reqA = (await createRequisition({ client, authorization: onlyA.authorization, changedBy: 'SPOOFED_NAME', items: [reqItem('PLA1')] })).requisitionNumber;
    reqB = (await createRequisition({ client, authorization: onlyB.authorization, changedBy: 'SPOOFED_NAME', items: [reqItem('PLB1')] })).requisitionNumber;
  }, 240_000);

  it('records the verified session user as the creator, never a supplied name', async () => {
    expect(await createdBy('purchase_order', 'order_number', orderA)).toBe(onlyA.username);
    expect(await createdBy('purchase_order', 'order_number', orderB)).toBe(onlyB.username);
    expect(await createdBy('purchase_requisition_item', 'requisition_number', reqA)).toBe(onlyA.username);
  });

  it('refuses an order or requisition for a company or plant outside the scope, writing nothing', async () => {
    const before = [await count('purchase_order'), await count('purchase_requisition_item')];
    await refused(createOrder({ client, authorization: onlyA.authorization, changedBy: 'X', ...header(B), items: [orderItem('PLB1')] }));
    await refused(createOrder({ client, authorization: onlyA.authorization, changedBy: 'X', ...header(A), items: [orderItem('PLB1')] }));
    await refused(createRequisition({ client, authorization: onlyA.authorization, changedBy: 'X', items: [reqItem('PLB1')] }));
    for (const authorization of bad()) {
      await refused(createOrder({ client, authorization, changedBy: 'X', ...header(A), items: [orderItem('PLA1')] }));
      await refused(createRequisition({ client, authorization, changedBy: 'X', items: [reqItem('PLA1')] }));
    }
    expect([await count('purchase_order'), await count('purchase_requisition_item')]).toEqual(before);
  });

  it('opens and changes an order only inside the scope; another company\'s answers as a missing one', async () => {
    expect((await getOrder(client, orderA, onlyA.authorization))?.orderNumber).toBe(orderA);
    expect(await getOrder(client, orderB, onlyA.authorization)).toBeNull();
    expect((await getOrder(client, orderB, both.authorization))?.orderNumber).toBe(orderB);
    for (const authorization of bad()) await refused(getOrder(client, orderA, authorization));
    const change = (authorization: FinanceActor['authorization'] | undefined, order: string, company: string, plant: string) =>
      changeOrder({ client, authorization, changedBy: 'X', orderNumber: order, ...header(company), items: [{ ...orderItem(plant), itemNumber: 10 }] } as never);
    expect(await ask(change(onlyA.authorization, orderB, B, 'PLB1'), orderB)).toBe(await ask(change(onlyA.authorization, '4599999999', B, 'PLB1'), '4599999999'));
    expect(await ask(change(onlyA.authorization, orderB, B, 'PLB1'), orderB)).toMatch(/does not exist/);
    for (const authorization of bad()) await refused(change(authorization, orderA, A, 'PLA1'));
  });

  it('offers only the readable companies, plants and storage locations as choices', async () => {
    const a = await orderChoices(client, onlyA.authorization);
    expect(JSON.stringify(a)).toContain('PLA1');
    expect(JSON.stringify(a)).not.toContain('PLB1');
    expect(JSON.stringify(await requisitionChoices(client, onlyA.authorization))).not.toContain('PLB1');
    for (const authorization of bad()) {
      await refused(orderChoices(client, authorization));
      await refused(requisitionChoices(client, authorization));
    }
  });

  it('opens, changes and lists requisitions only inside the scope', async () => {
    expect((await getRequisition(client, reqA, onlyA.authorization))?.items).toHaveLength(1);
    expect(await getRequisition(client, reqB, onlyA.authorization)).toBeNull();
    for (const authorization of bad()) await refused(getRequisition(client, reqA, authorization));
    const change = (authorization: FinanceActor['authorization'] | undefined, number: string, plant: string) =>
      changeRequisition({ client, authorization, changedBy: 'X', requisitionNumber: number, items: [{ ...reqItem(plant), itemNumber: 10 }] } as never);
    expect(await ask(change(onlyA.authorization, reqB, 'PLB1'), reqB)).toBe(await ask(change(onlyA.authorization, 'PR-9999999', 'PLB1'), 'PR-9999999'));
    for (const authorization of bad()) await refused(change(authorization, reqA, 'PLA1'));
    const list = (authorization: FinanceActor['authorization'] | undefined) =>
      listPurchaseRequisitions({ client, authorization, selection: { displayClosed: false, maxHits: 100 } });
    const numbers = (r: { rows: Array<{ requisitionNumber: string }> }) => [...new Set(r.rows.map((x) => x.requisitionNumber))].sort();
    expect(numbers(await list(onlyA.authorization))).toEqual([reqA]);
    expect(numbers(await list(onlyB.authorization))).toEqual([reqB]);
    expect(numbers(await list(both.authorization))).toEqual([reqA, reqB].sort());
    expect(numbers(await list(plantLimited.authorization))).toEqual([reqA, reqB].sort());
    for (const authorization of bad()) await refused(list(authorization));
  });

  it('releases and cancels a release only inside the scope; another company\'s answers as needing no release', async () => {
    expect(await getDocumentRelease(client, 'PURCHASE_ORDER', orderA)).toMatchObject({ status: 'PENDING' });
    const act = (authorization: FinanceActor['authorization'] | undefined, order: string) =>
      ({ client, authorization, changedBy: 'SPOOFED_NAME', documentCategory: 'PURCHASE_ORDER', documentNumber: order, releaseCode: 'MGR' });
    expect(await ask(releaseDocument(act(onlyB.authorization, orderA)), orderA))
      .toBe(await ask(releaseDocument(act(onlyB.authorization, '4599999999')), '4599999999'));
    await expect(releaseDocument(act(onlyB.authorization, orderA))).rejects.toThrow(/needs no release/);
    for (const authorization of bad()) {
      await refused(releaseDocument(act(authorization, orderA)));
      await refused(cancelDocumentRelease(act(authorization, orderA)));
    }
    await expect(cancelDocumentRelease(act(onlyB.authorization, orderA))).rejects.toThrow(/needs no release|no release/);
    expect(await getDocumentRelease(client, 'PURCHASE_ORDER', orderA)).toMatchObject({ status: 'PENDING' });
    // The company's own actor can release; the act is recorded under the session user.
    expect(await releaseDocument(act(onlyA.authorization, orderA))).toMatchObject({ status: 'RELEASED' });
    const by = await withTenant(client, async (tx) => (await tx.execute(sql`
      select changed_by from change_document where client = ${client} and object_key = ${orderA} order by changed_at desc limit 1`)) as unknown as Array<{ changed_by: string }>);
    expect(by[0]?.changed_by).toBe(onlyA.username);
  });
});

describe('purchasing org and group scope', () => {
  const R = 'Scope level setup';
  let orgA: FinanceActor;
  let groupOther: FinanceActor;
  const header = (company: string) => ({
    supplierNumber: 'V10000', purchasingOrg: company === A ? '1000' : '2000', purchasingGroup: '001', companyCode: company, currency: '',
  });
  const item = (plant: string) => ({
    materialNumber: '', shortText: 'Steel plate', quantity: 10, unit: 'PC', netPrice: 150, priceUnit: 1, taxCode: '',
    plant, storageLocation: '', markedForDeletion: false,
    scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 10 }], assignments: [] as never[],
  });
  const reqItem = (plant: string, group = '001') => ({
    materialNumber: '', shortText: 'Steel plate', quantity: 10, unit: 'PC', deliveryDate: '2026-11-15', plant,
    storageLocation: '', purchasingGroup: group, estimatedPrice: 150, priceUnit: 1, currency: 'USD',
    markedForDeletion: false, assignments: [] as never[],
  });
  const orderNumbers = async (a: FinanceActor) =>
    (await listPurchaseOrders({ client, authorization: a.authorization, selection: { perspective: 'VENDOR', scope: 'ALL', maxHits: 500 } as never }))
      .rows.map((r) => r.orderNumber);
  let orderOrg1000 = '';
  let orderOrg2000 = '';
  let reqNumber = '';

  beforeAll(async () => {
    orgA = await createFinanceActor(client, { capabilities: FINANCE_ACTOR_CAPABILITIES, companyScopes: [A, B] });
    groupOther = await createFinanceActor(client, { capabilities: FINANCE_ACTOR_CAPABILITIES, companyScopes: [A, B] });
    await withTenant(client, async (tx) => {
      await tx.insert(authOrgRestriction).values([
        { id: randomUUID(), client, userId: orgA.userId, scopeType: 'PURCHASING_ORG', scopeValue: '1000', createdBy: R },
        { id: randomUUID(), client, userId: groupOther.userId, scopeType: 'PURCHASING_GROUP', scopeValue: '999', createdBy: R },
      ]);
    });
    orderOrg1000 = (await createOrder({ client, authorization: both.authorization, changedBy: 'X', ...header(A), items: [item('PLA1')] })).orderNumber;
    orderOrg2000 = (await createOrder({ client, authorization: both.authorization, changedBy: 'X', ...header(B), items: [item('PLB1')] })).orderNumber;
    reqNumber = (await createRequisition({ client, authorization: both.authorization, changedBy: 'X', items: [reqItem('PLA1')] })).requisitionNumber;
  }, 240_000);

  it('reads an order only inside the purchasing org and group the actor holds, a missing one otherwise', async () => {
    expect((await getOrder(client, orderOrg1000, orgA.authorization))?.orderNumber).toBe(orderOrg1000);
    expect(await getOrder(client, orderOrg2000, orgA.authorization)).toBeNull();
    expect(await getOrder(client, orderOrg1000, groupOther.authorization)).toBeNull();
    expect((await getOrder(client, orderOrg2000, both.authorization))?.orderNumber).toBe(orderOrg2000);
  });

  it('judges invoices, parked invoices and their orders by the order\'s purchasing org and group', async () => {
    const ask = (p: Promise<unknown>, needle: string) => p.then(() => 'done', (e: Error) => e.message.replace(needle, '#'));
    // The seeded orders sit in organisation O100 and group G01: neither held level names them.
    expect((await getSupplierInvoice(client, INV_A, both.authorization))?.invoiceNumber).toBe(INV_A);
    for (const actor of [orgA, groupOther]) {
      expect(await getSupplierInvoice(client, INV_A, actor.authorization)).toBeNull();
      expect(await getInvoiceOrder(client, ORDER_A, actor.authorization)).toBeNull();
      expect(await openOrderForPark(client, ORDER_A, actor.authorization)).toBeNull();
    }
    expect((await openOrderForPark(client, ORDER_A, both.authorization))?.orderNumber).toBe(ORDER_A);
    const before = [await count('supplier_invoice'), await count('parked_supplier_invoice'), await count('journal_entry')];
    const post = (a: FinanceActor, order: string, key: string) => ({
      client, authorization: a.authorization, changedBy: 'X', orderNumber: order, supplierReference: `R-${key}`,
      invoiceDate: '2026-03-02', postingDate: '2026-03-02', grossAmount: 100, requestKey: key, lines: [{ itemNumber: 10, quantity: 1, netAmount: 10 }],
    });
    expect(await ask(postSupplierInvoice(post(orgA, ORDER_A, 'scope-lv-1')), ORDER_A)).toBe(await ask(postSupplierInvoice(post(orgA, '4599999999', 'scope-lv-2')), '4599999999'));
    expect(await ask(postSupplierInvoice(post(orgA, ORDER_A, 'scope-lv-1')), ORDER_A)).toMatch(/does not exist/);
    expect(await ask(parkSupplierInvoice(post(groupOther, ORDER_A, 'scope-lv-3')), ORDER_A)).toMatch(/does not stand/);
    expect(await ask(cancelSupplierInvoice({ client, authorization: groupOther.authorization, changedBy: 'X', invoiceNumber: INV_A, postingDate: '2026-03-02', requestKey: 'scope-lv-4' }), INV_A)).toMatch(/does not exist/);
    expect([await count('supplier_invoice'), await count('parked_supplier_invoice'), await count('journal_entry')]).toEqual(before);
  });

  it('lists, searches and displays orders only inside the held levels', async () => {
    expect(await orderNumbers(orgA)).toContain(orderOrg1000);
    expect(await orderNumbers(orgA)).not.toContain(orderOrg2000);
    expect(await orderNumbers(groupOther)).not.toContain(orderOrg1000);
    expect(await orderNumbers(both)).toEqual(expect.arrayContaining([orderOrg1000, orderOrg2000]));
    const display = await displayPurchaseOrder(client, orderOrg2000, orgA.authorization);
    expect(display.found).toBe(false);
    const search = await searchPurchaseOrders(client, {}, orgA.authorization);
    expect(JSON.stringify(search)).not.toContain(orderOrg2000);
  });

  it('refuses writing an order into an organisation or group outside the held levels, and a change as a missing order', async () => {
    const before = await count('purchase_order');
    await refused(createOrder({ client, authorization: orgA.authorization, changedBy: 'X', ...header(B), items: [item('PLB1')] }), /outside your access/);
    await refused(createOrder({ client, authorization: groupOther.authorization, changedBy: 'X', ...header(A), items: [item('PLA1')] }), /outside your access/);
    const change = (a: FinanceActor, order: string) => changeOrder({
      client, authorization: a.authorization, changedBy: 'X', orderNumber: order, ...header(A), items: [{ ...item('PLA1'), itemNumber: 10 }],
    } as never).then(() => 'done', (e: Error) => e.message.replace(order, '#'));
    expect(await change(orgA, orderOrg2000)).toMatch(/does not exist/);
    expect(await change(groupOther, orderOrg1000)).toMatch(/does not exist/);
    expect(await count('purchase_order')).toBe(before);
  });

  it('offers only the purchasing orgs and groups inside the held levels', async () => {
    const choices = await orderChoices(client, orgA.authorization);
    expect(choices.purchasingOrgs.map((o) => o.purchasingOrg)).toEqual(['1000']);
    expect((await orderChoices(client, groupOther.authorization)).purchasingGroups).toEqual([]);
    expect((await requisitionChoices(client, groupOther.authorization)).purchasingGroups).toEqual([]);
  });

  it('judges requisitions by their purchasing group', async () => {
    expect(await getRequisition(client, reqNumber, groupOther.authorization)).toBeNull();
    expect((await getRequisition(client, reqNumber, orgA.authorization))?.requisitionNumber).toBe(reqNumber);
    await refused(createRequisition({ client, authorization: groupOther.authorization, changedBy: 'X', items: [reqItem('PLA1')] }), /outside your access/);
    const rows = await listPurchaseRequisitions({ client, authorization: groupOther.authorization, selection: { displayClosed: false, maxHits: 100 } });
    expect(rows.rows).toEqual([]);
  });

  it('answers a release of a document outside the held levels as needing no release', async () => {
    const msg = await releaseDocument({ client, authorization: orgA.authorization, changedBy: 'X', documentCategory: 'PURCHASE_ORDER', documentNumber: orderOrg2000, releaseCode: 'MGR' } as never)
      .then(() => 'done', (e: Error) => e.message);
    expect(msg).toMatch(/needs no release/);
  });
});

describe('contracts and scheduling agreements', () => {
  const R = 'Scope contract setup';
  let orgOnly: FinanceActor;
  let groupOnly: FinanceActor;
  const header = (company: string, extra: Record<string, unknown> = {}) => ({
    documentType: 'Q1', supplierNumber: 'V10000', purchasingOrg: company === A ? '1000' : '2000', purchasingGroup: '001',
    companyCode: company, currency: 'USD', validityStart: '2026-01-01', validityEnd: '2026-12-31', ...extra,
  });
  const cItems = [{ shortText: 'Steel', targetQuantity: 10, unit: 'PC', netPrice: 5 }];
  const sItems = (plant: string) => [{ shortText: 'Steel', targetQuantity: 100, unit: 'PC', netPrice: 5, plant }];
  const createdBy = (table: string, keyColumn: string, key: string) => withTenant(client, async (tx) =>
    ((await tx.execute(sql.raw(`select created_by from ${table} where client = '${client}' and ${keyColumn} = '${key}'`))) as unknown as Array<{ created_by: string }>)[0]?.created_by);
  const bad = () => [undefined, noCapability.authorization, noScope.authorization, otherTenantActor.authorization];
  let contractA = '';
  let contractB = '';
  let agreementA = '';
  let agreementB = '';

  beforeAll(async () => {
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'PURCHCONT', subObject: '*', prefix: '46', numberLength: 10, createdBy: R });
      await defineRange(tx, { client, objectCode: 'SCHEDAGREE', subObject: '*', prefix: '55', numberLength: 10, createdBy: R });
      await defineRange(tx, { client, objectCode: 'SARELEASE', subObject: '*', prefix: '58', numberLength: 10, createdBy: R });
      await tx.execute(sql`insert into purchasing_org (client, purchasing_org, name, company_code, created_by) values (${client}, '1000', 'Org 1000', ${A}, ${R}), (${client}, '2000', 'Org 2000', ${B}, ${R}) on conflict do nothing`);
      await tx.execute(sql`insert into purchasing_org_plant (client, purchasing_org, plant, created_by) values (${client}, '1000', 'PLA1', ${R}), (${client}, '2000', 'PLB1', ${R}) on conflict do nothing`);
      await tx.execute(sql`insert into bp_role (client, partner_number, role_code, created_by) values (${client}, 'V10000', 'SUPPLIER', ${R}) on conflict do nothing`);
      await tx.execute(sql`insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by) values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', ${R}), (${client}, 'V10000', 'SUPPLIER', '2000', 'USD', ${R}) on conflict do nothing`);
      await tx.execute(sql`insert into purchasing_group (client, purchasing_group, name, created_by) values (${client}, '001', 'Group 001', ${R}) on conflict do nothing`);
      await tx.execute(sql`insert into purchasing_contract_type (client, document_type, description, category, created_by) values (${client}, 'Q1', 'Quantity contract', 'QUANTITY', ${R}) on conflict do nothing`);
      await tx.execute(sql`insert into scheduling_agreement_type (client, document_type, description, category, created_by) values (${client}, 'LP', 'Scheduling agreement', 'SCHEDULING', ${R}) on conflict do nothing`);
    });
    orgOnly = await createFinanceActor(client, { capabilities: FINANCE_ACTOR_CAPABILITIES, companyScopes: [A, B] });
    groupOnly = await createFinanceActor(client, { capabilities: FINANCE_ACTOR_CAPABILITIES, companyScopes: [A, B] });
    await withTenant(client, async (tx) => {
      await tx.insert(authOrgRestriction).values([
        { id: randomUUID(), client, userId: orgOnly.userId, scopeType: 'PURCHASING_ORG', scopeValue: '1000', createdBy: R },
        { id: randomUUID(), client, userId: groupOnly.userId, scopeType: 'PURCHASING_GROUP', scopeValue: '999', createdBy: R },
      ]);
    });
    contractA = (await createPurchaseContract({ client, authorization: onlyA.authorization, changedBy: 'SPOOFED_NAME', ...header(A), items: cItems })).contractNumber;
    contractB = (await createPurchaseContract({ client, authorization: onlyB.authorization, changedBy: 'SPOOFED_NAME', ...header(B), items: cItems })).contractNumber;
    agreementA = (await createSchedulingAgreement({ client, authorization: onlyA.authorization, changedBy: 'SPOOFED_NAME', ...header(A, { documentType: 'LP' }), items: sItems('PLA1') })).agreementNumber;
    agreementB = (await createSchedulingAgreement({ client, authorization: onlyB.authorization, changedBy: 'SPOOFED_NAME', ...header(B, { documentType: 'LP' }), items: sItems('PLB1') })).agreementNumber;
  }, 240_000);

  it('records the verified session user, never a supplied name', async () => {
    expect(await createdBy('purchase_contract', 'contract_number', contractA)).toBe(onlyA.username);
    expect(await createdBy('purchase_contract', 'contract_number', contractB)).toBe(onlyB.username);
    expect(await createdBy('scheduling_agreement', 'agreement_number', agreementA)).toBe(onlyA.username);
  });

  it('refuses no session, no capability, no scope and another tenant before anything is read or written', async () => {
    const contracts = await count('purchase_contract');
    const agreements = await count('scheduling_agreement');
    for (const authorization of bad()) {
      await refused(createPurchaseContract({ client, authorization, changedBy: 'X', ...header(A), items: cItems }));
      await refused(getPurchaseContract(client, contractA, authorization));
      await refused(listPurchaseContracts(client, authorization));
      await refused(contractChoices(client, authorization));
      await refused(createSchedulingAgreement({ client, authorization, changedBy: 'X', ...header(A, { documentType: 'LP' }), items: sItems('PLA1') }));
      await refused(getSchedulingAgreement(client, agreementA, authorization));
      await refused(listSchedulingAgreements(client, authorization));
      await refused(schedulingAgreementChoices(client, authorization));
      await refused(maintainDeliverySchedule({ client, authorization, changedBy: 'X', agreementNumber: agreementA, itemNumber: 10, lines: [{ deliveryDate: '2026-06-01', quantity: 1 }] } as never));
      await refused(createSchedulingAgreementReleases({ client, authorization, changedBy: 'X', agreementFrom: agreementA, releaseTypes: ['FRC'] } as never));
      await refused(listSchedulingAgreementReleases(client, agreementA, authorization));
    }
    expect(await count('purchase_contract')).toBe(contracts);
    expect(await count('scheduling_agreement')).toBe(agreements);
  });

  it('refuses writing into another company, and answers a change of another company\'s document as a missing one', async () => {
    const contracts = await count('purchase_contract');
    const agreements = await count('scheduling_agreement');
    await refused(createPurchaseContract({ client, authorization: onlyA.authorization, changedBy: 'X', ...header(B), items: cItems }), /outside your access/);
    await refused(createSchedulingAgreement({ client, authorization: onlyA.authorization, changedBy: 'X', ...header(B, { documentType: 'LP' }), items: sItems('PLB1') }), /outside your access/);
    const ask = (p: Promise<unknown>, n: string) => p.then(() => 'done', (e: Error) => e.message.replace(n, '#'));
    expect(await ask(changePurchaseContract({ client, authorization: onlyA.authorization, changedBy: 'X', contractNumber: contractB, ...header(A), items: cItems } as never), contractB)).toMatch(/does not exist/);
    expect(await ask(changeSchedulingAgreement({ client, authorization: onlyA.authorization, changedBy: 'X', agreementNumber: agreementB, ...header(A, { documentType: 'LP' }), items: sItems('PLA1') } as never), agreementB)).toMatch(/does not exist/);
    expect(await ask(maintainDeliverySchedule({ client, authorization: onlyA.authorization, changedBy: 'X', agreementNumber: agreementB, itemNumber: 10, lines: [{ deliveryDate: '2026-06-01', quantity: 1 }] } as never), agreementB)).toMatch(/does not exist/);
    expect(await count('purchase_contract')).toBe(contracts);
    expect(await count('scheduling_agreement')).toBe(agreements);
    expect(await count('scheduling_agreement_schedule_line')).toBe(0);
  });

  it('reads, lists, displays and offers choices only inside the scope; another company answers as missing', async () => {
    expect((await getPurchaseContract(client, contractA, onlyA.authorization))?.contractNumber).toBe(contractA);
    expect(await getPurchaseContract(client, contractB, onlyA.authorization)).toBeNull();
    expect(await getSchedulingAgreement(client, agreementB, onlyA.authorization)).toBeNull();
    expect((await listPurchaseContracts(client, onlyA.authorization)).map((r) => r.contractNumber)).toEqual(expect.arrayContaining([contractA]));
    expect((await listPurchaseContracts(client, onlyA.authorization)).map((r) => r.contractNumber)).not.toContain(contractB);
    expect((await listSchedulingAgreements(client, onlyA.authorization)).map((r) => r.agreementNumber)).not.toContain(agreementB);
    expect((await openPurchaseContractDisplay(client, { contract: contractB }, onlyA.authorization)).document).toBeNull();
    expect((await openSchedulingAgreementDisplay(client, { agreement: agreementB }, onlyA.authorization)).document).toBeNull();
    expect(await readDeliverySchedule(client, agreementB, undefined, onlyA.authorization)).toBeNull();
    expect(await listSchedulingAgreementReleases(client, agreementB, onlyA.authorization)).toEqual([]);
    expect((await contractChoices(client, onlyA.authorization)).companies.map((c) => c.companyCode)).toEqual([A]);
    expect((await schedulingAgreementChoices(client, onlyA.authorization)).companies.map((c) => c.companyCode)).toEqual([A]);
  });

  it('maintains a schedule only inside the scope and records the session user', async () => {
    await maintainDeliverySchedule({ client, authorization: onlyA.authorization, changedBy: 'SPOOFED_NAME', agreementNumber: agreementA, itemNumber: 10, lines: [{ deliveryDate: '2026-06-01', quantity: 5 }] } as never);
    const who = await withTenant(client, async (tx) =>
      ((await tx.execute(sql`select created_by from scheduling_agreement_schedule_line where client = ${client} and agreement_number = ${agreementA}`)) as unknown as Array<{ created_by: string }>)[0]?.created_by);
    expect(who).toBe(onlyA.username);
  });

  it('refuses a release run whose selection reaches another company as a whole, and a named one as missing', async () => {
    const run = (a: FinanceActor, sel: Record<string, unknown>) => createSchedulingAgreementReleases({
      client, authorization: a.authorization, changedBy: 'X', releaseTypes: ['FRC'], generationDate: '2026-06-02', ...sel,
    } as never).then((r) => r, (e: Error) => e);
    const wide = await run(onlyA, { supplierNumber: 'V10000' });
    expect(wide).toBeInstanceOf(Error);
    expect((wide as Error).message).toMatch(/outside your access/);
    const named = await run(onlyA, { agreementFrom: agreementB });
    expect(JSON.stringify(named)).toMatch(/does not exist/);
    expect(await count('scheduling_agreement_release')).toBe(0);
  });

  it('judges purchasing org and group levels on contracts and agreements', async () => {
    const before = await count('purchase_contract');
    expect((await getPurchaseContract(client, contractA, orgOnly.authorization))?.contractNumber).toBe(contractA);
    expect(await getPurchaseContract(client, contractB, orgOnly.authorization)).toBeNull();
    expect(await getPurchaseContract(client, contractA, groupOnly.authorization)).toBeNull();
    expect(await getSchedulingAgreement(client, agreementB, orgOnly.authorization)).toBeNull();
    expect(await getSchedulingAgreement(client, agreementA, groupOnly.authorization)).toBeNull();
    expect((await listSchedulingAgreements(client, groupOnly.authorization))).toEqual([]);
    expect((await contractChoices(client, orgOnly.authorization)).organizations.map((o) => o.purchasingOrg)).toEqual(['1000']);
    await refused(createPurchaseContract({ client, authorization: orgOnly.authorization, changedBy: 'X', ...header(B), items: cItems }), /outside your access/);
    await refused(createPurchaseContract({ client, authorization: groupOnly.authorization, changedBy: 'X', ...header(A), items: cItems }), /outside your access/);
    expect(await count('purchase_contract')).toBe(before);
  });

  it('answers a replayed request key that points at another company\'s document as refused, not as that document', async () => {
    const key = `scope-replay-${randomUUID()}`;
    const mine = await createPurchaseContract({ client, authorization: onlyB.authorization, changedBy: 'X', ...header(B), requestKey: key, items: cItems });
    await refused(createPurchaseContract({ client, authorization: onlyA.authorization, changedBy: 'X', ...header(A), requestKey: key, items: cItems }), /outside your access/);
    expect(mine.contractNumber).toBeTruthy();
    const skey = `scope-replay-${randomUUID()}`;
    await createSchedulingAgreement({ client, authorization: onlyB.authorization, changedBy: 'X', ...header(B, { documentType: 'LP' }), requestKey: skey, items: sItems('PLB1') });
    await refused(createSchedulingAgreement({ client, authorization: onlyA.authorization, changedBy: 'X', ...header(A, { documentType: 'LP' }), requestKey: skey, items: sItems('PLA1') }), /outside your access/);
  });
});

describe('requests for quotation and quotations', () => {
  const R = 'Scope rfq setup';
  let orgOnly: FinanceActor;
  const bad = () => [undefined, noCapability.authorization, noScope.authorization, otherTenantActor.authorization];
  const header = (org: string, extra: Record<string, unknown> = {}) => ({
    purchasingOrg: org, purchasingGroup: '001', rfqDate: '2026-10-22', quotationDeadline: '2026-12-31', ...extra,
  });
  const lines = (plant: string) => [{ materialNumber: 'M100', quantity: '5', plant, deliveryDate: '2026-12-01' }];
  const suppliers = [{ partnerNumber: 'V10000' }];
  let eventA = '';
  let eventB = '';
  let requestA = '';
  let requestB = '';
  const rfqCount = () => count('purchasing_rfq_event');

  beforeAll(async () => {
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'RFQEVENT', subObject: '*', prefix: 'EV', numberLength: 7, createdBy: R });
      await defineRange(tx, { client, objectCode: 'RFQ', subObject: '*', prefix: 'RQ', numberLength: 7, createdBy: R });
      await defineRange(tx, { client, objectCode: 'QUOTATION', subObject: '*', prefix: 'QT', numberLength: 7, createdBy: R });
      await tx.execute(sql`insert into purchasing_org (client, purchasing_org, name, company_code, created_by) values (${client}, '1000', 'Org 1000', ${A}, ${R}), (${client}, '2000', 'Org 2000', ${B}, ${R}) on conflict do nothing`);
      await tx.execute(sql`insert into purchasing_org_plant (client, purchasing_org, plant, created_by) values (${client}, '1000', 'PLA1', ${R}), (${client}, '2000', 'PLB1', ${R}) on conflict do nothing`);
      await tx.execute(sql`insert into bp_role (client, partner_number, role_code, created_by) values (${client}, 'V10000', 'SUPPLIER', ${R}) on conflict do nothing`);
      await tx.execute(sql`insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, purchasing_group, purchasing_status, created_by) values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', '001', 'CREATED', ${R}), (${client}, 'V10000', 'SUPPLIER', '2000', 'USD', '001', 'CREATED', ${R}) on conflict do nothing`);
      await tx.execute(sql`update purchasing_group set purchasing_org = null where client = ${client} and purchasing_group = '001'`);
      await tx.execute(sql`update supplier_purchasing_org set purchasing_status = 'CREATED', purchasing_group = '001' where client = ${client} and partner_number = 'V10000'`);
      await tx.execute(sql`insert into purchasing_group (client, purchasing_group, name, created_by) values (${client}, '001', 'Group 001', ${R}) on conflict do nothing`);
      await tx.execute(sql`insert into material_plant (client, material_number, plant, procurement_type, created_by) values (${client}, 'M100', 'PLA1', 'BUY', ${R}), (${client}, 'M100', 'PLB1', 'BUY', ${R}) on conflict do nothing`);
    });
    orgOnly = await createFinanceActor(client, { capabilities: FINANCE_ACTOR_CAPABILITIES, companyScopes: [A, B] });
    await withTenant(client, async (tx) => {
      await tx.insert(authOrgRestriction).values([{ id: randomUUID(), client, userId: orgOnly.userId, scopeType: 'PURCHASING_ORG', scopeValue: '1000', createdBy: R }]);
    });
    eventA = (await createRequestForQuotation({ client, authorization: onlyA.authorization, changedBy: 'SPOOFED_NAME', ...header('1000'), suppliers, lines: lines('PLA1') })).eventNumber;
    eventB = (await createRequestForQuotation({ client, authorization: onlyB.authorization, changedBy: 'SPOOFED_NAME', ...header('2000'), suppliers, lines: lines('PLB1') })).eventNumber;
    requestA = (await getRequestForQuotation(client, eventA, onlyA.authorization))!.requests[0]!.rfqNumber;
    requestB = (await getRequestForQuotation(client, eventB, onlyB.authorization))!.requests[0]!.rfqNumber;
  }, 240_000);

  it('records the session user, never a supplied name', async () => {
    const who = await withTenant(client, async (tx) =>
      ((await tx.execute(sql`select created_by from purchasing_rfq_event where client = ${client} and event_number = ${eventA}`)) as unknown as Array<{ created_by: string }>)[0]?.created_by);
    expect(who).toBe(onlyA.username);
  });

  it('refuses no session, no capability, no scope and another tenant before anything is read or written', async () => {
    const before = await rfqCount();
    for (const authorization of bad()) {
      await refused(createRequestForQuotation({ client, authorization, changedBy: 'X', ...header('1000'), suppliers, lines: lines('PLA1') }));
      await refused(getRequestForQuotation(client, eventA, authorization));
      await refused(listRecentRequestsForQuotation(client, authorization));
      await refused(resolveRequestForQuotation(client, eventA, authorization));
      await refused(openQuotation(client, requestA, authorization));
      await refused(listRecentQuotationRequests(client, authorization));
      await refused(displayQuotation(client, 'QT-0000001', authorization));
      await refused(compareQuotations({ client, eventNumber: eventA, purchasingOrg: '1000' }, authorization));
    }
    expect(await rfqCount()).toBe(before);
  });

  it('refuses a request for another company\'s plant or organisation, and rolls back a derived one', async () => {
    const before = await rfqCount();
    await refused(createRequestForQuotation({ client, authorization: onlyA.authorization, changedBy: 'X', ...header('2000'), suppliers, lines: lines('PLB1') }), /outside your access/);
    await refused(createRequestForQuotation({ client, authorization: onlyA.authorization, changedBy: 'X', ...header('1000'), suppliers, lines: lines('PLB1') }), /outside your access/);
    await refused(createRequestForQuotation({ client, authorization: orgOnly.authorization, changedBy: 'X', ...header('2000'), suppliers, lines: lines('PLB1') }), /outside your access/);
    expect(await rfqCount()).toBe(before);
  });

  it('reads, resolves, lists, opens and compares only inside the reach; another company answers as missing', async () => {
    expect((await getRequestForQuotation(client, eventA, onlyA.authorization))?.eventNumber).toBe(eventA);
    expect(await getRequestForQuotation(client, eventB, onlyA.authorization)).toBeNull();
    expect(await resolveRequestForQuotation(client, requestB, onlyA.authorization)).toBeNull();
    expect((await resolveRequestForQuotation(client, requestA, onlyA.authorization))?.eventNumber).toBe(eventA);
    const listed = (await listRecentRequestsForQuotation(client, onlyA.authorization)).map((r) => r.eventNumber);
    expect(listed).toContain(eventA);
    expect(listed).not.toContain(eventB);
    expect(await openQuotation(client, requestB, onlyA.authorization)).toBeNull();
    expect((await listRecentQuotationRequests(client, onlyA.authorization)).map((r) => r.rfqNumber)).not.toContain(requestB);
    expect((await displayQuotationForRequest(client, requestB, onlyA.authorization)).found).toBe(false);
    await expect(compareQuotations({ client, eventNumber: eventB, purchasingOrg: '2000' }, onlyA.authorization)).rejects.toThrow(/does not stand/);
    expect(await getRequestForQuotation(client, eventB, orgOnly.authorization)).toBeNull();
    expect((await getRequestForQuotation(client, eventA, orgOnly.authorization))?.eventNumber).toBe(eventA);
  });

  it('answers a change or a quotation on another company\'s request as a request that does not stand', async () => {
    const ask = (p: Promise<unknown>) => p.then(() => 'done', (e: Error) => e.message);
    expect(await ask(changeRequestForQuotation({ client, authorization: onlyA.authorization, changedBy: 'X', rfqNumber: requestB, quotationDeadline: '2026-12-30' }))).toMatch(/does not stand/);
    expect(await ask(previewRequestForQuotationChange({ client, authorization: onlyA.authorization, changedBy: 'X', rfqNumber: requestB, quotationDeadline: '2026-12-30' }))).toMatch(/does not stand/);
    const offer = (rfqNumber: string) => ({
      client, changedBy: 'X', rfqNumber, lines: [{ itemNumber: 10, quantity: '5', unit: 'PC', netPrice: '3', priceUnit: '1', deliveryDate: '2026-12-01' }],
    });
    expect(await ask(createQuotation({ ...offer(requestB), authorization: onlyA.authorization }))).toMatch(/does not stand/);
    expect(await ask(previewQuotation({ ...offer(requestB), authorization: onlyA.authorization }))).toMatch(/does not stand/);
    expect(await count('purchasing_quotation')).toBe(0);
    const own = await createQuotation({ ...offer(requestA), changedBy: 'SPOOFED_NAME', authorization: onlyA.authorization });
    const who = await withTenant(client, async (tx) =>
      ((await tx.execute(sql`select created_by from purchasing_quotation where client = ${client} and quotation_number = ${own.quotationNumber}`)) as unknown as Array<{ created_by: string }>)[0]?.created_by);
    expect(who).toBe(onlyA.username);
    expect((await getQuotation(client, own.quotationNumber, onlyA.authorization))?.rfqNumber).toBe(requestA);
    expect(await getQuotation(client, own.quotationNumber, onlyB.authorization)).toBeNull();
    expect((await displayQuotation(client, own.quotationNumber, onlyB.authorization)).found).toBe(false);
    expect((await displayQuotation(client, own.quotationNumber, onlyA.authorization)).found).toBe(true);
  });
});

describe('info records, source lists and quota arrangements', () => {
  const R = 'Scope sourcing setup';
  const bad = () => [undefined, noCapability.authorization, noScope.authorization, otherTenantActor.authorization];
  const price = { amount: 10, currency: 'USD', priceUnit: 1, priceUnitOfMeasure: 'EA', validFrom: '2020-01-01', validTo: '2099-12-31' };
  const infoA = (extra: Record<string, unknown> = {}) => ({ client, changedBy: 'X', partnerNumber: 'V10000', materialNumber: 'M7001', purchasingOrg: '1000', price, ...extra });
  const source = (plant: string, org: string, material = 'M7001') => ({
    client, changedBy: 'X', materialNumber: material, plant, partnerNumber: 'V10000', purchasingOrg: org, validFrom: '2020-01-01', validTo: '2099-12-31',
  });
  const quota = (plant: string, org: string, material = 'M7001') => ({
    client, changedBy: 'X', materialNumber: material, plant, validFrom: '2020-01-01', validTo: '2099-12-31',
    items: [{ partnerNumber: 'V10000', purchasingOrg: org, quota: 100 }],
  });
  let orgOnly: FinanceActor;
  let recordA = '';
  let recordB = '';
  let sourceA = '';
  let sourceB = '';
  let quotaA = '';
  let quotaB = '';
  const counted = () => Promise.all(['purchasing_info_record', 'purchasing_source_list_entry', 'purchasing_quota_arrangement'].map(count));

  beforeAll(async () => {
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'INFOREC', subObject: '*', prefix: 'IR', numberLength: 7, createdBy: R });
      await defineRange(tx, { client, objectCode: 'SOURCELIST', subObject: '*', prefix: 'SL', numberLength: 7, createdBy: R });
      await defineRange(tx, { client, objectCode: 'QUOTAARR', subObject: '*', prefix: 'QA', numberLength: 7, createdBy: R });
      await tx.execute(sql`insert into purchasing_org (client, purchasing_org, name, company_code, created_by) values (${client}, '1000', 'Org 1000', ${A}, ${R}), (${client}, '2000', 'Org 2000', ${B}, ${R}) on conflict do nothing`);
      await tx.execute(sql`insert into purchasing_org_plant (client, purchasing_org, plant, created_by) values (${client}, '1000', 'PLA1', ${R}), (${client}, '2000', 'PLB1', ${R}) on conflict do nothing`);
      await tx.execute(sql`insert into bp_role (client, partner_number, role_code, created_by) values (${client}, 'V10000', 'SUPPLIER', ${R}) on conflict do nothing`);
      await tx.execute(sql`insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, purchasing_group, purchasing_status, created_by) values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', '001', 'CREATED', ${R}), (${client}, 'V10000', 'SUPPLIER', '2000', 'USD', '001', 'CREATED', ${R}) on conflict do nothing`);
      await tx.execute(sql`update supplier_purchasing_org set purchasing_status = 'CREATED' where client = ${client} and partner_number = 'V10000'`);
      await tx.execute(sql`update business_partner set general_status = 'CREATED', is_blocked = false where client = ${client} and partner_number = 'V10000'`);
      await tx.execute(sql`insert into purchasing_group (client, purchasing_group, name, created_by) values (${client}, '001', 'Group 001', ${R}) on conflict do nothing`);
      await tx.execute(sql`update purchasing_group set purchasing_org = null, is_active = true where client = ${client} and purchasing_group = '001'`);
      await tx.execute(sql`update supplier_purchasing_org set purchasing_group = '001' where client = ${client} and partner_number = 'V10000'`);
      for (const m of ['M7001', 'M7002']) {
        await tx.execute(sql`insert into material (client, material_number, description, material_type, base_unit, created_by)
          select ${client}, ${m}, 'Sourcing material', material_type, 'EA', ${R} from material_type where client = ${client} order by material_type limit 1 on conflict do nothing`);
        await tx.execute(sql`insert into material_plant (client, material_number, plant, procurement_type, created_by) values (${client}, ${m}, 'PLA1', 'BUY', ${R}), (${client}, ${m}, 'PLB1', 'BUY', ${R}) on conflict do nothing`);
      }
    });
    orgOnly = await createFinanceActor(client, { capabilities: FINANCE_ACTOR_CAPABILITIES, companyScopes: [A, B] });
    await withTenant(client, async (tx) => {
      await tx.insert(authOrgRestriction).values([{ id: randomUUID(), client, userId: orgOnly.userId, scopeType: 'PURCHASING_ORG', scopeValue: '1000', createdBy: R }]);
    });
    recordA = (await createPurchasingInfoRecord({ ...infoA(), authorization: onlyA.authorization, changedBy: 'SPOOFED_NAME' })).infoRecordNumber;
    recordB = (await createPurchasingInfoRecord({ ...infoA({ materialNumber: 'M7002', purchasingOrg: '2000' }), authorization: onlyB.authorization })).infoRecordNumber;
    sourceA = (await createSourceListEntry({ ...source('PLA1', '1000'), authorization: onlyA.authorization, changedBy: 'SPOOFED_NAME' })).sourceNumber;
    sourceB = (await createSourceListEntry({ ...source('PLB1', '2000'), authorization: onlyB.authorization })).sourceNumber;
    quotaA = (await createQuotaArrangement({ ...quota('PLA1', '1000'), authorization: onlyA.authorization, changedBy: 'SPOOFED_NAME' })).quotaNumber;
    quotaB = (await createQuotaArrangement({ ...quota('PLB1', '2000'), authorization: onlyB.authorization })).quotaNumber;
  }, 240_000);

  it('records the verified session user, never a supplied name', async () => {
    const who = async (table: string, column: string, key: string) => withTenant(client, async (tx) =>
      ((await tx.execute(sql`select created_by from ${sql.raw(table)} where client = ${client} and ${sql.raw(column)} = ${key}`)) as unknown as Array<{ created_by: string }>)[0]?.created_by);
    expect(await who('purchasing_info_record', 'info_record_number', recordA)).toBe(onlyA.username);
    expect(await who('purchasing_source_list_entry', 'source_number', sourceA)).toBe(onlyA.username);
    expect(await who('purchasing_quota_arrangement', 'quota_number', quotaA)).toBe(onlyA.username);
  });

  it('refuses no session, no capability, no scope and another tenant before anything is read or written', async () => {
    const before = await counted();
    for (const authorization of bad()) {
      await refused(createPurchasingInfoRecord({ ...infoA({ materialNumber: 'M7002' }), authorization }));
      await refused(previewPurchasingInfoRecord({ ...infoA({ materialNumber: 'M7002' }), authorization }));
      await refused(getPurchasingInfoRecord(client, recordA, authorization));
      await refused(findPurchasingInfoRecord(client, 'V10000', 'M7001', authorization));
      await refused(infoRecordChoices(client, authorization));
      await refused(createSourceListEntry({ ...source('PLA1', '1000', 'M7002'), authorization }));
      await refused(previewSourceListEntry({ ...source('PLA1', '1000', 'M7002'), authorization }));
      await refused(getSourceListEntry(client, sourceA, authorization));
      await refused(getSourceList(client, 'M7001', 'PLA1', authorization));
      await refused(listRecentSourceEntries(client, authorization));
      await refused(createQuotaArrangement({ ...quota('PLA1', '1000', 'M7002'), authorization }));
      await refused(previewQuotaArrangement({ ...quota('PLA1', '1000', 'M7002'), authorization }));
      await refused(getQuotaArrangement(client, quotaA, authorization));
      await refused(listQuotaArrangements(client, 'M7001', 'PLA1', authorization));
      await refused(listRecentQuotaArrangements(client, authorization));
      await refused(previewQuotaSelection({ client, materialNumber: 'M7001', plant: 'PLA1', documentDate: '2026-10-22', authorization }));
    }
    expect(await counted()).toEqual(before);
  });

  it('refuses writing into another company\'s organisation or plant, writing nothing', async () => {
    const before = await counted();
    await refused(createPurchasingInfoRecord({ ...infoA({ materialNumber: 'M7002', purchasingOrg: '2000' }), authorization: onlyA.authorization }), /outside your access/);
    await refused(createPurchasingInfoRecord({ ...infoA({ materialNumber: 'M7002', plant: 'PLB1' }), authorization: onlyA.authorization }), /outside your access/);
    await refused(createPurchasingInfoRecord({ ...infoA({ materialNumber: 'M7002' }), authorization: orgOnly.authorization, purchasingOrg: '2000' }), /outside your access/);
    await refused(createSourceListEntry({ ...source('PLB1', '2000', 'M7002'), authorization: onlyA.authorization }), /outside your access/);
    await refused(createSourceListEntry({ ...source('PLA1', '2000', 'M7002'), authorization: onlyA.authorization }), /outside your access|not assigned to plant/);
    await refused(createQuotaArrangement({ ...quota('PLB1', '2000', 'M7002'), authorization: onlyA.authorization }), /outside your access/);
    await refused(createQuotaArrangement({ ...quota('PLA1', '2000', 'M7002'), authorization: onlyA.authorization }), /outside your access|not assigned to plant/);
    await refused(createQuotaArrangement({ ...quota('PLA1', '1000', 'M7002'), authorization: orgOnly.authorization, items: [{ partnerNumber: 'V10000', purchasingOrg: '2000', quota: 100 }] }), /outside your access/);
    expect(await counted()).toEqual(before);
  });

  it('reads, lists and offers choices only inside the reach; another company answers as missing', async () => {
    const record = await getPurchasingInfoRecord(client, recordA, onlyA.authorization);
    expect(record?.segments.map((s) => s.purchasingOrg)).toEqual(['1000']);
    expect(await getPurchasingInfoRecord(client, recordB, onlyA.authorization)).toBeNull();
    expect(await findPurchasingInfoRecord(client, 'V10000', 'M7002', onlyA.authorization)).toBeNull();
    expect(await findPurchasingInfoRecord(client, 'V10000', 'M7002', onlyB.authorization)).toBe(recordB);
    const choices = await infoRecordChoices(client, onlyA.authorization);
    expect(choices.purchasingOrgs.map((o) => o.purchasingOrg)).not.toContain('2000');
    expect(choices.records.map((r) => r.infoRecordNumber)).not.toContain(recordB);

    expect((await getSourceListEntry(client, sourceA, onlyA.authorization))?.sourceNumber).toBe(sourceA);
    expect(await getSourceListEntry(client, sourceB, onlyA.authorization)).toBeNull();
    expect(await getSourceList(client, 'M7001', 'PLB1', onlyA.authorization)).toBeNull();
    expect((await listRecentSourceEntries(client, onlyA.authorization)).map((r) => r.sourceNumber)).not.toContain(sourceB);
    expect((await listRecentSourceEntries(client, onlyA.authorization)).map((r) => r.sourceNumber)).toContain(sourceA);

    expect((await getQuotaArrangement(client, quotaA, onlyA.authorization))?.quotaNumber).toBe(quotaA);
    expect(await getQuotaArrangement(client, quotaB, onlyA.authorization)).toBeNull();
    expect(await listQuotaArrangements(client, 'M7001', 'PLB1', onlyA.authorization)).toEqual([]);
    expect((await listRecentQuotaArrangements(client, onlyA.authorization)).map((r) => r.quotaNumber)).not.toContain(quotaB);
    await refused(previewQuotaSelection({ client, materialNumber: 'M7001', plant: 'PLB1', documentDate: '2026-10-22', authorization: onlyA.authorization }), /outside your access/);
  });

  it('answers a change of another company\'s document as a missing one, and changes nothing', async () => {
    const ask = (p: Promise<unknown>) => p.then(() => 'done', (e: Error) => e.message);
    expect(await ask(changePurchasingInfoRecord({ client, changedBy: 'X', authorization: onlyA.authorization, reason: 'Scope probe', infoRecordNumber: recordB, expectedVersion: 1, plannedDeliveryDays: 3 }))).toMatch(/does not exist/);
    expect(await ask(previewPurchasingInfoRecordChange({ client, changedBy: 'X', authorization: onlyA.authorization, reason: 'Scope probe', infoRecordNumber: recordB, expectedVersion: 1, plannedDeliveryDays: 3 }))).toMatch(/does not exist/);
    expect(await ask(changeSourceListEntry({ client, changedBy: 'X', authorization: onlyA.authorization, reason: 'Scope probe', sourceNumber: sourceB, expectedVersion: 1, mrpRelevant: true }))).toMatch(/does not exist/);
    expect(await ask(changeQuotaArrangement({ client, changedBy: 'X', authorization: onlyA.authorization, reason: 'Scope probe', quotaNumber: quotaB, expectedVersion: 1, markDeleted: true }))).toMatch(/does not exist/);
    const marked = await withTenant(client, async (tx) =>
      ((await tx.execute(sql`select (select count(*) from purchasing_quota_arrangement where client = ${client} and marked_for_deletion) as q`)) as unknown as Array<{ q: string }>)[0]!.q);
    expect(Number(marked)).toBe(0);
    // The same actor changes their own, recording the session user.
    const done = await changePurchasingInfoRecord({ client, changedBy: 'SPOOFED_NAME', authorization: onlyA.authorization, reason: 'Delivery time', infoRecordNumber: recordA, expectedVersion: 1, segmentNumber: 1, plannedDeliveryDays: 4 });
    expect(done.infoRecordNumber).toBe(recordA);
    const changedBy = await withTenant(client, async (tx) =>
      ((await tx.execute(sql`select changed_by from purchasing_info_record where client = ${client} and info_record_number = ${recordA}`)) as unknown as Array<{ changed_by: string }>)[0]?.changed_by);
    expect(changedBy).toBe(onlyA.username);
  });

  it('answers adding a segment to a record with no segment in the reach as a missing record', async () => {
    const before = await counted();
    const version = (await getPurchasingInfoRecord(client, recordA, onlyA.authorization))!.version;
    await expect(createPurchasingInfoRecord({ ...infoA({ purchasingOrg: '2000', infoRecordNumber: recordA, expectedVersion: version }), authorization: onlyB.authorization }))
      .rejects.toThrow(/does not exist/);
    // Naming a segment that is not the actor's answers as no such segment.
    await expect(changePurchasingInfoRecord({ client, changedBy: 'X', authorization: onlyA.authorization, reason: 'Scope probe', infoRecordNumber: recordA, expectedVersion: version, segmentNumber: 9, plannedDeliveryDays: 9 }))
      .rejects.toThrow(/has no segment/);
    expect(await counted()).toEqual(before);
  });

  it('judges the purchasing org level on all three', async () => {
    expect(await getPurchasingInfoRecord(client, recordB, orgOnly.authorization)).toBeNull();
    expect((await getPurchasingInfoRecord(client, recordA, orgOnly.authorization))?.infoRecordNumber).toBe(recordA);
    expect(await getSourceListEntry(client, sourceB, orgOnly.authorization)).toBeNull();
    expect((await getSourceListEntry(client, sourceA, orgOnly.authorization))?.sourceNumber).toBe(sourceA);
    expect(await getQuotaArrangement(client, quotaB, orgOnly.authorization)).toBeNull();
    expect((await getQuotaArrangement(client, quotaA, orgOnly.authorization))?.quotaNumber).toBe(quotaA);
  });
});

describe('vendor evaluation, order drafts and stock transport orders', () => {
  const R = 'Scope follow-up setup';
  const bad = () => [undefined, noCapability.authorization, noScope.authorization, otherTenantActor.authorization];
  const PERIOD = { periodFrom: '2026-01-01', periodTo: '2026-06-30' };
  const evalParams = (org: string) => ({ supplier: 'V10000', purchasingOrg: org, ...PERIOD });
  const reqItem = (plant: string) => ({
    materialNumber: '', shortText: 'Steel plate', quantity: 10, unit: 'PC', deliveryDate: '2026-11-15', plant,
    storageLocation: '', purchasingGroup: '001', estimatedPrice: 150, priceUnit: 1, currency: 'USD',
    markedForDeletion: false, assignments: [] as never[],
  });
  const sto = (supplying: string, receiving: string) => ({
    documentType: 'STOCK_TRANSPORT', supplyingPlant: supplying, purchasingOrg: '1000', purchasingGroup: '001', companyCode: A,
    items: [{ materialNumber: 'M100', quantity: 5, unit: 'PC', plant: receiving, storageLocation: '', scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 5 }] }],
  });
  let reqA = '';
  let reqB = '';

  beforeAll(async () => {
    await withTenant(client, async (tx) => {
      await tx.execute(sql`insert into purchasing_org (client, purchasing_org, name, company_code, created_by) values (${client}, '1000', 'Org 1000', ${A}, ${R}), (${client}, '2000', 'Org 2000', ${B}, ${R}) on conflict do nothing`);
      await defineRange(tx, { client, objectCode: 'PURCHREQ', subObject: 'NB', prefix: 'PR', numberLength: 7, createdBy: R });
      await tx.execute(sql`insert into purchasing_group (client, purchasing_group, name, created_by) values (${client}, '001', 'Group 001', ${R}) on conflict do nothing`);
    });
    reqA = (await createRequisition({ client, authorization: onlyA.authorization, changedBy: 'X', items: [reqItem('PLA1')] })).requisitionNumber;
    reqB = (await createRequisition({ client, authorization: onlyB.authorization, changedBy: 'X', items: [reqItem('PLB1')] })).requisitionNumber;
  }, 120_000);

  it('refuses vendor evaluation with no session, capability or scope, and for another company\'s organisation as one that does not stand', async () => {
    for (const authorization of bad()) {
      await refused(listVendorEvaluation(client, evalParams('1000'), authorization));
      await refused(checkVendorEvaluation(client, evalParams('1000'), authorization));
    }
    const hidden = (org: string) => listVendorEvaluation(client, evalParams(org), onlyA.authorization).then(() => 'done', (e: Error) => e.message);
    expect((await hidden('2000')).replace('2000', 'X')).toBe((await hidden('9999')).replace('9999', 'X'));
    expect(await hidden('2000')).toMatch(/does not stand/);
    expect(await hidden('1000')).not.toMatch(/does not stand/);
  });

  it('refuses a manual score for another company\'s organisation and a plant-limited user a company-wide evaluation, writing nothing', async () => {
    const before = await count('vendor_evaluation_assessment');
    await expect(saveManualScore({
      client, changedBy: 'X', authorization: onlyA.authorization, ...evalParams('2000'), criterionCode: 'QUALITY', score: '80',
      reason: 'Scope probe', requestKey: 'scope-eval-1', expectedVersion: null,
    })).rejects.toThrow(/does not stand/);
    await expect(listVendorEvaluation(client, evalParams('1000'), plantLimited.authorization)).rejects.toThrow(/Plant scope|plant-limited/i);
    expect(await count('vendor_evaluation_assessment')).toBe(before);
  });

  it('drafts an order from a requisition only inside the reach; another company\'s answers as a missing one', async () => {
    for (const authorization of bad()) await refused(orderDraftFromRequisition(client, reqA, authorization));
    expect((await orderDraftFromRequisition(client, reqA, onlyA.authorization))?.items.length).toBeGreaterThan(0);
    const foreign = await orderDraftFromRequisition(client, reqB, onlyA.authorization);
    expect(foreign?.items).toEqual([]);
    expect(foreign?.warning).toBe(`Requisition ${reqB} does not exist.`);
    const missing = await orderDraftFromRequisition(client, 'PR-NOPE', onlyA.authorization);
    expect(missing?.warning).toBe('Requisition PR-NOPE does not exist.');
    for (const authorization of bad()) await refused(orderDraftFromQuotation(client, 'QT-0000001', authorization));
    expect(await orderDraftFromQuotation(client, 'QT-9999999', onlyA.authorization)).toBeNull();
    // A quotation of company A's request is a draft for A and absent for B.
    const draft = await orderDraftFromQuotation(client, 'QT-0000001', onlyA.authorization);
    if (draft) expect(await orderDraftFromQuotation(client, 'QT-0000001', onlyB.authorization)).toBeNull();
  });

  it('keeps a delivery-completion rule inside the reach: another company or plant answers as not there, a Plant limit is refused a company default', async () => {
    const before = await count('purchase_delivery_completion_policy') + await count('purchase_delivery_completion_plant');
    for (const authorization of bad()) {
      await refused(listDeliveryCompletionPolicy(client, authorization));
      await refused(setDeliveryCompletionPolicy({ client, changedBy: 'X', authorization, companyCode: A, autoClose: true }));
      await refused(setDeliveryCompletionPlantPolicy({ client, changedBy: 'X', authorization, plant: 'PLA1', autoClose: true }));
    }
    const listed = await listDeliveryCompletionPolicy(client, onlyA.authorization);
    expect(listed.companies.map((c) => c.companyCode)).toEqual([A]);
    expect(listed.plants.every((p) => p.companyCode === A)).toBe(true);
    await refused(setDeliveryCompletionPolicy({ client, changedBy: 'X', authorization: onlyA.authorization, companyCode: B, autoClose: true }));
    await expect(setDeliveryCompletionPlantPolicy({ client, changedBy: 'X', authorization: onlyA.authorization, plant: 'PLB1', autoClose: true })).rejects.toThrow(/does not exist/);
    await expect(setDeliveryCompletionPolicy({ client, changedBy: 'X', authorization: plantLimited.authorization, companyCode: A, autoClose: true })).rejects.toThrow(/Plant scope|plant-limited/i);
    expect(await count('purchase_delivery_completion_policy') + await count('purchase_delivery_completion_plant')).toBe(before);
    const standing = listed.companies.find((c) => c.companyCode === A)!.autoClose;
    await setDeliveryCompletionPolicy({ client, changedBy: 'SPOOFED_NAME', authorization: onlyA.authorization, companyCode: A, autoClose: !standing });
    const by = await withTenant(client, async (tx) =>
      ((await tx.execute(sql`select changed_by from purchase_delivery_completion_policy where client = ${client} and company_code = ${A}`)) as unknown as Array<{ changed_by: string }>)[0]?.changed_by);
    expect(by).toBe(onlyA.username);
  });

  it('refuses a stock transport order whose supplying or receiving plant is outside the reach, writing nothing', async () => {
    const before = await count('purchase_order');
    await refused(createOrder({ client, authorization: onlyA.authorization, changedBy: 'X', ...sto('PLA1', 'PLB1') } as never), /outside your access/);
    await refused(createOrder({ client, authorization: onlyA.authorization, changedBy: 'X', ...sto('PLB1', 'PLA1') } as never), /outside your access/);
    await refused(createOrder({ client, authorization: onlyA.authorization, changedBy: 'X', ...sto('PLA1', 'PLB1'), purchasingOrg: '1000' } as never), /outside your access/);
    expect(await count('purchase_order')).toBe(before);
  });
});

describe('provisioning-only read', () => {
  it('is not reachable from any page, action or route', async () => {
    const { execFileSync } = await import('node:child_process');
    let hits = '';
    try { hits = execFileSync('grep', ['-rlE', 'ForProvisioning', 'src/app'], { encoding: 'utf8' }); } catch { /* grep exits 1 when nothing matches */ }
    expect(hits.trim()).toBe('');
  });
});
